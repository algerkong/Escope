//! OS credential store adapter (F08.1).
//!
//! Secrets live only in the operating system credential store. Callers address a secret
//! through the stable UUID [`CredentialRef`], and [`SERVICE`] restricts addressing to a fixed
//! application namespace.
//!
//! Scope and limits: read before wiring this into connection setup:
//! - Not integrated yet. SQLite still has no credential column and nothing in this crate
//!   persists a reference. Storing `credentialRef` next to a connection, resolving a
//!   reference back to its owning connection, and deleting a secret when its connection is
//!   deleted are F08.2 work; this module is only the storage primitive for that contract.
//! - The namespace is an addressing constraint, nothing more. A canonical UUID proves the
//!   reference is well formed, not that it belongs to the connection being edited, so F08.2
//!   must resolve ownership from the trusted database and must never accept a reference
//!   chosen by the frontend or by any other untrusted caller.
//!
//! Guarantees enforced here:
//! - no plaintext, in-memory or file fallback when the OS store is unavailable or fails;
//! - secrets are never `Serialize`d and never printed by `Debug`;
//! - an owned secret buffer is zeroized on every path, including rejected input;
//! - errors carry a stable sanitized code only, never the underlying keyring/OS error.
//!
//! Windows is the only implemented platform: [`SystemCredentialStore`] uses the maintained
//! `keyring` crate (Windows Credential Manager generic credentials, no hand-written FFI).
//! macOS/Linux adapters are not implemented and fail explicitly with
//! [`CredentialError::Unavailable`]. This module deliberately exposes no command that
//! returns a secret.

use crate::error::AppError;
use std::fmt;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

/// Fixed service namespace. Every stored item is `<SERVICE>/<credential-ref>`; a reference
/// outside this namespace is unreachable through [`CredentialStore`]. This only limits which
/// entries can be addressed, it does not authorize access to a specific connection's secret.
pub const SERVICE: &str = "com.escope.desktop.credentials";

/// Upper bound for one secret. Windows `CRED_MAX_CREDENTIAL_BLOB_SIZE` is 2560 bytes, so
/// 2048 keeps every secret accepted here storable by the OS backend.
pub const MAX_SECRET_BYTES: usize = 2048;

/// Sanitized credential error. Variants carry no payload, so no OS/keyring detail and no
/// secret can leak through `Debug`, `Display` or IPC.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialError {
    /// Reference is not a canonical UUID.
    InvalidReference,
    /// Secret is empty or larger than [`MAX_SECRET_BYTES`].
    InvalidSecret,
    /// No secret is stored for this reference.
    NotFound,
    /// The OS store could not be used at all: locked, denied by access rules, or no adapter
    /// on this platform. Never degraded to plaintext or memory storage.
    Unavailable,
    /// The OS store rejected or failed the call. Details are intentionally dropped.
    StorageFailure,
}

impl CredentialError {
    /// Stable sanitized code for IPC mapping. Underlying errors are never propagated.
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidReference | Self::InvalidSecret => "invalidInput",
            Self::NotFound => "notFound",
            Self::Unavailable => "credentialUnavailable",
            Self::StorageFailure => "credentialFailure",
        }
    }
}

impl fmt::Display for CredentialError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for CredentialError {}

impl From<CredentialError> for AppError {
    fn from(error: CredentialError) -> Self {
        AppError::new(error.code())
    }
}

/// Stable reference to one stored secret. `parse` only proves the value is a canonical UUID;
/// it says nothing about which connection owns it. F08.2 must read the reference from the
/// trusted connection row before calling [`CredentialStore`], never from frontend input.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct CredentialRef(String);

impl fmt::Debug for CredentialRef {
    /// The reference is an addressing identifier, not a secret, but it is never printed: it would
    /// let log output point at a stored credential.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("CredentialRef([REDACTED])")
    }
}

