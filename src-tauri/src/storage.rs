use crate::error::AppError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use url::Url;
use uuid::Uuid;

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
        if self.endpoint.len() > 2048 {
            return Err(AppError::new("invalidEndpoint"));
        }
        let url = Url::parse(self.endpoint.trim()).map_err(|_| AppError::new("invalidEndpoint"))?;
        if !["http", "https"].contains(&url.scheme())
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(AppError::new("invalidEndpoint"));
        }
        if !["development", "staging", "production"].contains(&self.environment.as_str()) {
            return Err(AppError::new("invalidEnvironment"));
        }
        self.endpoint = url.as_str().trim_end_matches('/').to_owned();
        Ok(self)
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
    pub auth: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredState {
    preferences: Preferences,
    connections: Vec<ConnectionProfile>,
    active_connection_id: Option<String>,
}

pub struct Database(Connection);

impl Database {
    pub fn open(path: &Path) -> Result<Self, AppError> {
        let mut conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(3))?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        match version {
            0 => {
                let tx = conn.transaction()?;
                tx.execute_batch(include_str!("../migrations/001_initial.sql"))?;
                tx.commit()?;
            }
            1 => {}
            _ => return Err(AppError::new("unsupported")),
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
        let mut statement = self.0.prepare(
            "SELECT id, display_name, endpoint, environment, sort_order FROM connections ORDER BY sort_order, id",
        )?;
        let connections = statement
            .query_map([], |row| {
                Ok(ConnectionProfile {
                    id: row.get(0)?,
                    display_name: row.get(1)?,
                    endpoint: row.get(2)?,
                    environment: row.get(3)?,
                    sort_order: row.get(4)?,
                    auth: "none",
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if connections.len() > 1000 {
            return Err(AppError::new("storageUnavailable"));
        }
        for profile in &connections {
            let input = ConnectionInput {
                display_name: profile.display_name.clone(),
                endpoint: profile.endpoint.clone(),
                environment: profile.environment.clone(),
            };
            input
                .validate()
                .map_err(|_| AppError::new("storageUnavailable"))?;
            if Uuid::parse_str(&profile.id).is_err()
                || !(0..=1_000_000).contains(&profile.sort_order)
            {
                return Err(AppError::new("storageUnavailable"));
            }
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

    pub fn save_connection(
        &mut self,
        input: ConnectionInput,
        id: Option<String>,
    ) -> Result<ConnectionProfile, AppError> {
        let clean = input.validate()?;
        let tx = self.0.transaction()?;
        let (id, sort_order) = match id {
            Some(id) => {
                Uuid::parse_str(&id).map_err(|_| AppError::new("invalidInput"))?;
                let order = tx
                    .query_row(
                        "SELECT sort_order FROM connections WHERE id=?1",
                        [&id],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?
                    .ok_or_else(|| AppError::new("notFound"))?;
                (id, order)
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
                (Uuid::new_v4().to_string(), order)
            }
        };
        tx.execute(
            "INSERT INTO connections(id,display_name,endpoint,environment,sort_order) VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,endpoint=excluded.endpoint,environment=excluded.environment",
            params![id, clean.display_name, clean.endpoint, clean.environment, sort_order],
        )?;
        tx.commit()?;
        Ok(ConnectionProfile {
            id,
            display_name: clean.display_name,
            endpoint: clean.endpoint,
            environment: clean.environment,
            sort_order,
            auth: "none",
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

    pub fn delete_connection(&mut self, id: &str) -> Result<(), AppError> {
        let tx = self.0.transaction()?;
        if tx.execute("DELETE FROM connections WHERE id=?1", [id])? == 0 {
            return Err(AppError::new("notFound"));
        }
        tx.execute(
            "UPDATE workspace SET active_connection_id=(SELECT id FROM connections ORDER BY sort_order,id LIMIT 1)
             WHERE singleton=1 AND active_connection_id IS NULL", [],
        )?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let first = db.save_connection(input("Zulu"), None).unwrap();
        let second = db.save_connection(input("Alpha"), None).unwrap();
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
    fn corrupt_endpoint_is_not_returned_to_frontend() {
        let mut db = Database::open(Path::new(":memory:")).unwrap();
        let profile = db.save_connection(input("Test"), None).unwrap();
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
}
