use crate::connection_tls::CaCertificate;
use crate::credentials::CredentialRef;
use crate::data_views::{DataViewLibrary, DataViewRecord};
use crate::error::AppError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use url::Url;
use uuid::Uuid;

/// Highest schema version this build understands. A file above it fails closed instead of being
/// opened with an unknown layout.
const SCHEMA_VERSION: i64 = 7;

/// Hard upper bound for one credential cleanup batch, so no caller can request unbounded work.
pub const MAX_CLEANUP_BATCH: usize = 64;

/// Hard upper bound for stored model profiles, so one database cannot grow without limit.
pub const MAX_MODEL_PROFILES: usize = 128;

/// Hard upper bound for the saved-query document, matching the SQLite check on
/// `saved_query_library` and the bound the Q07 IPC layer repeats before serializing.
pub const MAX_SAVED_QUERIES_BYTES: usize = 4 * 1024 * 1024;

/// Hard upper bound for the stored workspace-recovery document, matching the UTF-8 byte check on
/// `workspace_recovery.json` (migration 006) and the bound the Q07 IPC layer enforces before
/// serializing (`workspace_recovery::MAX_RECOVERY_BYTES`).
const MAX_WORKSPACE_RECOVERY_BYTES: usize = crate::workspace_recovery::MAX_RECOVERY_BYTES;

/// JS-safe upper bound of the recovery revision counter, mirrored by the SQLite check on
/// `workspace_recovery.revision`.
const MAX_WORKSPACE_RECOVERY_REVISION: i64 = 9_007_199_254_740_991;

/// Hard upper bound for stored connections, applied to every read and write path.
const MAX_CONNECTIONS: i64 = 1000;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub mode: String,
    pub accent: String,
    pub locale: String,
    pub ui_font: String,
    pub code_font: String,
    pub ui_size: u8,
    pub code_size: u8,
    pub table_size: u8,
    pub density: String,
    pub time_zone: String,
    pub date_format: String,
    pub grouping: bool,
    /// The frontend contract spells this `startAI`, which `rename_all = "camelCase"` would turn
    /// into `startAi`; the explicit rename keeps both languages on one name. `startAi` stays
    /// readable because builds before this fix wrote that spelling into user databases, and both
    /// spellings together are rejected as ambiguous instead of merged.
    #[serde(rename = "startAI", alias = "startAi")]
    pub start_ai: bool,
    pub start_view: String,
    pub wrap_json: bool,
    pub reduce_motion: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            mode: "system".into(),
            accent: "graphite".into(),
            locale: "system".into(),
            ui_font: "plex".into(),
            code_font: "jetbrains".into(),
            ui_size: 14,
            code_size: 13,
            table_size: 13,
            density: "comfortable".into(),
            time_zone: "system".into(),
            date_format: "locale".into(),
            grouping: true,
            start_ai: false,
            start_view: "table".into(),
            wrap_json: true,
            reduce_motion: false,
        }
    }
}

impl Preferences {
    fn validate(&self) -> Result<(), AppError> {
        let valid = ["system", "light", "dark"].contains(&self.mode.as_str())
            && ["graphite", "jade", "blue", "violet"].contains(&self.accent.as_str())
            && ["system", "zh-CN", "en-US"].contains(&self.locale.as_str())
            && ["plex", "system"].contains(&self.ui_font.as_str())
            && ["jetbrains", "system"].contains(&self.code_font.as_str())
            && ["comfortable", "compact"].contains(&self.density.as_str())
            && ["system", "Asia/Shanghai", "UTC"].contains(&self.time_zone.as_str())
            && ["locale", "iso"].contains(&self.date_format.as_str())
            && ["table", "json"].contains(&self.start_view.as_str())
            && [self.ui_size, self.code_size, self.table_size]
                .iter()
                .all(|size| (12..=20).contains(size));
        if valid {
            Ok(())
        } else {
            Err(AppError::new("invalidInput"))
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionInput {
    pub display_name: String,
    pub endpoint: String,
    pub environment: String,
}

impl ConnectionInput {
    pub(crate) fn validate(mut self) -> Result<Self, AppError> {
        self.display_name = self.display_name.trim().to_owned();
        if self.display_name.is_empty() || self.display_name.chars().count() > 80 {
            return Err(AppError::new("invalidName"));
        }
        self.endpoint = clean_endpoint(&self.endpoint)?;
        if !["development", "staging", "production"].contains(&self.environment.as_str()) {
            return Err(AppError::new("invalidEnvironment"));
        }
        Ok(self)
    }
}

/// Authentication kind recorded for a connection. This is metadata only: the secret payload
/// stays in the OS credential store and its encoding is defined by the authentication code
/// that will consume it, not by this type.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthKind {
    None,
    Basic,
    ApiKey,
    Bearer,
}

impl AuthKind {
    const ALL: [Self; 4] = [Self::None, Self::Basic, Self::ApiKey, Self::Bearer];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Basic => "basic",
            Self::ApiKey => "apiKey",
            Self::Bearer => "bearer",
        }
    }

    /// Strict parse of a persisted value. Anything else fails closed.
    fn parse(value: &str) -> Result<Self, AppError> {
        Self::ALL
            .into_iter()
            .find(|kind| kind.as_str() == value)
            .ok_or_else(|| AppError::new("storageUnavailable"))
    }
}

/// Internal authentication metadata of one connection. Never serialized and never returned over
/// IPC: [`ConnectionProfile::auth`] stays `"none"` for the legacy metadata contract, whose reads
/// refuse bound rows. The authenticated transport uses a separate [`TransportSnapshot`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnectionAuth {
    pub kind: AuthKind,
    pub credential_ref: Option<CredentialRef>,
}

impl ConnectionAuth {
    pub const fn none() -> Self {
        Self {
            kind: AuthKind::None,
            credential_ref: None,
        }
    }

    /// True only for a well-formed unauthenticated state, so callers that gate network access on
    /// this can never treat a half-populated row as safe.
    pub const fn unauthenticated(&self) -> bool {
        matches!(self.kind, AuthKind::None) && self.credential_ref.is_none()
    }
}

/// Why a reference is queued for deletion. `Prepare` means the keyring write may not have
/// happened; `Cleanup` means a previously bound reference was detached.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CleanupReason {
    Prepare,
    Cleanup,
}

impl CleanupReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Prepare => "prepare",
            Self::Cleanup => "cleanup",
        }
    }

    fn parse(value: &str) -> Result<Self, AppError> {
        match value {
            "prepare" => Ok(Self::Prepare),
            "cleanup" => Ok(Self::Cleanup),
            _ => Err(AppError::new("storageUnavailable")),
        }
    }
}

/// One queued credential reference that must not be bound to a connection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingCleanup {
    pub reference: CredentialRef,
    pub reason: CleanupReason,
    pub attempts: i64,
}

/// Queue counts for one cleanup policy. Entries skipped by a cleanup pass stay in the table until
/// their secret is gone, so they can still be counted and recovered later.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CleanupBacklog {
    /// Entries skipped because a connection still references the credential.
    pub deferred: i64,
    /// Entries skipped because they exhausted the retry budget.
    pub abandoned: i64,
    /// Every queued entry, including both skipped categories.
    pub total: i64,
}

/// Result of a metadata write that may detach a credential.
#[derive(Debug)]
pub struct ConnectionRecord {
    pub profile: ConnectionProfile,
    /// Credential detached or replaced by the write, already queued for deletion.
    pub detached: Option<CredentialRef>,
    /// Whether the row now carries a custom CA chain. The chain itself never leaves the module.
    pub has_custom_ca: bool,
}

/// One connection as the credential-aware settings read returns it: the validated profile plus
/// the one CA fact the frontend needs. The credential reference and the CA chain itself never
/// appear here.
#[derive(Debug)]
pub struct ConnectionSummary {
    pub profile: ConnectionProfile,
    pub has_custom_ca: bool,
}

/// Result of a model metadata write that may detach a credential.
#[derive(Debug)]
pub struct ModelRecord {
    pub profile: ModelProfile,
    /// Credential detached or replaced by the write, already queued for deletion.
    pub detached: Option<CredentialRef>,
}

/// The credential action a model write applies in the same transaction as its metadata.
#[derive(Clone, Copy, Debug)]
pub(crate) enum ModelReferenceChange<'a> {
    /// Keep the existing reference, unless the target changed: a new endpoint or protocol can
    /// never silently reuse the authentication the user granted for the old one.
    Keep,
    /// Drop the reference; the secret is queued for deletion.
    Clear,
    /// Bind this freshly written reference, replacing any previous one.
    Replace(&'a CredentialRef),
}

/// One connection row exactly as stored, before validation. Read through this so `load`,
/// `connection`, `bind_credential` and `detach_credential` all apply the same field checks and the
/// same fail-closed credential rules.
struct RawConnection {
    id: String,
    display_name: String,
    endpoint: String,
    environment: String,
    sort_order: i64,
    auth_kind: String,
    credential_ref: Option<String>,
    ca_pem: Option<String>,
}

impl RawConnection {
    const COLUMNS: &'static str =
        "id, display_name, endpoint, environment, sort_order, auth_kind, credential_ref, ca_pem";

    fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            display_name: row.get(1)?,
            endpoint: row.get(2)?,
            environment: row.get(3)?,
            sort_order: row.get(4)?,
            auth_kind: row.get(5)?,
            credential_ref: row.get(6)?,
            ca_pem: row.get(7)?,
        })
    }

    /// Validate the row and return it together with its already-validated custom CA chain. The
    /// chain stays inside this module and the transport; it is never serialized.
    fn into_stored(self) -> Result<StoredConnection, AppError> {
        let auth_state = parse_auth(&self.auth_kind, self.credential_ref.as_deref())?;
        ConnectionInput {
            display_name: self.display_name.clone(),
            endpoint: self.endpoint.clone(),
            environment: self.environment.clone(),
        }
        .validate()
        .map_err(|_| AppError::new("storageUnavailable"))?;
        if Uuid::parse_str(&self.id).is_err() || !(0..=1_000_000).contains(&self.sort_order) {
            return Err(AppError::new("storageUnavailable"));
        }
        let ca = match self.ca_pem.as_deref() {
            // A row the writer could not have produced (foreign or tampered) fails closed here;
            // the code names the CA so the settings page can explain the refusal.
            Some(pem) => Some(CaCertificate::parse(pem)?),
            None => None,
        };
        Ok(StoredConnection {
            profile: ConnectionProfile {
                id: self.id,
                display_name: self.display_name,
                endpoint: self.endpoint,
                environment: self.environment,
                sort_order: self.sort_order,
                auth: "none",
                auth_state,
            },
            ca,
        })
    }
}

/// One validated connection row and its validated custom CA chain, if any. Used only inside this
/// module and by the transport; the chain never reaches the metadata IPC surface.
struct StoredConnection {
    profile: ConnectionProfile,
    ca: Option<CaCertificate>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    pub display_name: String,
    pub endpoint: String,
    pub environment: String,
    pub sort_order: i64,
    /// Legacy IPC authentication label. Metadata reads refuse bound rows rather than reporting
    /// them as `"none"`; the transport uses `auth_state`, which is never serialized.
    pub auth: &'static str,
    #[serde(skip)]
    pub(crate) auth_state: ConnectionAuth,
}

/// Immutable transport snapshot for the internal authenticated read-only path (C01.3).
///
/// The validated row it wraps is private to this module, so the only production way to obtain a
/// snapshot is [`Database::transport_snapshot`]. Callers cannot fabricate or mutate the target
/// (connection ID, normalized endpoint, auth kind, credential reference) a credential is
/// resolved for, and the resolver accepts this snapshot instead of a caller-built profile.
pub struct TransportSnapshot {
    profile: ConnectionProfile,
    /// Validated custom CA chain of this connection, read from the trusted row. Never serialized
    /// and never shared with another connection's client.
    ca: Option<CaCertificate>,
}

impl TransportSnapshot {
    /// The validated profile this snapshot was read from. Read-only: mutating a copy a caller
    /// made cannot change what the snapshot already fixed.
    pub fn profile(&self) -> &ConnectionProfile {
        &self.profile
    }

    /// The validated custom CA chain, if the row carries one. Transport code adds it to its own
    /// per-request client; no other module can serialize it into a record.
    pub(crate) fn ca(&self) -> Option<&CaCertificate> {
        self.ca.as_ref()
    }

    /// Test-only constructor for lower-level fixtures, compiled out of production builds. The
    /// explicit name marks it: a non-test caller can never mint a resolution from a hand-built
    /// profile.
    #[cfg(test)]
    pub(crate) fn for_test(profile: ConnectionProfile) -> Self {
        Self { profile, ca: None }
    }

    /// Test-only variant with a custom CA chain, so the per-request client path is exercised.
    #[cfg(test)]
    pub(crate) fn for_test_with_ca(profile: ConnectionProfile, ca: CaCertificate) -> Self {
        Self {
            profile,
            ca: Some(ca),
        }
    }
}

impl std::fmt::Debug for TransportSnapshot {
    /// Only the connection identity is printable; the credential state stays behind the
    /// resolver, whose own `Debug` redacts the reference and the header.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TransportSnapshot")
            .field("connection_id", &self.profile.id)
            .field("endpoint", &self.profile.endpoint)
            .finish_non_exhaustive()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredState {
    preferences: Preferences,
    connections: Vec<ConnectionProfile>,
    active_connection_id: Option<String>,
}

/// Wire protocol of one model profile. The closed list mirrors the adapters that exist; an
/// unknown value is refused on both read and write instead of being mapped to the closest one.
/// The spelling is part of the shared frontend fixture (`tests/fixtures/models-*.json`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum ModelProtocol {
    #[serde(rename = "openaiCompatible")]
    OpenaiCompatible,
    #[serde(rename = "ollama")]
    Ollama,
}

impl ModelProtocol {
    const ALL: [Self; 2] = [Self::OpenaiCompatible, Self::Ollama];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OpenaiCompatible => "openaiCompatible",
            Self::Ollama => "ollama",
        }
    }

    /// Strict parse of a persisted value. Anything else fails closed.
    fn parse(value: &str) -> Result<Self, AppError> {
        Self::ALL
            .into_iter()
            .find(|protocol| protocol.as_str() == value)
            .ok_or_else(|| AppError::new("storageUnavailable"))
    }
}

/// One model profile as the frontend submits it. This is configuration only: there is no field for
/// an API key, token, header, prompt or credential reference, and `deny_unknown_fields` means a
/// payload carrying one is rejected instead of silently stripped.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelInput {
    pub display_name: String,
    pub protocol: ModelProtocol,
    pub endpoint: String,
    pub model_id: String,
}

impl ModelInput {
    fn validate(mut self) -> Result<Self, AppError> {
        self.display_name = self.display_name.trim().to_owned();
        if self.display_name.is_empty() || self.display_name.chars().count() > 80 {
            return Err(AppError::new("invalidName"));
        }
        self.model_id = self.model_id.trim().to_owned();
        if self.model_id.is_empty() || self.model_id.chars().count() > 200 {
            return Err(AppError::new("invalidInput"));
        }
        self.endpoint = clean_endpoint(&self.endpoint)?;
        Ok(self)
    }
}

/// One stored model profile. Serialized exactly as `tests/fixtures/models-state-canonical.json`
/// spells it: `hasApiKey` is the only credential fact on the wire, and the reference itself is
/// skipped so it can never be returned, logged or accepted from a caller. `Deserialize` exists so
/// the fixture can be pinned from the Rust side too.
#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelProfile {
    pub id: String,
    pub display_name: String,
    pub protocol: ModelProtocol,
    pub endpoint: String,
    pub model_id: String,
    pub sort_order: i64,
    /// Whether a credential reference is persisted for this row. It says nothing about whether the
    /// secret still exists in the OS store or whether the model can be used successfully.
    pub has_api_key: bool,
    /// The trusted reference persisted on the row. Resolved only from here, never supplied by a
    /// caller, and never serialized.
    #[serde(skip)]
    pub(crate) credential_ref: Option<CredentialRef>,
}

/// Everything the model settings page reads in one call, so the list and the default selection can
/// never be read from two different states. `default_model_id` is the resolved default: the stored
/// selection while it still names a profile, otherwise the first profile, otherwise `None`.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelsState {
    pub profiles: Vec<ModelProfile>,
    pub default_model_id: Option<String>,
    /// True while the shared credential outbox still holds a reference that may exist in the OS
    /// store. A warning, not a failure: `models_cleanup` retries the bounded deletion.
    pub credential_cleanup_pending: bool,
}

