//! Model credential lifecycle (A01.2/A02.3).
//!
//! This module is the only place that combines trusted model metadata with the OS credential
//! store, reusing the shared outbox helpers from [`crate::connection_credentials`]. The order is
//! the same one that keeps a crash from either leaking or losing a secret:
//!
//! 1. **Validate** — metadata, identity and bounds are checked before any keyring side effect.
//! 2. **Prepare** — a freshly generated reference is queued *before* the keyring is touched, so a
//!    crash between the keyring write and the bind still leaves the orphan accounted for.
//! 3. **Write** — the new secret is written under its own reference. An existing secret is never
//!    overwritten in place, so a failed bind cannot destroy a working credential.
//! 4. **Bind** — metadata and reference change happen in one SQLite transaction; the previous
//!    reference is queued in the same commit. Only after that commit is a deletion attempted.
//!
//! Target rules: renaming or changing the model id keeps the credential; changing the endpoint or
//! the protocol detaches it unless the caller supplies a replacement, because the old secret was
//! captured for the old target. A detached secret is deleted after the commit; if that deletion
//! fails (or the pass cannot be accounted for), the committed profile is still returned and the
//! queued record stays for the bounded retry behind `models_cleanup`.
//!
//! The secret itself never reaches SQLite, IPC, a log line or an error: rows carry a reference,
//! values live in the OS store, and every failure maps to a stable sanitized code.

use crate::connection_credentials::{
    cleanup_after_commit, discard_unbound_secret, run_cleanup_pass, CleanupPass, CLEANUP_BATCH,
};
use crate::credentials::{CredentialError, CredentialRef, CredentialStore};
use crate::error::AppError;
use crate::model_api_key::OneShotApiKey;
use crate::storage::{CleanupReason, Database, ModelInput, ModelProfile, ModelReferenceChange};
use reqwest::header::HeaderValue;
use serde::{Deserialize, Deserializer};

/// How one save call changes the profile's stored credential. Omitted on the wire means `Keep`.
#[derive(Debug, Default)]
pub(crate) enum ModelCredentialChange {
    #[default]
    Keep,
    Clear,
    Replace(OneShotApiKey),
}

/// The wire spelling of one credential change. A raw struct keeps `deny_unknown_fields` exact:
/// serde cannot deny unknown fields on internally tagged enums, and a stray key must never be
/// silently dropped from a payload that carries a secret.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawCredentialChange {
    kind: String,
    #[serde(default)]
    api_key: Option<OneShotApiKey>,
}

impl<'de> Deserialize<'de> for ModelCredentialChange {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = RawCredentialChange::deserialize(deserializer)?;
        match (raw.kind.as_str(), raw.api_key) {
            ("keep", None) => Ok(Self::Keep),
            ("clear", None) => Ok(Self::Clear),
            ("replace", Some(key)) => Ok(Self::Replace(key)),
            // Static message: a refused payload must never echo the credential (or its absence).
            _ => Err(serde::de::Error::custom("invalid credential change")),
        }
    }
}

/// Result of one model write: the committed profile, the reference it detached (already queued),
/// and what the post-commit cleanup pass could account for.
#[derive(Debug)]
pub struct ModelWrite {
    pub profile: ModelProfile,
    pub detached: Option<CredentialRef>,
    pub cleanup: CleanupPass,
}

/// Result of deleting one model profile.
#[derive(Debug)]
pub struct ModelDelete {
    /// Credential detached by the deletion, already queued for deletion.
    pub detached: Option<CredentialRef>,
    pub cleanup: CleanupPass,
}

/// Map a store failure while reading a saved credential. Stable codes only: an unavailable or
/// missing key is never turned into an unauthenticated request or a plaintext fallback.
pub(crate) fn stored_secret_error(error: CredentialError) -> AppError {
    AppError::new(match error {
        CredentialError::NotFound => "credentialNotFound",
        CredentialError::Unavailable => "credentialUnavailable",
        CredentialError::StorageFailure => "credentialFailure",
        CredentialError::InvalidSecret | CredentialError::InvalidReference => "credentialFailure",
    })
}

