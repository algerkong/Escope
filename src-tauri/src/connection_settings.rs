//! C05.3/C01.4 connection settings IPC: the credential-aware read, the combined save that also
//! carries the custom CA change, delete, and the explicit cleanup retry.
//!
//! Wire contract (fixed; the TypeScript side mirrors it):
//!
//! - `connections_load` -> `{ preferences, connections, activeConnectionId, credentialCleanupPending }`.
//!   A public connection keeps `id`, `displayName`, `endpoint`, `environment`, `sortOrder` and
//!   `auth` (`"none" | "basic" | "apiKey" | "bearer"`) and adds `hasCredential` and `hasCustomCa`.
//!   Credential references, secret material and CA bodies never appear in these records.
//! - `connections_save { input, id, credential, ca }` -> `{ profile, credentialDetached, cleanup }`.
//!   `credential` is strictly tagged: `{kind:"keep"}`, `{kind:"clear"}`, `{kind:"basic",username,
//!   password}`, `{kind:"apiKey",id,key}` or `{kind:"bearer",token}`; `ca` is `{kind:"keep"}`,
//!   `{kind:"clear"}` or `{kind:"replace",pem}`. Unknown fields, unknown kinds, missing members and
//!   members a kind does not own are rejected before anything is read or written.
//! - `connections_delete { id }` -> `{ cleanup }`.
//! - `connections_cleanup` -> `CleanupState`.
//!
//! `CleanupState` separates what is certain: `complete` (nothing is queued), `pending` (a bounded
//! pass completed and `remaining` references are still queued, `abandoned` of them over their retry
//! budget), `incomplete` (the pass could not be accounted for; `remaining` is `null` because the
//! queue state is unknown and `abandoned` is not a claim either). An incomplete pass never rolls
//! back committed metadata.
//!
//! The legacy commands (`load_state`, `save_connection`, `delete_connection`) keep refusing a
//! connection with a bound credential; these commands are the truthful surface for them.

use crate::connection_auth::EsAuthMaterial;
use crate::connection_credentials::{
    CleanupPass, ConnectionCaPlan, ConnectionCredentialPlan, ConnectionCredentials,
};
use crate::connection_tls::CaCertificate;
use crate::credentials::{CredentialStore, SystemCredentialStore};
use crate::error::AppError;
use crate::storage::{ConnectionInput, ConnectionProfile, Database, Preferences};
use crate::{with_database, StorageState};
use serde::{Deserialize, Deserializer, Serialize};
use std::fmt;
use tauri::State;
use zeroize::Zeroizing;

/// One connection as the settings page reads it. References, secrets and CA bodies have no field
/// here; the two booleans are the only facts about them, and they say nothing about whether the
/// secret still exists in the OS store or whether the chain currently validates.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublicConnection {
    pub id: String,
    pub display_name: String,
    pub endpoint: String,
    pub environment: String,
    pub sort_order: i64,
    pub auth: &'static str,
    pub has_credential: bool,
    pub has_custom_ca: bool,
}

impl PublicConnection {
    fn new(profile: ConnectionProfile, has_custom_ca: bool) -> Self {
        Self {
            id: profile.id,
            display_name: profile.display_name,
            endpoint: profile.endpoint,
            environment: profile.environment,
            sort_order: profile.sort_order,
            auth: profile.auth_state.kind.as_str(),
            has_credential: profile.auth_state.credential_ref.is_some(),
            has_custom_ca,
        }
    }
}

/// Everything the credential-aware settings page reads in one call, so the list, the selection and
/// the cleanup warning can never come from two different database states.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionsState {
    pub preferences: Preferences,
    pub connections: Vec<PublicConnection>,
    pub active_connection_id: Option<String>,
    /// True while the shared outbox holds a reference that may still exist in the OS store.
    pub credential_cleanup_pending: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CleanupStatus {
    Complete,
    Pending,
    Incomplete,
}

/// What one write could account for about the shared credential outbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanupState {
    pub status: CleanupStatus,
    /// Queued references left after the pass; `null` when the pass did not finish and the queue
    /// state is unknown.
    pub remaining: Option<i64>,
    /// Queued references that exhausted their retry budget. Only authoritative for `complete` and
    /// `pending`; an `incomplete` pass does not know.
    pub abandoned: i64,
}