impl CredentialRef {
    /// Canonical reference for a new secret. The caller is responsible for persisting it and
    /// for never deriving it from a display name, endpoint or other user-supplied text.
    pub fn generate() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    /// Parse a persisted reference. Only canonical lowercase hyphenated UUIDs are accepted,
    /// so one credential cannot be addressed through two different spellings.
    pub fn parse(value: &str) -> Result<Self, CredentialError> {
        let parsed = Uuid::parse_str(value).map_err(|_| CredentialError::InvalidReference)?;
        if parsed.to_string() == value {
            Ok(Self(value.to_owned()))
        } else {
            Err(CredentialError::InvalidReference)
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for CredentialRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::str::FromStr for CredentialRef {
    type Err = CredentialError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

/// Opaque secret bytes: redacted `Debug`, zeroized on drop, not `Clone`, not `Serialize`.
pub struct Secret(Zeroizing<Vec<u8>>);

/// Erase rejected input explicitly; the production caller uses `Zeroizing` for accepted input.
fn adopt<B: AsRef<[u8]> + Zeroize>(mut bytes: B) -> Result<B, CredentialError> {
    let len = bytes.as_ref().len();
    if len == 0 || len > MAX_SECRET_BYTES {
        bytes.zeroize();
        return Err(CredentialError::InvalidSecret);
    }
    Ok(bytes)
}

impl Secret {
    /// Wrap raw secret bytes, rejecting empty and oversized values before the OS store is touched.
    pub fn new(bytes: impl Into<Vec<u8>>) -> Result<Self, CredentialError> {
        adopt(Zeroizing::new(bytes.into())).map(Self)
    }

    pub fn len(&self) -> usize {
        self.0.as_slice().len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.as_slice().is_empty()
    }

    /// Explicit accessor for transport code. Callers must never log, persist or forward these bytes.
    pub fn expose_secret(&self) -> &[u8] {
        self.0.as_slice()
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret([REDACTED])")
    }
}

/// Injectable credential backend used by connection orchestration (F08.2) and by tests.
/// Production code uses [`SystemCredentialStore`]; the in-memory fake exists only under
/// `#[cfg(test)]` and is unreachable from production paths.
pub trait CredentialStore: Send + Sync {
    /// Create or replace the secret for `reference`.
    fn set(&self, reference: &CredentialRef, secret: &Secret) -> Result<(), CredentialError>;

    /// Read the secret for `reference`, or [`CredentialError::NotFound`].
    fn get(&self, reference: &CredentialRef) -> Result<Secret, CredentialError>;

    /// Remove the secret for `reference`. Deleting an unknown reference succeeds (idempotent),
    /// so cleanup after a partially failed provisioning step cannot wedge.
    fn delete(&self, reference: &CredentialRef) -> Result<(), CredentialError>;
}

/// OS credential store adapter.
///
/// Windows: Windows Credential Manager via the `keyring` crate. Other platforms: no adapter
/// yet, every operation fails with [`CredentialError::Unavailable`] instead of storing a
/// secret somewhere weaker.
#[derive(Debug, Default)]
pub struct SystemCredentialStore;

impl SystemCredentialStore {
    pub fn new() -> Self {
        Self
    }
}

#[cfg(windows)]
impl CredentialStore for SystemCredentialStore {
    fn set(&self, reference: &CredentialRef, secret: &Secret) -> Result<(), CredentialError> {
        BackendStore(KeyringBackend).set(reference, secret)
    }

    fn get(&self, reference: &CredentialRef) -> Result<Secret, CredentialError> {
        BackendStore(KeyringBackend).get(reference)
    }

    fn delete(&self, reference: &CredentialRef) -> Result<(), CredentialError> {
        BackendStore(KeyringBackend).delete(reference)
    }
}

#[cfg(not(windows))]
impl CredentialStore for SystemCredentialStore {
    fn set(&self, _reference: &CredentialRef, _secret: &Secret) -> Result<(), CredentialError> {
        Err(CredentialError::Unavailable)
    }

    fn get(&self, _reference: &CredentialRef) -> Result<Secret, CredentialError> {
        Err(CredentialError::Unavailable)
    }

    fn delete(&self, _reference: &CredentialRef) -> Result<(), CredentialError> {
        Err(CredentialError::Unavailable)
    }
}

/// Minimal seam over the OS entry primitives, so the orchestration below (sanitized error
/// mapping, idempotent delete, rejection of a corrupt stored blob) is exercised with a
/// scripted backend instead of the real credential store.
#[cfg(windows)]
trait EntryBackend: Send + Sync {
    fn write(&self, reference: &CredentialRef, secret: &[u8]) -> Result<(), CredentialError>;
    fn read(&self, reference: &CredentialRef) -> Result<Vec<u8>, CredentialError>;
    fn remove(&self, reference: &CredentialRef) -> Result<(), CredentialError>;
}

/// Backend-parameterized orchestration. [`SystemCredentialStore`] instantiates it with the
/// keyring backend, tests with a scripted one, so both run the same production code path.
#[cfg(windows)]
struct BackendStore<B>(B);

#[cfg(windows)]
impl<B: EntryBackend> CredentialStore for BackendStore<B> {
    fn set(&self, reference: &CredentialRef, secret: &Secret) -> Result<(), CredentialError> {
        self.0.write(reference, secret.expose_secret())
    }

    fn get(&self, reference: &CredentialRef) -> Result<Secret, CredentialError> {
        let bytes = self.0.read(reference)?;
        // A blob outside our own bounds is a store failure, not user input, and is erased by `adopt`.
        Secret::new(bytes).map_err(|_| CredentialError::StorageFailure)
    }

    fn delete(&self, reference: &CredentialRef) -> Result<(), CredentialError> {
        // A missing entry is already the desired state, so cleanup stays idempotent.
        match self.0.remove(reference) {
            Ok(()) | Err(CredentialError::NotFound) => Ok(()),
            Err(error) => Err(error),
        }
    }
}

#[cfg(windows)]
struct KeyringBackend;

#[cfg(windows)]
impl EntryBackend for KeyringBackend {
    fn write(&self, reference: &CredentialRef, secret: &[u8]) -> Result<(), CredentialError> {
        entry(reference)?
            .set_secret(secret)
            .map_err(map_keyring_error)
    }

    fn read(&self, reference: &CredentialRef) -> Result<Vec<u8>, CredentialError> {
        entry(reference)?.get_secret().map_err(map_keyring_error)
    }

    fn remove(&self, reference: &CredentialRef) -> Result<(), CredentialError> {
        entry(reference)?
            .delete_credential()
            .map_err(map_keyring_error)
    }
}

#[cfg(windows)]
fn entry(reference: &CredentialRef) -> Result<keyring::Entry, CredentialError> {
    // The fixed service plus a validated reference is the only addressable namespace.
    keyring::Entry::new(SERVICE, reference.as_str()).map_err(map_keyring_error)
}

#[cfg(windows)]
fn map_keyring_error(error: keyring::Error) -> CredentialError {
    // The keyring error is dropped without formatting: it can carry OS paths and user names.
    match error {
        keyring::Error::NoEntry => CredentialError::NotFound,
        keyring::Error::NoStorageAccess(_) => CredentialError::Unavailable,
        _ => CredentialError::StorageFailure,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    /// Test-only fake. Never constructible from production code, never a production fallback.
    #[derive(Default)]
    struct FakeStore {
        entries: Mutex<HashMap<String, Vec<u8>>>,
        fault: Mutex<Option<CredentialError>>,
    }

    impl FakeStore {
        fn faulty(fault: CredentialError) -> Self {
            Self {
                fault: Mutex::new(Some(fault)),
                ..Self::default()
            }
        }

        fn check(&self) -> Result<(), CredentialError> {
            match *self.fault.lock().unwrap() {
                Some(fault) => Err(fault),
                None => Ok(()),
            }
        }

        fn clear_fault(&self) {
            *self.fault.lock().unwrap() = None;
        }
    }

    impl CredentialStore for FakeStore {
        fn set(&self, reference: &CredentialRef, secret: &Secret) -> Result<(), CredentialError> {
            self.check()?;
            self.entries.lock().unwrap().insert(
                reference.as_str().to_owned(),
                secret.expose_secret().to_vec(),
            );
            Ok(())
        }

        fn get(&self, reference: &CredentialRef) -> Result<Secret, CredentialError> {
            self.check()?;
            let entries = self.entries.lock().unwrap();
            let bytes = entries
                .get(reference.as_str())
                .ok_or(CredentialError::NotFound)?;
            Secret::new(bytes.clone())
        }

        fn delete(&self, reference: &CredentialRef) -> Result<(), CredentialError> {
            self.check()?;
            self.entries.lock().unwrap().remove(reference.as_str());
            Ok(())
        }
    }

    fn secret(value: &str) -> Secret {
        Secret::new(value).unwrap()
    }

    const CANONICAL: &str = "6f1a1e6e-1a2b-4c3d-8e4f-0123456789ab";

    #[test]
    fn reference_accepts_only_canonical_uuids() {
        assert!(SERVICE.starts_with("com.escope."));
        let reference = CredentialRef::parse(CANONICAL).unwrap();
        assert_eq!(reference.as_str(), CANONICAL);
        assert_eq!(reference.to_string(), CANONICAL);
        let generated = CredentialRef::generate();
        assert_eq!(CredentialRef::parse(generated.as_str()).unwrap(), generated);

        let mut tampered = CANONICAL.to_owned();
        tampered.replace_range(0..1, "z");
        for rejected in [
            // Same UUID spelled differently must not address the same credential.
            CANONICAL.to_uppercase(),
            format!("{{{CANONICAL}}}"),
            CANONICAL.replace('-', ""),
            tampered,
            "not-a-uuid".to_owned(),
            String::new(),
        ] {
            assert_eq!(
                CredentialRef::parse(&rejected).unwrap_err(),
                CredentialError::InvalidReference,
                "reference must be rejected: {rejected}"
            );
        }
        assert_eq!(
            "not-a-uuid".parse::<CredentialRef>().unwrap_err(),
            CredentialError::InvalidReference
        );
    }

    #[test]
    fn reference_debug_is_redacted() {
        let reference = CredentialRef::parse(CANONICAL).unwrap();
        let debug = format!("{reference:?}");
        assert_eq!(debug, "CredentialRef([REDACTED])");
        assert!(!debug.contains(CANONICAL));
    }

    #[test]
    fn secret_size_bounds_and_debug_are_enforced() {
        assert_eq!(
            Secret::new(Vec::<u8>::new()).unwrap_err(),
            CredentialError::InvalidSecret
        );
        assert_eq!(
            Secret::new(vec![b'x'; MAX_SECRET_BYTES + 1]).unwrap_err(),
            CredentialError::InvalidSecret
        );
        let boundary = Secret::new(vec![b'x'; MAX_SECRET_BYTES]).unwrap();
        assert_eq!(boundary.len(), MAX_SECRET_BYTES);
        assert!(!boundary.is_empty());
        assert_eq!(boundary.expose_secret().len(), MAX_SECRET_BYTES);

        let plaintext = "super-secret-api-key";
        let debug = format!("{:?}", secret(plaintext));
        assert_eq!(debug, "Secret([REDACTED])");
        assert!(!debug.contains(plaintext));
        assert!(!debug.contains("super"));
    }

    /// Owned buffer that records its own drop, so the error path of [`adopt`] can be asserted
    /// without inspecting freed memory.
    #[derive(Debug)]
    struct SpyBytes {
        inner: Zeroizing<Vec<u8>>,
        dropped: Arc<AtomicBool>,
    }

    impl SpyBytes {
        fn new(bytes: Vec<u8>, dropped: &Arc<AtomicBool>) -> Self {
            Self {
                inner: Zeroizing::new(bytes),
                dropped: Arc::clone(dropped),
            }
        }
    }

    impl AsRef<[u8]> for SpyBytes {
        fn as_ref(&self) -> &[u8] {
            self.inner.as_slice()
        }
    }

    impl Zeroize for SpyBytes {
        fn zeroize(&mut self) {
            self.inner.zeroize();
        }
    }

    impl Drop for SpyBytes {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::SeqCst);
            self.inner.zeroize();
        }
    }

    #[test]
    fn rejected_secret_bytes_are_owned_and_erased_before_the_error_returns() {
        let empty = Arc::new(AtomicBool::new(false));
        assert_eq!(
            adopt(SpyBytes::new(Vec::new(), &empty)).unwrap_err(),
            CredentialError::InvalidSecret
        );
        assert!(
            empty.load(Ordering::SeqCst),
            "rejected bytes must be dropped by the validating owner"
        );

        let oversized = Arc::new(AtomicBool::new(false));
        assert_eq!(
            adopt(SpyBytes::new(vec![b'x'; MAX_SECRET_BYTES + 1], &oversized)).unwrap_err(),
            CredentialError::InvalidSecret
        );
        assert!(oversized.load(Ordering::SeqCst));

        // Accepted bytes survive validation and are erased only when the owner is dropped.
        let accepted = Arc::new(AtomicBool::new(false));
        let owned = adopt(SpyBytes::new(vec![7u8; MAX_SECRET_BYTES], &accepted)).unwrap();
        assert_eq!(owned.as_ref().len(), MAX_SECRET_BYTES);
        assert!(!accepted.load(Ordering::SeqCst));
        drop(owned);
        assert!(accepted.load(Ordering::SeqCst));
    }

    #[test]
    fn store_round_trip_replaces_and_delete_is_idempotent() {
        let store = FakeStore::default();
        let reference = CredentialRef::generate();
        assert_eq!(
            store.get(&reference).unwrap_err(),
            CredentialError::NotFound
        );

        store.set(&reference, &secret("first")).unwrap();
        assert_eq!(
            store.get(&reference).unwrap().expose_secret(),
            "first".as_bytes()
        );

        store.set(&reference, &secret("second")).unwrap();
        assert_eq!(
            store.get(&reference).unwrap().expose_secret(),
            "second".as_bytes()
        );

        store.delete(&reference).unwrap();
        assert_eq!(
            store.get(&reference).unwrap_err(),
            CredentialError::NotFound
        );
        // Deleting a missing or already deleted reference succeeds.
        store.delete(&reference).unwrap();

        let other = CredentialRef::generate();
        assert_eq!(store.get(&other).unwrap_err(), CredentialError::NotFound);
    }

    #[test]
    fn unavailable_and_denied_store_never_degrade_to_memory_or_plaintext() {
        for fault in [
            CredentialError::Unavailable,
            CredentialError::StorageFailure,
            CredentialError::NotFound,
        ] {
            let store = FakeStore::faulty(fault);
            let reference = CredentialRef::generate();
            assert_eq!(store.set(&reference, &secret("secret")).unwrap_err(), fault);
            assert_eq!(store.get(&reference).unwrap_err(), fault);
            assert_eq!(store.delete(&reference).unwrap_err(), fault);
            // No fallback buffer exists: with the fault cleared nothing was written anywhere.
            store.clear_fault();
            assert_eq!(
                store.get(&reference).unwrap_err(),
                CredentialError::NotFound
            );
        }
    }

    #[test]
    fn errors_expose_stable_codes_without_details() {
        assert_eq!(CredentialError::InvalidReference.code(), "invalidInput");
        assert_eq!(CredentialError::InvalidSecret.code(), "invalidInput");
        assert_eq!(CredentialError::NotFound.code(), "notFound");
        assert_eq!(CredentialError::Unavailable.code(), "credentialUnavailable");
        assert_eq!(CredentialError::StorageFailure.code(), "credentialFailure");
        for error in [
            CredentialError::InvalidReference,
            CredentialError::InvalidSecret,
            CredentialError::NotFound,
            CredentialError::Unavailable,
            CredentialError::StorageFailure,
        ] {
            assert_eq!(error.to_string(), error.code());
            assert_eq!(AppError::from(error).code, error.code());
        }
        assert_eq!(
            format!("{:?}", CredentialError::StorageFailure),
            "StorageFailure"
        );
    }

    #[test]
    fn stores_are_injectable_as_trait_objects() {
        let store: Box<dyn CredentialStore> = Box::new(FakeStore::default());
        let reference = CredentialRef::generate();
        store.set(&reference, &secret("value")).unwrap();
        assert_eq!(store.get(&reference).unwrap().expose_secret(), b"value");
        store.delete(&reference).unwrap();

        // The production adapter is constructible without touching any stored credential.
        let system: Box<dyn CredentialStore> = Box::new(SystemCredentialStore::new());
        let _ = system;
    }

    #[cfg(not(windows))]
    #[test]
    fn system_store_without_platform_adapter_fails_explicitly() {
        let store = SystemCredentialStore::new();
        let reference = CredentialRef::generate();
        assert_eq!(
            store.set(&reference, &secret("value")).unwrap_err(),
            CredentialError::Unavailable
        );
        assert_eq!(
            store.get(&reference).unwrap_err(),
            CredentialError::Unavailable
        );
        assert_eq!(
            store.delete(&reference).unwrap_err(),
            CredentialError::Unavailable
        );
    }

    /// Scripted OS primitives: exercises the orchestration above [`EntryBackend`] without
    /// touching the real credential store.
    #[cfg(windows)]
    struct ScriptedBackend {
        write: Result<(), CredentialError>,
        read: Result<Vec<u8>, CredentialError>,
        remove: Result<(), CredentialError>,
        written: Mutex<Option<Vec<u8>>>,
    }

    #[cfg(windows)]
    impl ScriptedBackend {
        fn ok(read: &[u8]) -> Self {
            Self {
                write: Ok(()),
                read: Ok(read.to_vec()),
                remove: Ok(()),
                written: Mutex::new(None),
            }
        }

        fn failing(error: CredentialError) -> Self {
            Self {
                write: Err(error),
                read: Err(error),
                remove: Err(error),
                written: Mutex::new(None),
            }
        }
    }

    #[cfg(windows)]
    impl EntryBackend for ScriptedBackend {
        fn write(&self, _reference: &CredentialRef, secret: &[u8]) -> Result<(), CredentialError> {
            *self.written.lock().unwrap() = Some(secret.to_vec());
            self.write
        }

        fn read(&self, _reference: &CredentialRef) -> Result<Vec<u8>, CredentialError> {
            self.read.clone()
        }

        fn remove(&self, _reference: &CredentialRef) -> Result<(), CredentialError> {
            self.remove
        }
    }

    /// The scripted backend runs the same orchestration [`SystemCredentialStore`] delegates
    /// to; only the innermost `KeyringBackend` calls are not reached here.
    #[cfg(windows)]
    #[test]
    fn system_store_orchestration_maps_missing_failing_and_corrupt_entries() {
        let reference = CredentialRef::generate();

        // Missing entry: reads report NotFound, delete stays idempotent.
        let missing = BackendStore(ScriptedBackend::failing(CredentialError::NotFound));
        assert_eq!(
            missing.get(&reference).unwrap_err(),
            CredentialError::NotFound
        );
        assert_eq!(missing.delete(&reference), Ok(()));

        // Unavailable store and OS failure are propagated, never swallowed or downgraded.
        for fault in [
            CredentialError::Unavailable,
            CredentialError::StorageFailure,
        ] {
            let store = BackendStore(ScriptedBackend::failing(fault));
            assert_eq!(store.set(&reference, &secret("value")).unwrap_err(), fault);
            assert_eq!(store.get(&reference).unwrap_err(), fault);
            assert_eq!(store.delete(&reference).unwrap_err(), fault);
        }

        // A stored blob outside our own bounds is a store failure, not user input.
        for corrupt in [Vec::new(), vec![b'x'; MAX_SECRET_BYTES + 1]] {
            let store = BackendStore(ScriptedBackend::ok(&corrupt));
            assert_eq!(
                store.get(&reference).unwrap_err(),
                CredentialError::StorageFailure
            );
        }

        // Accepted round trip passes the exact bytes through and returns them.
        let store = BackendStore(ScriptedBackend::ok(b"stored-value"));
        store.set(&reference, &secret("stored-value")).unwrap();
        assert_eq!(
            store.0.written.lock().unwrap().as_deref(),
            Some("stored-value".as_bytes())
        );
        assert_eq!(
            store.get(&reference).unwrap().expose_secret(),
            "stored-value".as_bytes()
        );
        assert_eq!(store.delete(&reference), Ok(()));
    }

    #[cfg(windows)]
    #[test]
    fn keyring_errors_map_to_sanitized_variants() {
        let details = || Box::new(std::io::Error::other("marker-detail")) as _;
        assert_eq!(
            map_keyring_error(keyring::Error::NoEntry),
            CredentialError::NotFound
        );
        assert_eq!(
            map_keyring_error(keyring::Error::NoStorageAccess(details())),
            CredentialError::Unavailable
        );
        assert_eq!(
            map_keyring_error(keyring::Error::PlatformFailure(details())),
            CredentialError::StorageFailure
        );
        assert_eq!(
            map_keyring_error(keyring::Error::TooLong("secret".into(), 2560)),
            CredentialError::StorageFailure
        );
        for error in [
            keyring::Error::NoStorageAccess(details()),
            keyring::Error::PlatformFailure(details()),
        ] {
            let mapped = map_keyring_error(error);
            assert!(!mapped.code().contains("marker-detail"));
            assert!(!mapped.to_string().contains("marker-detail"));
            assert!(!format!("{mapped:?}").contains("marker-detail"));
        }
    }

    /// Deletes only the random reference this test created, even when an assertion panics.
    /// Never scans or touches any other credential.
    #[cfg(windows)]
    struct ReferenceCleanup<'a> {
        store: &'a SystemCredentialStore,
        reference: CredentialRef,
    }

    #[cfg(windows)]
    impl Drop for ReferenceCleanup<'_> {
        fn drop(&mut self) {
            let _ = self.store.delete(&self.reference);
        }
    }

    /// Manual real-machine check. Touches the Windows Credential Manager with a fresh random
    /// reference only, and removes it again on success and on panic. Ignored by default: run
    /// explicitly with
    /// `cargo test --manifest-path src-tauri/Cargo.toml credentials -- --ignored`.
    #[cfg(windows)]
    #[test]
    #[ignore = "touches the real Windows Credential Manager; run manually"]
    fn windows_credential_manager_round_trip_with_random_reference() {
        let store = SystemCredentialStore::new();
        let reference = CredentialRef::generate();
        let _cleanup = ReferenceCleanup {
            store: &store,
            reference: reference.clone(),
        };

        store.set(&reference, &secret("escope-f08-smoke")).unwrap();
        assert_eq!(
            store.get(&reference).unwrap().expose_secret(),
            "escope-f08-smoke".as_bytes()
        );
        store.delete(&reference).unwrap();
        assert_eq!(
            store.get(&reference).unwrap_err(),
            CredentialError::NotFound
        );
        // Deleting an already removed entry must succeed against the real backend too.
        store.delete(&reference).unwrap();
    }
}
