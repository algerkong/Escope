//! `saved_queries` IPC: the local query library (named drafts/favorites) and loaded-result export.
//!
//! The library is one versioned document stored as a single opaque row
//! (`Database::saved_queries_json` / `save_saved_queries_json`). This module owns the typed
//! contract of that document, mirroring the frontend `query-library` domain module:
//!
//! * `saved_queries_load` reads the stored JSON, validates it strictly (`deny_unknown_fields`,
//!   version, count and per-field bounds) and returns an empty library only when nothing was ever
//!   saved. Anything this build cannot explain fails the load with `invalidResponse`; the stored
//!   bytes are never rewritten from a failed load, so damaged data is left untouched.
//! * `saved_queries_save` validates the same bounds and the stored library, then compares the
//!   caller's last-read document before an atomic write. Corrupt, unknown or conflicting state
//!   is never repaired or overwritten; an over-limit payload leaves the previous row intact.
//! * `saved_queries_export` opens the native save dialog and writes the caller's bounded bytes to
//!   the user-chosen file through a same-directory temporary file. The request carries only a
//!   format, a file name and the content — never a path — and a cancelled dialog is reported as
//!   `cancelled`, never as a saved file. The dialog and the file I/O run off the async runtime's
//!   worker threads.
//!
//! Drafts may hold invalid or incomplete DSL on purpose: only the byte size is bounded. Entries
//! carry the stable connection ID they were saved under; nothing here rebinds, executes or
//! resolves a connection.

use crate::error::AppError;
use crate::query_parameters::{optional_parameters, QueryParameters};
use crate::storage::Database;
use crate::{with_database, StorageState};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

/// Version of the library document this build writes and accepts.
pub const LIBRARY_VERSION: u32 = 1;
/// Hard bound on stored entries, mirrored by the frontend domain module.
const MAX_ENTRIES: usize = 100;
const MAX_ID_BYTES: usize = 64;
const MAX_NAME_CHARS: usize = 120;
const MAX_CONNECTION_ID_BYTES: usize = 64;
const MAX_INDEX_BYTES: usize = 1024;
/// One draft body stays bounded without validating it: an incomplete query is still a draft.
const MAX_DSL_BYTES: usize = 256 * 1024;
const MAX_UPDATED_AT_CHARS: usize = 40;
/// One export payload bound; loaded rows only, so this is generous but finite.
const MAX_EXPORT_BYTES: usize = 16 * 1024 * 1024;
const MAX_EXPORT_NAME_CHARS: usize = 128;

/// Windows device names that cannot be used as a file stem, with or without an extension.
const RESERVED_STEMS: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ResultView {
    Table,
    Json,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedQueryEntry {
    pub id: String,
    pub name: String,
    /// Stable connection ID captured at save time; kept even after the connection is deleted.
    pub connection_id: Option<String>,
    pub index: String,
    /// Verbatim DSL text, incomplete drafts included.
    pub dsl: String,
    pub result_view: ResultView,
    pub favorite: bool,
    pub updated_at: String,
    #[serde(
        default,
        deserialize_with = "optional_parameters",
        skip_serializing_if = "Option::is_none"
    )]
    pub parameters: Option<QueryParameters>,
}

/// Debug output must never leak a draft body: the DSL is shown as its byte length only.
impl std::fmt::Debug for SavedQueryEntry {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SavedQueryEntry")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("connection_id", &self.connection_id)
            .field("index", &self.index)
            .field("dsl_bytes", &self.dsl.len())
            .field("result_view", &self.result_view)
            .field("favorite", &self.favorite)
            .field("updated_at", &self.updated_at)
            .field("parameters", &self.parameters)
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedQueryLibrary {
    pub version: u32,
    pub entries: Vec<SavedQueryEntry>,
}

impl SavedQueryLibrary {
    pub fn empty() -> Self {
        Self {
            version: LIBRARY_VERSION,
            entries: Vec::new(),
        }
    }