impl CleanupState {
    fn from_pass(pass: CleanupPass) -> Self {
        match pass {
            CleanupPass::Completed(report) => {
                let remaining = report.remaining as i64;
                Self {
                    status: if remaining == 0 {
                        CleanupStatus::Complete
                    } else {
                        CleanupStatus::Pending
                    },
                    remaining: Some(remaining),
                    abandoned: report.abandoned as i64,
                }
            }
            // The pass could not be accounted for. Nothing is reported as cleaned and no number is
            // guessed: `remaining` stays `null` and the status is what callers must branch on.
            CleanupPass::Incomplete => Self {
                status: CleanupStatus::Incomplete,
                remaining: None,
                abandoned: 0,
            },
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveOutcome {
    pub profile: PublicConnection,
    /// True when this save detached or replaced a previous credential, which is now queued for
    /// deletion.
    pub credential_detached: bool,
    pub cleanup: CleanupState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteResponse {
    pub cleanup: CleanupState,
}

/// Field presence on the wire. Unlike `Option`, a member that is present but `null` (or of the
/// wrong type) is a deserialization error instead of being folded into "absent": the credential
/// structs need that distinction to reject a member a kind does not own.
enum Presence<T> {
    Absent,
    Present(T),
}

// A derived `Default` would require `T: Default`, but absence is meaningful for every field type
// (the credential fields are deliberately not `Default`), so the impl is manual on purpose.
#[allow(clippy::derivable_impls)]
impl<T> Default for Presence<T> {
    fn default() -> Self {
        Self::Absent
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Presence<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        T::deserialize(deserializer).map(Self::Present)
    }
}

/// One credential field exactly as it arrives on the wire.
///
/// The buffer is wrapped in [`Zeroizing`] the moment serde hands it over — an owned buffer from
/// serde is moved in without a copy — so a payload that fails before or after this field is
/// matched (unknown kind, mixed members, a later field of the wrong type) erases every field it
/// already allocated instead of dropping plain `String`s. The wire shape stays a plain JSON
/// string; only the in-memory representation is stricter. The type never prints its value.
struct SecretField(Zeroizing<String>);

impl SecretField {
    /// Move the erased buffer into the validated enum without copying it.
    fn take(self) -> Zeroizing<String> {
        self.0
    }
}

impl<'de> Deserialize<'de> for SecretField {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct FieldVisitor;

        impl<'de> serde::de::Visitor<'de> for FieldVisitor {
            type Value = SecretField;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a string credential field")
            }

            fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
                Ok(SecretField(Zeroizing::new(value.to_owned())))
            }

            fn visit_string<E: serde::de::Error>(self, value: String) -> Result<Self::Value, E> {
                Ok(SecretField(Zeroizing::new(value)))
            }
        }

        deserializer.deserialize_string(FieldVisitor)
    }
}

/// One credential change as the frontend submits it. Every member is erased: the wire fields
/// become [`Zeroizing`] buffers before the payload is matched, and this enum holds no copy of an
/// accepted value, so neither a rejected payload nor a dropped plan leaves a plaintext buffer
/// behind. The type deliberately prints no field value.
pub(crate) enum CredentialChange {
    Keep,
    Clear,
    Basic {
        username: Zeroizing<String>,
        password: Zeroizing<String>,
    },
    ApiKey {
        id: Zeroizing<String>,
        key: Zeroizing<String>,
    },
    Bearer {
        token: Zeroizing<String>,
    },
}

impl fmt::Debug for CredentialChange {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let variant = match self {
            Self::Keep => "Keep",
            Self::Clear => "Clear",
            Self::Basic { .. } => "Basic",
            Self::ApiKey { .. } => "ApiKey",
            Self::Bearer { .. } => "Bearer",
        };
        write!(f, "CredentialChange({variant}, [REDACTED])")
    }
}

impl CredentialChange {
    /// Build the validated credential plan. Every field bound and character rule is enforced here
    /// by [`EsAuthMaterial`], before any database or keyring side effect.
    fn into_plan(self) -> Result<ConnectionCredentialPlan, AppError> {
        match self {
            Self::Keep => Ok(ConnectionCredentialPlan::Keep),
            Self::Clear => Ok(ConnectionCredentialPlan::Clear),
            Self::Basic { username, password } => Ok(ConnectionCredentialPlan::Replace(
                EsAuthMaterial::basic(&username, &password)?,
            )),
            Self::ApiKey { id, key } => Ok(ConnectionCredentialPlan::Replace(
                EsAuthMaterial::api_key(&id, &key)?,
            )),
            Self::Bearer { token } => Ok(ConnectionCredentialPlan::Replace(
                EsAuthMaterial::bearer(&token)?,
            )),
        }
    }
}