/// Resolve one stored model credential into its sensitive bearer header. The reference comes from
/// the trusted saved row; nothing here is caller-supplied, and the secret is not retained.
pub(crate) fn stored_bearer_header(
    store: &dyn CredentialStore,
    reference: &CredentialRef,
) -> Result<HeaderValue, AppError> {
    let secret = store.get(reference).map_err(stored_secret_error)?;
    crate::model_api_key::validate_secret(&secret)
        .map_err(|_| AppError::new("credentialFailure"))?;
    crate::model_api_key::bearer_header(&secret).map_err(|_| AppError::new("credentialFailure"))
}

/// Credential-aware model saves over one database handle and one injectable credential store.
pub(crate) struct ModelCredentials<'a> {
    database: &'a mut Database,
    store: &'a dyn CredentialStore,
}

impl<'a> ModelCredentials<'a> {
    pub(crate) fn new(database: &'a mut Database, store: &'a dyn CredentialStore) -> Self {
        Self { database, store }
    }

    /// Create or update one profile and apply the credential change in the same commit.
    pub(crate) fn save(
        &mut self,
        input: ModelInput,
        id: Option<String>,
        change: ModelCredentialChange,
    ) -> Result<ModelWrite, AppError> {
        // Metadata, identity and bounds before any keyring side effect; the write transaction
        // repeats every check, so this only narrows the window in which a rejected request could
        // have touched the OS store.
        self.database.model_save_precheck(&input, id.as_deref())?;
        match change {
            ModelCredentialChange::Keep => {
                let record =
                    self.database
                        .save_model_record(input, id, ModelReferenceChange::Keep)?;
                Ok(self.finish(record))
            }
            ModelCredentialChange::Clear => {
                let record =
                    self.database
                        .save_model_record(input, id, ModelReferenceChange::Clear)?;
                Ok(self.finish(record))
            }
            ModelCredentialChange::Replace(key) => {
                let reference = CredentialRef::generate();
                // Persist the intent before the keyring write: a crash before the bind commits
                // leaves a prepare entry, and the cleanup pass then deletes the orphan.
                self.database
                    .queue_credential_cleanup(&reference, CleanupReason::Prepare)?;
                if let Err(error) = self.store.set(&reference, key.secret()) {
                    // The write may or may not have landed, so the reference stays accounted for.
                    discard_unbound_secret(self.database, self.store, &reference);
                    return Err(AppError::from(error));
                }
                // From here the secret lives in the OS store only.
                drop(key);
                match self.database.save_model_record(
                    input,
                    id,
                    ModelReferenceChange::Replace(&reference),
                ) {
                    Ok(record) => Ok(self.finish(record)),
                    Err(error) => {
                        // The bind did not commit, so the new secret must not survive it.
                        discard_unbound_secret(self.database, self.store, &reference);
                        Err(error)
                    }
                }
            }
        }
    }

    /// Delete one profile: its metadata, the default repair and the queued reference commit
    /// together; the keyring deletion is attempted afterwards.
    pub(crate) fn delete(&mut self, id: &str) -> Result<ModelDelete, AppError> {
        let detached = self.database.delete_model_record(id)?;
        let cleanup = cleanup_after_commit(self.database, self.store, CLEANUP_BATCH);
        Ok(ModelDelete { detached, cleanup })
    }

    /// One bounded cleanup pass for the settings page. `true` only when nothing is left queued;
    /// `false` keeps the warning, and an account failure is a structured error, never a silent
    /// "all clean".
    pub(crate) fn cleanup(&mut self) -> Result<bool, AppError> {
        let report = run_cleanup_pass(self.database, self.store, CLEANUP_BATCH)?;
        Ok(!report.cleanup_pending())
    }

    fn finish(&mut self, record: crate::storage::ModelRecord) -> ModelWrite {
        let cleanup = cleanup_after_commit(self.database, self.store, CLEANUP_BATCH);
        ModelWrite {
            profile: record.profile,
            detached: record.detached,
            cleanup,
        }
    }
}

/// Test-only in-memory credential store with per-operation fault injection. Never constructible
/// from production code and never a production fallback.
#[cfg(test)]
pub(crate) mod test_store {
    use crate::credentials::{CredentialError, CredentialRef, CredentialStore, Secret};
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    pub(crate) struct Faults {
        pub write: Option<CredentialError>,
        pub read: Option<CredentialError>,
        pub delete: Option<CredentialError>,
    }

