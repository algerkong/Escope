use crate::credentials::CredentialRef;
use crate::error::AppError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use url::Url;
use uuid::Uuid;

/// Highest schema version this build understands. A file above it fails closed instead of being
/// opened with an unknown layout.
const SCHEMA_VERSION: i64 = 3;

/// Hard upper bound for one credential cleanup batch, so no caller can request unbounded work.
pub const MAX_CLEANUP_BATCH: usize = 64;

/// Hard upper bound for stored model profiles, so one database cannot grow without limit.
pub const MAX_MODEL_PROFILES: usize = 128;

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionInput {
    pub display_name: String,
    pub endpoint: String,
    pub environment: String,
}

impl ConnectionInput {
    fn validate(mut self) -> Result<Self, AppError> {
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
/// IPC: [`ConnectionProfile::auth`] stays `"none"` until an authenticated request path exists, so
/// a stored credential can never be mistaken for an active authenticated session.
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
}

impl RawConnection {
    const COLUMNS: &'static str =
        "id, display_name, endpoint, environment, sort_order, auth_kind, credential_ref";

    fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            display_name: row.get(1)?,
            endpoint: row.get(2)?,
            environment: row.get(3)?,
            sort_order: row.get(4)?,
            auth_kind: row.get(5)?,
            credential_ref: row.get(6)?,
        })
    }

    /// Validate every stored field and the credential metadata. Anything the writer could not have
    /// produced through this module fails closed instead of reaching a caller.
    fn into_profile(self) -> Result<ConnectionProfile, AppError> {
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
        Ok(ConnectionProfile {
            id: self.id,
            display_name: self.display_name,
            endpoint: self.endpoint,
            environment: self.environment,
            sort_order: self.sort_order,
            auth: "none",
            auth_state,
        })
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    pub display_name: String,
    pub endpoint: String,
    pub environment: String,
    pub sort_order: i64,
    /// IPC-facing authentication label. Stays `"none"` while no authenticated request path
    /// exists; the real state lives in `auth_state` and is never serialized.
    pub auth: &'static str,
    #[serde(skip)]
    pub(crate) auth_state: ConnectionAuth,
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
/// spells it; `Deserialize` exists so that fixture can be pinned from the Rust side too.
#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelProfile {
    pub id: String,
    pub display_name: String,
    pub protocol: ModelProtocol,
    pub endpoint: String,
    pub model_id: String,
    pub sort_order: i64,
}

/// Everything the model settings page reads in one call, so the list and the default selection can
/// never be read from two different states. `default_model_id` is the resolved default: the stored
/// selection while it still names a profile, otherwise the first profile, otherwise `None`.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelsState {
    pub profiles: Vec<ModelProfile>,
    pub default_model_id: Option<String>,
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
}

impl RawModel {
    const COLUMNS: &'static str = "id, display_name, protocol, endpoint, model_id, sort_order";

    fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            display_name: row.get(1)?,
            protocol: row.get(2)?,
            endpoint: row.get(3)?,
            model_id: row.get(4)?,
            sort_order: row.get(5)?,
        })
    }

    /// Validate every stored field. Anything the writer could not have produced through this module
    /// fails closed instead of reaching a caller.
    fn into_profile(self) -> Result<ModelProfile, AppError> {
        let protocol = ModelProtocol::parse(&self.protocol)?;
        if Uuid::parse_str(&self.id).is_err() || !(0..=1_000_000).contains(&self.sort_order) {
            return Err(AppError::new("storageUnavailable"));
        }
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
        })
    }
}

pub struct Database(Connection);

impl Database {
    /// Read one connection for the legacy IPC surface. A connection with a bound credential is
    /// refused: the legacy profile reports `auth: "none"`, which would misrepresent it. The
    /// credential-aware caller reads through the orchestration snapshot instead.
    pub fn connection(&self, id: &str) -> Result<ConnectionProfile, AppError> {
        Uuid::parse_str(id).map_err(|_| AppError::new("invalidInput"))?;
        let profile = self
            .read_connection(id)?
            .ok_or_else(|| AppError::new("notFound"))?;
        if !profile.auth_state.unauthenticated() {
            return Err(AppError::new("unsupported"));
        }
        Ok(profile)
    }