/// The wire struct keeps `deny_unknown_fields` exact: serde cannot deny unknown fields on
/// internally tagged enums, and a stray key must never be silently dropped from a payload that
/// carries a secret.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawCredentialChange {
    kind: String,
    #[serde(default)]
    username: Presence<SecretField>,
    #[serde(default)]
    password: Presence<SecretField>,
    #[serde(default)]
    id: Presence<SecretField>,
    #[serde(default)]
    key: Presence<SecretField>,
    #[serde(default)]
    token: Presence<SecretField>,
}

impl<'de> Deserialize<'de> for CredentialChange {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = RawCredentialChange::deserialize(deserializer)?;
        match (
            raw.kind.as_str(),
            raw.username,
            raw.password,
            raw.id,
            raw.key,
            raw.token,
        ) {
            (
                "keep",
                Presence::Absent,
                Presence::Absent,
                Presence::Absent,
                Presence::Absent,
                Presence::Absent,
            ) => Ok(Self::Keep),
            (
                "clear",
                Presence::Absent,
                Presence::Absent,
                Presence::Absent,
                Presence::Absent,
                Presence::Absent,
            ) => Ok(Self::Clear),
            (
                "basic",
                Presence::Present(username),
                Presence::Present(password),
                Presence::Absent,
                Presence::Absent,
                Presence::Absent,
            ) => Ok(Self::Basic {
                username: username.take(),
                password: password.take(),
            }),
            (
                "apiKey",
                Presence::Absent,
                Presence::Absent,
                Presence::Present(id),
                Presence::Present(key),
                Presence::Absent,
            ) => Ok(Self::ApiKey {
                id: id.take(),
                key: key.take(),
            }),
            (
                "bearer",
                Presence::Absent,
                Presence::Absent,
                Presence::Absent,
                Presence::Absent,
                Presence::Present(token),
            ) => Ok(Self::Bearer {
                token: token.take(),
            }),
            // Static message: a refused payload must never echo a credential.
            _ => Err(serde::de::Error::custom("invalid credential change")),
        }
    }
}

/// One custom CA change as the frontend submits it.
///
/// A submitted PEM is public certificate material *when* it is a certificate — but a user can paste
/// a private key by mistake, so the field stays in a [`Zeroizing`] buffer until
/// [`crate::connection_tls::CaCertificate::parse`] has accepted it as a chain of public
/// certificates. A private key, a request or garbage is therefore erased on drop, and the validated
/// chain (public bytes only) is what the plan carries onwards. The type never prints its value.
pub(crate) enum CaChange {
    Keep,
    Clear,
    Replace { pem: Zeroizing<String> },
}

impl fmt::Debug for CaChange {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Keep => write!(f, "CaChange(Keep)"),
            Self::Clear => write!(f, "CaChange(Clear)"),
            Self::Replace { pem } => write!(f, "CaChange(Replace, {} bytes)", pem.len()),
        }
    }
}