    /// Shared handle so a test can keep inspecting the store after handing a boxed clone to the
    /// production state types.
    #[derive(Default, Clone)]
    pub(crate) struct TestCredentialStore {
        entries: Arc<Mutex<HashMap<String, Vec<u8>>>>,
        faults: Arc<Mutex<Faults>>,
    }

    impl TestCredentialStore {
        pub(crate) fn new() -> Self {
            Self::default()
        }

        pub(crate) fn set_faults(&self, faults: Faults) {
            *self.faults.lock().unwrap() = faults;
        }

        pub(crate) fn contains(&self, reference: &CredentialRef) -> bool {
            self.entries
                .lock()
                .unwrap()
                .contains_key(reference.as_str())
        }

        pub(crate) fn is_empty(&self) -> bool {
            self.entries.lock().unwrap().is_empty()
        }

        pub(crate) fn len(&self) -> usize {
            self.entries.lock().unwrap().len()
        }
    }

    impl CredentialStore for TestCredentialStore {
        fn set(&self, reference: &CredentialRef, secret: &Secret) -> Result<(), CredentialError> {
            if let Some(fault) = self.faults.lock().unwrap().write {
                return Err(fault);
            }
            self.entries.lock().unwrap().insert(
                reference.as_str().to_owned(),
                secret.expose_secret().to_vec(),
            );
            Ok(())
        }

        fn get(&self, reference: &CredentialRef) -> Result<Secret, CredentialError> {
            if let Some(fault) = self.faults.lock().unwrap().read {
                return Err(fault);
            }
            let bytes = self
                .entries
                .lock()
                .unwrap()
                .get(reference.as_str())
                .cloned()
                .ok_or(CredentialError::NotFound)?;
            Secret::new(bytes)
        }