    /// Count, unique IDs, version and every per-field bound. The message is always
    /// `invalidInput`; the load path maps that to its own fail-closed code.
    pub fn validate(&self) -> Result<(), AppError> {
        if self.version != LIBRARY_VERSION || self.entries.len() > MAX_ENTRIES {
            return Err(AppError::new("invalidInput"));
        }
        let mut ids = std::collections::HashSet::with_capacity(self.entries.len());
        for entry in &self.entries {
            entry.validate()?;
            if !ids.insert(entry.id.as_str()) {
                return Err(AppError::new("invalidInput"));
            }
        }
        Ok(())
    }
}

impl SavedQueryEntry {
    pub(crate) fn validate(&self) -> Result<(), AppError> {
        if !valid_id(&self.id) {
            return Err(AppError::new("invalidInput"));
        }
        if self.name.chars().count() > MAX_NAME_CHARS || self.name.chars().any(char::is_control) {
            return Err(AppError::new("invalidInput"));
        }
        if let Some(connection_id) = &self.connection_id {
            if connection_id.is_empty()
                || connection_id.len() > MAX_CONNECTION_ID_BYTES
                || !connection_id.bytes().all(|byte| byte.is_ascii_graphic())
            {
                return Err(AppError::new("invalidInput"));
            }
        }
        if self.index.len() > MAX_INDEX_BYTES || self.dsl.len() > MAX_DSL_BYTES {
            return Err(AppError::new("invalidInput"));
        }
        if let Some(parameters) = &self.parameters {
            parameters.validate()?;
        }
        if self.updated_at.is_empty()
            || self.updated_at.len() > MAX_UPDATED_AT_CHARS
            || !self
                .updated_at
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '.' | '+' | '-'))
        {
            return Err(AppError::new("invalidInput"));
        }
        Ok(())
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_BYTES
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// Fail-closed read: `None` is an empty library, and a document this build cannot explain is an
/// error whose bytes stay exactly as stored (nothing is repaired or rewritten here).
pub(crate) fn load_library(database: &mut Database) -> Result<SavedQueryLibrary, AppError> {
    let Some(json) = database.saved_queries_json()? else {
        return Ok(SavedQueryLibrary::empty());
    };
    decode_library(&json)
}

pub(crate) fn decode_library(json: &str) -> Result<SavedQueryLibrary, AppError> {
    if json.len() > crate::storage::MAX_SAVED_QUERIES_BYTES {
        return Err(AppError::new("invalidResponse"));
    }
    let library = serde_json::from_str::<SavedQueryLibrary>(json)
        .map_err(|_| AppError::new("invalidResponse"))?;
    library
        .validate()
        .map_err(|_| AppError::new("invalidResponse"))?;
    Ok(library)
}

pub(crate) fn save_checked(
    database: &mut Database,
    library: SavedQueryLibrary,
    expected: SavedQueryLibrary,
    targets: &[(String, String)],
) -> Result<(), AppError> {
    library.validate()?;
    expected.validate()?;
    let json = serde_json::to_string(&library).map_err(|_| AppError::new("invalidInput"))?;
    if json.len() > crate::storage::MAX_SAVED_QUERIES_BYTES {
        return Err(AppError::new("invalidInput"));
    }
    let previous = database.saved_queries_json()?;
    let stored = previous
        .as_deref()
        .map(decode_library)
        .transpose()?
        .unwrap_or_else(SavedQueryLibrary::empty);
    if stored != expected {
        return Err(AppError::new("libraryConflict"));
    }
    database.compare_saved_queries_json(previous.as_deref(), &json, targets)
}

#[cfg(test)]
fn save_library(database: &mut Database, library: SavedQueryLibrary) -> Result<(), AppError> {
    let expected = load_library(database)?;
    save_checked(database, library, expected, &[])
}

/// Read the whole library. A document this build cannot explain is `invalidResponse`.
#[tauri::command]
pub(crate) fn saved_queries_load(
    state: State<'_, StorageState>,
) -> Result<SavedQueryLibrary, AppError> {
    with_database(&state, load_library)
}

/// Replace the whole library only when the caller's last-read document still matches.
#[tauri::command]
pub(crate) fn saved_queries_save(
    state: State<'_, StorageState>,
    library: SavedQueryLibrary,
    expected: SavedQueryLibrary,
) -> Result<(), AppError> {
    with_database(&state, |database| {
        save_checked(database, library, expected, &[])
    })
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Jsonl,
}

impl ExportFormat {
    fn suffix(self) -> &'static str {
        match self {
            Self::Csv => ".csv",
            Self::Jsonl => ".jsonl",
        }
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Csv => "CSV",
            Self::Jsonl => "JSONL",
        }
    }

    /// Extension as the dialog filter spells it: without the dot.
    pub(crate) fn filter_extension(self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Jsonl => "jsonl",
        }
    }
}