    /// Read one connection including its credential metadata, without the legacy refusal. Used by
    /// the credential orchestration, never by an IPC command.
    fn read_connection(&self, id: &str) -> Result<Option<ConnectionProfile>, AppError> {
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
        raw.map(RawConnection::into_profile).transpose()
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

    pub fn load(&self) -> Result<StoredState, AppError> {
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
        let mut statement = self.0.prepare(&format!(
            "SELECT {} FROM connections ORDER BY sort_order, id",
            RawConnection::COLUMNS
        ))?;
        let rows = statement
            .query_map([], RawConnection::read)?
            .collect::<Result<Vec<_>, _>>()?;
        if rows.len() > 1000 {
            return Err(AppError::new("storageUnavailable"));
        }
        let mut connections = Vec::with_capacity(rows.len());
        for raw in rows {
            let profile = raw.into_profile()?;
            if !profile.auth_state.unauthenticated() {
                // The legacy state read reports every connection as `auth: "none"`. Rather than
                // misrepresent a connection that has a credential, it refuses the whole read until
                // the credential-aware contract exists.
                return Err(AppError::new("unsupported"));
            }
            connections.push(profile);
        }
        let selected: Option<String> = self.0.query_row(
            "SELECT active_connection_id FROM workspace WHERE singleton=1",
            [],
            |row| row.get(0),
        )?;
        let active_connection_id = selected
            .filter(|id| connections.iter().any(|profile| &profile.id == id))
            .or_else(|| connections.first().map(|profile| profile.id.clone()));
        Ok(StoredState {
            preferences,
            connections,
            active_connection_id,
        })
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
        let (id, sort_order, auth_state, detached) = match id {
            Some(id) => {
                Uuid::parse_str(&id).map_err(|_| AppError::new("invalidInput"))?;
                let previous = tx
                    .query_row(
                        "SELECT sort_order, endpoint, auth_kind, credential_ref FROM connections WHERE id=?1",
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
                let auth = parse_auth(&previous.2, previous.3.as_deref())?;
                if policy == BoundCredential::Reject && !auth.unauthenticated() {
                    return Err(AppError::new("unsupported"));
                }
                // A credential was captured for one endpoint. Sending it to a different host
                // would disclose the old secret to a new target, so an endpoint change detaches
                // it in the same transaction and queues the secret for deletion. Renaming keeps
                // the reference and the stable id.
                let detached = if previous.1 == clean.endpoint {
                    None
                } else {
                    if !auth.unauthenticated() {
                        tx.execute(
                            "UPDATE connections SET auth_kind='none', credential_ref=NULL WHERE id=?1",
                            [&id],
                        )?;
                    }
                    auth.credential_ref.clone()
                };
                let auth_state = if detached.is_some() {
                    ConnectionAuth::none()
                } else {
                    auth
                };
                (id, previous.0, auth_state, detached)
            }
            None => {
                let count: i64 =
                    tx.query_row("SELECT count(*) FROM connections", [], |row| row.get(0))?;
                if count >= 1000 {
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
                )
            }
        };
        tx.execute(
            "INSERT INTO connections(id,display_name,endpoint,environment,sort_order) VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,endpoint=excluded.endpoint,environment=excluded.environment",
            params![id, clean.display_name, clean.endpoint, clean.environment, sort_order],
        )?;
        if let Some(reference) = &detached {
            queue_cleanup(&tx, reference, CleanupReason::Cleanup)?;
        }
        tx.commit()?;
        Ok(ConnectionRecord {
            profile: ConnectionProfile {
                id,
                display_name: clean.display_name,
                endpoint: clean.endpoint,
                environment: clean.environment,
                sort_order,
                auth: "none",
                auth_state,
            },
            detached,
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
    /// adapter applies, so both adapters answer the same question with the same answer.
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
        })
    }

    /// Create or update one model profile. `id` is the stable identity: an update keeps it and its
    /// sort order, and a new profile is appended. Model metadata has no credential to detach, so
    /// editing an endpoint only changes the target.
    pub fn save_model(
        &mut self,
        input: ModelInput,
        id: Option<String>,
    ) -> Result<ModelProfile, AppError> {
        let clean = input.validate()?;
        let tx = self.0.transaction()?;
        let (id, sort_order) = match id {
            Some(id) => {
                Uuid::parse_str(&id).map_err(|_| AppError::new("invalidInput"))?;
                let sort_order = tx
                    .query_row(
                        "SELECT sort_order FROM model_profiles WHERE id=?1",
                        [&id],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?
                    .ok_or_else(|| AppError::new("notFound"))?;
                (id, sort_order)
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
                (Uuid::new_v4().to_string(), order)
            }
        };
        tx.execute(
            "INSERT INTO model_profiles(id,display_name,protocol,endpoint,model_id,sort_order)
             VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,protocol=excluded.protocol,
               endpoint=excluded.endpoint,model_id=excluded.model_id",
            params![
                id,
                clean.display_name,
                clean.protocol.as_str(),
                clean.endpoint,
                clean.model_id,
                sort_order
            ],
        )?;
        tx.commit()?;
        Ok(ModelProfile {
            id,
            display_name: clean.display_name,
            protocol: clean.protocol,
            endpoint: clean.endpoint,
            model_id: clean.model_id,
            sort_order,
        })
    }

    /// Delete one profile and repair the stored default in the same transaction: the selection
    /// moves to the first remaining profile, or becomes `NULL` when none is left. Without this the
    /// row would keep pointing at an id that no longer exists.
    pub fn delete_model(&mut self, id: &str) -> Result<(), AppError> {
        Uuid::parse_str(id).map_err(|_| AppError::new("invalidInput"))?;
        let tx = self.0.transaction()?;
        if tx.execute("DELETE FROM model_profiles WHERE id=?1", [id])? == 0 {
            return Err(AppError::new("notFound"));
        }
        tx.execute(
            "UPDATE workspace
             SET default_model_id=(SELECT id FROM model_profiles ORDER BY sort_order,id LIMIT 1)
             WHERE singleton=1
               AND (default_model_id IS NULL
                    OR NOT EXISTS (SELECT 1 FROM model_profiles WHERE id=default_model_id))",
            [],
        )?;
        tx.commit()?;
        Ok(())
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
        let profile = read_profile(&tx, id)?;
        tx.commit()?;
        Ok(ConnectionRecord {
            profile,
            detached: auth.credential_ref,
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
        let profile = read_profile(&tx, id)?;
        tx.commit()?;
        Ok(ConnectionRecord {
            profile,
            detached: previous,
        })
    }

    /// One bounded batch of queued references that may be deleted right now. Entries that exhausted
    /// their retry budget and entries a connection still uses are skipped in SQL, so a stuck head
    /// can never starve later entries; they stay in the table for recovery and are counted by
    /// [`Database::credential_cleanup_backlog`]. `limit` is clamped to [`MAX_CLEANUP_BATCH`].
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
    /// forgotten, so a caller can surface how many still need attention.
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
                   AND EXISTS (SELECT 1 FROM connections WHERE credential_ref = credential_cleanup.reference)) AS deferred",
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
/// are refused: a saved endpoint is a target, never a place to hide a secret.
fn clean_endpoint(value: &str) -> Result<String, AppError> {
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

/// Read and validate one connection row inside an open transaction.
fn read_profile(tx: &rusqlite::Transaction<'_>, id: &str) -> Result<ConnectionProfile, AppError> {
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
    raw.into_profile()
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

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
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
        let profile = db.read_connection(&created.id).unwrap().unwrap();
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
}
