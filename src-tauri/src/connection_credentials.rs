//! Connection credential lifecycle (F08.2/C05.2).
//!
//! This module is the only place that combines the trusted SQLite metadata with the OS credential
//! store. It implements the order that keeps a crash from either leaking or losing a secret:
//!
//! 1. **Prepare** — the new reference is queued as `prepare` *before* the keyring is touched, so a
//!    crash between the keyring write and the bind still leaves the orphan accounted for.
//! 2. **Write** — the new secret is written under a freshly generated UUID. An existing secret is
//!    never overwritten in place, so a failed bind cannot destroy a working credential.
//! 3. **Bind** — row update, prepare removal and old-reference queuing happen in one transaction,
//!    which also returns the resulting profile snapshot. Only after that commit is the old secret
//!    deleted, and a reference still used by any connection is never deleted at all.
//!
//! Detaching (unbind, delete, endpoint change) always clears the reference and queues the secret in
//! one transaction first; the keyring deletion is attempted afterwards and, if it fails, the queued
//! record stays for a bounded retry instead of being silently dropped.
//!
//! Outcomes distinguish what is certain from what is not. Every write returns the committed
//! profile plus a [`CleanupPass`]: a completed pass with its report, or `Incomplete` when the
//! post-commit cleanup could not be accounted for (queue read, retry counter or queue removal
//! failed). `Incomplete` never means "nothing to clean", and a cleanup failure never rolls back
//! committed metadata and never reports full success. These outcomes are Rust-internal; no IPC
//! command returns them yet and no command accepts a secret, so the legacy IPC contract is
//! unchanged. The legacy commands therefore refuse a connection that has a bound credential
//! instead of acting on it (see `Database::save_connection_metadata_only`).
//!
//! Concurrency: single writer. Every write goes through one `&mut Database` owned by the caller
//! (the desktop runtime holds it behind a mutex), so the transactions here are serialized
//! in-process. There is no cross-process coordination and no lock file: two application instances
//! sharing one SQLite file are not supported, and adding such a lock is out of scope here.
//!
//! Out of scope: authenticated network requests, secret payload encoding, startup recovery wiring
//! and any command that accepts or returns a secret.

use crate::credentials::{CredentialRef, CredentialStore, Secret};
use crate::error::AppError;
use crate::storage::{
    AuthKind, CleanupReason, ConnectionInput, ConnectionProfile, Database, MAX_CLEANUP_BATCH,
};

/// Retry budget per queued reference. A reference that keeps failing stays queued and is reported
/// as abandoned instead of being retried forever or dropped silently.
pub const MAX_CLEANUP_ATTEMPTS: i64 = 5;

/// References processed by one write before the rest of the backlog is left to the next call.
pub const CLEANUP_BATCH: usize = 8;

/// Outcome of one bounded cleanup pass. Reported so a caller can tell "metadata committed and the
/// secret is gone" apart from "metadata committed, secret still queued".
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CleanupReport {
    /// References a deletion was attempted for in this pass.
    pub attempted: usize,
    /// References whose secret is now gone and whose queue entry was removed.
    pub cleaned: usize,
    /// References whose deletion failed and whose retry counter was incremented.
    pub failed: usize,
    /// Queued references skipped because a connection still uses them.
    pub deferred: usize,
    /// Queued references skipped because they exhausted [`MAX_CLEANUP_ATTEMPTS`].
    pub abandoned: usize,
    /// Queue entries still present after this pass, in every category.
    pub remaining: usize,
}

impl CleanupReport {
    /// True while a detached secret is still waiting for deletion.
    pub const fn cleanup_pending(&self) -> bool {
        self.remaining > 0
    }
}

/// Result of one bounded cleanup pass, including the case where the pass itself could not finish.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupPass {
    /// The pass ran to completion; the report describes exactly what it did.
    Completed(CleanupReport),
    /// The pass could not complete, so the queue state is unknown and at least one detached secret
    /// may still exist. Committed metadata is unaffected and nothing is reported as cleaned.
    Incomplete,
}

impl CleanupPass {
    /// True while a detached secret may still be waiting for deletion. An incomplete pass is always
    /// pending: its result is unknown, never "nothing left to do".
    pub const fn cleanup_pending(&self) -> bool {
        match self {
            Self::Completed(report) => report.cleanup_pending(),
            Self::Incomplete => true,
        }
    }

    /// True when the pass could not be accounted for at all.
    pub const fn is_incomplete(&self) -> bool {
        matches!(self, Self::Incomplete)
    }

    /// The report of a completed pass, or `None` when the pass did not finish.
    pub const fn report(&self) -> Option<&CleanupReport> {
        match self {
            Self::Completed(report) => Some(report),
            Self::Incomplete => None,
        }
    }
}

/// Result of a write that returns the affected connection.
#[derive(Debug)]
pub struct CredentialWrite {
    pub profile: ConnectionProfile,
    /// Credential detached or replaced by this call, already queued for deletion.
    pub detached: Option<CredentialRef>,
    pub cleanup: CleanupPass,
}

/// Result of deleting a connection.
#[derive(Debug)]
pub struct DeleteOutcome {
    /// Credential detached by the deletion, already queued for deletion.
    pub detached: Option<CredentialRef>,
    pub cleanup: CleanupPass,
}

/// Credential lifecycle over one database handle and one injectable credential store.
pub struct ConnectionCredentials<'a> {
    database: &'a mut Database,
    store: &'a dyn CredentialStore,
}

impl<'a> ConnectionCredentials<'a> {
    pub fn new(database: &'a mut Database, store: &'a dyn CredentialStore) -> Self {
        Self { database, store }
    }