/// No `Debug`: this type carries the exported bytes and must not be formatted into logs.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportRequest {
    pub format: ExportFormat,
    pub file_name: String,
    pub content: String,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExportStatus {
    Saved,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
pub struct ExportOutcome {
    pub status: ExportStatus,
}

/// Bounded and path-free: the file name must match the format's extension, contain no path
/// separator, control character or Windows-reserved device stem. The dialog picks the directory.
fn validate_export(request: &ExportRequest) -> Result<(), AppError> {
    if request.content.is_empty() || request.content.len() > MAX_EXPORT_BYTES {
        return Err(AppError::new("invalidInput"));
    }
    validate_export_name(&request.file_name, request.format)
}

pub(crate) fn validate_export_name(file_name: &str, format: ExportFormat) -> Result<(), AppError> {
    let name = file_name.trim();
    if name.is_empty() || name.chars().count() > MAX_EXPORT_NAME_CHARS {
        return Err(AppError::new("invalidInput"));
    }
    if name.chars().any(|c| {
        c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
    }) {
        return Err(AppError::new("invalidInput"));
    }
    let lowered = name.to_ascii_lowercase();
    let Some(stem) = lowered.strip_suffix(format.suffix()) else {
        return Err(AppError::new("invalidInput"));
    };
    // No silent extension fix-up and no stem that Windows would reject or strip.
    let stem = stem.trim_end_matches(['.', ' ']);
    if stem.is_empty() {
        return Err(AppError::new("invalidInput"));
    }
    let base = stem.split('.').next().unwrap_or(stem).to_ascii_uppercase();
    if RESERVED_STEMS.contains(&base.as_str()) {
        return Err(AppError::new("invalidInput"));
    }
    Ok(())
}

/// Owns the temporary file next to the target. Cleanup only ever removes the path this guard
/// created: when `create_new` fails (collision, permission), no guard exists, so an unrelated
/// path is never deleted. `persist` disarms the guard after the rename succeeded.
struct TemporaryExport {
    path: PathBuf,
    file: Option<std::fs::File>,
    owned: bool,
}

impl TemporaryExport {
    fn create(directory: &Path, file_name: &str) -> Result<Self, AppError> {
        let path = directory.join(format!(".{file_name}.tmp-{}", uuid::Uuid::new_v4()));
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| AppError::new("exportFailed"))?;
        Ok(Self {
            path,
            file: Some(file),
            owned: true,
        })
    }

    fn write_all(&mut self, bytes: &[u8]) -> Result<(), AppError> {
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| AppError::new("exportFailed"))?;
        file.write_all(bytes)
            .and_then(|()| file.flush())
            .and_then(|()| file.sync_all())
            .map_err(|_| AppError::new("exportFailed"))
    }

    fn persist(mut self, target: &Path) -> Result<(), AppError> {
        self.file.take();
        fs::rename(&self.path, target).map_err(|_| AppError::new("exportFailed"))?;
        self.owned = false;
        Ok(())
    }
}