/// One model row exactly as stored, before validation. Read through this so `models`, `save_model`
/// and `delete_model` all apply the same field checks.
struct RawModel {
    id: String,
    display_name: String,
    protocol: String,
    endpoint: String,
    model_id: String,
    sort_order: i64,
    credential_ref: Option<String>,
}

impl RawModel {
    const COLUMNS: &'static str =
        "id, display_name, protocol, endpoint, model_id, sort_order, credential_ref";

    fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            display_name: row.get(1)?,
            protocol: row.get(2)?,
            endpoint: row.get(3)?,
            model_id: row.get(4)?,
            sort_order: row.get(5)?,
            credential_ref: row.get(6)?,
        })
    }

    /// Validate every stored field. Anything the writer could not have produced through this module
    /// fails closed instead of reaching a caller.
    fn into_profile(self) -> Result<ModelProfile, AppError> {
        let protocol = ModelProtocol::parse(&self.protocol)?;
        if Uuid::parse_str(&self.id).is_err() || !(0..=1_000_000).contains(&self.sort_order) {
            return Err(AppError::new("storageUnavailable"));
        }
        // A reference is only usable when it is the canonical spelling this module writes.
        let credential_ref = match self.credential_ref.as_deref() {
            Some(value) => {
                Some(CredentialRef::parse(value).map_err(|_| AppError::new("storageUnavailable"))?)
            }
            None => None,
        };
        let clean = ModelInput {
            display_name: self.display_name,
            protocol,
            endpoint: self.endpoint,
            model_id: self.model_id,
        }
        .validate()
        .map_err(|_| AppError::new("storageUnavailable"))?;
        Ok(ModelProfile {
            id: self.id,
            display_name: clean.display_name,
            protocol: clean.protocol,
            endpoint: clean.endpoint,
            model_id: clean.model_id,
            sort_order: self.sort_order,
            has_api_key: credential_ref.is_some(),
            credential_ref,
        })
    }
}

pub struct Database(Connection);

impl Database {
    /// Read one connection for the legacy IPC surface. A connection with a bound credential is
    /// refused: the legacy profile reports `auth: "none"`, which would misrepresent it. The
    /// authenticated transport reads through [`Database::transport_snapshot`] instead.
    pub fn connection(&self, id: &str) -> Result<ConnectionProfile, AppError> {
        Uuid::parse_str(id).map_err(|_| AppError::new("invalidInput"))?;
        let stored = self
            .read_connection(id)?
            .ok_or_else(|| AppError::new("notFound"))?;
        if !stored.profile.auth_state.unauthenticated() {
            return Err(AppError::new("unsupported"));
        }
        Ok(stored.profile)
    }

    /// Read one connection row including its credential metadata and custom CA chain, without the
    /// legacy refusal. Each caller keeps its own gate: [`Database::connection`] refuses bound rows
    /// for the legacy IPC surface, [`Database::transport_snapshot`] seals the row for the
    /// authenticated transport, and the credential orchestration reads it for a write.
    fn read_connection(&self, id: &str) -> Result<Option<StoredConnection>, AppError> {
        let raw = self
            .0
            .query_row(
                &format!(
                    "SELECT {} FROM connections WHERE id=?1",
                    RawConnection::COLUMNS
                ),
                [id],
                RawConnection::read,
            )
            .optional()?;
        raw.map(RawConnection::into_stored).transpose()
    }

    /// Trusted snapshot for the internal authenticated transport (C01.3/C04.1): the same validated
    /// row as [`Database::connection`], without the legacy refusal, so the credential a bound
    /// connection owns and the CA chain it trusts can be used for a request. The snapshot seals
    /// the target — the resolver cannot be pointed at a different endpoint or reference, and the
    /// client builder cannot mix one connection's chain into another's request — and the IPC
    /// surface does not change: the legacy metadata commands keep refusing bound rows.
    pub fn transport_snapshot(&self, id: &str) -> Result<TransportSnapshot, AppError> {
        Uuid::parse_str(id).map_err(|_| AppError::new("invalidInput"))?;
        self.read_connection(id)?
            .map(|stored| TransportSnapshot {
                profile: stored.profile,
                ca: stored.ca,
            })
            .ok_or_else(|| AppError::new("notFound"))
    }