impl CaChange {
    /// Validate the chain before it can be stored: text, bounds and the maintained rustls parse.
    /// A structurally invalid PEM is `invalidCertificate`; a chain rustls refuses is `tlsError`.
    fn into_plan(self) -> Result<ConnectionCaPlan, AppError> {
        match self {
            Self::Keep => Ok(ConnectionCaPlan::Keep),
            Self::Clear => Ok(ConnectionCaPlan::Clear),
            Self::Replace { pem } => {
                let certificate = CaCertificate::parse(&pem)?;
                certificate.verify_usable()?;
                Ok(ConnectionCaPlan::Replace(certificate))
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawCaChange {
    kind: String,
    #[serde(default)]
    pem: Presence<SecretField>,
}

impl<'de> Deserialize<'de> for CaChange {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = RawCaChange::deserialize(deserializer)?;
        match (raw.kind.as_str(), raw.pem) {
            ("keep", Presence::Absent) => Ok(Self::Keep),
            ("clear", Presence::Absent) => Ok(Self::Clear),
            ("replace", Presence::Present(pem)) => Ok(Self::Replace { pem: pem.take() }),
            _ => Err(serde::de::Error::custom("invalid CA change")),
        }
    }
}

/// The credential-aware settings read. Every connection is reported truthfully, including the ones
/// with a bound credential; the reference and the CA body stay in the backend.
#[tauri::command]
pub(crate) fn connections_load(
    state: State<'_, StorageState>,
) -> Result<ConnectionsState, AppError> {
    with_database(&state, |database| load_state_inner(database))
}

/// Create (`id` absent) or update (`id` present) one connection, applying the credential and CA
/// changes in the same commit as the metadata. Rejected input never reaches the OS store.
#[tauri::command]
pub(crate) fn connections_save(
    state: State<'_, StorageState>,
    input: ConnectionInput,
    id: Option<String>,
    credential: CredentialChange,
    ca: CaChange,
) -> Result<SaveOutcome, AppError> {
    let store = SystemCredentialStore::new();
    with_database(&state, |database| {
        save_inner(database, &store, input, id, credential, ca)
    })
}

/// Delete one connection; its metadata and the queued credential reference commit together and the
/// bounded cleanup runs afterwards.
#[tauri::command]
pub(crate) fn connections_delete(
    state: State<'_, StorageState>,
    id: String,
) -> Result<DeleteResponse, AppError> {
    let store = SystemCredentialStore::new();
    with_database(&state, |database| delete_inner(database, &store, &id))
}

/// Retry the bounded credential cleanup of the shared outbox. The returned state distinguishes a
/// completed pass from one that could not be accounted for.
#[tauri::command]
pub(crate) fn connections_cleanup(
    state: State<'_, StorageState>,
) -> Result<CleanupState, AppError> {
    let store = SystemCredentialStore::new();
    with_database(&state, |database| cleanup_inner(database, &store))
}

fn load_state_inner(database: &Database) -> Result<ConnectionsState, AppError> {
    let preferences = database.preferences()?;
    let summaries = database.connection_summaries()?;
    let stored = database.stored_active_connection_id()?;
    let active_connection_id = stored
        .filter(|id| summaries.iter().any(|summary| &summary.profile.id == id))
        .or_else(|| summaries.first().map(|summary| summary.profile.id.clone()));
    let credential_cleanup_pending = database.pending_credential_cleanup_count()? > 0;
    Ok(ConnectionsState {
        preferences,
        connections: summaries
            .into_iter()
            .map(|summary| PublicConnection::new(summary.profile, summary.has_custom_ca))
            .collect(),
        active_connection_id,
        credential_cleanup_pending,
    })
}

fn save_inner(
    database: &mut Database,
    store: &dyn CredentialStore,
    input: ConnectionInput,
    id: Option<String>,
    credential: CredentialChange,
    ca: CaChange,
) -> Result<SaveOutcome, AppError> {
    // Every input is validated before the first side effect: material fields, CA text and the
    // maintained rustls parse, then the connection identity inside the orchestration.
    let credential_plan = credential.into_plan()?;
    let ca_plan = ca.into_plan()?;
    let write = ConnectionCredentials::new(database, store).save_combined(
        input,
        id,
        credential_plan,
        ca_plan,
    )?;
    Ok(SaveOutcome {
        profile: PublicConnection::new(write.profile, write.has_custom_ca),
        credential_detached: write.detached.is_some(),
        cleanup: CleanupState::from_pass(write.cleanup),
    })
}

fn delete_inner(
    database: &mut Database,
    store: &dyn CredentialStore,
    id: &str,
) -> Result<DeleteResponse, AppError> {
    let outcome = ConnectionCredentials::new(database, store).delete(id)?;
    Ok(DeleteResponse {
        cleanup: CleanupState::from_pass(outcome.cleanup),
    })
}

fn cleanup_inner(
    database: &mut Database,
    store: &dyn CredentialStore,
) -> Result<CleanupState, AppError> {
    Ok(CleanupState::from_pass(
        ConnectionCredentials::new(database, store).cleanup_outcome(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection_tls::test_certificates::ROOT_CA_3;
    use crate::credentials::CredentialError;
    use crate::model_credentials::test_store::{Faults, TestCredentialStore};
    use crate::storage::CleanupReason;

    fn input(name: &str, endpoint: &str) -> ConnectionInput {
        ConnectionInput {
            display_name: name.into(),
            endpoint: endpoint.into(),
            environment: "development".into(),
        }
    }

    fn database() -> Database {
        Database::open(std::path::Path::new(":memory:")).unwrap()
    }

    fn credential(json: &str) -> CredentialChange {
        serde_json::from_str(json).unwrap()
    }

    fn save(
        database: &mut Database,
        store: &TestCredentialStore,
        name: &str,
        endpoint: &str,
        id: Option<String>,
        credential_json: &str,
        ca: CaChange,
    ) -> Result<SaveOutcome, AppError> {
        save_inner(
            database,
            store,
            input(name, endpoint),
            id,
            credential(credential_json),
            ca,
        )
    }

    #[test]
    fn credential_wire_contract_is_strict() {
        assert!(matches!(
            credential(r#"{"kind":"keep"}"#),
            CredentialChange::Keep
        ));
        assert!(matches!(
            credential(r#"{"kind":"clear"}"#),
            CredentialChange::Clear
        ));
        assert!(matches!(
            credential(r#"{"kind":"basic","username":"u","password":"p"}"#),
            CredentialChange::Basic { .. }
        ));
        assert!(matches!(
            credential(r#"{"kind":"apiKey","id":"i","key":"k"}"#),
            CredentialChange::ApiKey { .. }
        ));
        assert!(matches!(
            credential(r#"{"kind":"bearer","token":"t"}"#),
            CredentialChange::Bearer { .. }
        ));
        for refused in [
            // A member the kind does not own, present or null.
            r#"{"kind":"keep","password":"x"}"#,
            r#"{"kind":"keep","username":null}"#,
            r#"{"kind":"clear","token":"x"}"#,
            // Missing members.
            r#"{"kind":"basic","username":"u"}"#,
            r#"{"kind":"basic","password":"p"}"#,
            r#"{"kind":"apiKey","id":"i"}"#,
            r#"{"kind":"bearer"}"#,
            // Foreign or misspelled members, wrong types, unknown kinds.
            r#"{"kind":"basic","username":"u","password":"p","extra":"x"}"#,
            r#"{"kind":"basic","username":"u","password":"p","token":"t"}"#,
            r#"{"kind":"basic","username":"u","password":7}"#,
            r#"{"kind":"unknown"}"#,
            r#"{}"#,
        ] {
            assert!(
                serde_json::from_str::<CredentialChange>(refused).is_err(),
                "must be rejected: {refused}"
            );
        }
        // Neither fields nor an error can echo a secret through Debug.
        let change = credential(r#"{"kind":"bearer","token":"wire-secret"}"#);
        assert!(!format!("{change:?}").contains("wire-secret"));
        let error = serde_json::from_str::<CredentialChange>(
            r#"{"kind":"basic","username":"u","password":"wire-secret","token":"x"}"#,
        )
        .unwrap_err()
        .to_string();
        assert!(!error.contains("wire-secret"));
    }

    #[test]
    fn ca_wire_contract_is_strict() {
        assert!(matches!(
            credential_ca(r#"{"kind":"keep"}"#),
            CaChange::Keep
        ));
        assert!(matches!(
            credential_ca(r#"{"kind":"clear"}"#),
            CaChange::Clear
        ));
        let replace = credential_ca(r#"{"kind":"replace","pem":"-----BEGIN CERTIFICATE-----\n"}"#);
        assert!(matches!(replace, CaChange::Replace { .. }));
        for refused in [
            r#"{"kind":"keep","pem":"x"}"#,
            r#"{"kind":"clear","pem":null}"#,
            r#"{"kind":"replace"}"#,
            r#"{"kind":"replace","pem":null}"#,
            r#"{"kind":"replace","pem":"x","extra":1}"#,
            r#"{"kind":"unknown","pem":"x"}"#,
        ] {
            assert!(
                serde_json::from_str::<CaChange>(refused).is_err(),
                "must be rejected: {refused}"
            );
        }
        // The Debug output never carries the PEM body.
        let replace = credential_ca(&format!(
            r#"{{"kind":"replace","pem":{}}}"#,
            serde_json::to_string(ROOT_CA_3).unwrap()
        ));
        assert!(!format!("{replace:?}").contains("MIIB"));
    }

    fn credential_ca(json: &str) -> CaChange {
        serde_json::from_str(json).unwrap()
    }

    /// Build the wire shape the frontend submits; the buffer is zeroizing exactly like the
    /// deserialized one, so a rejected fixture is erased as well.
    fn ca_pem(pem: &str) -> CaChange {
        CaChange::Replace {
            pem: Zeroizing::new(pem.to_owned()),
        }
    }

    fn replace_ca() -> CaChange {
        ca_pem(ROOT_CA_3)
    }

    #[test]
    fn invalid_material_and_pem_are_refused_before_any_write() {
        let mut db = database();
        let store = TestCredentialStore::default();

        // A user id containing `:` is refused by the material constructor.
        let error = save(
            &mut db,
            &store,
            "Bad",
            "https://a.test/es",
            None,
            r#"{"kind":"basic","username":"a:b","password":"p"}"#,
            CaChange::Keep,
        )
        .unwrap_err();
        assert_eq!(error.code, "invalidInput");
        // Structurally invalid PEM and text that only looks like PEM.
        let error = save(
            &mut db,
            &store,
            "Bad",
            "https://a.test/es",
            None,
            r#"{"kind":"keep"}"#,
            ca_pem("not a certificate"),
        )
        .unwrap_err();
        assert_eq!(error.code, "invalidCertificate");
        let error = save(
            &mut db,
            &store,
            "Bad",
            "https://a.test/es",
            None,
            r#"{"kind":"keep"}"#,
            ca_pem("-----BEGIN CERTIFICATE-----\naGVsbG8=\n-----END CERTIFICATE-----\n"),
        )
        .unwrap_err();
        assert_eq!(error.code, "tlsError");
        // A private key is not a trusted public chain, and its buffer is erased by the wire type.
        let error = save(
            &mut db,
            &store,
            "Bad",
            "https://a.test/es",
            None,
            r#"{"kind":"keep"}"#,
            ca_pem("-----BEGIN EC PRIVATE KEY-----\nMHcCAQEE\n-----END EC PRIVATE KEY-----\n"),
        )
        .unwrap_err();
        assert_eq!(error.code, "invalidCertificate");

        // Nothing was created, nothing was queued and the store was never touched.
        assert!(db.connection_summaries().unwrap().is_empty());
        assert_eq!(db.pending_credential_cleanup_count().unwrap(), 0);
        assert!(store.is_empty());
    }

    #[test]
    fn save_projects_a_public_record_without_references_secrets_or_pem() {
        let mut db = database();
        let store = TestCredentialStore::default();
        let outcome = save(
            &mut db,
            &store,
            "Secured",
            "https://secured.test/es",
            None,
            r#"{"kind":"bearer","token":"projection-secret"}"#,
            replace_ca(),
        )
        .unwrap();
        assert_eq!(outcome.profile.auth, "bearer");
        assert!(outcome.profile.has_credential);
        assert!(outcome.profile.has_custom_ca);
        assert!(!outcome.credential_detached);
        assert_eq!(outcome.cleanup.status, CleanupStatus::Complete);
        assert_eq!(outcome.cleanup.remaining, Some(0));
        assert_eq!(outcome.cleanup.abandoned, 0);
        let id = outcome.profile.id.clone();

        let json = serde_json::to_string(&outcome).unwrap();
        assert!(!json.contains("projection-secret"));
        assert!(!json.contains("BEGIN CERTIFICATE"));
        assert!(!json.contains("credentialRef"));
        assert!(!json.contains("authState"));
        assert!(json.contains(r#""hasCredential":true"#));
        assert!(json.contains(r#""hasCustomCa":true"#));
        let reference = db
            .connection_auth(&id)
            .unwrap()
            .credential_ref
            .expect("the connection must have a bound credential");
        assert!(!json.contains(reference.as_str()));

        let state = load_state_inner(&db).unwrap();
        assert_eq!(state.connections.len(), 1);
        assert_eq!(state.connections[0].auth, "bearer");
        assert!(state.connections[0].has_credential);
        assert!(state.connections[0].has_custom_ca);
        assert_eq!(state.active_connection_id.as_deref(), Some(id.as_str()));
        assert!(!state.credential_cleanup_pending);
        let json = serde_json::to_string(&state).unwrap();
        assert!(!json.contains("projection-secret"));
        assert!(!json.contains(reference.as_str()));
        assert!(!json.contains("BEGIN CERTIFICATE"));
    }

    #[test]
    fn keep_preserves_and_target_change_detaches_reference_and_ca() {
        let mut db = database();
        let store = TestCredentialStore::default();
        let created = save(
            &mut db,
            &store,
            "A",
            "https://a.test/es",
            None,
            r#"{"kind":"apiKey","id":"key-id","key":"key-secret"}"#,
            replace_ca(),
        )
        .unwrap();
        let id = created.profile.id.clone();

        // Renaming with `keep` preserves the reference and the chain.
        let renamed = save(
            &mut db,
            &store,
            "Renamed",
            "https://a.test/es",
            Some(id.clone()),
            r#"{"kind":"keep"}"#,
            CaChange::Keep,
        )
        .unwrap();
        assert!(!renamed.credential_detached);
        assert!(renamed.profile.has_credential);
        assert!(renamed.profile.has_custom_ca);

        // A changed endpoint drops both even under `keep`, and reports the detachment.
        let moved = save(
            &mut db,
            &store,
            "Renamed",
            "https://moved.test/es",
            Some(id.clone()),
            r#"{"kind":"keep"}"#,
            CaChange::Keep,
        )
        .unwrap();
        assert!(moved.credential_detached);
        assert!(!moved.profile.has_credential);
        assert!(!moved.profile.has_custom_ca);
        assert_eq!(moved.profile.auth, "none");
        assert_eq!(moved.cleanup.status, CleanupStatus::Complete);
        assert_eq!(store.len(), 0);

        // Clearing an already empty connection stays a no-op.
        let cleared = save(
            &mut db,
            &store,
            "Renamed",
            "https://moved.test/es",
            Some(id),
            r#"{"kind":"clear"}"#,
            CaChange::Clear,
        )
        .unwrap();
        assert!(!cleared.credential_detached);
        assert!(!cleared.profile.has_credential);
    }

    #[test]
    fn delete_queues_the_secret_and_reports_the_cleanup_state() {
        let mut db = database();
        let store = TestCredentialStore::default();
        let first = save(
            &mut db,
            &store,
            "Keep",
            "https://keep.test/es",
            None,
            r#"{"kind":"keep"}"#,
            CaChange::Keep,
        )
        .unwrap()
        .profile
        .id;
        let removed = save(
            &mut db,
            &store,
            "Remove",
            "https://remove.test/es",
            None,
            r#"{"kind":"basic","username":"alice","password":"delete-secret"}"#,
            CaChange::Keep,
        )
        .unwrap()
        .profile
        .id;
        db.select_connection(Some(removed.clone())).unwrap();

        let response = delete_inner(&mut db, &store, &removed).unwrap();
        assert_eq!(response.cleanup.status, CleanupStatus::Complete);
        assert_eq!(response.cleanup.remaining, Some(0));
        // The secret was queued by the delete and deleted by the bounded pass that follows it:
        // the only stored secret belonged to the removed connection.
        assert_eq!(store.len(), 0);
        let state = load_state_inner(&db).unwrap();
        assert_eq!(state.connections.len(), 1);
        assert_eq!(state.connections[0].id, first);
        assert_eq!(state.active_connection_id.as_deref(), Some(first.as_str()));
        assert!(!state.credential_cleanup_pending);

        // Deletion follows the existing storage contract: an id that names no row is `notFound`,
        // whether or not it is a canonical UUID.
        assert_eq!(
            delete_inner(&mut db, &store, "not-an-id").unwrap_err().code,
            "notFound"
        );
        assert_eq!(
            delete_inner(&mut db, &store, &uuid::Uuid::new_v4().to_string())
                .unwrap_err()
                .code,
            "notFound"
        );

        // A failing vault keeps the detached secret queued and reports the uncertain outcome as
        // pending instead of claiming a clean delete.
        let faulted = save(
            &mut db,
            &store,
            "Faulted",
            "https://faulted.test/es",
            None,
            r#"{"kind":"bearer","token":"faulted-secret"}"#,
            CaChange::Keep,
        )
        .unwrap()
        .profile
        .id;
        store.set_faults(Faults {
            delete: Some(CredentialError::StorageFailure),
            ..Faults::default()
        });
        let response = delete_inner(&mut db, &store, &faulted).unwrap();
        assert_eq!(response.cleanup.status, CleanupStatus::Pending);
        assert_eq!(response.cleanup.remaining, Some(1));
        assert!(db
            .connection_summaries()
            .unwrap()
            .iter()
            .all(|summary| summary.profile.id != faulted));
        store.set_faults(Faults::default());
        let state = cleanup_inner(&mut db, &store).unwrap();
        assert_eq!(state.status, CleanupStatus::Complete);
    }

    #[test]
    fn cleanup_reports_pending_and_incomplete_without_rolling_back() {
        let mut db = database();
        let store = TestCredentialStore::default();
        let created = save(
            &mut db,
            &store,
            "A",
            "https://a.test/es",
            None,
            r#"{"kind":"bearer","token":"old-secret"}"#,
            CaChange::Keep,
        )
        .unwrap();
        let id = created.profile.id.clone();

        // The deletion of the detached secret fails, so the committed write reports pending.
        store.set_faults(Faults {
            delete: Some(CredentialError::StorageFailure),
            ..Faults::default()
        });
        let moved = save(
            &mut db,
            &store,
            "A",
            "https://moved.test/es",
            Some(id.clone()),
            r#"{"kind":"keep"}"#,
            CaChange::Keep,
        )
        .unwrap();
        assert!(moved.credential_detached);
        assert_eq!(moved.cleanup.status, CleanupStatus::Pending);
        assert_eq!(moved.cleanup.remaining, Some(1));
        assert_eq!(moved.cleanup.abandoned, 0);
        // The metadata change is committed even though the cleanup is pending.
        let snapshot = db.transport_snapshot(&id).unwrap();
        assert_eq!(snapshot.profile().endpoint, "https://moved.test/es");
        assert!(snapshot.profile().auth_state.unauthenticated());

        store.set_faults(Faults::default());
        let state = cleanup_inner(&mut db, &store).unwrap();
        assert_eq!(state.status, CleanupStatus::Complete);
        assert_eq!(state.remaining, Some(0));
        assert_eq!(db.pending_credential_cleanup_count().unwrap(), 0);

        // A queued entry whose queue removal fails makes the whole pass unaccountable.
        let second = save(
            &mut db,
            &store,
            "B",
            "https://b.test/es",
            None,
            r#"{"kind":"bearer","token":"second-secret"}"#,
            CaChange::Keep,
        )
        .unwrap()
        .profile
        .id;
        let reference = db
            .connection_auth(&second)
            .unwrap()
            .credential_ref
            .expect("bound");
        db.run_sql_for_test(&format!(
            "CREATE TRIGGER fail_cancel BEFORE DELETE ON credential_cleanup WHEN old.reference='{}' BEGIN SELECT RAISE(ABORT, 'forced'); END",
            reference.as_str()
        ))
        .unwrap();
        let detached = save(
            &mut db,
            &store,
            "B",
            "https://b-moved.test/es",
            Some(second.clone()),
            r#"{"kind":"keep"}"#,
            CaChange::Keep,
        )
        .unwrap();
        assert_eq!(detached.cleanup.status, CleanupStatus::Incomplete);
        assert_eq!(detached.cleanup.remaining, None);
        assert_eq!(detached.cleanup.abandoned, 0);
        let state = cleanup_inner(&mut db, &store).unwrap();
        assert_eq!(state.status, CleanupStatus::Incomplete);
        assert_eq!(state.remaining, None);

        // The committed metadata was never rolled back, and the entry is still queued for retry.
        let snapshot = db.transport_snapshot(&second).unwrap();
        assert_eq!(snapshot.profile().endpoint, "https://b-moved.test/es");
        assert!(snapshot.profile().auth_state.unauthenticated());
        assert_eq!(db.pending_credential_cleanup_count().unwrap(), 1);
        let state = load_state_inner(&db).unwrap();
        assert!(state.credential_cleanup_pending);

        db.run_sql_for_test("DROP TRIGGER fail_cancel").unwrap();
        let state = cleanup_inner(&mut db, &store).unwrap();
        assert_eq!(state.status, CleanupStatus::Complete);
    }

    #[test]
    fn load_reports_authenticated_records_while_the_legacy_read_still_refuses() {
        let mut db = database();
        let store = TestCredentialStore::default();
        let plain = save(
            &mut db,
            &store,
            "Plain",
            "https://plain.test/es",
            None,
            r#"{"kind":"keep"}"#,
            CaChange::Keep,
        )
        .unwrap()
        .profile
        .id;
        let bound = save(
            &mut db,
            &store,
            "Bound",
            "https://bound.test/es",
            None,
            r#"{"kind":"basic","username":"alice","password":"load-secret"}"#,
            CaChange::Keep,
        )
        .unwrap()
        .profile
        .id;

        // The legacy state read cannot describe a bound credential truthfully, so it refuses.
        assert_eq!(db.load().err().unwrap().code, "unsupported");

        db.select_connection(Some(bound.clone())).unwrap();
        let reference = crate::credentials::CredentialRef::generate();
        db.queue_credential_cleanup(&reference, CleanupReason::Prepare)
            .unwrap();
        let state = load_state_inner(&db).unwrap();
        assert_eq!(state.connections.len(), 2);
        assert_eq!(state.connections[0].id, plain);
        assert_eq!(state.connections[0].auth, "none");
        assert!(!state.connections[0].has_credential);
        assert_eq!(state.connections[1].id, bound);
        assert_eq!(state.connections[1].auth, "basic");
        assert!(state.connections[1].has_credential);
        assert_eq!(state.active_connection_id.as_deref(), Some(bound.as_str()));
        assert!(state.credential_cleanup_pending);

        // A stored selection that no longer names a connection resolves to the first one.
        db.select_connection(None).unwrap();
        let state = load_state_inner(&db).unwrap();
        assert_eq!(state.active_connection_id.as_deref(), Some(plain.as_str()));
    }

    #[test]
    fn cleanup_state_maps_pass_outcomes_exactly() {
        let complete = CleanupState::from_pass(CleanupPass::Completed(Default::default()));
        assert_eq!(complete.status, CleanupStatus::Complete);
        assert_eq!(complete.remaining, Some(0));

        let report = crate::connection_credentials::CleanupReport {
            failed: 1,
            remaining: 2,
            abandoned: 1,
            ..Default::default()
        };
        let pending = CleanupState::from_pass(CleanupPass::Completed(report));
        assert_eq!(pending.status, CleanupStatus::Pending);
        assert_eq!(pending.remaining, Some(2));
        assert_eq!(pending.abandoned, 1);

        let incomplete = CleanupState::from_pass(CleanupPass::Incomplete);
        assert_eq!(incomplete.status, CleanupStatus::Incomplete);
        assert_eq!(incomplete.remaining, None);
        assert_eq!(incomplete.abandoned, 0);
    }
}