        fn delete(&self, reference: &CredentialRef) -> Result<(), CredentialError> {
            if let Some(fault) = self.faults.lock().unwrap().delete {
                return Err(fault);
            }
            self.entries.lock().unwrap().remove(reference.as_str());
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_store::{Faults, TestCredentialStore};
    use super::*;
    use crate::connection_credentials::MAX_CLEANUP_ATTEMPTS;
    use crate::storage::ModelProtocol;
    use std::path::Path;

    const FIXTURE_KEY: &str = "fixture-model-key-0001";

    fn input(name: &str, endpoint: &str) -> ModelInput {
        ModelInput {
            display_name: name.into(),
            protocol: ModelProtocol::Ollama,
            endpoint: endpoint.into(),
            model_id: "llama3.1:8b".into(),
        }
    }

    fn replace(bytes: &str) -> ModelCredentialChange {
        ModelCredentialChange::Replace(
            OneShotApiKey::new(bytes.as_bytes().to_vec()).expect("fixture key must be valid"),
        )
    }

    /// Create a profile with a stored key; returns the profile id and its reference.
    fn seeded(database: &mut Database, store: &TestCredentialStore) -> (String, CredentialRef) {
        let write = ModelCredentials::new(database, store)
            .save(
                input("Local", "http://127.0.0.1:11434"),
                None,
                replace(FIXTURE_KEY),
            )
            .unwrap();
        assert!(write.profile.has_api_key);
        let reference = write.profile.credential_ref.clone().unwrap();
        (write.profile.id, reference)
    }

    #[test]
    fn create_keep_replace_clear_and_target_change_never_share_a_key() {
        let mut database = Database::open(Path::new(":memory:")).unwrap();
        let store = TestCredentialStore::new();
        let (id, first_reference) = seeded(&mut database, &store);
        assert!(store.contains(&first_reference));
        // The prepare entry was consumed by the bind itself.
        assert_eq!(database.pending_credential_cleanup_count().unwrap(), 0);
        assert!(!database.models().unwrap().credential_cleanup_pending);

        // Renaming keeps the identity, the credential and its reference.
        let renamed = ModelCredentials::new(&mut database, &store)
            .save(
                input("Renamed", "http://127.0.0.1:11434"),
                Some(id.clone()),
                ModelCredentialChange::Keep,
            )
            .unwrap();
        assert_eq!(renamed.profile.id, id);
        assert!(renamed.profile.has_api_key);
        assert_eq!(
            renamed.profile.credential_ref.as_ref(),
            Some(&first_reference)
        );
        assert!(store.contains(&first_reference));

        // Changing only the model id keeps it too.
        let mut renamed_input = input("Renamed", "http://127.0.0.1:11434");
        renamed_input.model_id = "qwen2.5:7b".into();
        let changed_model = ModelCredentials::new(&mut database, &store)
            .save(renamed_input, Some(id.clone()), ModelCredentialChange::Keep)
            .unwrap();
        assert!(changed_model.profile.has_api_key);

        // Replacing binds a fresh reference and deletes the old secret.
        let replaced = ModelCredentials::new(&mut database, &store)
            .save(
                input("Renamed", "http://127.0.0.1:11434"),
                Some(id.clone()),
                replace("fixture-model-key-0002"),
            )
            .unwrap();
        assert_eq!(replaced.detached.as_ref(), Some(&first_reference));
        let second_reference = replaced.profile.credential_ref.clone().unwrap();
        assert_ne!(second_reference, first_reference);
        assert!(!store.contains(&first_reference));
        assert!(store.contains(&second_reference));
        assert_eq!(database.pending_credential_cleanup_count().unwrap(), 0);
        assert!(!database.models().unwrap().credential_cleanup_pending);

        // Changing the endpoint detaches the credential instead of reusing it at a new target.
        let moved = ModelCredentials::new(&mut database, &store)
            .save(
                input("Renamed", "http://127.0.0.1:9999"),
                Some(id.clone()),
                ModelCredentialChange::Keep,
            )
            .unwrap();
        assert!(!moved.profile.has_api_key);
        assert_eq!(moved.detached.as_ref(), Some(&second_reference));
        assert!(!store.contains(&second_reference));
        assert_eq!(database.pending_credential_cleanup_count().unwrap(), 0);

        // A protocol change does the same, and an explicit clear only detaches.
        let bound_again = ModelCredentials::new(&mut database, &store)
            .save(
                input("Renamed", "http://127.0.0.1:9999"),
                Some(id.clone()),
                replace("fixture-model-key-0003"),
            )
            .unwrap();
        let third_reference = bound_again.profile.credential_ref.clone().unwrap();
        let protocol_switch = ModelCredentials::new(&mut database, &store)
            .save(
                ModelInput {
                    display_name: "Renamed".into(),
                    protocol: ModelProtocol::OpenaiCompatible,
                    endpoint: "http://127.0.0.1:9999".into(),
                    model_id: "qwen2.5:7b".into(),
                },
                Some(id.clone()),
                ModelCredentialChange::Keep,
            )
            .unwrap();
        assert_eq!(protocol_switch.detached.as_ref(), Some(&third_reference));
        assert!(!protocol_switch.profile.has_api_key);
        assert!(!store.contains(&third_reference));

        let bound_again = ModelCredentials::new(&mut database, &store)
            .save(
                ModelInput {
                    display_name: "Renamed".into(),
                    protocol: ModelProtocol::OpenaiCompatible,
                    endpoint: "http://127.0.0.1:9999".into(),
                    model_id: "qwen2.5:7b".into(),
                },
                Some(id.clone()),
                replace("fixture-model-key-0004"),
            )
            .unwrap();
        let fourth_reference = bound_again.profile.credential_ref.clone().unwrap();
        let cleared = ModelCredentials::new(&mut database, &store)
            .save(
                ModelInput {
                    display_name: "Renamed".into(),
                    protocol: ModelProtocol::OpenaiCompatible,
                    endpoint: "http://127.0.0.1:9999".into(),
                    model_id: "qwen2.5:7b".into(),
                },
                Some(id.clone()),
                ModelCredentialChange::Clear,
            )
            .unwrap();
        assert!(!cleared.profile.has_api_key);
        assert_eq!(cleared.detached.as_ref(), Some(&fourth_reference));
        assert!(store.is_empty());
        assert_eq!(database.pending_credential_cleanup_count().unwrap(), 0);
    }

    #[test]
    fn failed_keyring_write_leaves_no_model_and_a_durable_orphan_record() {
        // Case A: the write fails and the store can still delete, so the reference is discarded.
        let mut database = Database::open(Path::new(":memory:")).unwrap();
        let store = TestCredentialStore::new();
        store.set_faults(Faults {
            write: Some(CredentialError::StorageFailure),
            ..Faults::default()
        });
        let error = ModelCredentials::new(&mut database, &store)
            .save(
                input("Local", "http://127.0.0.1:11434"),
                None,
                replace(FIXTURE_KEY),
            )
            .unwrap_err();
        assert_eq!(error.code, "credentialFailure");
        assert!(database.models().unwrap().profiles.is_empty());
        assert!(store.is_empty());
        assert_eq!(database.pending_credential_cleanup_count().unwrap(), 0);

        // Case B: the store cannot delete either, so the prepare record stays durable and the
        // settings page warns until a bounded cleanup pass can finish the job.
        let mut database = Database::open(Path::new(":memory:")).unwrap();
        let store = TestCredentialStore::new();
        store.set_faults(Faults {
            write: Some(CredentialError::StorageFailure),
            delete: Some(CredentialError::Unavailable),
            ..Faults::default()
        });
        let error = ModelCredentials::new(&mut database, &store)
            .save(
                input("Local", "http://127.0.0.1:11434"),
                None,
                replace(FIXTURE_KEY),
            )
            .unwrap_err();
        assert_eq!(error.code, "credentialFailure");
        assert!(database.models().unwrap().profiles.is_empty());
        assert_eq!(database.pending_credential_cleanup_count().unwrap(), 1);
        assert!(database.models().unwrap().credential_cleanup_pending);
        // A later bounded pass with a working store removes it.
        store.set_faults(Faults::default());
        let mut credentials = ModelCredentials::new(&mut database, &store);
        assert!(credentials.cleanup().unwrap());
        assert_eq!(database.pending_credential_cleanup_count().unwrap(), 0);

        // Metadata that cannot pass validation never reaches the keyring at all.
        let error = ModelCredentials::new(&mut database, &store)
            .save(
                input("   ", "http://127.0.0.1:11434"),
                None,
                replace(FIXTURE_KEY),
            )
            .unwrap_err();
        assert_eq!(error.code, "invalidName");
        assert!(store.is_empty());
        assert_eq!(database.pending_credential_cleanup_count().unwrap(), 0);
    }

    #[test]
    fn failed_sqlite_bind_discards_the_new_secret_and_keeps_the_old_metadata() {
        let mut database = Database::open(Path::new(":memory:")).unwrap();
        let store = TestCredentialStore::new();
        let (id, first_reference) = seeded(&mut database, &store);

        // An update that cannot commit must not replace the working credential.
        database
            .run_sql_for_test(
                "CREATE TRIGGER fail_model_update BEFORE UPDATE ON model_profiles
                 BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
            )
            .unwrap();
        let error = ModelCredentials::new(&mut database, &store)
            .save(
                input("Renamed", "http://127.0.0.1:11434"),
                Some(id.clone()),
                replace("fixture-model-key-9999"),
            )
            .unwrap_err();
        assert_eq!(error.code, "storageUnavailable");
        let stored = database.model_profile(&id).unwrap();
        assert_eq!(stored.display_name, "Local");
        assert_eq!(stored.credential_ref.as_ref(), Some(&first_reference));
        // The new secret was discarded with its prepare record; the old one is untouched.
        assert!(store.contains(&first_reference));
        assert_eq!(store.len(), 1);
        assert_eq!(database.pending_credential_cleanup_count().unwrap(), 0);

        // A create that cannot commit leaves no model and no secret.
        database
            .run_sql_for_test("DROP TRIGGER fail_model_update")
            .unwrap();
        database
            .run_sql_for_test(
                "CREATE TRIGGER fail_model_insert BEFORE INSERT ON model_profiles
                 BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
            )
            .unwrap();
        let error = ModelCredentials::new(&mut database, &store)
            .save(
                input("Second", "http://127.0.0.1:11434"),
                None,
                replace(FIXTURE_KEY),
            )
            .unwrap_err();
        assert_eq!(error.code, "storageUnavailable");
        assert_eq!(database.models().unwrap().profiles.len(), 1);
        assert_eq!(store.len(), 1);
        assert_eq!(database.pending_credential_cleanup_count().unwrap(), 0);
    }

    #[test]
    fn post_commit_cleanup_failure_returns_the_committed_profile_and_stays_pending() {
        let mut database = Database::open(Path::new(":memory:")).unwrap();
        let store = TestCredentialStore::new();
        let (id, first_reference) = seeded(&mut database, &store);

        store.set_faults(Faults {
            delete: Some(CredentialError::StorageFailure),
            ..Faults::default()
        });
        let cleared = ModelCredentials::new(&mut database, &store)
            .save(
                input("Local", "http://127.0.0.1:11434"),
                Some(id.clone()),
                ModelCredentialChange::Clear,
            )
            .unwrap();
        // The write is committed and reported as such; only the cleanup is incomplete.
        assert!(!cleared.profile.has_api_key);
        assert_eq!(cleared.detached.as_ref(), Some(&first_reference));
        assert!(cleared.cleanup.cleanup_pending());
        assert_eq!(
            database
                .pending_credential_cleanup(8, MAX_CLEANUP_ATTEMPTS)
                .unwrap()
                .len(),
            1
        );
        assert!(database.models().unwrap().credential_cleanup_pending);

        // A retry with a healthy store finishes the deletion and clears the warning.
        store.set_faults(Faults::default());
        let mut credentials = ModelCredentials::new(&mut database, &store);
        assert!(credentials.cleanup().unwrap());
        assert!(store.is_empty());
        assert!(!database.models().unwrap().credential_cleanup_pending);
    }

    #[test]
    fn delete_queues_the_reference_and_a_late_cleanup_retries_it() {
        let mut database = Database::open(Path::new(":memory:")).unwrap();
        let store = TestCredentialStore::new();
        let (id, reference) = seeded(&mut database, &store);

        store.set_faults(Faults {
            delete: Some(CredentialError::Unavailable),
            ..Faults::default()
        });
        let deleted = ModelCredentials::new(&mut database, &store)
            .delete(&id)
            .unwrap();
        assert_eq!(deleted.detached.as_ref(), Some(&reference));
        assert!(deleted.cleanup.cleanup_pending());
        assert!(database.models().unwrap().profiles.is_empty());
        assert!(database.models().unwrap().credential_cleanup_pending);

        store.set_faults(Faults::default());
        let mut credentials = ModelCredentials::new(&mut database, &store);
        assert!(credentials.cleanup().unwrap());
        assert!(!store.contains(&reference));
        assert_eq!(database.pending_credential_cleanup_count().unwrap(), 0);
    }

    #[test]
    fn queued_references_bound_to_a_model_or_connection_are_never_deleted() {
        let mut database = Database::open(Path::new(":memory:")).unwrap();
        let store = TestCredentialStore::new();
        let (id, reference) = seeded(&mut database, &store);

        // A stale queue entry for a reference the model still uses must not delete it.
        database
            .queue_credential_cleanup(&reference, CleanupReason::Cleanup)
            .unwrap();
        let report =
            crate::connection_credentials::run_cleanup_pass(&mut database, &store, CLEANUP_BATCH)
                .unwrap();
        assert_eq!(report.cleaned, 0);
        assert_eq!(report.deferred, 1);
        assert_eq!(report.abandoned, 0);
        assert!(store.contains(&reference));
        assert_eq!(database.pending_credential_cleanup_count().unwrap(), 1);
        let backlog = database
            .credential_cleanup_backlog(MAX_CLEANUP_ATTEMPTS)
            .unwrap();
        assert_eq!(backlog.deferred, 1);
        assert_eq!(backlog.abandoned, 0);

        // A connection-bound reference is protected exactly the same way.
        let connection_reference = CredentialRef::generate();
        let connection_key = crate::credentials::Secret::new(b"connection-key".to_vec()).unwrap();
        store.set(&connection_reference, &connection_key).unwrap();
        database
            .queue_credential_cleanup(&connection_reference, CleanupReason::Prepare)
            .unwrap();
        database
            .run_sql_for_test(&format!(
                "INSERT INTO connections(id, display_name, endpoint, environment, sort_order, auth_kind, credential_ref)
                 VALUES ('{}','Legacy','http://127.0.0.1:9200','development',0,'bearer','{}')",
                uuid::Uuid::new_v4(),
                connection_reference.as_str()
            ))
            .unwrap();
        let report =
            crate::connection_credentials::run_cleanup_pass(&mut database, &store, CLEANUP_BATCH)
                .unwrap();
        assert_eq!(report.cleaned, 0);
        assert_eq!(report.deferred, 2);
        assert!(store.contains(&connection_reference));

        // Once no model and no connection references a key, the same pass deletes both.
        database
            .run_sql_for_test("DELETE FROM connections")
            .unwrap();
        database
            .run_sql_for_test(&format!(
                "UPDATE model_profiles SET credential_ref=NULL WHERE id='{id}'"
            ))
            .unwrap();
        let report =
            crate::connection_credentials::run_cleanup_pass(&mut database, &store, CLEANUP_BATCH)
                .unwrap();
        assert_eq!(report.cleaned, 2);
        assert!(store.is_empty());
        assert_eq!(database.pending_credential_cleanup_count().unwrap(), 0);
    }

    #[test]
    fn secrets_never_reach_sqlite_bytes_public_output_or_errors() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("models.sqlite");
        let store = TestCredentialStore::new();
        {
            let mut database = Database::open(&path).unwrap();
            let write = ModelCredentials::new(&mut database, &store)
                .save(
                    input("Local", "http://127.0.0.1:11434"),
                    None,
                    replace(FIXTURE_KEY),
                )
                .unwrap();
            let state = database.models().unwrap();
            let serialized = serde_json::to_string(&state).unwrap();
            assert!(!serialized.contains(FIXTURE_KEY));
            assert!(!format!("{:?}", write.profile).contains(FIXTURE_KEY));
            assert!(!format!("{:?}", state).contains(FIXTURE_KEY));

            // Credential-shaped failures are static codes only.
            store.set_faults(Faults {
                read: Some(CredentialError::NotFound),
                ..Faults::default()
            });
            let error =
                stored_bearer_header(&store, write.profile.credential_ref.as_ref().unwrap())
                    .unwrap_err();
            assert_eq!(error.code, "credentialNotFound");
            assert!(!serde_json::to_string(&error).unwrap().contains(FIXTURE_KEY));
        }
        // The database file itself holds metadata and a reference, never the key.
        let bytes = std::fs::read(&path).unwrap();
        assert!(!bytes
            .windows(FIXTURE_KEY.len())
            .any(|window| window == FIXTURE_KEY.as_bytes()));
        // The injected store is where the value actually lives.
        assert!(store.len() == 1);
        // Reopening keeps the reference usable without re-entering the secret into SQLite.
        let database = Database::open(&path).unwrap();
        let profile = database
            .model_profile(&database.models().unwrap().profiles[0].id)
            .unwrap();
        assert!(profile.has_api_key);
        assert!(profile.credential_ref.is_some());
    }