    /// Metadata-only write. Renaming preserves the id and the credential reference; changing the
    /// endpoint detaches the credential, because the old secret was captured for the old target.
    pub fn save(
        &mut self,
        input: ConnectionInput,
        id: Option<String>,
    ) -> Result<CredentialWrite, AppError> {
        let record = self.database.save_connection(input, id)?;
        let cleanup = self.cleanup_after_commit(CLEANUP_BATCH);
        Ok(CredentialWrite {
            profile: record.profile,
            detached: record.detached,
            cleanup,
        })
    }

    /// Bind a new secret to a connection, replacing any previous one.
    pub fn bind(
        &mut self,
        connection_id: &str,
        kind: AuthKind,
        secret: Secret,
    ) -> Result<CredentialWrite, AppError> {
        if kind == AuthKind::None {
            return Err(AppError::new("invalidInput"));
        }
        // The reference is resolved from the trusted row, never supplied by the caller.
        self.database.connection_auth(connection_id)?;
        let reference = CredentialRef::generate();
        // Persist the intent before the keyring write: a crash before the bind commits leaves a
        // prepare entry, and the cleanup pass then deletes the orphan.
        self.database
            .queue_credential_cleanup(&reference, CleanupReason::Prepare)?;
        if let Err(error) = self.store.set(&reference, &secret) {
            // The write may or may not have landed, so the reference stays accounted for: either
            // the entry is removed because nothing exists, or it stays queued for retry.
            self.discard_new_secret(&reference);
            return Err(AppError::from(error));
        }
        // The secret is not retained here: from this point it lives in the OS store only.
        drop(secret);
        match self
            .database
            .bind_credential(connection_id, kind, &reference)
        {
            Ok(record) => {
                let cleanup = self.cleanup_after_commit(CLEANUP_BATCH);
                Ok(CredentialWrite {
                    profile: record.profile,
                    detached: record.detached,
                    cleanup,
                })
            }
            Err(error) => {
                // The bind did not commit, so the new secret must not survive it.
                self.discard_new_secret(&reference);
                Err(error)
            }
        }
    }

    /// Detach a connection's credential without deleting the connection.
    pub fn unbind(&mut self, connection_id: &str) -> Result<CredentialWrite, AppError> {
        let record = self.database.detach_credential(connection_id)?;
        let cleanup = self.cleanup_after_commit(CLEANUP_BATCH);
        Ok(CredentialWrite {
            profile: record.profile,
            detached: record.detached,
            cleanup,
        })
    }

    /// Delete a connection and its credential.
    pub fn delete(&mut self, connection_id: &str) -> Result<DeleteOutcome, AppError> {
        let detached = self.database.delete_connection(connection_id)?;
        let cleanup = self.cleanup_after_commit(CLEANUP_BATCH);
        Ok(DeleteOutcome { detached, cleanup })
    }

    /// Drain one bounded batch of queued references. Never deletes a reference that a connection
    /// or a model row still uses, and never fails because a deletion failed. This returns `Err`
    /// only when the pass itself could not be accounted for; the write paths wrap that in
    /// [`CleanupPass::Incomplete`] instead, because by then their metadata is already committed.
    pub fn run_pending_cleanup(&mut self, limit: usize) -> Result<CleanupReport, AppError> {
        run_cleanup_pass(self.database, self.store, limit)
    }

    /// Cleanup after a committed write. A storage or store failure here must never look like a
    /// failed write, and must never look like a successful cleanup either.
    fn cleanup_after_commit(&mut self, limit: usize) -> CleanupPass {
        cleanup_after_commit(self.database, self.store, limit)
    }

    /// Best-effort removal of a secret that was never bound. Any failure keeps the queued record,
    /// which is the conservative outcome, and never masks the error that caused the rollback.
    fn discard_new_secret(&mut self, reference: &CredentialRef) {
        discard_unbound_secret(self.database, self.store, reference);
    }
}

/// One bounded cleanup pass over the shared outbox, used by both connection and model credential
/// workflows. Never deletes a reference that a connection or a model still uses, never retries
/// beyond the persisted attempt budget, and never fails because a single deletion failed. This
/// returns `Err` only when the pass itself could not be accounted for.
pub(crate) fn run_cleanup_pass(
    database: &mut Database,
    store: &dyn CredentialStore,
    limit: usize,
) -> Result<CleanupReport, AppError> {
    let limit = limit.min(MAX_CLEANUP_BATCH);
    let pending = database.pending_credential_cleanup(limit, MAX_CLEANUP_ATTEMPTS)?;
    let mut report = CleanupReport::default();
    for entry in pending {
        report.attempted += 1;
        match store.delete(&entry.reference) {
            Ok(()) => {
                database.cancel_credential_cleanup(&entry.reference)?;
                report.cleaned += 1;
            }
            Err(_) => {
                // The store error is dropped: it can carry OS detail, and the queue entry is the
                // record that matters.
                database.record_cleanup_attempt(&entry.reference)?;
                report.failed += 1;
            }
        }
    }
    let backlog = database.credential_cleanup_backlog(MAX_CLEANUP_ATTEMPTS)?;
    report.deferred = backlog.deferred as usize;
    report.abandoned = backlog.abandoned as usize;
    report.remaining = backlog.total as usize;
    Ok(report)
}

/// Cleanup after a committed write. A storage or store failure here must never look like a failed
/// write, and must never look like a successful cleanup either.
pub(crate) fn cleanup_after_commit(
    database: &mut Database,
    store: &dyn CredentialStore,
    limit: usize,
) -> CleanupPass {
    match run_cleanup_pass(database, store, limit) {
        Ok(report) => CleanupPass::Completed(report),
        Err(_) => CleanupPass::Incomplete,
    }
}