    pub fn open(path: &Path) -> Result<Self, AppError> {
        let mut conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(3))?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        let mut version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(AppError::new("unsupported"));
        }
        while version < SCHEMA_VERSION {
            let next = version + 1;
            // One transaction per step: a failing step rolls back both its DDL and its
            // `user_version` bump, so the next attempt restarts from the same version.
            let tx = conn.transaction()?;
            match next {
                1 => tx.execute_batch(include_str!("../migrations/001_initial.sql"))?,
                2 => tx.execute_batch(include_str!("../migrations/002_credentials.sql"))?,
                3 => tx.execute_batch(include_str!("../migrations/003_models.sql"))?,
                4 => tx.execute_batch(include_str!("../migrations/004_model_credentials.sql"))?,
                5 => tx.execute_batch(include_str!("../migrations/005_connection_settings.sql"))?,
                6 => tx.execute_batch(include_str!("../migrations/006_workspace_recovery.sql"))?,
                7 => tx.execute_batch(include_str!("../migrations/007_data_views.sql"))?,
                _ => return Err(AppError::new("unsupported")),
            }
            tx.commit()?;
            let applied: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
            if applied != next {
                return Err(AppError::new("storageUnavailable"));
            }
            version = applied;
        }
        Ok(Self(conn))
    }

    /// The stored preferences, validated. A missing row means defaults; a corrupt row fails
    /// closed and is never overwritten by a read.
    pub fn preferences(&self) -> Result<Preferences, AppError> {
        let raw: Option<String> = self
            .0
            .query_row(
                "SELECT json FROM preferences WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let preferences = match raw {
            Some(json) => serde_json::from_str::<Preferences>(&json)
                .map_err(|_| AppError::new("storageUnavailable"))?,
            None => Preferences::default(),
        };
        preferences
            .validate()
            .map_err(|_| AppError::new("storageUnavailable"))?;
        Ok(preferences)
    }

    /// Legacy state read. A row with a bound credential is refused (`unsupported`), because this
    /// record cannot describe one truthfully; the authenticated settings read is
    /// [`Database::connection_summaries`].
    pub fn load(&self) -> Result<StoredState, AppError> {
        let preferences = self.preferences()?;
        let mut connections = Vec::new();
        for summary in self.connection_summaries()? {
            let profile = summary.profile;
            if !profile.auth_state.unauthenticated() {
                // The legacy state read reports every connection as `auth: "none"`. Rather than
                // misrepresent a connection that has a credential, it refuses the whole read until
                // the credential-aware contract exists.
                return Err(AppError::new("unsupported"));
            }
            connections.push(profile);
        }
        let selected = self.stored_active_connection_id()?;
        let active_connection_id = selected
            .filter(|id| connections.iter().any(|profile| &profile.id == id))
            .or_else(|| connections.first().map(|profile| profile.id.clone()));
        Ok(StoredState {
            preferences,
            connections,
            active_connection_id,
        })
    }

    /// Every stored connection including its authenticated state, for the credential-aware
    /// settings read. Each row is validated exactly like a legacy read; the credential reference
    /// is never part of the result.
    pub fn connection_summaries(&self) -> Result<Vec<ConnectionSummary>, AppError> {
        let mut statement = self.0.prepare(&format!(
            "SELECT {} FROM connections ORDER BY sort_order, id",
            RawConnection::COLUMNS
        ))?;
        let rows = statement
            .query_map([], RawConnection::read)?
            .collect::<Result<Vec<_>, _>>()?;
        if rows.len() as i64 > MAX_CONNECTIONS {
            return Err(AppError::new("storageUnavailable"));
        }
        let mut summaries = Vec::with_capacity(rows.len());
        for raw in rows {
            let stored = raw.into_stored()?;
            summaries.push(ConnectionSummary {
                profile: stored.profile,
                has_custom_ca: stored.ca.is_some(),
            });
        }
        Ok(summaries)
    }

    /// The stored active connection selection, exactly as persisted. Callers resolve it against
    /// the connection list they actually returned.
    pub fn stored_active_connection_id(&self) -> Result<Option<String>, AppError> {
        Ok(self.0.query_row(
            "SELECT active_connection_id FROM workspace WHERE singleton=1",
            [],
            |row| row.get(0),
        )?)
    }

    /// The saved-query document as stored, or `None` when nothing was saved yet. Shared storage
    /// only: the document is opaque here, and its typed validation belongs to the Q07 module that
    /// owns the schema of this JSON.
    pub fn saved_queries_json(&self) -> Result<Option<String>, AppError> {
        Ok(self
            .0
            .query_row(
                "SELECT json FROM saved_query_library WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Store the saved-query document in one atomic upsert. The byte bound is enforced here as
    /// well as by the table check, so an oversized payload is refused before it is written and the
    /// previous document stays intact.
    #[cfg(test)]
    pub fn save_saved_queries_json(&self, json: &str) -> Result<(), AppError> {
        if json.len() > MAX_SAVED_QUERIES_BYTES {
            return Err(AppError::new("invalidInput"));
        }
        self.0.execute(
            "INSERT INTO saved_query_library(singleton,json) VALUES (1,?1) ON CONFLICT(singleton) DO UPDATE SET json=excluded.json",
            [json],
        )?;
        Ok(())
    }

    /// CAS also guards import connection choices in the same write transaction. No credentials
    /// are loaded: a mapping binds only an existing stable ID and its reviewed endpoint.
    pub(crate) fn compare_saved_queries_json(
        &mut self,
        expected: Option<&str>,
        json: &str,
        targets: &[(String, String)],
    ) -> Result<(), AppError> {
        if json.len() > MAX_SAVED_QUERIES_BYTES {
            return Err(AppError::new("invalidInput"));
        }
        let tx = self
            .0
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let current: Option<String> = tx
            .query_row(
                "SELECT json FROM saved_query_library WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if current.as_deref() != expected {
            return Err(AppError::new("libraryConflict"));
        }
        for (id, endpoint) in targets {
            let stored: Option<String> = tx
                .query_row(
                    "SELECT endpoint FROM connections WHERE id=?1",
                    [id],
                    |row| row.get(0),
                )
                .optional()?;
            if stored.as_deref() != Some(endpoint.as_str()) {
                return Err(AppError::new("exchangeTargetChanged"));
            }
        }
        tx.execute(
            "INSERT INTO saved_query_library(singleton,json) VALUES (1,?1) ON CONFLICT(singleton) DO UPDATE SET json=excluded.json",
            [json],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// The singleton workspace-recovery row exactly as stored, or `None` when no document was
    /// saved yet. Reading never inserts, repairs or rewrites anything; typed validation of the
    /// document, and with it the `invalidResponse` contract of the load command, belongs to
    /// `workspace_recovery`.
    pub(crate) fn workspace_recovery_row(&self) -> Result<Option<WorkspaceRecoveryRow>, AppError> {
        read_workspace_recovery_row(&self.0)
    }

    /// Compare-and-swap the recovery document in one SQL transaction. `json` is applied only when
    /// the stored revision still equals `expected_revision` (`0` means no row exists yet), and the
    /// whole document is stored with `revision + 1` atomically, returning the new revision. The
    /// stored document is validated before the revision is compared, so a corrupt or future row is
    /// never overwritten - not even by a writer whose expected revision happens to match. A stale
    /// writer gets `workspaceConflict` and the stored bytes stay untouched; the caller validates
    /// the incoming document before it reaches this method.
    pub(crate) fn save_workspace_recovery(
        &mut self,
        expected_revision: u64,
        json: &str,
    ) -> Result<u64, AppError> {
        let Ok(expected_revision) = i64::try_from(expected_revision) else {
            return Err(AppError::new("invalidInput"));
        };
        if !(0..=MAX_WORKSPACE_RECOVERY_REVISION).contains(&expected_revision)
            || json.len() > MAX_WORKSPACE_RECOVERY_BYTES
        {
            return Err(AppError::new("invalidInput"));
        }
        let tx = self.0.transaction()?;
        match read_workspace_recovery_row(&tx)? {
            Some(row) => {
                crate::workspace_recovery::decode_stored(&row.json)?;
                if row.revision != expected_revision {
                    return Err(AppError::new("workspaceConflict"));
                }
                let next = row
                    .revision
                    .checked_add(1)
                    .filter(|next| *next <= MAX_WORKSPACE_RECOVERY_REVISION)
                    .ok_or_else(|| AppError::new("storageUnavailable"))?;
                tx.execute(
                    "UPDATE workspace_recovery SET revision=?1, json=?2 WHERE singleton=1",
                    params![next, json],
                )?;
                tx.commit()?;
                Ok(next as u64)
            }
            None => {
                if expected_revision != 0 {
                    return Err(AppError::new("workspaceConflict"));
                }
                tx.execute(
                    "INSERT INTO workspace_recovery(singleton,revision,json) VALUES (1,1,?1)",
                    [json],
                )?;
                tx.commit()?;
                Ok(1)
            }
        }
    }

    pub(crate) fn data_views(&self) -> Result<DataViewRecord, AppError> {
        read_data_views(&self.0)
    }

    /// Validate the stored document and immutable connection ownership under the same CAS lock.
    /// New definitions require an existing ID; old definitions survive deletion without rebinding.
    pub(crate) fn save_data_views(
        &mut self,
        expected_revision: u64,
        library: &DataViewLibrary,
    ) -> Result<u64, AppError> {
        library.validate()?;
        if expected_revision >= crate::data_views::MAX_REVISION {
            return Err(AppError::new("invalidInput"));
        }
        let json = serde_json::to_string(library).map_err(|_| AppError::new("invalidInput"))?;
        let tx = self
            .0
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let current = read_data_views(&tx)?;
        if expected_revision != current.revision {
            return Err(AppError::new("dataViewConflict"));
        }
        for entry in &library.entries {
            if let Some(previous) = current
                .library
                .entries
                .iter()
                .find(|previous| previous.id == entry.id)
            {
                if entry.connection_id != previous.connection_id {
                    return Err(AppError::new("invalidInput"));
                }
            } else {
                let exists: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM connections WHERE id=?1)",
                    [&entry.connection_id],
                    |row| row.get(0),
                )?;
                if !exists {
                    return Err(AppError::new("dataViewConnectionMissing"));
                }
            }
        }
        let revision = expected_revision + 1;
        tx.execute(
            "INSERT INTO data_view_library(singleton,revision,json) VALUES (1,?1,?2)
             ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,json=excluded.json",
            params![revision, json],
        )?;
        tx.commit()?;
        Ok(revision)
    }

    pub fn save_preferences(&self, preferences: Preferences) -> Result<(), AppError> {
        preferences.validate()?;
        let json =
            serde_json::to_string(&preferences).map_err(|_| AppError::new("invalidInput"))?;
        self.0.execute(
            "INSERT INTO preferences(singleton,json) VALUES (1,?1) ON CONFLICT(singleton) DO UPDATE SET json=excluded.json",
            [json],
        )?;
        Ok(())
    }

    /// Credential-aware metadata write used by the credential orchestration. Changing the endpoint
    /// detaches a bound credential so the old secret is never reused for a new target.
    pub fn save_connection(
        &mut self,
        input: ConnectionInput,
        id: Option<String>,
    ) -> Result<ConnectionRecord, AppError> {
        self.write_connection(input, id, BoundCredential::Manage)
    }

    /// Legacy IPC metadata path. A connection that has a bound credential is refused with
    /// `unsupported` before anything is modified: the legacy commands cannot report credential
    /// handling, and must never detach or delete a secret they cannot describe.
    pub fn save_connection_metadata_only(
        &mut self,
        input: ConnectionInput,
        id: Option<String>,
    ) -> Result<ConnectionProfile, AppError> {
        self.write_connection(input, id, BoundCredential::Reject)
            .map(|record| record.profile)
    }

    fn write_connection(
        &mut self,
        input: ConnectionInput,
        id: Option<String>,
        policy: BoundCredential,
    ) -> Result<ConnectionRecord, AppError> {
        let clean = input.validate()?;
        let tx = self.0.transaction()?;
        let (id, sort_order, auth_state, detached, ca_state) = match id {
            Some(id) => {
                Uuid::parse_str(&id).map_err(|_| AppError::new("invalidInput"))?;
                let previous = tx
                    .query_row(
                        "SELECT sort_order, endpoint, auth_kind, credential_ref, ca_pem FROM connections WHERE id=?1",
                        [&id],
                        |row| {
                            Ok((
                                row.get::<_, i64>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, Option<String>>(3)?,
                                row.get::<_, Option<String>>(4)?,
                            ))
                        },
                    )
                    .optional()?
                    .ok_or_else(|| AppError::new("notFound"))?;
                let auth = parse_auth(&previous.2, previous.3.as_deref())?;
                if policy == BoundCredential::Reject && !auth.unauthenticated() {
                    return Err(AppError::new("unsupported"));
                }
                // A credential (and a custom CA) was captured for one endpoint. Sending the old
                // secret or trusting the old chain for a different host would silently reuse
                // something granted for another target, so an endpoint change detaches the
                // credential in the same transaction, queues the secret for deletion and drops
                // the chain. Renaming keeps both, plus the stable id.
                let target_changed = previous.1 != clean.endpoint;
                let detached = if target_changed {
                    auth.credential_ref.clone()
                } else {
                    None
                };
                let auth_state = if detached.is_some() {
                    ConnectionAuth::none()
                } else {
                    auth
                };
                let ca_state = if target_changed {
                    None
                } else {
                    previous
                        .4
                        .as_deref()
                        .map(CaCertificate::parse)
                        .transpose()?
                };
                (id, previous.0, auth_state, detached, ca_state)
            }
            None => {
                let count: i64 =
                    tx.query_row("SELECT count(*) FROM connections", [], |row| row.get(0))?;
                if count >= MAX_CONNECTIONS {
                    return Err(AppError::new("invalidInput"));
                }
                let order: i64 = tx.query_row(
                    "SELECT coalesce(max(sort_order),-1)+1 FROM connections",
                    [],
                    |row| row.get(0),
                )?;
                (
                    Uuid::new_v4().to_string(),
                    order,
                    ConnectionAuth::none(),
                    None,
                    None,
                )
            }
        };
        tx.execute(
            "INSERT INTO connections(id,display_name,endpoint,environment,sort_order,auth_kind,credential_ref,ca_pem)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,endpoint=excluded.endpoint,
               environment=excluded.environment,auth_kind=excluded.auth_kind,
               credential_ref=excluded.credential_ref,ca_pem=excluded.ca_pem",
            params![
                id,
                clean.display_name,
                clean.endpoint,
                clean.environment,
                sort_order,
                auth_state.kind.as_str(),
                auth_state.credential_ref.as_ref().map(CredentialRef::as_str),
                ca_state.as_ref().map(CaCertificate::as_pem)
            ],
        )?;
        if let Some(reference) = &detached {
            queue_cleanup(&tx, reference, CleanupReason::Cleanup)?;
        }
        let stored = read_stored_connection(&tx, &id)?;
        tx.commit()?;
        Ok(ConnectionRecord {
            profile: stored.profile,
            detached,
            has_custom_ca: stored.ca.is_some(),
        })
    }

    /// Validate metadata, identity and bounds before any keyring side effect. The combined write
    /// transaction repeats every check, so this only narrows the window in which a rejected
    /// request could have touched the OS store.
    pub fn connection_save_precheck(
        &self,
        input: &ConnectionInput,
        id: Option<&str>,
    ) -> Result<(), AppError> {
        input.clone().validate()?;
        match id {
            Some(id) => {
                Uuid::parse_str(id).map_err(|_| AppError::new("invalidInput"))?;
                let exists: bool = self.0.query_row(
                    "SELECT EXISTS(SELECT 1 FROM connections WHERE id=?1)",
                    [id],
                    |row| row.get(0),
                )?;
                if !exists {
                    return Err(AppError::new("notFound"));
                }
            }
            None => {
                let count: i64 =
                    self.0
                        .query_row("SELECT count(*) FROM connections", [], |row| row.get(0))?;
                if count >= MAX_CONNECTIONS {
                    return Err(AppError::new("invalidInput"));
                }
            }
        }
        Ok(())
    }

    /// One authenticated write that commits metadata, the credential reference and the custom CA
    /// chain in a single transaction, applying the target rule to every part:
    ///
    /// - `Replace` binds the freshly written reference and queues the previous one;
    /// - `Keep` preserves the reference and the chain while the endpoint is unchanged;
    /// - a changed endpoint detaches the old reference (queued for deletion) and drops the old
    ///   chain even under `Keep`, because neither was granted for the new target; renaming keeps
    ///   both.
    ///
    /// The reference must already exist in the OS store: this method never writes a secret, and a
    /// caller that changes its mind afterwards must use the shared outbox to account for the
    /// orphan. The returned record is built inside the transaction, so a post-commit read failure
    /// can never be mistaken for a rolled-back write.
    pub(crate) fn save_connection_combined(
        &mut self,
        input: ConnectionInput,
        id: Option<String>,
        change: ConnectionReferenceChange<'_>,
        ca: ConnectionCaChange,
    ) -> Result<ConnectionRecord, AppError> {
        if let ConnectionReferenceChange::Replace { kind, .. } = change {
            // A replacement always names a real scheme; `none` cannot bind.
            if kind == AuthKind::None {
                return Err(AppError::new("invalidInput"));
            }
        }
        let clean = input.validate()?;
        let tx = self.0.transaction()?;
        let (id, sort_order, previous) = match id {
            Some(id) => {
                Uuid::parse_str(&id).map_err(|_| AppError::new("invalidInput"))?;
                let stored = tx
                    .query_row(
                        "SELECT sort_order, endpoint, auth_kind, credential_ref, ca_pem FROM connections WHERE id=?1",
                        [&id],
                        |row| {
                            Ok((
                                row.get::<_, i64>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, Option<String>>(3)?,
                                row.get::<_, Option<String>>(4)?,
                            ))
                        },
                    )
                    .optional()?
                    .ok_or_else(|| AppError::new("notFound"))?;
                (id, stored.0, Some(stored))
            }
            None => {
                let count: i64 =
                    tx.query_row("SELECT count(*) FROM connections", [], |row| row.get(0))?;
                if count >= MAX_CONNECTIONS {
                    return Err(AppError::new("invalidInput"));
                }
                let order: i64 = tx.query_row(
                    "SELECT coalesce(max(sort_order),-1)+1 FROM connections",
                    [],
                    |row| row.get(0),
                )?;
                (Uuid::new_v4().to_string(), order, None)
            }
        };
        let target_changed = previous
            .as_ref()
            .is_some_and(|stored| stored.1 != clean.endpoint);
        let previous_auth = match &previous {
            Some(stored) => parse_auth(&stored.2, stored.3.as_deref())?,
            None => ConnectionAuth::none(),
        };
        let previous_ca = match &previous {
            Some(stored) => match stored.4.as_deref() {
                Some(pem) => Some(CaCertificate::parse(pem)?),
                None => None,
            },
            None => None,
        };
        let (auth_state, detached) = match change {
            ConnectionReferenceChange::Keep if target_changed => {
                (ConnectionAuth::none(), previous_auth.credential_ref.clone())
            }
            ConnectionReferenceChange::Keep => (previous_auth, None),
            ConnectionReferenceChange::Clear => {
                (ConnectionAuth::none(), previous_auth.credential_ref.clone())
            }
            ConnectionReferenceChange::Replace { kind, reference } => {
                let detached = previous_auth
                    .credential_ref
                    .filter(|previous_ref| previous_ref != reference);
                (
                    ConnectionAuth {
                        kind,
                        credential_ref: Some(reference.clone()),
                    },
                    detached,
                )
            }
        };
        let ca_state = match ca {
            ConnectionCaChange::Keep if target_changed => None,
            ConnectionCaChange::Keep => previous_ca,
            ConnectionCaChange::Clear => None,
            ConnectionCaChange::Replace(certificate) => Some(certificate),
        };
        tx.execute(
            "INSERT INTO connections(id,display_name,endpoint,environment,sort_order,auth_kind,credential_ref,ca_pem)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,endpoint=excluded.endpoint,
               environment=excluded.environment,auth_kind=excluded.auth_kind,
               credential_ref=excluded.credential_ref,ca_pem=excluded.ca_pem",
            params![
                id,
                clean.display_name,
                clean.endpoint,
                clean.environment,
                sort_order,
                auth_state.kind.as_str(),
                auth_state.credential_ref.as_ref().map(CredentialRef::as_str),
                ca_state.as_ref().map(CaCertificate::as_pem)
            ],
        )?;
        if let Some(reference) = &auth_state.credential_ref {
            // The reference is bound to this row now, so a prepare entry would be stale.
            tx.execute(
                "DELETE FROM credential_cleanup WHERE reference=?1",
                [reference.as_str()],
            )?;
        }
        if let Some(reference) = &detached {
            queue_cleanup(&tx, reference, CleanupReason::Cleanup)?;
        }
        let stored = read_stored_connection(&tx, &id)?;
        tx.commit()?;
        Ok(ConnectionRecord {
            profile: stored.profile,
            detached,
            has_custom_ca: stored.ca.is_some(),
        })
    }

    pub fn select_connection(&self, id: Option<String>) -> Result<(), AppError> {
        if let Some(ref id) = id {
            let exists: bool = self.0.query_row(
                "SELECT EXISTS(SELECT 1 FROM connections WHERE id=?1)",
                [id],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(AppError::new("notFound"));
            }
        }
        self.0.execute(
            "UPDATE workspace SET active_connection_id=?1 WHERE singleton=1",
            [id],
        )?;
        Ok(())
    }

    /// Delete a connection and queue its credential reference in the same transaction, so the
    /// secret is never deleted before the metadata that referenced it is gone. Returns the
    /// detached reference for the caller to clean up.
    pub fn delete_connection(&mut self, id: &str) -> Result<Option<CredentialRef>, AppError> {
        self.remove_connection(id, BoundCredential::Manage)
    }

    /// Legacy IPC metadata path. A connection that has a bound credential is refused with
    /// `unsupported` before the row is touched, so the secret stays bound and intact.
    pub fn delete_connection_metadata_only(&mut self, id: &str) -> Result<(), AppError> {
        self.remove_connection(id, BoundCredential::Reject)
            .map(|_| ())
    }

    fn remove_connection(
        &mut self,
        id: &str,
        policy: BoundCredential,
    ) -> Result<Option<CredentialRef>, AppError> {
        let tx = self.0.transaction()?;
        let stored = tx
            .query_row(
                "SELECT auth_kind, credential_ref FROM connections WHERE id=?1",
                [id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?;
        let detached = match stored {
            Some((kind, reference)) => {
                let auth = parse_auth(&kind, reference.as_deref())?;
                if policy == BoundCredential::Reject && !auth.unauthenticated() {
                    return Err(AppError::new("unsupported"));
                }
                auth.credential_ref
            }
            None => return Err(AppError::new("notFound")),
        };
        tx.execute("DELETE FROM connections WHERE id=?1", [id])?;
        tx.execute(
            "UPDATE workspace SET active_connection_id=(SELECT id FROM connections ORDER BY sort_order,id LIMIT 1)
             WHERE singleton=1 AND active_connection_id IS NULL", [],
        )?;
        if let Some(reference) = &detached {
            queue_cleanup(&tx, reference, CleanupReason::Cleanup)?;
        }
        tx.commit()?;
        Ok(detached)
    }

    /// Model profiles plus the resolved default selection, read in one shot. A stored default that
    /// no longer names a profile falls back to the first one — the same rule the frontend session
    /// adapter applies, so both adapters answer the same question with the same answer. The
    /// credential flag reports the shared outbox, never a keyring probe.
    pub fn models(&self) -> Result<ModelsState, AppError> {
        let mut statement = self.0.prepare(&format!(
            "SELECT {} FROM model_profiles ORDER BY sort_order, id",
            RawModel::COLUMNS
        ))?;
        let rows = statement
            .query_map([], RawModel::read)?
            .collect::<Result<Vec<_>, _>>()?;
        if rows.len() > MAX_MODEL_PROFILES {
            return Err(AppError::new("storageUnavailable"));
        }
        let mut profiles = Vec::with_capacity(rows.len());
        for raw in rows {
            profiles.push(raw.into_profile()?);
        }
        let stored: Option<String> = self.0.query_row(
            "SELECT default_model_id FROM workspace WHERE singleton=1",
            [],
            |row| row.get(0),
        )?;
        let default_model_id = stored
            .filter(|id| profiles.iter().any(|profile| &profile.id == id))
            .or_else(|| profiles.first().map(|profile| profile.id.clone()));
        Ok(ModelsState {
            profiles,
            default_model_id,
            credential_cleanup_pending: self.pending_credential_cleanup_count()? > 0,
        })
    }

    /// Trusted read of one model profile including its credential reference. Used by the
    /// credential and discovery paths; the reference never leaves the backend.
    pub fn model_profile(&self, id: &str) -> Result<ModelProfile, AppError> {
        Uuid::parse_str(id).map_err(|_| AppError::new("invalidInput"))?;
        read_model_row(&self.0, id)?.ok_or_else(|| AppError::new("notFound"))
    }

    /// Validate metadata, identity and bounds before any keyring side effect. The write
    /// transaction repeats every check, so this only narrows the window in which a rejected
    /// request could have touched the OS store.
    pub fn model_save_precheck(
        &self,
        input: &ModelInput,
        id: Option<&str>,
    ) -> Result<(), AppError> {
        input.clone().validate()?;
        match id {
            Some(id) => {
                Uuid::parse_str(id).map_err(|_| AppError::new("invalidInput"))?;
                let exists: bool = self.0.query_row(
                    "SELECT EXISTS(SELECT 1 FROM model_profiles WHERE id=?1)",
                    [id],
                    |row| row.get(0),
                )?;
                if !exists {
                    return Err(AppError::new("notFound"));
                }
            }
            None => {
                let count: i64 =
                    self.0
                        .query_row("SELECT count(*) FROM model_profiles", [], |row| row.get(0))?;
                if count >= MAX_MODEL_PROFILES as i64 {
                    return Err(AppError::new("invalidInput"));
                }
            }
        }
        Ok(())
    }

    /// Create or update one model profile without touching its credential. Kept for callers that
    /// only own metadata; a target change still detaches the old reference and queues it, so this
    /// path can never leave an old secret bound to a new endpoint or protocol.
    pub fn save_model(
        &mut self,
        input: ModelInput,
        id: Option<String>,
    ) -> Result<ModelProfile, AppError> {
        Ok(self
            .save_model_record(input, id, ModelReferenceChange::Keep)?
            .profile)
    }

    /// Create or update one model profile and apply a credential action in the same transaction.
    /// `id` is the stable identity: an update keeps it and its sort order, and a new profile is
    /// appended. The returned snapshot is built inside the transaction, so a post-commit read
    /// failure can never be mistaken for a rolled-back write.
    ///
    /// Target rules: renaming or changing only the model id keeps the reference; changing the
    /// endpoint or the protocol detaches it unless the caller binds a replacement in the same
    /// write. A detached or replaced reference is queued for deletion inside this transaction and
    /// is only removed from the OS store afterwards.
    pub(crate) fn save_model_record(
        &mut self,
        input: ModelInput,
        id: Option<String>,
        change: ModelReferenceChange<'_>,
    ) -> Result<ModelRecord, AppError> {
        let clean = input.validate()?;
        let tx = self.0.transaction()?;
        let (id, sort_order, previous, previous_target) = match id {
            Some(id) => {
                Uuid::parse_str(&id).map_err(|_| AppError::new("invalidInput"))?;
                let stored = tx
                    .query_row(
                        "SELECT sort_order, protocol, endpoint, credential_ref FROM model_profiles WHERE id=?1",
                        [&id],
                        |row| {
                            Ok((
                                row.get::<_, i64>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, Option<String>>(3)?,
                            ))
                        },
                    )
                    .optional()?
                    .ok_or_else(|| AppError::new("notFound"))?;
                let previous = stored
                    .3
                    .as_deref()
                    .map(CredentialRef::parse)
                    .transpose()
                    .map_err(|_| AppError::new("storageUnavailable"))?;
                (
                    id,
                    stored.0,
                    previous,
                    Some((ModelProtocol::parse(&stored.1)?, stored.2)),
                )
            }
            None => {
                let count: i64 =
                    tx.query_row("SELECT count(*) FROM model_profiles", [], |row| row.get(0))?;
                if count >= MAX_MODEL_PROFILES as i64 {
                    return Err(AppError::new("invalidInput"));
                }
                let order: i64 = tx.query_row(
                    "SELECT coalesce(max(sort_order),-1)+1 FROM model_profiles",
                    [],
                    |row| row.get(0),
                )?;
                (Uuid::new_v4().to_string(), order, None, None)
            }
        };
        let target_changed = previous_target
            .map(|(protocol, endpoint)| protocol != clean.protocol || endpoint != clean.endpoint)
            .unwrap_or(false);
        let (next, detached) = match change {
            ModelReferenceChange::Keep if target_changed => (None, previous),
            ModelReferenceChange::Keep => (previous, None),
            ModelReferenceChange::Clear => (None, previous),
            ModelReferenceChange::Replace(reference) => (
                Some(reference.clone()),
                previous.filter(|old| old != reference),
            ),
        };
        tx.execute(
            "INSERT INTO model_profiles(id,display_name,protocol,endpoint,model_id,sort_order,credential_ref)
             VALUES (?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,protocol=excluded.protocol,
               endpoint=excluded.endpoint,model_id=excluded.model_id,credential_ref=excluded.credential_ref",
            params![
                id,
                clean.display_name,
                clean.protocol.as_str(),
                clean.endpoint,
                clean.model_id,
                sort_order,
                next.as_ref().map(CredentialRef::as_str)
            ],
        )?;
        if let Some(reference) = &next {
            // The reference is bound to this row now, so a prepare entry would be stale.
            tx.execute(
                "DELETE FROM credential_cleanup WHERE reference=?1",
                [reference.as_str()],
            )?;
        }
        if let Some(reference) = &detached {
            queue_cleanup(&tx, reference, CleanupReason::Cleanup)?;
        }
        let profile = read_model_row(&tx, &id)?.ok_or_else(|| AppError::new("notFound"))?;
        tx.commit()?;
        Ok(ModelRecord { profile, detached })
    }

    /// Delete one profile and repair the stored default in the same transaction: the selection
    /// moves to the first remaining profile, or becomes `NULL` when none is left. Without this the
    /// row would keep pointing at an id that no longer exists.
    pub fn delete_model(&mut self, id: &str) -> Result<(), AppError> {
        self.delete_model_record(id).map(|_| ())
    }

    /// Delete one profile, repair the default and queue its credential reference in one
    /// transaction. The returned reference is already detached and queued; the caller attempts the
    /// keyring deletion afterwards.
    pub(crate) fn delete_model_record(
        &mut self,
        id: &str,
    ) -> Result<Option<CredentialRef>, AppError> {
        Uuid::parse_str(id).map_err(|_| AppError::new("invalidInput"))?;
        let tx = self.0.transaction()?;
        let stored: Option<Option<String>> = tx
            .query_row(
                "SELECT credential_ref FROM model_profiles WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(stored) = stored else {
            return Err(AppError::new("notFound"));
        };
        let detached = stored
            .as_deref()
            .map(CredentialRef::parse)
            .transpose()
            .map_err(|_| AppError::new("storageUnavailable"))?;
        tx.execute("DELETE FROM model_profiles WHERE id=?1", [id])?;
        tx.execute(
            "UPDATE workspace
             SET default_model_id=(SELECT id FROM model_profiles ORDER BY sort_order,id LIMIT 1)
             WHERE singleton=1
               AND (default_model_id IS NULL
                    OR NOT EXISTS (SELECT 1 FROM model_profiles WHERE id=default_model_id))",
            [],
        )?;
        if let Some(reference) = &detached {
            queue_cleanup(&tx, reference, CleanupReason::Cleanup)?;
        }
        tx.commit()?;
        Ok(detached)
    }

    /// Remember which profile is the default. `None` clears the stored selection, which the next
    /// read resolves back to the first profile while any profile exists.
    pub fn select_model(&self, id: Option<String>) -> Result<(), AppError> {
        if let Some(ref id) = id {
            Uuid::parse_str(id).map_err(|_| AppError::new("invalidInput"))?;
            let exists: bool = self.0.query_row(
                "SELECT EXISTS(SELECT 1 FROM model_profiles WHERE id=?1)",
                [id],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(AppError::new("notFound"));
            }
        }
        self.0.execute(
            "UPDATE workspace SET default_model_id=?1 WHERE singleton=1",
            [id],
        )?;
        Ok(())
    }

    /// Trusted read of one connection's authentication metadata. Callers resolve a reference from
    /// here; a reference supplied by a frontend or any other untrusted caller is never accepted.
    pub fn connection_auth(&self, id: &str) -> Result<ConnectionAuth, AppError> {
        Uuid::parse_str(id).map_err(|_| AppError::new("invalidInput"))?;
        let stored = self
            .0
            .query_row(
                "SELECT auth_kind, credential_ref FROM connections WHERE id=?1",
                [id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::new("notFound"))?;
        parse_auth(&stored.0, stored.1.as_deref())
    }

    /// Record that a reference may exist in the OS store and must not be bound. Written *before*
    /// the keyring call, so a crash in between still leaves the orphan accounted for.
    pub fn queue_credential_cleanup(
        &mut self,
        reference: &CredentialRef,
        reason: CleanupReason,
    ) -> Result<(), AppError> {
        self.0.execute(
            "INSERT OR IGNORE INTO credential_cleanup(reference,reason,queued_at,attempts) VALUES (?1,?2,?3,0)",
            params![reference.as_str(), reason.as_str(), now()],
        )?;
        Ok(())
    }

    /// Drop a queued reference after the secret is known to be gone (or never written).
    pub fn cancel_credential_cleanup(&mut self, reference: &CredentialRef) -> Result<(), AppError> {
        self.0.execute(
            "DELETE FROM credential_cleanup WHERE reference=?1",
            [reference.as_str()],
        )?;
        Ok(())
    }

    /// Detach a connection's credential and queue it atomically. The returned snapshot is built
    /// inside the same transaction, so the caller never has to re-read (and never has to guess
    /// whether the write committed).
    pub fn detach_credential(&mut self, id: &str) -> Result<ConnectionRecord, AppError> {
        let tx = self.0.transaction()?;
        let stored = tx
            .query_row(
                "SELECT auth_kind, credential_ref FROM connections WHERE id=?1",
                [id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::new("notFound"))?;
        let auth = parse_auth(&stored.0, stored.1.as_deref())?;
        tx.execute(
            "UPDATE connections SET auth_kind='none', credential_ref=NULL WHERE id=?1",
            [id],
        )?;
        if let Some(reference) = &auth.credential_ref {
            queue_cleanup(&tx, reference, CleanupReason::Cleanup)?;
        }
        let stored = read_stored_connection(&tx, id)?;
        tx.commit()?;
        Ok(ConnectionRecord {
            profile: stored.profile,
            detached: auth.credential_ref,
            has_custom_ca: stored.ca.is_some(),
        })
    }

    /// Bind a reference to a connection in one transaction: the row is updated, the prepare entry
    /// is cleared and the previous reference is queued together. The returned snapshot is built
    /// inside that transaction, so a post-commit read failure can never be mistaken for a
    /// rolled-back write.
    pub fn bind_credential(
        &mut self,
        id: &str,
        kind: AuthKind,
        reference: &CredentialRef,
    ) -> Result<ConnectionRecord, AppError> {
        if kind == AuthKind::None {
            return Err(AppError::new("invalidInput"));
        }
        let tx = self.0.transaction()?;
        let stored = tx
            .query_row(
                "SELECT auth_kind, credential_ref FROM connections WHERE id=?1",
                [id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::new("notFound"))?;
        let previous = parse_auth(&stored.0, stored.1.as_deref())?.credential_ref;
        tx.execute(
            "UPDATE connections SET auth_kind=?2, credential_ref=?3 WHERE id=?1",
            params![id, kind.as_str(), reference.as_str()],
        )?;
        tx.execute(
            "DELETE FROM credential_cleanup WHERE reference=?1",
            [reference.as_str()],
        )?;
        if let Some(previous) = &previous {
            if previous != reference {
                queue_cleanup(&tx, previous, CleanupReason::Cleanup)?;
            }
        }
        let stored = read_stored_connection(&tx, id)?;
        tx.commit()?;
        Ok(ConnectionRecord {
            profile: stored.profile,
            detached: previous,
            has_custom_ca: stored.ca.is_some(),
        })
    }

    /// One bounded batch of queued references that may be deleted right now. Entries that exhausted
    /// their retry budget and entries a connection or a model row still uses are skipped in SQL, so
    /// a stuck head can never starve later entries; they stay in the table for recovery and are
    /// counted by [`Database::credential_cleanup_backlog`]. `limit` is clamped to
    /// [`MAX_CLEANUP_BATCH`].
    pub fn pending_credential_cleanup(
        &self,
        limit: usize,
        max_attempts: i64,
    ) -> Result<Vec<PendingCleanup>, AppError> {
        let limit = limit.min(MAX_CLEANUP_BATCH) as i64;
        let mut statement = self.0.prepare(
            "SELECT reference, reason, attempts FROM credential_cleanup
             WHERE attempts < ?1
               AND NOT EXISTS (SELECT 1 FROM connections WHERE credential_ref = credential_cleanup.reference)
               AND NOT EXISTS (SELECT 1 FROM model_profiles WHERE credential_ref = credential_cleanup.reference)
             ORDER BY attempts, queued_at, reference
             LIMIT ?2",
        )?;
        let rows = statement
            .query_map(params![max_attempts, limit], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(reference, reason, attempts)| {
                Ok(PendingCleanup {
                    reference: CredentialRef::parse(&reference)
                        .map_err(|_| AppError::new("storageUnavailable"))?,
                    reason: CleanupReason::parse(&reason)?,
                    attempts,
                })
            })
            .collect()
    }

    pub fn pending_credential_cleanup_count(&self) -> Result<i64, AppError> {
        Ok(self
            .0
            .query_row("SELECT count(*) FROM credential_cleanup", [], |row| {
                row.get(0)
            })?)
    }

    /// Queue counts by category for the given retry budget. Skipped entries are never deleted or
    /// forgotten, so a caller can surface how many still need attention. A reference still bound
    /// to a connection or a model row counts as deferred, never as cleaned.
    pub fn credential_cleanup_backlog(
        &self,
        max_attempts: i64,
    ) -> Result<CleanupBacklog, AppError> {
        Ok(self.0.query_row(
            "SELECT
               (SELECT count(*) FROM credential_cleanup) AS total,
               (SELECT count(*) FROM credential_cleanup WHERE attempts >= ?1) AS abandoned,
               (SELECT count(*) FROM credential_cleanup
                 WHERE attempts < ?1
                   AND (EXISTS (SELECT 1 FROM connections WHERE credential_ref = credential_cleanup.reference)
                        OR EXISTS (SELECT 1 FROM model_profiles WHERE credential_ref = credential_cleanup.reference))) AS deferred",
            [max_attempts],
            |row| {
                Ok(CleanupBacklog {
                    total: row.get(0)?,
                    abandoned: row.get(1)?,
                    deferred: row.get(2)?,
                })
            },
        )?)
    }

    /// Increment the retry counter and return the new value.
    pub fn record_cleanup_attempt(&mut self, reference: &CredentialRef) -> Result<i64, AppError> {
        Ok(self.0.query_row(
            "UPDATE credential_cleanup SET attempts=attempts+1 WHERE reference=?1 RETURNING attempts",
            [reference.as_str()],
            |row| row.get(0),
        )?)
    }

    /// Test-only SQL hook, used to install triggers that force a real SQLite failure inside an
    /// orchestration step. Not compiled into production builds.
    #[cfg(test)]
    pub(crate) fn run_sql_for_test(&self, sql: &str) -> Result<(), AppError> {
        self.0.execute_batch(sql)?;
        Ok(())
    }
}

/// Validate and normalize a stored HTTP(S) base endpoint. Credentials, query strings and fragments
/// are refused: a saved endpoint is a target, never a place to hide a secret. Shared with model
/// discovery, which validates the same draft endpoint before a profile exists.
pub(crate) fn clean_endpoint(value: &str) -> Result<String, AppError> {
    if value.len() > 2048 {
        return Err(AppError::new("invalidEndpoint"));
    }
    let url = Url::parse(value.trim()).map_err(|_| AppError::new("invalidEndpoint"))?;
    if !["http", "https"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::new("invalidEndpoint"));
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

/// How one combined authenticated write changes a connection's credential reference.
pub(crate) enum ConnectionReferenceChange<'a> {
    /// Keep the bound reference; a changed endpoint detaches it instead, because the secret was
    /// granted for the old target.
    Keep,
    /// Drop any bound reference and queue it for deletion.
    Clear,
    /// Bind this freshly written reference, replacing (and queuing) any previous one.
    Replace {
        kind: AuthKind,
        reference: &'a CredentialRef,
    },
}

/// How one combined write changes a connection's custom CA chain.
pub(crate) enum ConnectionCaChange {
    /// Keep the stored chain; a changed endpoint drops it instead, like the credential.
    Keep,
    /// Drop the stored chain.
    Clear,
    /// Store this already-validated chain.
    Replace(CaCertificate),
}

/// Whether a metadata write may act on a connection that has a bound credential. The legacy IPC
/// commands cannot report credential handling, so they refuse such a row instead.
#[derive(Clone, Copy, PartialEq, Eq)]
enum BoundCredential {
    Reject,
    Manage,
}

/// Validate one persisted auth pair. An unknown kind, a kind without a reference, a reference
/// without a kind and a non-canonical reference all fail closed.
fn parse_auth(kind: &str, reference: Option<&str>) -> Result<ConnectionAuth, AppError> {
    let kind = AuthKind::parse(kind)?;
    match (kind, reference) {
        (AuthKind::None, None) => Ok(ConnectionAuth::none()),
        (AuthKind::None, Some(_)) => Err(AppError::new("storageUnavailable")),
        (kind, Some(value)) => CredentialRef::parse(value)
            .map(|reference| ConnectionAuth {
                kind,
                credential_ref: Some(reference),
            })
            .map_err(|_| AppError::new("storageUnavailable")),
        (_, None) => Err(AppError::new("storageUnavailable")),
    }
}

/// Read and validate one whole connection row (profile plus custom CA chain) inside an open
/// transaction.
fn read_stored_connection(
    tx: &rusqlite::Transaction<'_>,
    id: &str,
) -> Result<StoredConnection, AppError> {
    let raw = tx
        .query_row(
            &format!(
                "SELECT {} FROM connections WHERE id=?1",
                RawConnection::COLUMNS
            ),
            [id],
            RawConnection::read,
        )
        .optional()?
        .ok_or_else(|| AppError::new("notFound"))?;
    raw.into_stored()
}

fn queue_cleanup(
    tx: &rusqlite::Transaction<'_>,
    reference: &CredentialRef,
    reason: CleanupReason,
) -> Result<(), AppError> {
    tx.execute(
        "INSERT OR IGNORE INTO credential_cleanup(reference,reason,queued_at,attempts) VALUES (?1,?2,?3,0)",
        params![reference.as_str(), reason.as_str(), now()],
    )?;
    Ok(())
}

/// Read and validate one model row, or `None` when it does not exist.
fn read_model_row(conn: &Connection, id: &str) -> Result<Option<ModelProfile>, AppError> {
    let raw = conn
        .query_row(
            &format!(
                "SELECT {} FROM model_profiles WHERE id=?1",
                RawModel::COLUMNS
            ),
            [id],
            RawModel::read,
        )
        .optional()?;
    raw.map(RawModel::into_profile).transpose()
}

/// One workspace-recovery row exactly as stored, before typed validation. Both the load and the
/// compare-and-swap save read through this, so they apply the same schema-level checks.
pub(crate) struct WorkspaceRecoveryRow {
    pub(crate) revision: i64,
    pub(crate) json: String,
}

/// Debug output must never leak a stored draft body: the document is a byte length only.
impl std::fmt::Debug for WorkspaceRecoveryRow {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorkspaceRecoveryRow")
            .field("revision", &self.revision)
            .field("json_bytes", &self.json.len())
            .finish()
    }
}

/// Read the singleton recovery row inside any connection or transaction. A row whose revision is
/// outside the JS-safe counter range or whose document exceeds the byte bound fails closed with
/// `invalidResponse`: typed validation of the document belongs to `workspace_recovery`, and
/// neither caller may repair or rewrite such a row.
fn read_workspace_recovery_row(
    connection: &Connection,
) -> Result<Option<WorkspaceRecoveryRow>, AppError> {
    let row = connection
        .query_row(
            "SELECT revision,
                CASE WHEN length(CAST(json AS BLOB)) <= ?1 THEN json ELSE NULL END
             FROM workspace_recovery WHERE singleton=1",
            [MAX_WORKSPACE_RECOVERY_BYTES as i64],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| match error {
            rusqlite::Error::InvalidColumnType(..)
            | rusqlite::Error::IntegralValueOutOfRange(..)
            | rusqlite::Error::FromSqlConversionFailure(..) => AppError::new("invalidResponse"),
            _ => AppError::new("storageUnavailable"),
        })?;
    let Some((revision, json)) = row else {
        return Ok(None);
    };
    if !(0..=MAX_WORKSPACE_RECOVERY_REVISION).contains(&revision)
        || json.len() > MAX_WORKSPACE_RECOVERY_BYTES
    {
        return Err(AppError::new("invalidResponse"));
    }
    Ok(Some(WorkspaceRecoveryRow { revision, json }))
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

fn read_data_views(connection: &Connection) -> Result<DataViewRecord, AppError> {
    let row = connection
        .query_row(
            "SELECT revision,
           CASE WHEN length(CAST(json AS BLOB)) <= ?1 THEN json ELSE NULL END
         FROM data_view_library WHERE singleton=1",
            [crate::data_views::MAX_BYTES as i64],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| match error {
            rusqlite::Error::InvalidColumnType(..)
            | rusqlite::Error::IntegralValueOutOfRange(..)
            | rusqlite::Error::FromSqlConversionFailure(..) => AppError::new("invalidResponse"),
            _ => AppError::new("storageUnavailable"),
        })?;
    match row {
        None => Ok(DataViewRecord {
            revision: 0,
            library: DataViewLibrary::empty(),
        }),
        Some((revision, json)) => {
            if revision <= 0 || revision as u64 > crate::data_views::MAX_REVISION {
                return Err(AppError::new("invalidResponse"));
            }
            Ok(DataViewRecord {
                revision: revision as u64,
                library: crate::data_views::decode_stored(&json)?,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection_credentials::MAX_CLEANUP_ATTEMPTS as MAX_ATTEMPTS;

    fn input(name: &str) -> ConnectionInput {
        ConnectionInput {
            display_name: name.into(),
            endpoint: "https://example.test/es".into(),
            environment: "development".into(),
        }
    }

    #[test]
    fn metadata_survives_restart_and_selection_uses_stable_id() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("test.sqlite");
        let mut db = Database::open(&path).unwrap();
        assert!(db.load().unwrap().connections.is_empty());
        let first = db.save_connection(input("Zulu"), None).unwrap().profile;
        let second = db.save_connection(input("Alpha"), None).unwrap().profile;
        db.select_connection(Some(second.id.clone())).unwrap();
        db.save_connection(input("Renamed"), Some(second.id.clone()))
            .unwrap();
        drop(db);
        let mut db = Database::open(&path).unwrap();
        let state = db.load().unwrap();
        assert_eq!(
            state.active_connection_id.as_deref(),
            Some(second.id.as_str())
        );
        assert_eq!(state.connections[0].id, first.id);
        assert_eq!(state.connections[1].display_name, "Renamed");
        db.delete_connection(&second.id).unwrap();
        assert_eq!(
            db.load().unwrap().active_connection_id,
            Some(first.id.clone())
        );
        db.delete_connection(&first.id).unwrap();
        assert!(db.load().unwrap().active_connection_id.is_none());
    }

    #[test]
    fn credentials_urls_unknown_properties_and_invalid_preferences_are_rejected() {
        let mut db = Database::open(Path::new(":memory:")).unwrap();
        for endpoint in [
            "https://user:secret@example.test",
            "https://example.test/?key=secret",
            "file:///etc/passwd",
            "javascript:alert(1)",
        ] {
            let mut profile = input("Test");
            profile.endpoint = endpoint.into();
            assert_eq!(
                db.save_connection(profile, None).unwrap_err().code,
                "invalidEndpoint"
            );
        }
        assert!(serde_json::from_str::<ConnectionInput>(
            r#"{"displayName":"x","endpoint":"https://example.test","environment":"development","password":"secret"}"#
        ).is_err());
        let prefs = Preferences {
            ui_size: 255,
            ..Preferences::default()
        };
        assert_eq!(db.save_preferences(prefs).unwrap_err().code, "invalidInput");
        assert!(db.load().unwrap().connections.is_empty());
    }

    #[test]
    fn preferences_round_trip_and_corruption_is_not_overwritten() {
        let db = Database::open(Path::new(":memory:")).unwrap();
        db.save_preferences(Preferences {
            mode: "dark".into(),
            ..Preferences::default()
        })
        .unwrap();
        assert_eq!(db.load().unwrap().preferences.mode, "dark");
        db.0.execute("UPDATE preferences SET json='broken' WHERE singleton=1", [])
            .unwrap();
        assert!(db.load().is_err());
        let raw: String =
            db.0.query_row("SELECT json FROM preferences", [], |row| row.get(0))
                .unwrap();
        assert_eq!(raw, "broken");
    }

    const CANONICAL_PREFERENCES: &str =
        include_str!("../../tests/fixtures/preferences-canonical.json");
    const LEGACY_PREFERENCES: &str = include_str!("../../tests/fixtures/preferences-legacy.json");
    const INVALID_PREFERENCES: &str = include_str!("../../tests/fixtures/preferences-invalid.json");
    const UNKNOWN_KEY_PREFERENCES: &str =
        include_str!("../../tests/fixtures/preferences-unknown-key.json");

    fn stored_preferences_json(db: &Database) -> String {
        db.0.query_row(
            "SELECT json FROM preferences WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    /// The TypeScript `Preferences` object is the wire contract: the exact bytes the frontend
    /// sends must deserialize into `Preferences` and serialize back byte-identically. A drifted
    /// field name (for example `startAi` instead of `startAI`) fails here, not at runtime.
    #[test]
    fn preference_wire_contract_round_trips_the_typescript_fixture() {
        let canonical: Preferences = serde_json::from_str(CANONICAL_PREFERENCES).unwrap();
        canonical.validate().unwrap();
        assert!(canonical.start_ai);
        assert_eq!(canonical.mode, "dark");
        assert_eq!(canonical.ui_size, 16);
        assert_eq!(canonical.code_size, 15);
        assert_eq!(canonical.table_size, 12);
        assert_eq!(canonical.start_view, "json");
        assert!(!canonical.wrap_json);
        assert!(canonical.reduce_motion);
        let encoded = serde_json::to_string(&canonical).unwrap();
        assert_eq!(encoded, CANONICAL_PREFERENCES.trim());
        assert!(!encoded.contains("startAi"));
    }

    /// A row written by an earlier build uses the camelCase rename of `start_ai`. Reading it must
    /// keep the flag, and the next save must write the canonical `startAI` spelling.
    #[test]
    fn legacy_start_ai_rows_read_and_are_rewritten_in_canonical_form() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("legacy-preferences.sqlite");
        let db = Database::open(&path).unwrap();
        db.0.execute(
            "INSERT INTO preferences(singleton,json) VALUES (1,?1)",
            [LEGACY_PREFERENCES.trim()],
        )
        .unwrap();
        let loaded = db.load().unwrap();
        assert!(loaded.preferences.start_ai);
        assert_eq!(loaded.preferences.mode, "dark");
        // Reading is not a write: the legacy row stays exactly as the earlier build left it.
        assert_eq!(stored_preferences_json(&db), LEGACY_PREFERENCES.trim());
        db.save_preferences(loaded.preferences).unwrap();
        assert_eq!(stored_preferences_json(&db), CANONICAL_PREFERENCES.trim());
        assert!(db.load().unwrap().preferences.start_ai);
    }

    #[test]
    fn preferences_survive_reopen_and_rejected_writes_keep_the_previous_row() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("preferences.sqlite");
        let canonical: Preferences = serde_json::from_str(CANONICAL_PREFERENCES).unwrap();
        {
            let db = Database::open(&path).unwrap();
            db.save_preferences(canonical).unwrap();
        }
        {
            let db = Database::open(&path).unwrap();
            let loaded = db.load().unwrap();
            assert!(loaded.preferences.start_ai);
            assert_eq!(loaded.preferences.ui_size, 16);
            assert_eq!(loaded.preferences.start_view, "json");
            assert_eq!(loaded.preferences.density, "compact");
            assert_eq!(stored_preferences_json(&db), CANONICAL_PREFERENCES.trim());
            // A rejected payload must not replace the row the user already has.
            let invalid = Preferences {
                ui_size: 255,
                ..Preferences::default()
            };
            assert_eq!(
                db.save_preferences(invalid).unwrap_err().code,
                "invalidInput"
            );
            assert_eq!(stored_preferences_json(&db), CANONICAL_PREFERENCES.trim());
        }
    }

    #[test]
    fn unknown_and_invalid_preference_payloads_are_rejected() {
        assert!(serde_json::from_str::<Preferences>(INVALID_PREFERENCES).is_err());
        assert!(serde_json::from_str::<Preferences>(UNKNOWN_KEY_PREFERENCES).is_err());
        assert!(serde_json::from_str::<Preferences>(r#"{"startAI":true}"#).is_err());
        // Both spellings at once is ambiguous input, not a merge.
        let mut both: serde_json::Value = serde_json::from_str(CANONICAL_PREFERENCES).unwrap();
        both["startAi"] = serde_json::Value::Bool(false);
        assert!(serde_json::from_str::<Preferences>(&both.to_string()).is_err());
    }

    #[test]
    fn unknown_schema_and_missing_connection_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("future.sqlite");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA user_version=99").unwrap();
        assert!(Database::open(&path).is_err());
        let mut db = Database::open(Path::new(":memory:")).unwrap();
        assert_eq!(
            db.select_connection(Some("missing".into()))
                .unwrap_err()
                .code,
            "notFound"
        );
        assert_eq!(
            db.delete_connection("missing").unwrap_err().code,
            "notFound"
        );
    }

    #[test]
    fn connection_lookup_uses_saved_id_without_changing_selection() {
        let mut db = Database::open(Path::new(":memory:")).unwrap();
        let first = db.save_connection(input("First"), None).unwrap().profile;
        let second = db.save_connection(input("Second"), None).unwrap().profile;
        db.select_connection(Some(second.id.clone())).unwrap();
        let snapshot = db.connection(&first.id).unwrap();
        let mut updated = input("Renamed");
        updated.endpoint = "https://changed.example.test".into();
        db.save_connection(updated, Some(first.id.clone())).unwrap();
        assert_eq!(snapshot.endpoint, first.endpoint);
        assert_eq!(
            db.connection(&first.id).unwrap().endpoint,
            "https://changed.example.test"
        );
        assert_eq!(db.load().unwrap().active_connection_id, Some(second.id));
        assert_eq!(db.connection("not-an-id").unwrap_err().code, "invalidInput");
        db.delete_connection(&first.id).unwrap();
        assert_eq!(db.connection(&first.id).unwrap_err().code, "notFound");
    }

    #[test]
    fn corrupt_endpoint_is_not_returned_to_frontend() {
        let mut db = Database::open(Path::new(":memory:")).unwrap();
        let profile = db.save_connection(input("Test"), None).unwrap().profile;
        db.0.execute(
            "UPDATE connections SET endpoint='https://user:secret@example.test' WHERE id=?1",
            [&profile.id],
        )
        .unwrap();
        assert!(db.load().is_err());
    }

    #[test]
    fn failed_migration_and_read_only_storage_do_not_claim_success() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("conflict.sqlite");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE preferences (existing TEXT);")
            .unwrap();
        assert!(Database::open(&path).is_err());
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 0);
        let created: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='connections'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(created, 0);
        let db = Database::open(Path::new(":memory:")).unwrap();
        db.0.execute_batch("PRAGMA query_only=ON;").unwrap();
        assert_eq!(
            db.save_preferences(Preferences::default())
                .unwrap_err()
                .code,
            "storageUnavailable"
        );
    }

    /// A version 1 database as the previous release left it: no credential columns, no outbox.
    fn v1_database(path: &Path) -> (Connection, String) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(include_str!("../migrations/001_initial.sql"))
            .unwrap();
        let id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO connections(id,display_name,endpoint,environment,sort_order) VALUES (?1,'Legacy','https://legacy.test/es','staging',3)",
            [&id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO preferences(singleton,json) VALUES (1,?1)",
            [serde_json::to_string(&Preferences {
                mode: "dark".into(),
                ..Preferences::default()
            })
            .unwrap()],
        )
        .unwrap();
        conn.execute("UPDATE workspace SET active_connection_id=?1", [&id])
            .unwrap();
        (conn, id)
    }

    #[test]
    fn credential_migration_preserves_v1_rows_and_is_reentrant() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("legacy.sqlite");
        let (conn, id) = v1_database(&path);
        drop(conn);

        let db = Database::open(&path).unwrap();
        let state = db.load().unwrap();
        assert_eq!(state.preferences.mode, "dark");
        assert_eq!(state.active_connection_id.as_deref(), Some(id.as_str()));
        assert_eq!(state.connections.len(), 1);
        let profile = &state.connections[0];
        assert_eq!(profile.display_name, "Legacy");
        assert_eq!(profile.endpoint, "https://legacy.test/es");
        assert_eq!(profile.environment, "staging");
        assert_eq!(profile.sort_order, 3);
        // Legacy rows are unauthenticated and reference no secret.
        assert_eq!(db.connection_auth(&id).unwrap(), ConnectionAuth::none());
        assert!(db.connection(&id).unwrap().auth_state.unauthenticated());

        // Reopening a version 2 file must be a no-op, not a second migration attempt.
        drop(db);
        let mut db = Database::open(&path).unwrap();
        assert_eq!(db.load().unwrap().connections.len(), 1);
        assert_eq!(db.pending_credential_cleanup_count().unwrap(), 0);
        let reference = CredentialRef::generate();
        db.queue_credential_cleanup(&reference, CleanupReason::Prepare)
            .unwrap();
        drop(db);
        let db = Database::open(&path).unwrap();
        assert_eq!(
            db.pending_credential_cleanup(8, MAX_ATTEMPTS)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn failed_credential_migration_rolls_back_to_version_one() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("conflict.sqlite");
        let (conn, id) = v1_database(&path);
        // Force the second migration step to fail after the first ALTER would have succeeded.
        conn.execute_batch("CREATE TABLE credential_cleanup (bogus TEXT);")
            .unwrap();
        drop(conn);

        assert!(Database::open(&path).is_err());
        let conn = Connection::open(&path).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 1);
        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(connections)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(!columns.iter().any(|column| column.as_str() == "auth_kind"));
        assert!(!columns
            .iter()
            .any(|column| column.as_str() == "credential_ref"));
        let name: String = conn
            .query_row(
                "SELECT display_name FROM connections WHERE id=?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(name, "Legacy");
    }

    #[test]
    fn credential_columns_reject_malformed_values_at_the_sql_layer() {
        let mut db = Database::open(Path::new(":memory:")).unwrap();
        let id = db.save_connection(input("Test"), None).unwrap().profile.id;
        let reference = CredentialRef::generate();
        for sql in [
            format!("UPDATE connections SET auth_kind='oauth' WHERE id='{id}'"),
            format!("UPDATE connections SET credential_ref='not-a-uuid' WHERE id='{id}'"),
            format!("UPDATE connections SET credential_ref='' WHERE id='{id}'"),
            "INSERT INTO credential_cleanup(reference,reason,queued_at) VALUES ('short','prepare',0)"
                .to_owned(),
            format!(
                "INSERT INTO credential_cleanup(reference,reason,queued_at) VALUES ('{}','later',0)",
                reference.as_str()
            ),
        ] {
            assert!(db.run_sql_for_test(&sql).is_err(), "must be rejected: {sql}");
        }
        // A combination the per-column checks cannot express is still refused when read.
        db.run_sql_for_test(&format!(
            "UPDATE connections SET auth_kind='none', credential_ref='{}' WHERE id='{id}'",
            reference.as_str()
        ))
        .unwrap();
        assert_eq!(db.load().err().unwrap().code, "storageUnavailable");
        assert_eq!(
            db.connection_auth(&id).unwrap_err().code,
            "storageUnavailable"
        );
    }

    #[test]
    fn hand_written_credential_metadata_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("foreign.sqlite");
        let id = Uuid::new_v4().to_string();
        let reference = CredentialRef::generate();
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(include_str!("../migrations/001_initial.sql"))
            .unwrap();
        // A version 2 file that was not written by this build: the combinations below cannot be
        // produced through `Database`, and must still be refused when read.
        conn.execute_batch(
            "ALTER TABLE connections ADD COLUMN auth_kind TEXT NOT NULL DEFAULT 'none';
             ALTER TABLE connections ADD COLUMN credential_ref TEXT;
             CREATE TABLE credential_cleanup (reference TEXT PRIMARY KEY, reason TEXT NOT NULL, queued_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
             PRAGMA user_version = 2;",
        )
        .unwrap();
        for (kind, stored) in [
            ("apiKey", "NULL".to_owned()),
            ("basic", "NULL".to_owned()),
            ("oauth", format!("'{reference}'")),
            ("apiKey", "'not-a-uuid'".to_owned()),
            ("apiKey", format!("'{}'", reference.as_str().to_uppercase())),
        ] {
            conn.execute(
                &format!(
                    "INSERT OR REPLACE INTO connections(id,display_name,endpoint,environment,sort_order,auth_kind,credential_ref)
                     VALUES ('{id}','Foreign','https://foreign.test/es','development',0,'{kind}',{stored})"
                ),
                [],
            )
            .unwrap();
            let db = Database::open(&path).unwrap();
            assert_eq!(
                db.load().err().unwrap().code,
                "storageUnavailable",
                "kind {kind} with {stored} must fail closed"
            );
            assert_eq!(
                db.connection_auth(&id).unwrap_err().code,
                "storageUnavailable"
            );
        }
    }

    #[test]
    fn auth_metadata_is_never_serialized_or_printed_and_legacy_reads_refuse_it() {
        let mut db = Database::open(Path::new(":memory:")).unwrap();
        let created = db.save_connection(input("Test"), None).unwrap();
        let reference = CredentialRef::generate();
        let bound = db
            .bind_credential(&created.profile.id, AuthKind::Bearer, &reference)
            .unwrap();
        assert_eq!(bound.profile.auth_state.kind, AuthKind::Bearer);

        // The snapshot the orchestration returns serializes exactly like the legacy shape.
        let json = serde_json::to_string(&bound.profile).unwrap();
        assert!(json.contains(r#""auth":"none""#));
        assert!(!json.contains("credentialRef"));
        assert!(!json.contains("authState"));
        assert!(!json.contains(reference.as_str()));
        // Neither the reference nor the secret state is printed.
        let debug = format!("{:?}", bound.profile);
        assert!(!debug.contains(reference.as_str()));
        assert!(debug.contains("Bearer"));

        // The legacy reads cannot represent a bound credential, so they refuse instead of
        // reporting `auth: "none"` for a connection that has one.
        assert_eq!(db.load().err().unwrap().code, "unsupported");
        assert_eq!(
            db.connection(&created.profile.id).unwrap_err().code,
            "unsupported"
        );

        // Detaching restores the legacy read for that connection.
        let unbound = db.detach_credential(&created.profile.id).unwrap();
        assert!(unbound.profile.auth_state.unauthenticated());
        assert_eq!(db.load().unwrap().connections.len(), 1);
        assert_eq!(
            db.connection(&created.profile.id).unwrap().id,
            created.profile.id
        );
    }

    #[test]
    fn legacy_metadata_paths_refuse_a_connection_with_a_bound_credential() {
        fn at(name: &str, endpoint: &str) -> ConnectionInput {
            ConnectionInput {
                display_name: name.into(),
                endpoint: endpoint.into(),
                environment: "development".into(),
            }
        }

        let mut db = Database::open(Path::new(":memory:")).unwrap();
        let created = db.save_connection(input("Bound"), None).unwrap().profile;
        let reference = CredentialRef::generate();
        db.bind_credential(&created.id, AuthKind::ApiKey, &reference)
            .unwrap();

        // Rename, endpoint change and delete are all refused before anything is modified.
        for (name, endpoint) in [
            ("Renamed", "https://bound.test/es"),
            ("Moved", "https://moved.test/es"),
        ] {
            assert_eq!(
                db.save_connection_metadata_only(at(name, endpoint), Some(created.id.clone()))
                    .unwrap_err()
                    .code,
                "unsupported"
            );
        }
        assert_eq!(
            db.delete_connection_metadata_only(&created.id)
                .unwrap_err()
                .code,
            "unsupported"
        );
        let stored = db.connection_auth(&created.id).unwrap();
        assert_eq!(stored.kind, AuthKind::ApiKey);
        assert_eq!(stored.credential_ref.as_ref(), Some(&reference));
        // The refused writes left the row exactly as it was.
        let profile = db.read_connection(&created.id).unwrap().unwrap().profile;
        assert_eq!(profile.display_name, "Bound");
        assert_eq!(profile.endpoint, "https://example.test/es");
        // Nothing was queued for deletion, so the bound secret stays untouched.
        assert_eq!(db.pending_credential_cleanup_count().unwrap(), 0);

        // A connection without a credential keeps the legacy behavior.
        let plain = db.save_connection(input("Plain"), None).unwrap().profile;
        let renamed = db
            .save_connection_metadata_only(
                at("Renamed", "https://renamed.test/es"),
                Some(plain.id.clone()),
            )
            .unwrap();
        assert_eq!(renamed.display_name, "Renamed");
        assert_eq!(renamed.endpoint, "https://renamed.test/es");
        db.delete_connection_metadata_only(&plain.id).unwrap();
        assert_eq!(db.connection(&plain.id).unwrap_err().code, "notFound");
        assert_eq!(db.pending_credential_cleanup_count().unwrap(), 0);
    }

    #[test]
    fn endpoint_change_detaches_in_the_same_transaction_as_the_update() {
        let mut db = Database::open(Path::new(":memory:")).unwrap();
        let created = db.save_connection(input("Test"), None).unwrap().profile;
        let reference = CredentialRef::generate();
        db.bind_credential(&created.id, AuthKind::Basic, &reference)
            .unwrap();

        let mut renamed = input("Renamed");
        renamed.endpoint = "https://other.test/es".into();
        let record = db
            .save_connection(renamed, Some(created.id.clone()))
            .unwrap();
        assert_eq!(record.detached.as_ref(), Some(&reference));
        assert!(record.profile.auth_state.unauthenticated());
        assert_eq!(record.profile.id, created.id);
        assert_eq!(
            db.connection_auth(&created.id).unwrap(),
            ConnectionAuth::none()
        );
        let queued = db.pending_credential_cleanup(8, MAX_ATTEMPTS).unwrap();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].reference, reference);
        assert_eq!(queued[0].reason, CleanupReason::Cleanup);

        // The same endpoint keeps the reference, and a plain rename keeps it too.
        db.bind_credential(&created.id, AuthKind::Basic, &reference)
            .unwrap();
        let mut kept = input("Renamed again");
        kept.endpoint = "https://other.test/es".into();
        let record = db.save_connection(kept, Some(created.id.clone())).unwrap();
        assert!(record.detached.is_none());
        assert_eq!(
            record.profile.auth_state.credential_ref.as_ref(),
            Some(&reference)
        );
    }

    #[test]
    fn delete_and_detach_queue_the_reference_before_it_is_removed() {
        let mut db = Database::open(Path::new(":memory:")).unwrap();
        let keep = db.save_connection(input("Keep"), None).unwrap().profile;
        let removed = db.save_connection(input("Drop"), None).unwrap().profile;
        let keep_ref = CredentialRef::generate();
        let drop_ref = CredentialRef::generate();
        db.bind_credential(&keep.id, AuthKind::Basic, &keep_ref)
            .unwrap();
        db.bind_credential(&removed.id, AuthKind::ApiKey, &drop_ref)
            .unwrap();

        let detached = db.detach_credential(&removed.id).unwrap();
        assert_eq!(detached.detached.as_ref(), Some(&drop_ref));
        assert!(db.connection_auth(&removed.id).unwrap().unauthenticated());
        let queued = db.pending_credential_cleanup(8, MAX_ATTEMPTS).unwrap();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].reference, drop_ref);
        // Only the detached connection lost its reference; the other one still points at its own.
        assert_eq!(
            db.connection_auth(&keep.id)
                .unwrap()
                .credential_ref
                .as_ref(),
            Some(&keep_ref)
        );
        assert_eq!(
            db.connection_auth(&removed.id).unwrap().credential_ref,
            None
        );

        // Unbinding twice is idempotent and never queues the same reference again.
        assert!(db
            .detach_credential(&removed.id)
            .unwrap()
            .detached
            .is_none());
        assert_eq!(
            db.pending_credential_cleanup(8, MAX_ATTEMPTS)
                .unwrap()
                .len(),
            1
        );

        let detached = db.delete_connection(&removed.id).unwrap();
        assert!(detached.is_none());
        let deleted = db.delete_connection(&keep.id).unwrap();
        assert_eq!(deleted.as_ref(), Some(&keep_ref));
        assert!(db.connection_auth(&keep.id).is_err());
        let queued = db.pending_credential_cleanup(8, MAX_ATTEMPTS).unwrap();
        assert_eq!(queued.len(), 2);
        assert_eq!(db.record_cleanup_attempt(&keep_ref).unwrap(), 1);
        assert_eq!(
            db.pending_credential_cleanup(8, MAX_ATTEMPTS)
                .unwrap()
                .into_iter()
                .find(|entry| entry.reference == keep_ref)
                .unwrap()
                .attempts,
            1
        );
    }

    const MODEL_INPUT: &str = include_str!("../../tests/fixtures/models-input-canonical.json");
    const MODEL_STATE: &str = include_str!("../../tests/fixtures/models-state-canonical.json");
    const MODEL_INPUT_INVALID: &str =
        include_str!("../../tests/fixtures/models-input-invalid.json");
    const MODEL_INPUT_UNKNOWN_KEY: &str =
        include_str!("../../tests/fixtures/models-input-unknown-key.json");

    fn model_input(name: &str, model_id: &str) -> ModelInput {
        ModelInput {
            display_name: name.into(),
            protocol: ModelProtocol::Ollama,
            endpoint: "http://127.0.0.1:11434".into(),
            model_id: model_id.into(),
        }
    }

    /// The TypeScript payload is the wire contract: the exact bytes the frontend sends must
    /// deserialize into `ModelInput`, and the state the frontend reads must serialize
    /// byte-identically to the shared fixture. A renamed field, a new key or another protocol
    /// spelling fails here instead of at runtime.
    #[test]
    fn model_wire_contract_round_trips_the_shared_fixtures() {
        let canonical: ModelInput = serde_json::from_str(MODEL_INPUT).unwrap();
        canonical.clone().validate().unwrap();
        assert_eq!(canonical.protocol, ModelProtocol::Ollama);
        assert_eq!(canonical.model_id, "llama3.1:8b");
        assert_eq!(canonical.endpoint, "http://127.0.0.1:11434");
        // An unimplemented protocol and a payload carrying a secret-shaped key are both refused.
        assert!(serde_json::from_str::<ModelInput>(MODEL_INPUT_INVALID).is_err());
        assert!(serde_json::from_str::<ModelInput>(MODEL_INPUT_UNKNOWN_KEY).is_err());

        let state: ModelsState = serde_json::from_str(MODEL_STATE).unwrap();
        assert_eq!(state.profiles.len(), 2);
        assert_eq!(state.profiles[0].protocol, ModelProtocol::Ollama);
        assert_eq!(state.profiles[1].protocol, ModelProtocol::OpenaiCompatible);
        assert_eq!(
            state.default_model_id.as_deref(),
            Some(state.profiles[1].id.as_str())
        );
        assert_eq!(serde_json::to_string(&state).unwrap(), MODEL_STATE.trim());

        let mut extra: serde_json::Value = serde_json::from_str(MODEL_STATE).unwrap();
        extra["profiles"][0]["apiKey"] = serde_json::Value::String("placeholder-not-a-key".into());
        assert!(serde_json::from_str::<ModelsState>(&extra.to_string()).is_err());
    }

    #[test]
    fn model_profiles_persist_the_default_selection_and_keep_stable_ids() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("models.sqlite");
        let first = {
            let mut db = Database::open(&path).unwrap();
            let empty = db.models().unwrap();
            assert!(empty.profiles.is_empty());
            assert_eq!(empty.default_model_id, None);

            let first = db.save_model(model_input("Zulu", "zulu:1b"), None).unwrap();
            let second = db
                .save_model(model_input("Alpha", "alpha:7b"), None)
                .unwrap();
            assert_eq!(first.sort_order, 0);
            assert_eq!(second.sort_order, 1);
            // The first profile is the default until the user selects another one.
            assert_eq!(
                db.models().unwrap().default_model_id,
                Some(first.id.clone())
            );
            db.select_model(Some(second.id.clone())).unwrap();

            // Editing keeps the identity and the sort order; only the fields change.
            let mut updated = model_input("Renamed", "alpha:7b");
            updated.protocol = ModelProtocol::OpenaiCompatible;
            updated.endpoint = "https://gateway.example.test/v1".into();
            let renamed = db.save_model(updated, Some(second.id.clone())).unwrap();
            assert_eq!(renamed.id, second.id);
            assert_eq!(renamed.sort_order, 1);
            assert_eq!(renamed.endpoint, "https://gateway.example.test/v1");
            first
        };

        let mut db = Database::open(&path).unwrap();
        let state = db.models().unwrap();
        assert_eq!(
            state
                .profiles
                .iter()
                .map(|profile| profile.display_name.as_str())
                .collect::<Vec<_>>(),
            ["Zulu", "Renamed"]
        );
        let selected = state.profiles[1].id.clone();
        assert_eq!(state.default_model_id, Some(selected.clone()));

        // A stored default that no longer names a profile resolves to the first one.
        db.run_sql_for_test(&format!(
            "UPDATE workspace SET default_model_id='{}' WHERE singleton=1",
            Uuid::new_v4()
        ))
        .unwrap();
        assert_eq!(
            db.models().unwrap().default_model_id,
            Some(first.id.clone())
        );
        // Clearing the selection resolves the same way; it never leaves the page without a default
        // while a profile exists.
        db.select_model(None).unwrap();
        assert_eq!(
            db.models().unwrap().default_model_id,
            Some(first.id.clone())
        );

        // Deleting the selected profile moves the selection to the first remaining one.
        db.select_model(Some(selected.clone())).unwrap();
        db.delete_model(&selected).unwrap();
        assert_eq!(
            db.models().unwrap().default_model_id,
            Some(first.id.clone())
        );
        assert_eq!(db.models().unwrap().profiles.len(), 1);
        assert_eq!(db.delete_model(&selected).unwrap_err().code, "notFound");
        db.delete_model(&first.id).unwrap();
        let empty = db.models().unwrap();
        assert!(empty.profiles.is_empty());
        assert_eq!(empty.default_model_id, None);

        assert_eq!(
            db.select_model(Some("missing".into())).unwrap_err().code,
            "invalidInput"
        );
        assert_eq!(
            db.select_model(Some(Uuid::new_v4().to_string()))
                .unwrap_err()
                .code,
            "notFound"
        );
        assert_eq!(
            db.save_model(
                model_input("Gone", "gone:1b"),
                Some(Uuid::new_v4().to_string())
            )
            .unwrap_err()
            .code,
            "notFound"
        );
    }

    #[test]
    fn model_profile_limit_counts_only_new_profiles() {
        let mut db = Database::open(Path::new(":memory:")).unwrap();
        for index in 0..MAX_MODEL_PROFILES {
            db.save_model(
                model_input(&format!("Model {index}"), &format!("model-{index}")),
                None,
            )
            .unwrap();
        }
        assert_eq!(db.models().unwrap().profiles.len(), MAX_MODEL_PROFILES);
        assert_eq!(
            db.save_model(model_input("One too many", "model-limit"), None)
                .unwrap_err()
                .code,
            "invalidInput"
        );
        // Editing an existing profile still works at the limit.
        let existing = db.models().unwrap().profiles[0].id.clone();
        assert!(db
            .save_model(model_input("Renamed at limit", "model-0"), Some(existing))
            .is_ok());
        assert_eq!(db.models().unwrap().profiles.len(), MAX_MODEL_PROFILES);
    }

    #[test]
    fn model_validation_and_foreign_rows_fail_closed() {
        let mut db = Database::open(Path::new(":memory:")).unwrap();
        for endpoint in [
            "https://user:secret@example.test",
            "https://example.test/?key=secret",
            "https://example.test/#fragment",
            "file:///etc/passwd",
            "not a url",
        ] {
            let mut input = model_input("Test", "model:1b");
            input.endpoint = endpoint.into();
            assert_eq!(
                db.save_model(input, None).unwrap_err().code,
                "invalidEndpoint",
                "must be rejected: {endpoint}"
            );
        }
        let long_name = "n".repeat(81);
        let long_model_id = "m".repeat(201);
        for (name, model_id, code) in [
            ("", "model:1b", "invalidName"),
            ("   ", "model:1b", "invalidName"),
            (long_name.as_str(), "model:1b", "invalidName"),
            ("Test", "", "invalidInput"),
            ("Test", "   ", "invalidInput"),
            ("Test", long_model_id.as_str(), "invalidInput"),
        ] {
            let input = model_input(name, model_id);
            assert_eq!(
                db.save_model(input, None).unwrap_err().code,
                code,
                "must be rejected: {name:?} / {model_id:?}"
            );
        }
        assert!(db.models().unwrap().profiles.is_empty());

        let saved = db
            .save_model(model_input("Test", "model:1b"), None)
            .unwrap();
        // Values this module cannot write are refused by the schema itself.
        for sql in [
            format!(
                "UPDATE model_profiles SET protocol='anthropic' WHERE id='{}'",
                saved.id
            ),
            format!(
                "UPDATE model_profiles SET model_id='' WHERE id='{}'",
                saved.id
            ),
            format!(
                "UPDATE model_profiles SET sort_order=-1 WHERE id='{}'",
                saved.id
            ),
            "UPDATE workspace SET default_model_id='short' WHERE singleton=1".to_owned(),
        ] {
            assert!(
                db.run_sql_for_test(&sql).is_err(),
                "must be rejected: {sql}"
            );
        }
        // A combination the column checks cannot express is still refused when read, so a
        // hand-edited row never reaches the settings page.
        db.run_sql_for_test(&format!(
            "UPDATE model_profiles SET endpoint='https://user:secret@example.test' WHERE id='{}'",
            saved.id
        ))
        .unwrap();
        assert_eq!(db.models().unwrap_err().code, "storageUnavailable");
    }

    /// A version 2 database as the previous release left it: no model table, but the credential
    /// outbox already in use.
    fn v2_database(path: &Path) -> (Connection, String, CredentialRef) {
        let (conn, id) = v1_database(path);
        conn.execute_batch(include_str!("../migrations/002_credentials.sql"))
            .unwrap();
        let reference = CredentialRef::generate();
        conn.execute(
            "INSERT INTO credential_cleanup(reference,reason,queued_at,attempts) VALUES (?1,'cleanup',7,2)",
            [reference.as_str()],
        )
        .unwrap();
        (conn, id, reference)
    }

    #[test]
    fn version_one_database_gains_the_model_schema_without_losing_rows() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v1-models.sqlite");
        let (conn, id) = v1_database(&path);
        drop(conn);

        let db = Database::open(&path).unwrap();
        assert_eq!(
            db.0.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        let state = db.load().unwrap();
        assert_eq!(state.preferences.mode, "dark");
        assert_eq!(state.active_connection_id.as_deref(), Some(id.as_str()));
        assert_eq!(state.connections.len(), 1);
        assert_eq!(state.connections[0].display_name, "Legacy");
        assert_eq!(state.connections[0].sort_order, 3);
        assert_eq!(db.connection_auth(&id).unwrap(), ConnectionAuth::none());
        assert!(db.models().unwrap().profiles.is_empty());
        assert_eq!(db.models().unwrap().default_model_id, None);
        assert_eq!(db.pending_credential_cleanup_count().unwrap(), 0);
    }

    /// A version 3 database as the previous release left it: model profiles and the credential
    /// outbox exist, but the model table has no credential reference yet.
    fn v3_database(path: &Path) -> (Connection, String, CredentialRef, String) {
        let (conn, connection_id, reference) = v2_database(path);
        conn.execute_batch(include_str!("../migrations/003_models.sql"))
            .unwrap();
        let model_id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO model_profiles(id,display_name,protocol,endpoint,model_id,sort_order)
             VALUES (?1,'Legacy model','ollama','http://127.0.0.1:11434','llama3.1:8b',0)",
            [&model_id],
        )
        .unwrap();
        conn.execute(
            "UPDATE workspace SET default_model_id=?1 WHERE singleton=1",
            [&model_id],
        )
        .unwrap();
        (conn, connection_id, reference, model_id)
    }

    #[test]
    fn version_three_database_gains_the_model_credential_reference() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v3-credentials.sqlite");
        let (conn, connection_id, reference, model_id) = v3_database(&path);
        drop(conn);

        let db = Database::open(&path).unwrap();
        assert_eq!(
            db.0.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        let state = db.models().unwrap();
        assert_eq!(state.profiles.len(), 1);
        assert_eq!(state.profiles[0].id, model_id);
        assert!(!state.profiles[0].has_api_key);
        assert!(state.profiles[0].credential_ref.is_none());
        assert_eq!(state.default_model_id.as_deref(), Some(model_id.as_str()));
        // The pre-existing queue entry is preserved and still reported as pending.
        assert!(state.credential_cleanup_pending);
        assert_eq!(db.pending_credential_cleanup_count().unwrap(), 1);
        assert_eq!(
            db.load().unwrap().active_connection_id.as_deref(),
            Some(connection_id.as_str())
        );

        // The new column accepts a canonical reference and fails closed on a foreign spelling.
        db.run_sql_for_test(&format!(
            "UPDATE model_profiles SET credential_ref='{}' WHERE id='{model_id}'",
            reference.as_str()
        ))
        .unwrap();
        let profile = db.model_profile(&model_id).unwrap();
        assert!(profile.has_api_key);
        assert_eq!(profile.credential_ref.as_ref(), Some(&reference));
        db.run_sql_for_test(&format!(
            "UPDATE model_profiles SET credential_ref='zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz' WHERE id='{model_id}'"
        ))
        .unwrap();
        assert_eq!(db.models().unwrap_err().code, "storageUnavailable");
    }

    #[test]
    fn failed_model_credential_migration_keeps_the_previous_version_and_rows() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("credential-conflict.sqlite");
        let (conn, _, _, model_id) = v3_database(&path);
        // Force the fourth step to fail after the migration starts.
        conn.execute_batch("ALTER TABLE model_profiles ADD COLUMN credential_ref INTEGER;")
            .unwrap();
        drop(conn);

        assert!(Database::open(&path).is_err());
        let conn = Connection::open(&path).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 3);
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM model_profiles WHERE id=?1",
                [&model_id],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM credential_cleanup", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn legacy_model_metadata_paths_stay_safe_for_bound_keys() {
        let mut db = Database::open(Path::new(":memory:")).unwrap();
        let saved = db
            .save_model(model_input("Local", "llama3.1:8b"), None)
            .unwrap();
        let reference = CredentialRef::generate();
        db.run_sql_for_test(&format!(
            "UPDATE model_profiles SET credential_ref='{}' WHERE id='{}'",
            reference.as_str(),
            saved.id
        ))
        .unwrap();

        // Renaming and changing the model id keep the bound reference.
        let mut renamed = model_input("Renamed", "qwen2.5:7b");
        let kept = db
            .save_model(renamed.clone(), Some(saved.id.clone()))
            .unwrap();
        assert!(kept.has_api_key);

        // An endpoint change detaches it and queues it in the same metadata write.
        renamed.endpoint = "http://127.0.0.1:9999".into();
        let moved = db.save_model(renamed, Some(saved.id.clone())).unwrap();
        assert!(!moved.has_api_key);
        let queued = db.pending_credential_cleanup(8, MAX_ATTEMPTS).unwrap();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].reference, reference);

        // Deleting a profile that still has a bound reference queues it too instead of losing it.
        let deleted_reference = CredentialRef::generate();
        db.run_sql_for_test(&format!(
            "UPDATE model_profiles SET credential_ref='{}' WHERE id='{}'",
            deleted_reference.as_str(),
            saved.id
        ))
        .unwrap();
        db.delete_model(&saved.id).unwrap();
        let queued: Vec<CredentialRef> = db
            .pending_credential_cleanup(8, MAX_ATTEMPTS)
            .unwrap()
            .into_iter()
            .map(|entry| entry.reference)
            .collect();
        assert!(queued.contains(&reference));
        assert!(queued.contains(&deleted_reference));
        assert!(db.models().unwrap().credential_cleanup_pending);
    }

    #[test]
    fn model_migration_preserves_the_credential_queue_and_is_reentrant() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v2-models.sqlite");
        let (conn, id, reference) = v2_database(&path);
        drop(conn);

        let mut db = Database::open(&path).unwrap();
        let queued = db.pending_credential_cleanup(8, MAX_ATTEMPTS).unwrap();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].reference, reference);
        assert_eq!(queued[0].attempts, 2);
        assert_eq!(
            db.load().unwrap().active_connection_id.as_deref(),
            Some(id.as_str())
        );

        // Model rows written after the migration survive a reopen, and a version 3 file is not
        // migrated a second time.
        let saved = db
            .save_model(model_input("Local", "llama3.1:8b"), None)
            .unwrap();
        drop(db);
        let db = Database::open(&path).unwrap();
        assert_eq!(
            db.0.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        let state = db.models().unwrap();
        assert_eq!(state.profiles.len(), 1);
        assert_eq!(state.profiles[0].id, saved.id);
        assert_eq!(state.default_model_id, Some(saved.id));
        assert_eq!(db.pending_credential_cleanup_count().unwrap(), 1);
    }

    #[test]
    fn failed_model_migration_keeps_the_previous_version_and_every_row() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("model-conflict.sqlite");
        let (conn, id, _) = v2_database(&path);
        // Force the third step to fail after the column add inside it would have succeeded.
        conn.execute_batch("CREATE TABLE model_profiles (bogus TEXT);")
            .unwrap();
        drop(conn);

        assert!(Database::open(&path).is_err());
        let conn = Connection::open(&path).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 2);
        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(workspace)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(!columns.iter().any(|column| column == "default_model_id"));
        assert_eq!(
            conn.query_row(
                "SELECT display_name FROM connections WHERE id=?1",
                [&id],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "Legacy"
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM credential_cleanup", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    /// A version 4 database as the previous release left it: connection/credential metadata,
    /// model profiles with credential support and the shared outbox, but no CA column and no
    /// saved-query table.
    fn v4_database(path: &Path) -> (Connection, String, CredentialRef, String) {
        let (conn, connection_id, reference, model_id) = v3_database(path);
        conn.execute_batch(include_str!("../migrations/004_model_credentials.sql"))
            .unwrap();
        (conn, connection_id, reference, model_id)
    }

    fn legacy_input(name: &str) -> ConnectionInput {
        ConnectionInput {
            display_name: name.into(),
            endpoint: "https://legacy.test/es".into(),
            environment: "staging".into(),
        }
    }

    #[test]
    fn version_four_database_gains_connection_settings_without_losing_rows() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v4-settings.sqlite");
        let (conn, connection_id, reference, model_id) = v4_database(&path);
        drop(conn);

        let mut db = Database::open(&path).unwrap();
        assert_eq!(
            db.0.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        // Every pre-existing row survived; the new state starts empty.
        let summaries = db.connection_summaries().unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].profile.id, connection_id);
        assert!(!summaries[0].has_custom_ca);
        assert_eq!(summaries[0].profile.display_name, "Legacy");
        assert_eq!(db.pending_credential_cleanup_count().unwrap(), 1);
        assert_eq!(
            db.pending_credential_cleanup(8, MAX_ATTEMPTS).unwrap()[0].reference,
            reference
        );
        assert!(db
            .model_profile(&model_id)
            .unwrap()
            .credential_ref
            .is_none());
        assert!(db
            .connection_auth(&connection_id)
            .unwrap()
            .unauthenticated());
        assert_eq!(db.saved_queries_json().unwrap(), None);
        assert_eq!(
            db.load().unwrap().active_connection_id.as_deref(),
            Some(connection_id.as_str())
        );

        // The new CA column accepts a validated chain through the combined write...
        let ca = CaCertificate::parse(crate::connection_tls::test_certificates::ROOT_CA_3).unwrap();
        let record = db
            .save_connection_combined(
                legacy_input("Legacy"),
                Some(connection_id.clone()),
                ConnectionReferenceChange::Keep,
                ConnectionCaChange::Replace(ca),
            )
            .unwrap();
        assert!(record.has_custom_ca);
        assert!(db
            .transport_snapshot(&connection_id)
            .unwrap()
            .ca()
            .is_some());
        // ...and the SQL check refuses a document outside the 64 KiB bound.
        db.run_sql_for_test("UPDATE connections SET ca_pem=hex(zeroblob(32768))")
            .unwrap();
        assert!(db
            .run_sql_for_test("UPDATE connections SET ca_pem=hex(zeroblob(32769))")
            .is_err());
        // A hand-written value that is not a certificate fails closed on read.
        db.run_sql_for_test("UPDATE connections SET ca_pem='not a certificate'")
            .unwrap();
        assert_eq!(
            db.transport_snapshot(&connection_id).unwrap_err().code,
            "invalidCertificate"
        );
        assert_eq!(
            db.connection_summaries().unwrap_err().code,
            "invalidCertificate"
        );
    }

    #[test]
    fn failed_connection_settings_migration_keeps_version_four_and_every_row() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v4-conflict.sqlite");
        let (conn, connection_id, _, model_id) = v4_database(&path);
        // Force the fifth step to fail after the ALTER inside it would have succeeded.
        conn.execute_batch("CREATE TABLE saved_query_library (bogus TEXT);")
            .unwrap();
        drop(conn);

        assert!(Database::open(&path).is_err());
        let conn = Connection::open(&path).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 4);
        // The column added before the failing statement was rolled back with the transaction.
        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(connections)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(!columns.iter().any(|column| column == "ca_pem"));
        assert_eq!(
            conn.query_row(
                "SELECT display_name FROM connections WHERE id=?1",
                [&connection_id],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "Legacy"
        );
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM model_profiles WHERE id=?1",
                [&model_id],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM credential_cleanup", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn saved_query_library_round_trips_and_is_bounded() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("saved-queries.sqlite");
        let document = r#"{"version":1,"queries":[{"id":"a"}]}"#;
        {
            let db = Database::open(&path).unwrap();
            assert_eq!(db.saved_queries_json().unwrap(), None);
            db.save_saved_queries_json(document).unwrap();
            // The upsert replaces the single row instead of appending.
            db.save_saved_queries_json(document).unwrap();
        }
        let db = Database::open(&path).unwrap();
        assert_eq!(db.saved_queries_json().unwrap().as_deref(), Some(document));

        // The application bound refuses an oversized document and keeps the previous one.
        let oversized = "x".repeat(MAX_SAVED_QUERIES_BYTES + 1);
        assert_eq!(
            db.save_saved_queries_json(&oversized).unwrap_err().code,
            "invalidInput"
        );
        assert_eq!(db.saved_queries_json().unwrap().as_deref(), Some(document));
        // The SQL check refuses a document that bypasses the application bound.
        assert!(db
            .run_sql_for_test("UPDATE saved_query_library SET json=hex(zeroblob(2097152))")
            .is_ok());
        assert!(db
            .run_sql_for_test("UPDATE saved_query_library SET json=hex(zeroblob(2097153))")
            .is_err());
    }

    #[test]
    fn combined_save_applies_the_target_rule_to_reference_and_ca() {
        let mut db = Database::open(Path::new(":memory:")).unwrap();
        let created = db.save_connection(input("First"), None).unwrap().profile;
        let reference = CredentialRef::generate();
        let ca = CaCertificate::parse(&crate::connection_tls::test_certificates::chain()).unwrap();

        let record = db
            .save_connection_combined(
                input("First"),
                Some(created.id.clone()),
                ConnectionReferenceChange::Replace {
                    kind: AuthKind::Bearer,
                    reference: &reference,
                },
                ConnectionCaChange::Replace(ca),
            )
            .unwrap();
        assert_eq!(record.profile.auth_state.kind, AuthKind::Bearer);
        assert_eq!(
            record.profile.auth_state.credential_ref.as_ref(),
            Some(&reference)
        );
        assert!(record.has_custom_ca);
        assert!(record.detached.is_none());
        assert_eq!(db.pending_credential_cleanup_count().unwrap(), 0);

        // Renaming with `keep` on the same endpoint preserves both the reference and the chain.
        let record = db
            .save_connection_combined(
                input("Renamed"),
                Some(created.id.clone()),
                ConnectionReferenceChange::Keep,
                ConnectionCaChange::Keep,
            )
            .unwrap();
        assert_eq!(
            record.profile.auth_state.credential_ref.as_ref(),
            Some(&reference)
        );
        assert!(record.has_custom_ca);
        assert!(record.detached.is_none());

        // A changed endpoint with `keep` detaches the credential (queued) and drops the chain.
        let mut moved = input("Renamed");
        moved.endpoint = "https://moved.test/es".into();
        let record = db
            .save_connection_combined(
                moved,
                Some(created.id.clone()),
                ConnectionReferenceChange::Keep,
                ConnectionCaChange::Keep,
            )
            .unwrap();
        assert_eq!(record.detached.as_ref(), Some(&reference));
        assert!(record.profile.auth_state.unauthenticated());
        assert!(!record.has_custom_ca);
        let queued = db.pending_credential_cleanup(8, MAX_ATTEMPTS).unwrap();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].reference, reference);
        let snapshot = db.transport_snapshot(&created.id).unwrap();
        assert!(snapshot.profile().auth_state.unauthenticated());
        assert!(snapshot.ca().is_none());

        // A replacement without a scheme and a missing connection are refused before any write.
        assert_eq!(
            db.save_connection_combined(
                input("Renamed"),
                Some(created.id.clone()),
                ConnectionReferenceChange::Replace {
                    kind: AuthKind::None,
                    reference: &reference,
                },
                ConnectionCaChange::Keep,
            )
            .unwrap_err()
            .code,
            "invalidInput"
        );
        let missing = Uuid::new_v4().to_string();
        assert_eq!(
            db.save_connection_combined(
                input("Missing"),
                Some(missing),
                ConnectionReferenceChange::Keep,
                ConnectionCaChange::Clear,
            )
            .unwrap_err()
            .code,
            "notFound"
        );
        assert_eq!(
            db.save_connection_combined(
                input("Invalid"),
                Some("not-an-id".into()),
                ConnectionReferenceChange::Keep,
                ConnectionCaChange::Keep,
            )
            .unwrap_err()
            .code,
            "invalidInput"
        );
    }

    #[test]
    fn summaries_report_authenticated_rows_truthfully_without_references() {
        let mut db = Database::open(Path::new(":memory:")).unwrap();
        let plain = db.save_connection(input("Plain"), None).unwrap().profile;
        let bound = db.save_connection(input("Bound"), None).unwrap().profile;
        let reference = CredentialRef::generate();
        db.bind_credential(&bound.id, AuthKind::ApiKey, &reference)
            .unwrap();

        // The legacy read still refuses the whole state while a bound row exists.
        assert_eq!(db.load().err().unwrap().code, "unsupported");

        let summaries = db.connection_summaries().unwrap();
        assert_eq!(summaries.len(), 2);
        assert!(summaries[0].profile.auth_state.unauthenticated());
        assert_eq!(summaries[0].profile.id, plain.id);
        assert_eq!(summaries[1].profile.id, bound.id);
        assert_eq!(summaries[1].profile.auth_state.kind, AuthKind::ApiKey);
        assert_eq!(
            summaries[1].profile.auth_state.credential_ref.as_ref(),
            Some(&reference)
        );
        // The internal profile never serializes the reference or the hidden auth state; the
        // credential-aware projection is built by the settings module.
        let json = serde_json::to_string(&summaries[1].profile).unwrap();
        assert!(json.contains(r#""auth":"none""#));
        assert!(!json.contains("credentialRef"));
        assert!(!json.contains(reference.as_str()));
    }

    #[test]
    fn custom_ca_is_isolated_to_its_own_connection_snapshot() {
        let mut db = Database::open(Path::new(":memory:")).unwrap();
        let secured = db.save_connection(input("Secured"), None).unwrap().profile;
        let plain = db.save_connection(input("Plain"), None).unwrap().profile;
        let ca = CaCertificate::parse(crate::connection_tls::test_certificates::ROOT_CA_3).unwrap();
        db.save_connection_combined(
            input("Secured"),
            Some(secured.id.clone()),
            ConnectionReferenceChange::Keep,
            ConnectionCaChange::Replace(ca),
        )
        .unwrap();

        // The chain belongs to the row that stored it; another connection's snapshot has none, so
        // its client can never be built with a foreign root.
        assert!(db.transport_snapshot(&secured.id).unwrap().ca().is_some());
        assert!(db.transport_snapshot(&plain.id).unwrap().ca().is_none());
        let summaries = db.connection_summaries().unwrap();
        assert!(summaries[0].has_custom_ca);
        assert!(!summaries[1].has_custom_ca);

        // Clearing it touches only its own row.
        db.save_connection_combined(
            input("Secured"),
            Some(secured.id.clone()),
            ConnectionReferenceChange::Keep,
            ConnectionCaChange::Clear,
        )
        .unwrap();
        assert!(db.transport_snapshot(&secured.id).unwrap().ca().is_none());
        assert!(db.transport_snapshot(&plain.id).unwrap().ca().is_none());
    }

    #[test]
    fn legacy_metadata_write_clears_the_ca_on_an_endpoint_change_only() {
        let mut db = Database::open(Path::new(":memory:")).unwrap();
        let created = db.save_connection(input("First"), None).unwrap().profile;
        let ca = CaCertificate::parse(crate::connection_tls::test_certificates::ROOT_CA_3).unwrap();
        db.save_connection_combined(
            input("First"),
            Some(created.id.clone()),
            ConnectionReferenceChange::Keep,
            ConnectionCaChange::Replace(ca),
        )
        .unwrap();

        // The legacy metadata path preserves the chain on a rename...
        let renamed = db
            .save_connection(input("Renamed"), Some(created.id.clone()))
            .unwrap();
        assert!(renamed.has_custom_ca);
        // ...and drops it with the endpoint change, exactly like a credential.
        let mut moved = input("Renamed");
        moved.endpoint = "https://moved.test/es".into();
        let record = db.save_connection(moved, Some(created.id.clone())).unwrap();
        assert!(!record.has_custom_ca);
        assert!(db.transport_snapshot(&created.id).unwrap().ca().is_none());
        assert_eq!(db.pending_credential_cleanup_count().unwrap(), 0);
    }

    /// A saved-query document as the previous release stored it, byte for byte.
    const SAVED_QUERY_DOCUMENT: &str = r#"{"version":1,"entries":[]}"#;

    /// A version 5 database as the previous release left it: connection/model/credential metadata,
    /// the CA column and the saved-query library, but no recovery table.
    fn v5_database(path: &Path) -> (Connection, String, CredentialRef, String) {
        let (conn, connection_id, reference, model_id) = v4_database(path);
        conn.execute_batch(include_str!("../migrations/005_connection_settings.sql"))
            .unwrap();
        conn.execute(
            "INSERT INTO saved_query_library(singleton,json) VALUES (1,?1)",
            [SAVED_QUERY_DOCUMENT],
        )
        .unwrap();
        (conn, connection_id, reference, model_id)
    }

    #[test]
    fn workspace_recovery_migration_preserves_v5_rows_and_reopens() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v5-recovery.sqlite");
        let (conn, connection_id, _, model_id) = v5_database(&path);
        drop(conn);

        let db = Database::open(&path).unwrap();
        assert_eq!(
            db.0.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        // The migration only adds the table: it starts empty and nothing is inserted.
        assert!(db.workspace_recovery_row().unwrap().is_none());
        // Every pre-existing row survived untouched.
        assert_eq!(
            db.saved_queries_json().unwrap().as_deref(),
            Some(SAVED_QUERY_DOCUMENT)
        );
        let summaries = db.connection_summaries().unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].profile.id, connection_id);
        let models = db.models().unwrap();
        assert_eq!(models.profiles.len(), 1);
        assert_eq!(models.profiles[0].id, model_id);
        assert_eq!(db.preferences().unwrap().mode, "dark");
        drop(db);

        // Reopening an already-migrated file is a no-op and keeps the schema version.
        let db = Database::open(&path).unwrap();
        assert_eq!(
            db.0.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert_eq!(
            db.saved_queries_json().unwrap().as_deref(),
            Some(SAVED_QUERY_DOCUMENT)
        );
        assert!(db.workspace_recovery_row().unwrap().is_none());
    }

    #[test]
    fn failed_workspace_recovery_migration_keeps_version_five_and_every_row() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v5-conflict.sqlite");
        let (conn, connection_id, _, model_id) = v5_database(&path);
        // Force the sixth step to fail after the transaction begins: the table name is taken by
        // a foreign table the migration must not clobber.
        conn.execute_batch("CREATE TABLE workspace_recovery (bogus TEXT);")
            .unwrap();
        drop(conn);

        assert!(Database::open(&path).is_err());
        let conn = Connection::open(&path).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 5);
        // The foreign table is left exactly as it was; the failing CREATE never happened.
        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(workspace_recovery)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(columns, vec!["bogus".to_owned()]);
        // Every previous row survives the rolled-back step.
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM connections WHERE id=?1",
                [&connection_id],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM model_profiles WHERE id=?1",
                [&model_id],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT json FROM saved_query_library WHERE singleton=1",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            SAVED_QUERY_DOCUMENT
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM credential_cleanup", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    fn v6_database(path: &Path) -> (Connection, String, String) {
        let (conn, connection_id, _, model_id) = v5_database(path);
        conn.execute_batch(include_str!("../migrations/006_workspace_recovery.sql"))
            .unwrap();
        conn.execute(
            "INSERT INTO workspace_recovery(singleton,revision,json) VALUES(1,7,?1)",
            [r#"{"version":1,"workspace":null,"history":[]}"#],
        )
        .unwrap();
        (conn, connection_id, model_id)
    }

    #[test]
    fn data_views_migration_preserves_v6_rows_and_reopens_without_inserting_views() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("v6-views.sqlite");
        let (conn, connection_id, model_id) = v6_database(&path);
        drop(conn);
        for _ in 0..2 {
            let database = Database::open(&path).unwrap();
            assert_eq!(
                database
                    .0
                    .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                    .unwrap(),
                7
            );
            assert_eq!(database.data_views().unwrap().revision, 0);
            assert_eq!(
                database
                    .0
                    .query_row("SELECT count(*) FROM data_view_library", [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            assert_eq!(
                database.workspace_recovery_row().unwrap().unwrap().revision,
                7
            );
            assert_eq!(
                database.saved_queries_json().unwrap().as_deref(),
                Some(SAVED_QUERY_DOCUMENT)
            );
            assert_eq!(
                database.connection_summaries().unwrap()[0].profile.id,
                connection_id
            );
            assert_eq!(database.models().unwrap().profiles[0].id, model_id);
            assert_eq!(database.preferences().unwrap().mode, "dark");
            assert_eq!(database.pending_credential_cleanup_count().unwrap(), 1);
        }
    }

    #[test]
    fn failed_data_views_migration_preserves_version_six_and_all_existing_documents() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("v6-conflict.sqlite");
        let (conn, connection_id, model_id) = v6_database(&path);
        conn.execute_batch("CREATE TABLE data_view_library(bogus TEXT)")
            .unwrap();
        drop(conn);
        assert!(Database::open(&path).is_err());
        let conn = Connection::open(&path).unwrap();
        assert_eq!(
            conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            6
        );
        assert_eq!(
            conn.query_row(
                "SELECT name FROM pragma_table_info('data_view_library')",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "bogus"
        );
        assert_eq!(
            conn.query_row("SELECT revision FROM workspace_recovery", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            7
        );
        assert_eq!(
            conn.query_row("SELECT json FROM saved_query_library", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            SAVED_QUERY_DOCUMENT
        );
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM connections WHERE id=?1",
                [&connection_id],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM model_profiles WHERE id=?1",
                [&model_id],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM credential_cleanup", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn workspace_recovery_rows_with_invalid_revision_or_size_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("foreign-recovery.sqlite");
        let db = Database::open(&path).unwrap();
        // A revision no writer of this build could have produced. The SQL check is bypassed on
        // purpose: the read must fail closed on its own.
        db.run_sql_for_test(
            "PRAGMA ignore_check_constraints=ON;
             INSERT INTO workspace_recovery(singleton,revision,json) VALUES (1,9007199254740992,'{}');",
        )
        .unwrap();
        assert_eq!(
            db.workspace_recovery_row().unwrap_err().code,
            "invalidResponse"
        );
        // An oversize document (8389634 UTF-8 bytes) fails the same way.
        db.run_sql_for_test(
            "UPDATE workspace_recovery SET revision=1, json=hex(zeroblob(4194817));",
        )
        .unwrap();
        assert_eq!(
            db.workspace_recovery_row().unwrap_err().code,
            "invalidResponse"
        );
        // A well-formed row reads back exactly as stored.
        db.run_sql_for_test(
            "UPDATE workspace_recovery SET revision=4, json='{\"version\":1,\"workspace\":null,\"history\":[]}';",
        )
        .unwrap();
        let row = db.workspace_recovery_row().unwrap().unwrap();
        assert_eq!(row.revision, 4);
        assert_eq!(row.json, r#"{"version":1,"workspace":null,"history":[]}"#);
    }

    #[test]
    fn workspace_recovery_save_is_a_compare_and_swap_and_stays_bounded() {
        let mut db = Database::open(Path::new(":memory:")).unwrap();
        let first = r#"{"version":1,"workspace":null,"history":[]}"#;
        let second = r#"{"version":1,"workspace":{"activeConnectionId":null,"activeTabId":null,"tabs":[],"lastTabByConnection":{}},"history":[]}"#;

        // Absent row: expected 0 inserts revision 1; anything else is a conflict.
        assert_eq!(
            db.save_workspace_recovery(5, first).unwrap_err().code,
            "workspaceConflict"
        );
        assert_eq!(db.save_workspace_recovery(0, first).unwrap(), 1);
        assert_eq!(db.workspace_recovery_row().unwrap().unwrap().json, first);

        // A stale writer cannot overwrite the stored bytes.
        assert_eq!(
            db.save_workspace_recovery(0, second).unwrap_err().code,
            "workspaceConflict"
        );
        assert_eq!(db.workspace_recovery_row().unwrap().unwrap().json, first);
        assert_eq!(db.save_workspace_recovery(1, second).unwrap(), 2);
        let row = db.workspace_recovery_row().unwrap().unwrap();
        assert_eq!(row.revision, 2);
        assert_eq!(row.json, second);

        // An expected revision outside the JS-safe range is refused before any read.
        assert_eq!(
            db.save_workspace_recovery(u64::MAX, first)
                .unwrap_err()
                .code,
            "invalidInput"
        );

        // The application bound keeps the previous document; the SQL check refuses a document
        // that bypasses it.
        let oversized = "x".repeat(MAX_WORKSPACE_RECOVERY_BYTES + 1);
        assert_eq!(
            db.save_workspace_recovery(2, &oversized).unwrap_err().code,
            "invalidInput"
        );
        assert_eq!(db.workspace_recovery_row().unwrap().unwrap().json, second);
        assert!(db
            .run_sql_for_test("UPDATE workspace_recovery SET json=hex(zeroblob(4194816))")
            .is_ok());
        assert!(db
            .run_sql_for_test("UPDATE workspace_recovery SET json=hex(zeroblob(4194817))")
            .is_err());
    }

    #[test]
    fn workspace_recovery_read_only_storage_does_not_claim_success() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("readonly-recovery.sqlite");
        let mut db = Database::open(&path).unwrap();
        let document = r#"{"version":1,"workspace":null,"history":[]}"#;
        assert_eq!(db.save_workspace_recovery(0, document).unwrap(), 1);
        db.run_sql_for_test("PRAGMA query_only=ON;").unwrap();

        // Reads still work; a write fails closed and the stored row is untouched.
        assert_eq!(db.workspace_recovery_row().unwrap().unwrap().revision, 1);
        assert_eq!(
            db.save_workspace_recovery(1, document).unwrap_err().code,
            "storageUnavailable"
        );
        assert_eq!(db.workspace_recovery_row().unwrap().unwrap().json, document);
    }

    #[test]
    fn workspace_recovery_read_failure_is_not_an_empty_or_damaged_document() {
        let connection = Connection::open_in_memory().unwrap();
        assert_eq!(
            read_workspace_recovery_row(&connection).unwrap_err().code,
            "storageUnavailable"
        );
        connection
            .execute_batch(
                "CREATE TABLE workspace_recovery (singleton INTEGER, revision, json);
                 INSERT INTO workspace_recovery VALUES (1, 'invalid-counter', '{}');",
            )
            .unwrap();
        assert_eq!(
            read_workspace_recovery_row(&connection).unwrap_err().code,
            "invalidResponse"
        );
    }
}