    #[test]
    fn credential_change_payloads_are_closed_and_never_echo_the_key() {
        let keep: ModelCredentialChange = serde_json::from_str(r#"{"kind":"keep"}"#).unwrap();
        assert!(matches!(keep, ModelCredentialChange::Keep));
        let clear: ModelCredentialChange = serde_json::from_str(r#"{"kind":"clear"}"#).unwrap();
        assert!(matches!(clear, ModelCredentialChange::Clear));
        let replace: ModelCredentialChange =
            serde_json::from_str(r#"{"kind":"replace","apiKey":"fixture-model-key-0005"}"#)
                .unwrap();
        assert!(matches!(replace, ModelCredentialChange::Replace(_)));

        for payload in [
            r#"{"kind":"keep","apiKey":"fixture-model-key-0005"}"#,
            r#"{"kind":"clear","apiKey":"fixture-model-key-0005"}"#,
            r#"{"kind":"replace"}"#,
            r#"{"kind":"replace","apiKey":"has space"}"#,
            r#"{"kind":"wipe"}"#,
            r#"{"kind":"keep","extra":1}"#,
            r#"{}"#,
        ] {
            let result = serde_json::from_str::<ModelCredentialChange>(payload);
            assert!(result.is_err(), "must be refused: {payload}");
            let message = result.unwrap_err().to_string();
            assert!(!message.contains("fixture-model-key-0005"));
            assert!(!message.contains("has space"));
        }
    }
}