/// Best-effort removal of a secret that was never bound to a row. Any failure keeps the queued
/// record, which is the conservative outcome, and never masks the error that caused the rollback.
pub(crate) fn discard_unbound_secret(
    database: &mut Database,
    store: &dyn CredentialStore,
    reference: &CredentialRef,
) {
    if store.delete(reference).is_ok() {
        let _ = database.cancel_credential_cleanup(reference);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::CredentialError;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// Test-only store: records every call so ordering can be asserted, and injects failures per
    /// operation. Never reachable from production code and never a production fallback.
    #[derive(Default)]
    struct RecordingStore {
        entries: Mutex<HashMap<String, Vec<u8>>>,
        events: Mutex<Vec<String>>,
        fail_set: Mutex<Option<CredentialError>>,
        fail_delete: Mutex<Option<CredentialError>>,
    }

    impl RecordingStore {
        fn set_fault(&self, fault: Option<CredentialError>) {
            *self.fail_set.lock().unwrap() = fault;
        }

        fn delete_fault(&self, fault: Option<CredentialError>) {
            *self.fail_delete.lock().unwrap() = fault;
        }

        fn events(&self) -> Vec<String> {
            self.events.lock().unwrap().clone()
        }

        /// References touched by one operation kind, in call order.
        fn refs(&self, prefix: &str) -> Vec<String> {
            self.events()
                .into_iter()
                .filter_map(|event| event.strip_prefix(prefix).map(str::to_owned))
                .collect()
        }

        fn secret(&self, reference: &CredentialRef) -> Option<String> {
            self.entries
                .lock()
                .unwrap()
                .get(reference.as_str())
                .map(|bytes| String::from_utf8(bytes.clone()).unwrap())
        }
    }

    impl CredentialStore for RecordingStore {
        fn set(&self, reference: &CredentialRef, secret: &Secret) -> Result<(), CredentialError> {
            if let Some(fault) = *self.fail_set.lock().unwrap() {
                return Err(fault);
            }
            self.events
                .lock()
                .unwrap()
                .push(format!("set:{}", reference.as_str()));
            self.entries.lock().unwrap().insert(
                reference.as_str().to_owned(),
                secret.expose_secret().to_vec(),
            );
            Ok(())
        }

        fn get(&self, reference: &CredentialRef) -> Result<Secret, CredentialError> {
            self.events
                .lock()
                .unwrap()
                .push(format!("get:{}", reference.as_str()));
            let entries = self.entries.lock().unwrap();
            Secret::new(
                entries
                    .get(reference.as_str())
                    .ok_or(CredentialError::NotFound)?
                    .clone(),
            )
        }

        fn delete(&self, reference: &CredentialRef) -> Result<(), CredentialError> {
            if let Some(fault) = *self.fail_delete.lock().unwrap() {
                return Err(fault);
            }
            self.events
                .lock()
                .unwrap()
                .push(format!("delete:{}", reference.as_str()));
            self.entries.lock().unwrap().remove(reference.as_str());
            Ok(())
        }
    }

    /// Real SQLite file plus an injectable store, so every assertion observes production code
    /// paths. The temporary directory lives as long as the fixture, so the file can be reopened.
    struct Fixture {
        temp: tempfile::TempDir,
        database: Database,
        store: RecordingStore,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let database = Database::open(&temp.path().join("escope.sqlite")).unwrap();
            Self {
                temp,
                database,
                store: RecordingStore::default(),
            }
        }

        fn add(&mut self, name: &str, endpoint: &str) -> String {
            self.credentials()
                .save(input(name, endpoint), None)
                .unwrap()
                .profile
                .id
        }

        fn credentials(&mut self) -> ConnectionCredentials<'_> {
            ConnectionCredentials::new(&mut self.database, &self.store)
        }

        fn reference(&self, id: &str) -> CredentialRef {
            self.database
                .connection_auth(id)
                .unwrap()
                .credential_ref
                .expect("connection must have a bound credential")
        }
    }

    fn input(name: &str, endpoint: &str) -> ConnectionInput {
        ConnectionInput {
            display_name: name.into(),
            endpoint: endpoint.into(),
            environment: "development".into(),
        }
    }

    fn secret(value: &str) -> Secret {
        Secret::new(value).unwrap()
    }

    /// Completed-pass report, so tests read the counts and still assert completeness explicitly.
    fn completed(pass: &CleanupPass) -> &CleanupReport {
        pass.report().expect("cleanup pass must have completed")
    }

    /// Forces the metadata commit of a bind to fail with a real SQLite error.
    fn fail_bind_writes(fixture: &Fixture) {
        fixture
            .database
            .run_sql_for_test(
                "CREATE TRIGGER fail_bind BEFORE UPDATE ON connections BEGIN SELECT RAISE(ABORT, 'forced'); END",
            )
            .unwrap();
    }

    #[test]
    fn save_without_credentials_never_touches_the_credential_store() {
        let mut fixture = Fixture::new();
        let write = fixture
            .credentials()
            .save(input("Plain", "https://plain.test/es"), None)
            .unwrap();
        assert!(write.detached.is_none());
        assert_eq!(completed(&write.cleanup), &CleanupReport::default());
        assert!(!write.cleanup.is_incomplete());
        assert!(!write.cleanup.cleanup_pending());
        assert!(write.profile.auth_state.unauthenticated());
        let id = write.profile.id.clone();
        fixture.credentials().delete(&id).unwrap();
        assert!(fixture.store.events().is_empty());
        assert_eq!(
            fixture.database.pending_credential_cleanup_count().unwrap(),
            0
        );
    }

    #[test]
    fn bind_writes_a_fresh_reference_then_rotates_through_a_new_one() {
        let mut fixture = Fixture::new();
        let id = fixture.add("A", "https://a.test/es");

        let write = fixture
            .credentials()
            .bind(&id, AuthKind::Basic, secret("first-secret"))
            .unwrap();
        let first = fixture.reference(&id);
        assert!(write.detached.is_none());
        assert_eq!(write.profile.auth_state.kind, AuthKind::Basic);
        assert_eq!(
            fixture.store.secret(&first).as_deref(),
            Some("first-secret")
        );
        assert_eq!(
            fixture.database.pending_credential_cleanup_count().unwrap(),
            0
        );

        let write = fixture
            .credentials()
            .bind(&id, AuthKind::Bearer, secret("second-secret"))
            .unwrap();
        let second = fixture.reference(&id);
        // A rotation never overwrites in place: the reference and the stored entry are new.
        assert_ne!(second, first);
        assert_eq!(write.detached.as_ref(), Some(&first));
        assert_eq!(write.profile.auth_state.kind, AuthKind::Bearer);
        assert_eq!(completed(&write.cleanup).cleaned, 1);
        assert!(!write.cleanup.cleanup_pending());
        assert_eq!(fixture.store.secret(&first), None);
        assert_eq!(
            fixture.store.secret(&second).as_deref(),
            Some("second-secret")
        );
        assert_eq!(
            fixture.database.pending_credential_cleanup_count().unwrap(),
            0
        );

        // The new secret is written before the old one is deleted, and the old one is deleted only
        // after the binding committed. Ordering is observed, not assumed.
        assert_eq!(
            fixture.store.events(),
            vec![
                format!("set:{first}"),
                format!("set:{second}"),
                format!("delete:{first}"),
            ]
        );
    }

    #[test]
    fn failed_keyring_write_never_binds_and_keeps_no_queue_entry() {
        let mut fixture = Fixture::new();
        let id = fixture.add("A", "https://a.test/es");
        fixture
            .store
            .set_fault(Some(CredentialError::StorageFailure));

        let error = fixture
            .credentials()
            .bind(&id, AuthKind::Basic, secret("doomed"))
            .unwrap_err();
        assert_eq!(error.code, "credentialFailure");
        assert!(fixture
            .database
            .connection_auth(&id)
            .unwrap()
            .unauthenticated());
        assert_eq!(
            fixture.database.pending_credential_cleanup_count().unwrap(),
            0
        );
        assert!(fixture.store.refs("set:").is_empty());

        // An unavailable store is reported as such and never degrades to plaintext storage.
        fixture.store.set_fault(Some(CredentialError::Unavailable));
        let error = fixture
            .credentials()
            .bind(&id, AuthKind::Basic, secret("doomed"))
            .unwrap_err();
        assert_eq!(error.code, "credentialUnavailable");
        assert!(fixture
            .database
            .connection_auth(&id)
            .unwrap()
            .unauthenticated());
        assert_eq!(
            fixture.database.pending_credential_cleanup_count().unwrap(),
            0
        );
    }

    #[test]
    fn failed_metadata_commit_erases_the_new_secret_and_keeps_the_old_one() {
        let mut fixture = Fixture::new();
        let id = fixture.add("A", "https://a.test/es");
        fixture
            .credentials()
            .bind(&id, AuthKind::Basic, secret("first-secret"))
            .unwrap();
        let first = fixture.reference(&id);
        fail_bind_writes(&fixture);

        let error = fixture
            .credentials()
            .bind(&id, AuthKind::ApiKey, secret("second-secret"))
            .unwrap_err();
        assert_eq!(error.code, "storageUnavailable");

        // The committed binding is untouched and the old secret was never deleted.
        assert_eq!(fixture.reference(&id), first);
        assert_eq!(
            fixture.store.secret(&first).as_deref(),
            Some("first-secret")
        );
        // The unbound new secret was erased and left no queue entry behind; nothing else was
        // deleted, so the old reference was never touched before the new binding succeeded.
        let written = fixture.store.refs("set:");
        assert_eq!(written.len(), 2);
        let abandoned = CredentialRef::parse(&written[1]).unwrap();
        assert_eq!(fixture.store.secret(&abandoned), None);
        assert_eq!(
            fixture.store.refs("delete:"),
            vec![abandoned.as_str().to_owned()]
        );
        assert_eq!(
            fixture.database.pending_credential_cleanup_count().unwrap(),
            0
        );
    }

    #[test]
    fn new_secret_cleanup_failure_keeps_a_persistent_prepare_record() {
        let mut fixture = Fixture::new();
        let id = fixture.add("A", "https://a.test/es");
        fail_bind_writes(&fixture);
        fixture
            .store
            .delete_fault(Some(CredentialError::Unavailable));

        assert_eq!(
            fixture
                .credentials()
                .bind(&id, AuthKind::Basic, secret("orphan-secret"))
                .unwrap_err()
                .code,
            "storageUnavailable"
        );
        // The record was persisted before the keyring write, so the orphan stays accounted for.
        let queued = fixture
            .database
            .pending_credential_cleanup(8, MAX_CLEANUP_ATTEMPTS)
            .unwrap();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].reason, CleanupReason::Prepare);
        let orphan = queued[0].reference.clone();
        assert_eq!(
            fixture.store.secret(&orphan).as_deref(),
            Some("orphan-secret")
        );
        assert!(fixture
            .database
            .connection_auth(&id)
            .unwrap()
            .unauthenticated());

        // Once the store is reachable again the orphan is removed and the record disappears.
        fixture.store.delete_fault(None);
        let report = fixture
            .credentials()
            .run_pending_cleanup(CLEANUP_BATCH)
            .unwrap();
        assert_eq!(report.cleaned, 1);
        assert!(!report.cleanup_pending());
        assert_eq!(fixture.store.secret(&orphan), None);
        assert_eq!(
            fixture.database.pending_credential_cleanup_count().unwrap(),
            0
        );
    }

    #[test]
    fn rotation_cleanup_failure_keeps_the_committed_binding_and_queues_the_old_reference() {
        let mut fixture = Fixture::new();
        let id = fixture.add("A", "https://a.test/es");
        fixture
            .credentials()
            .bind(&id, AuthKind::Basic, secret("first-secret"))
            .unwrap();
        let first = fixture.reference(&id);
        fixture
            .store
            .delete_fault(Some(CredentialError::StorageFailure));

        let write = fixture
            .credentials()
            .bind(&id, AuthKind::Bearer, secret("second-secret"))
            .unwrap();
        let second = fixture.reference(&id);
        assert_ne!(second, first);
        assert_eq!(completed(&write.cleanup).failed, 1);
        assert_eq!(completed(&write.cleanup).cleaned, 0);
        assert!(write.cleanup.cleanup_pending());
        assert_eq!(completed(&write.cleanup).remaining, 1);
        // The metadata commit stands, the new secret is bound, and the old one is still queued
        // instead of being lost or reported as cleaned.
        assert_eq!(
            write.profile.auth_state.credential_ref.as_ref(),
            Some(&second)
        );
        assert_eq!(
            fixture.store.secret(&second).as_deref(),
            Some("second-secret")
        );
        assert_eq!(
            fixture.store.secret(&first).as_deref(),
            Some("first-secret")
        );
        let queued = fixture
            .database
            .pending_credential_cleanup(8, MAX_CLEANUP_ATTEMPTS)
            .unwrap();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].reference, first);
        assert_eq!(queued[0].attempts, 1);

        fixture.store.delete_fault(None);
        let report = fixture
            .credentials()
            .run_pending_cleanup(CLEANUP_BATCH)
            .unwrap();
        assert_eq!(report.cleaned, 1);
        assert_eq!(report.remaining, 0);
        assert_eq!(fixture.store.secret(&first), None);
    }

    #[test]
    fn queued_references_survive_a_restart_and_recover_orphans() {
        let mut fixture = Fixture::new();
        let id = fixture.add("A", "https://a.test/es");
        fixture
            .credentials()
            .bind(&id, AuthKind::Basic, secret("kept-secret"))
            .unwrap();
        let bound = fixture.reference(&id);

        // Crash between the keyring write and the bind: the secret exists but nothing owns it.
        let orphan = CredentialRef::generate();
        fixture
            .database
            .queue_credential_cleanup(&orphan, CleanupReason::Prepare)
            .unwrap();
        fixture
            .store
            .set(&orphan, &secret("orphan-secret"))
            .unwrap();
        // Crash before the keyring write: a record without a secret, which must stay idempotent.
        let never_written = CredentialRef::generate();
        fixture
            .database
            .queue_credential_cleanup(&never_written, CleanupReason::Prepare)
            .unwrap();

        // New process: reopen the same file and drain the queue.
        let Fixture {
            temp: _temp,
            database,
            store,
        } = fixture;
        let path = _temp.path().join("escope.sqlite");
        drop(database);
        let mut database = Database::open(&path).unwrap();
        assert_eq!(database.pending_credential_cleanup_count().unwrap(), 2);
        let mut credentials = ConnectionCredentials::new(&mut database, &store);
        let report = credentials.run_pending_cleanup(CLEANUP_BATCH).unwrap();
        assert_eq!(report.cleaned, 2);
        assert_eq!(report.remaining, 0);
        assert_eq!(store.secret(&orphan), None);
        assert_eq!(store.secret(&never_written), None);
        // The credential that is still bound was never touched.
        assert_eq!(store.secret(&bound).as_deref(), Some("kept-secret"));
        assert_eq!(
            database
                .connection_auth(&id)
                .unwrap()
                .credential_ref
                .as_ref(),
            Some(&bound)
        );
    }

    #[test]
    fn a_reference_still_in_use_is_never_deleted_and_cleanup_stays_scoped_to_its_connection() {
        let mut fixture = Fixture::new();
        let a = fixture.add("A", "https://a.test/es");
        let b = fixture.add("B", "https://b.test/es");
        fixture
            .credentials()
            .bind(&a, AuthKind::Basic, secret("a-secret"))
            .unwrap();
        fixture
            .credentials()
            .bind(&b, AuthKind::ApiKey, secret("b-secret"))
            .unwrap();
        let a_ref = fixture.reference(&a);
        let b_ref = fixture.reference(&b);
        assert_ne!(a_ref, b_ref);

        // A stale queue entry for a reference that is still bound must not delete the secret.
        fixture
            .database
            .queue_credential_cleanup(&a_ref, CleanupReason::Cleanup)
            .unwrap();
        let report = fixture
            .credentials()
            .run_pending_cleanup(CLEANUP_BATCH)
            .unwrap();
        assert_eq!(report.deferred, 1);
        assert_eq!(report.cleaned, 0);
        assert_eq!(report.remaining, 1);
        assert_eq!(fixture.store.secret(&a_ref).as_deref(), Some("a-secret"));

        // Deleting one connection removes only the reference resolved from its own row.
        fixture.credentials().delete(&b).unwrap();
        assert_eq!(fixture.store.secret(&b_ref), None);
        assert_eq!(fixture.store.secret(&a_ref).as_deref(), Some("a-secret"));
        assert_eq!(fixture.reference(&a), a_ref);
        assert_eq!(
            fixture.store.refs("delete:"),
            vec![b_ref.as_str().to_owned()]
        );
    }

    #[test]
    fn unbind_and_endpoint_change_stop_using_the_old_secret() {
        let mut fixture = Fixture::new();
        let id = fixture.add("A", "https://a.test/es");
        fixture
            .credentials()
            .bind(&id, AuthKind::Basic, secret("first-secret"))
            .unwrap();
        let first = fixture.reference(&id);

        let write = fixture.credentials().unbind(&id).unwrap();
        assert_eq!(write.detached.as_ref(), Some(&first));
        assert!(write.profile.auth_state.unauthenticated());
        assert_eq!(completed(&write.cleanup).cleaned, 1);
        assert_eq!(fixture.store.secret(&first), None);
        assert_eq!(
            fixture.database.pending_credential_cleanup_count().unwrap(),
            0
        );
        // Unbinding again is idempotent and queues nothing.
        let write = fixture.credentials().unbind(&id).unwrap();
        assert!(write.detached.is_none());
        assert_eq!(
            fixture.store.refs("delete:"),
            vec![first.as_str().to_owned()]
        );

        fixture
            .credentials()
            .bind(&id, AuthKind::Bearer, secret("endpoint-secret"))
            .unwrap();
        let second = fixture.reference(&id);
        let write = fixture
            .credentials()
            .save(input("A", "https://moved.test/es"), Some(id.clone()))
            .unwrap();
        assert_eq!(write.detached.as_ref(), Some(&second));
        assert!(write.profile.auth_state.unauthenticated());
        assert_eq!(completed(&write.cleanup).cleaned, 1);
        // The credential captured for the old host is gone, so it cannot be sent to the new one.
        assert_eq!(fixture.store.secret(&second), None);
        assert_eq!(
            fixture.database.pending_credential_cleanup_count().unwrap(),
            0
        );
        assert_eq!(fixture.store.refs("set:").len(), 2);
    }

    #[test]
    fn rename_preserves_the_id_the_reference_and_the_secret() {
        let mut fixture = Fixture::new();
        let id = fixture.add("A", "https://a.test/es");
        fixture
            .credentials()
            .bind(&id, AuthKind::ApiKey, secret("api-key-secret"))
            .unwrap();
        let reference = fixture.reference(&id);
        let events = fixture.store.events().len();

        let write = fixture
            .credentials()
            .save(input("Renamed", "https://a.test/es"), Some(id.clone()))
            .unwrap();
        assert_eq!(write.profile.id, id);
        assert_eq!(write.profile.display_name, "Renamed");
        assert!(write.detached.is_none());
        assert_eq!(write.profile.auth_state.kind, AuthKind::ApiKey);
        assert_eq!(
            write.profile.auth_state.credential_ref.as_ref(),
            Some(&reference)
        );
        assert_eq!(
            fixture.store.secret(&reference).as_deref(),
            Some("api-key-secret")
        );
        // A rename causes no credential traffic at all.
        assert_eq!(fixture.store.events().len(), events);
        assert_eq!(
            fixture.database.pending_credential_cleanup_count().unwrap(),
            0
        );
    }

    #[test]
    fn no_secret_bytes_reach_the_database_file() {
        const MARKER: &str = "escope-f08-2-secret-marker";
        let mut fixture = Fixture::new();
        let id = fixture.add("A", "https://a.test/es");
        let write = fixture
            .credentials()
            .bind(&id, AuthKind::Bearer, secret(MARKER))
            .unwrap();
        let reference = write.profile.auth_state.credential_ref.clone().unwrap();

        // The secret really was stored, so this is not a "nothing was written" result.
        assert_eq!(fixture.store.secret(&reference).as_deref(), Some(MARKER));
        let Fixture {
            temp: _temp,
            database,
            store,
        } = fixture;
        let path = _temp.path().join("escope.sqlite");
        drop(database);
        assert_eq!(store.secret(&reference).as_deref(), Some(MARKER));
        let bytes = std::fs::read(&path).unwrap();
        assert!(
            !bytes
                .windows(MARKER.len())
                .any(|window| window == MARKER.as_bytes()),
            "the secret must never be persisted in SQLite"
        );
        // Only the reference is stored, as an opaque identifier.
        assert!(bytes
            .windows(reference.as_str().len())
            .any(|window| window == reference.as_str().as_bytes()));
    }

    #[test]
    fn cleanup_retries_are_bounded_and_abandoned_entries_are_reported_not_dropped() {
        let mut fixture = Fixture::new();
        let id = fixture.add("A", "https://a.test/es");
        fixture
            .credentials()
            .bind(&id, AuthKind::Basic, secret("first-secret"))
            .unwrap();
        let first = fixture.reference(&id);
        fixture
            .store
            .delete_fault(Some(CredentialError::Unavailable));

        // The rotation commits, but the queued old reference cannot be deleted yet.
        fixture
            .credentials()
            .bind(&id, AuthKind::Bearer, secret("second-secret"))
            .unwrap();
        for _ in 1..MAX_CLEANUP_ATTEMPTS {
            fixture
                .credentials()
                .run_pending_cleanup(CLEANUP_BATCH)
                .unwrap();
        }
        let report = fixture
            .credentials()
            .run_pending_cleanup(CLEANUP_BATCH)
            .unwrap();
        assert_eq!(report.attempted, 0);
        assert_eq!(report.abandoned, 1);
        assert_eq!(report.remaining, 1);
        assert!(report.cleanup_pending());
        // Giving up on retries never deletes or forgets the secret.
        assert_eq!(
            fixture.store.secret(&first).as_deref(),
            Some("first-secret")
        );
        assert_eq!(
            fixture.database.pending_credential_cleanup_count().unwrap(),
            1
        );
        // The entry is no longer processable, and stays counted instead of being dropped.
        assert!(fixture
            .database
            .pending_credential_cleanup(8, MAX_CLEANUP_ATTEMPTS)
            .unwrap()
            .is_empty());
        let backlog = fixture
            .database
            .credential_cleanup_backlog(MAX_CLEANUP_ATTEMPTS)
            .unwrap();
        assert_eq!(backlog.abandoned, 1);
        assert_eq!(backlog.deferred, 0);
        assert_eq!(backlog.total, 1);
    }

    #[test]
    fn post_commit_bookkeeping_failure_reports_committed_with_pending_cleanup() {
        let mut fixture = Fixture::new();
        let id = fixture.add("A", "https://a.test/es");
        fixture
            .credentials()
            .bind(&id, AuthKind::Basic, secret("first-secret"))
            .unwrap();
        let first = fixture.reference(&id);
        // The keyring deletion fails and the retry counter cannot be written either.
        fixture
            .store
            .delete_fault(Some(CredentialError::Unavailable));
        fixture
            .database
            .run_sql_for_test(
                "CREATE TRIGGER fail_attempt BEFORE UPDATE ON credential_cleanup BEGIN SELECT RAISE(ABORT, 'forced'); END",
            )
            .unwrap();

        let write = fixture
            .credentials()
            .bind(&id, AuthKind::Bearer, secret("second-secret"))
            .unwrap();
        let second = fixture.reference(&id);
        assert_ne!(second, first);
        // The write committed: the new binding and its secret are in place.
        assert_eq!(
            write.profile.auth_state.credential_ref.as_ref(),
            Some(&second)
        );
        assert_eq!(
            fixture.store.secret(&second).as_deref(),
            Some("second-secret")
        );
        // The cleanup could not be accounted for, so it is reported as unknown and pending, never
        // as a clean success and never as a failed write.
        assert!(write.cleanup.is_incomplete());
        assert!(write.cleanup.cleanup_pending());
        assert_eq!(write.cleanup.report(), None);
        assert_eq!(
            fixture.store.secret(&first).as_deref(),
            Some("first-secret")
        );
        assert_eq!(
            fixture.database.pending_credential_cleanup_count().unwrap(),
            1
        );

        // Recovery: with the store and the counter working again, the next pass finishes the job.
        fixture
            .database
            .run_sql_for_test("DROP TRIGGER fail_attempt")
            .unwrap();
        fixture.store.delete_fault(None);
        let report = fixture
            .credentials()
            .run_pending_cleanup(CLEANUP_BATCH)
            .unwrap();
        assert_eq!(report.cleaned, 1);
        assert_eq!(report.remaining, 0);
        assert_eq!(fixture.store.secret(&first), None);
    }

    #[test]
    fn post_commit_queue_removal_failure_stays_pending_and_recovers_idempotently() {
        let mut fixture = Fixture::new();
        let id = fixture.add("A", "https://a.test/es");
        fixture
            .credentials()
            .bind(&id, AuthKind::Basic, secret("first-secret"))
            .unwrap();
        let first = fixture.reference(&id);
        // Only the removal of the old reference's record fails; the prepare entry is unaffected.
        fixture
            .database
            .run_sql_for_test(&format!(
                "CREATE TRIGGER fail_cancel BEFORE DELETE ON credential_cleanup WHEN old.reference='{first}' BEGIN SELECT RAISE(ABORT, 'forced'); END"
            ))
            .unwrap();

        let write = fixture
            .credentials()
            .bind(&id, AuthKind::Bearer, secret("second-secret"))
            .unwrap();
        assert!(write.cleanup.is_incomplete());
        assert!(write.cleanup.cleanup_pending());
        // The old secret is gone but its record could not be removed, so the state is pending
        // rather than reported as cleaned.
        assert_eq!(fixture.store.secret(&first), None);
        assert_eq!(
            fixture.database.pending_credential_cleanup_count().unwrap(),
            1
        );

        fixture
            .database
            .run_sql_for_test("DROP TRIGGER fail_cancel")
            .unwrap();
        let report = fixture
            .credentials()
            .run_pending_cleanup(CLEANUP_BATCH)
            .unwrap();
        assert_eq!(report.cleaned, 1);
        assert_eq!(report.remaining, 0);
    }

    #[test]
    fn a_stuck_head_never_starves_later_queue_entries() {
        let mut fixture = Fixture::new();
        let id = fixture.add("A", "https://a.test/es");
        fixture
            .credentials()
            .bind(&id, AuthKind::Basic, secret("bound-secret"))
            .unwrap();
        let bound = fixture.reference(&id);

        // Two older entries that exhausted their retry budget, plus one that is still referenced by
        // a connection: all three sit ahead of a processable entry in queue order.
        let mut abandoned = Vec::new();
        for _ in 0..2 {
            let reference = CredentialRef::generate();
            fixture
                .database
                .queue_credential_cleanup(&reference, CleanupReason::Cleanup)
                .unwrap();
            for _ in 0..MAX_CLEANUP_ATTEMPTS {
                fixture.database.record_cleanup_attempt(&reference).unwrap();
            }
            abandoned.push(reference);
        }
        fixture
            .database
            .queue_credential_cleanup(&bound, CleanupReason::Cleanup)
            .unwrap();
        let processable = CredentialRef::generate();
        fixture
            .database
            .queue_credential_cleanup(&processable, CleanupReason::Cleanup)
            .unwrap();

        let report = fixture.credentials().run_pending_cleanup(1).unwrap();
        assert_eq!(report.attempted, 1);
        assert_eq!(report.cleaned, 1);
        assert_eq!(report.abandoned, 2);
        assert_eq!(report.deferred, 1);
        assert_eq!(report.remaining, 3);
        // The skipped entries are still counted and still in the queue.
        let backlog = fixture
            .database
            .credential_cleanup_backlog(MAX_CLEANUP_ATTEMPTS)
            .unwrap();
        assert_eq!(backlog.total, 3);
        assert_eq!(backlog.abandoned, 2);
        assert_eq!(backlog.deferred, 1);
        assert_eq!(
            fixture.database.pending_credential_cleanup_count().unwrap(),
            3
        );
        // Nothing that is still referenced was deleted.
        assert_eq!(
            fixture.store.secret(&bound).as_deref(),
            Some("bound-secret")
        );
        // The referenced credential is still bound, so its record is still in use.
        assert_eq!(fixture.reference(&id), bound);
    }

    #[test]
    fn cleanup_processes_a_bounded_batch_per_call() {
        let mut fixture = Fixture::new();
        for _ in 0..3 {
            let reference = CredentialRef::generate();
            fixture
                .database
                .queue_credential_cleanup(&reference, CleanupReason::Cleanup)
                .unwrap();
        }
        let report = fixture.credentials().run_pending_cleanup(2).unwrap();
        assert_eq!(report.cleaned, 2);
        assert_eq!(report.remaining, 1);
        let report = fixture.credentials().run_pending_cleanup(2).unwrap();
        assert_eq!(report.cleaned, 1);
        assert_eq!(report.remaining, 0);

        // A caller cannot request unbounded work: the backend clamps the batch.
        for _ in 0..(MAX_CLEANUP_BATCH + 2) {
            let reference = CredentialRef::generate();
            fixture
                .database
                .queue_credential_cleanup(&reference, CleanupReason::Cleanup)
                .unwrap();
        }
        let report = fixture
            .credentials()
            .run_pending_cleanup(usize::MAX)
            .unwrap();
        assert_eq!(report.attempted, MAX_CLEANUP_BATCH);
        assert_eq!(report.cleaned, MAX_CLEANUP_BATCH);
        assert_eq!(report.remaining, 2);
    }

    #[test]
    fn production_composition_handles_connections_without_credentials() {
        // The exact composition the IPC commands use, including the real OS store adapter. No
        // credential is bound here, so the queue stays empty and the OS store is never called: a
        // credential-less save must work even where no store adapter exists at all.
        let temp = tempfile::tempdir().unwrap();
        let mut database = Database::open(&temp.path().join("escope.sqlite")).unwrap();
        let store = crate::credentials::SystemCredentialStore::new();
        let id;
        {
            let mut credentials = ConnectionCredentials::new(&mut database, &store);
            let saved = credentials
                .save(input("A", "https://a.test/es"), None)
                .unwrap();
            id = saved.profile.id.clone();
            assert_eq!(completed(&saved.cleanup), &CleanupReport::default());
            assert!(saved.detached.is_none());

            let renamed = credentials
                .save(input("B", "https://a.test/es"), Some(id.clone()))
                .unwrap();
            assert_eq!(renamed.profile.display_name, "B");
            assert_eq!(renamed.profile.id, id);
            assert!(renamed.profile.auth_state.unauthenticated());

            let moved = credentials
                .save(input("B", "https://moved.test/es"), Some(id.clone()))
                .unwrap();
            assert!(moved.detached.is_none());
            assert_eq!(completed(&moved.cleanup).remaining, 0);

            credentials.delete(&id).unwrap();
        }
        assert_eq!(database.pending_credential_cleanup_count().unwrap(), 0);
        assert_eq!(database.connection(&id).unwrap_err().code, "notFound");
    }

    #[test]
    fn bind_and_detach_require_a_stored_connection_and_a_real_auth_kind() {
        let mut fixture = Fixture::new();
        let id = fixture.add("A", "https://a.test/es");
        let missing = uuid::Uuid::new_v4().to_string();

        assert_eq!(
            fixture
                .credentials()
                .bind("not-a-uuid", AuthKind::Basic, secret("value"))
                .unwrap_err()
                .code,
            "invalidInput"
        );
        assert_eq!(
            fixture
                .credentials()
                .bind(&missing, AuthKind::Basic, secret("value"))
                .unwrap_err()
                .code,
            "notFound"
        );
        assert_eq!(
            fixture
                .credentials()
                .bind(&id, AuthKind::None, secret("value"))
                .unwrap_err()
                .code,
            "invalidInput"
        );
        assert_eq!(
            fixture.credentials().unbind(&missing).unwrap_err().code,
            "notFound"
        );
        assert_eq!(
            fixture.credentials().delete(&missing).unwrap_err().code,
            "notFound"
        );
        assert!(fixture.store.events().is_empty());
        assert_eq!(
            fixture.database.pending_credential_cleanup_count().unwrap(),
            0
        );

        for kind in [AuthKind::Basic, AuthKind::ApiKey, AuthKind::Bearer] {
            fixture
                .credentials()
                .bind(&id, kind, secret("value"))
                .unwrap();
            assert_eq!(fixture.database.connection_auth(&id).unwrap().kind, kind);
        }
        assert_eq!(
            [
                AuthKind::None,
                AuthKind::Basic,
                AuthKind::ApiKey,
                AuthKind::Bearer
            ]
            .map(AuthKind::as_str),
            ["none", "basic", "apiKey", "bearer"]
        );
    }
}