impl Drop for TemporaryExport {
    fn drop(&mut self) {
        self.file.take();
        if self.owned {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Write through a unique same-directory temporary file: the target is only ever replaced by a
/// fully written and flushed file, a failed write or persist removes only the temporary this
/// process created, the previous file stays intact, and a `.tmp-` leftover is never kept.
pub(crate) fn write_atomically(target: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let directory = target
        .parent()
        .ok_or_else(|| AppError::new("unsupported"))?;
    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::new("unsupported"))?;
    let mut temporary = TemporaryExport::create(directory, file_name)?;
    temporary.write_all(bytes)?;
    temporary.persist(target)
}

/// Export the loaded rows to a user-chosen file. `cancelled` is the honest outcome of a closed
/// dialog; a write failure surfaces as an error and never as a partial success.
#[tauri::command]
pub(crate) async fn saved_queries_export(
    app: AppHandle,
    request: ExportRequest,
) -> Result<ExportOutcome, AppError> {
    validate_export(&request)?;
    let ExportRequest {
        format,
        file_name,
        content,
    } = request;
    let file_name = file_name.trim().to_owned();
    let outcome =
        tauri::async_runtime::spawn_blocking(move || -> Result<ExportOutcome, AppError> {
            let selected = app
                .dialog()
                .file()
                .set_file_name(file_name)
                .add_filter(format.label(), &[format.filter_extension()])
                .blocking_save_file();
            let Some(selected) = selected else {
                return Ok(ExportOutcome {
                    status: ExportStatus::Cancelled,
                });
            };
            let path: PathBuf = selected
                .as_path()
                .map(Path::to_path_buf)
                .ok_or_else(|| AppError::new("unsupported"))?;
            write_atomically(&path, content.as_bytes())?;
            Ok(ExportOutcome {
                status: ExportStatus::Saved,
            })
        })
        .await
        .map_err(|_| AppError::new("exportFailed"))??;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::with_database;
    use crate::StorageState;
    use std::sync::Mutex;
    use tempfile::tempdir;

    fn temp_storage() -> (tempfile::TempDir, StorageState) {
        let directory = tempdir().unwrap();
        let database = Database::open(&directory.path().join("saved-queries.sqlite")).unwrap();
        (directory, StorageState(Mutex::new(Ok(database))))
    }

    fn entry(id: &str) -> SavedQueryEntry {
        SavedQueryEntry {
            id: id.to_owned(),
            name: format!("Draft {id}"),
            connection_id: Some("3f2f2c9a-5b1e-4c6d-9a70-1b2c3d4e5f60".to_owned()),
            index: "orders-*".to_owned(),
            dsl: "{\"query\":{\"range\":{\"total\":{\"gte\":9007199254740993}}},\"size\":25}"
                .to_owned(),
            result_view: ResultView::Table,
            favorite: false,
            updated_at: "2026-10-09T12:00:00.000Z".to_owned(),
            parameters: None,
        }
    }

    #[test]
    fn empty_database_loads_an_empty_library_and_round_trips_exactly() {
        let (_directory, storage) = temp_storage();
        let empty = with_database(&storage, load_library).unwrap();
        assert_eq!(empty, SavedQueryLibrary::empty());

        let library = SavedQueryLibrary {
            version: LIBRARY_VERSION,
            entries: vec![
                entry("e1"),
                SavedQueryEntry {
                    favorite: true,
                    name: "Unicode 查询".to_owned(),
                    connection_id: None,
                    ..entry("e2")
                },
            ],
        };
        with_database(&storage, |database| save_library(database, library.clone())).unwrap();
        let loaded = with_database(&storage, load_library).unwrap();
        assert_eq!(loaded, library);
        assert_eq!(
            loaded.entries[0].dsl,
            "{\"query\":{\"range\":{\"total\":{\"gte\":9007199254740993}}},\"size\":25}"
        );
        assert_eq!(loaded.entries[1].connection_id, None);
    }

    #[test]
    fn damaged_or_future_documents_fail_closed_without_rewriting_them() {
        let (_directory, storage) = temp_storage();
        for damaged in [
            r#"{"version":1,"entries":[{"id":"e1"}]}"#,
            r#"{"version":2,"entries":[]}"#,
            r#"{"version":1,"entries":[],"extra":true}"#,
            r#"{"version":1,"entries":[{"id":"e1","name":"Draft","connectionId":null,"index":"i","dsl":"{}","resultView":"csv","favorite":false,"updatedAt":"2026-10-09T12:00:00.000Z"}]}"#,
            r#"{"version":1,"entries":[{"id":"e1","name":"Draft","connectionId":null,"index":"i","dsl":"{}","resultView":"table","favorite":false,"updatedAt":"2026-10-09T12:00:00.000Z"},{"id":"e1","name":"Dup","connectionId":null,"index":"i","dsl":"{}","resultView":"table","favorite":false,"updatedAt":"2026-10-09T12:00:00.000Z"}]}"#,
            "not json",
        ] {
            with_database(&storage, |database| {
                database.save_saved_queries_json(damaged)
            })
            .unwrap();
            let error = with_database(&storage, load_library).unwrap_err();
            assert_eq!(error.code, "invalidResponse");
            // The damaged bytes stay exactly as stored; a failed load never repairs or replaces.
            let stored = with_database(&storage, |database| database.saved_queries_json()).unwrap();
            assert_eq!(stored.as_deref(), Some(damaged));
        }
    }

    #[test]
    fn save_refuses_over_limit_entries_and_keeps_the_previous_document() {
        let (_directory, storage) = temp_storage();
        let good = SavedQueryLibrary {
            version: LIBRARY_VERSION,
            entries: vec![entry("e1")],
        };
        with_database(&storage, |database| save_library(database, good.clone())).unwrap();

        let oversized = SavedQueryLibrary {
            version: LIBRARY_VERSION,
            entries: vec![SavedQueryEntry {
                dsl: "x".repeat(MAX_DSL_BYTES + 1),
                ..entry("e2")
            }],
        };
        assert_eq!(
            with_database(&storage, |database| save_library(database, oversized))
                .unwrap_err()
                .code,
            "invalidInput"
        );
        assert_eq!(
            with_database(&storage, |database| save_library(
                database,
                SavedQueryLibrary {
                    version: LIBRARY_VERSION + 1,
                    entries: Vec::new(),
                }
            ))
            .unwrap_err()
            .code,
            "invalidInput"
        );
        assert_eq!(with_database(&storage, load_library).unwrap(), good);
    }

    #[test]
    fn one_hundred_and_one_entries_are_refused() {
        let mut entries = Vec::new();
        for index in 0..=MAX_ENTRIES {
            entries.push(entry(&format!("e{index}")));
        }
        let library = SavedQueryLibrary {
            version: LIBRARY_VERSION,
            entries,
        };
        assert_eq!(library.validate().unwrap_err().code, "invalidInput");
    }

    #[test]
    fn the_wire_contract_is_camel_case_and_closed() {
        let json = r#"{"version":1,"entries":[{"id":"e1","name":"Draft","connectionId":null,"index":"orders-1","dsl":"{\"size\":9007199254740993}","resultView":"json","favorite":true,"updatedAt":"2026-10-09T12:00:00.000Z"}]}"#;
        let library: SavedQueryLibrary = serde_json::from_str(json).unwrap();
        assert_eq!(library.entries[0].dsl, "{\"size\":9007199254740993}");
        assert_eq!(library.entries[0].result_view, ResultView::Json);
        assert_eq!(serde_json::to_string(&library).unwrap(), json);
        for rejected in [
            json.replace(r#""favorite":true"#, r#""favorite":true,"extra":1"#),
            json.replace(r#""resultView":"json""#, r#""resultView":"csv""#),
            json.replace(
                r#""connectionId":null"#,
                r#""connectionId":"a","unknown":2"#,
            ),
            "{\"version\":1,\"entries\":[]}extra".to_owned(),
        ] {
            assert!(serde_json::from_str::<SavedQueryLibrary>(&rejected).is_err());
        }
    }

    fn export_request(format: ExportFormat, file_name: &str, content: &str) -> ExportRequest {
        ExportRequest {
            format,
            file_name: file_name.to_owned(),
            content: content.to_owned(),
        }
    }

    #[test]
    fn export_requests_are_bounded_and_path_free() {
        assert!(validate_export(&export_request(
            ExportFormat::Csv,
            "escope-orders-20261009-120000.csv",
            "a\r\n"
        ))
        .is_ok());
        assert!(validate_export(&export_request(
            ExportFormat::Jsonl,
            "escope.jsonl",
            "{\"a\":1}\n"
        ))
        .is_ok());
        assert!(validate_export(&export_request(ExportFormat::Jsonl, "escope.CSV", "x")).is_err());
        assert!(validate_export(&export_request(ExportFormat::Csv, "escope.txt", "x")).is_err());
        assert!(validate_export(&export_request(ExportFormat::Csv, "escope", "x")).is_err());
        assert!(validate_export(&export_request(ExportFormat::Csv, ".csv", "x")).is_err());
        assert!(validate_export(&export_request(ExportFormat::Csv, "..\\evil.csv", "x")).is_err());
        assert!(validate_export(&export_request(ExportFormat::Csv, "sub/evil.csv", "x")).is_err());
        assert!(validate_export(&export_request(ExportFormat::Csv, "con.csv", "x")).is_err());
        assert!(validate_export(&export_request(ExportFormat::Csv, "LPT1.jsonl", "x")).is_err());
        assert!(validate_export(&export_request(ExportFormat::Csv, " .csv", "x")).is_err());
        assert!(
            validate_export(&export_request(ExportFormat::Csv, "line\nbreak.csv", "x")).is_err()
        );
        assert!(validate_export(&export_request(ExportFormat::Csv, "x.csv", "")).is_err());
        assert!(validate_export(&export_request(
            ExportFormat::Csv,
            &"n".repeat(MAX_EXPORT_NAME_CHARS + 1),
            "x"
        ))
        .is_err());
        assert!(validate_export(&export_request(
            ExportFormat::Csv,
            "x.csv",
            &"x".repeat(MAX_EXPORT_BYTES + 1)
        ))
        .is_err());
    }

    #[test]
    fn atomic_write_replaces_the_target_and_never_leaves_a_temporary_file() {
        let directory = tempdir().unwrap();
        let target = directory.path().join("export.csv");
        fs::write(&target, b"previous").unwrap();

        write_atomically(&target, b"fresh bytes").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"fresh bytes");
        let leftovers = fs::read_dir(directory.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
            .count();
        assert_eq!(leftovers, 0);

        let missing = tempdir().unwrap().path().join("missing").join("x.csv");
        assert_eq!(
            write_atomically(&missing, b"nope").unwrap_err().code,
            "exportFailed"
        );
        assert!(!missing.exists());
    }

    #[test]
    fn a_failed_temporary_create_never_removes_an_unrelated_path() {
        let directory = tempdir().unwrap();
        let blocker = directory.path().join("blocker");
        fs::write(&blocker, b"keep").unwrap();

        // The temp file cannot be created under a path whose parent is a file: no guard exists,
        // so nothing may be deleted and the unrelated path stays exactly as it was.
        let target = blocker.join("export.csv");
        assert_eq!(
            write_atomically(&target, b"data").unwrap_err().code,
            "exportFailed"
        );
        assert_eq!(fs::read(&blocker).unwrap(), b"keep");
        assert!(blocker.is_file());
    }

    #[test]
    fn a_failed_persist_removes_only_its_own_temporary() {
        let directory = tempdir().unwrap();
        let target = directory.path().join("occupied");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("inner.txt"), b"inner").unwrap();

        assert_eq!(
            write_atomically(&target, b"fresh").unwrap_err().code,
            "exportFailed"
        );
        assert!(target.is_dir());
        assert_eq!(fs::read(target.join("inner.txt")).unwrap(), b"inner");
        let leftovers: Vec<String> = fs::read_dir(directory.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "leftovers: {leftovers:?}");
    }

    #[test]
    fn debug_output_redacts_draft_bodies() {
        let entry = entry("e1");
        let rendered = format!("{entry:?}");
        assert!(!rendered.contains("9007199254740993"));
        assert!(rendered.contains("dsl_bytes"));

        let library = SavedQueryLibrary {
            version: LIBRARY_VERSION,
            entries: vec![entry],
        };
        let rendered = format!("{library:?}");
        assert!(!rendered.contains("9007199254740993"));
    }
}
