//! Bounded local query-definition exchange. This is not a connection backup or a file proxy.
//! Native dialogs own paths. Imports append new IDs under CAS, never restore a workspace or run
//! a query. Connection aliases require an explicit local mapping; authentication is not read.

use crate::error::AppError;
use crate::query::validate_json_body;
use crate::query_parameters::{optional_parameters, QueryParameters};
use crate::saved_queries::{
    save_checked, ExportOutcome, ExportStatus, ResultView, SavedQueryEntry, SavedQueryLibrary,
};
use crate::storage::Database;
use crate::workspace_recovery::Nullable;
use crate::{with_database, StorageState};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

const FORMAT: &str = "escope-query-definitions";
const VERSION: u32 = 1;
const MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_QUERIES: usize = 100;
const SENSITIVE_KEYS: &[&str] = &[
    "authorization",
    "proxyauthorization",
    "auth",
    "authstate",
    "authentication",
    "headers",
    "requestheaders",
    "credential",
    "credentials",
    "credentialref",
    "credentialreference",
    "keychainref",
    "keyringref",
    "apikey",
    "apikeyid",
    "apikeysecret",
    "password",
    "passwd",
    "secret",
    "clientsecret",
    "privatekey",
    "accesstoken",
    "refreshtoken",
    "token",
    "transportsnapshot",
];

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableConnection {
    key: String,
    label: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableQuery {
    key: String,
    name: String,
    connection_key: Nullable<String>,
    index: String,
    dsl: String,
    result_view: ResultView,
    favorite: bool,
    #[serde(
        default,
        deserialize_with = "optional_parameters",
        skip_serializing_if = "Option::is_none"
    )]
    parameters: Option<QueryParameters>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryExchange {
    format: String,
    version: u32,
    connections: Vec<PortableConnection>,
    queries: Vec<PortableQuery>,
}

impl std::fmt::Debug for QueryExchange {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("QueryExchange")
            .field("version", &self.version)
            .field("connection_count", &self.connections.len())
            .field("query_count", &self.queries.len())
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MappingTarget {
    connection_id: String,
    endpoint: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionMapping {
    source_key: String,
    target: Nullable<MappingTarget>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExchangeImportRequest {
    bundle: QueryExchange,
    mappings: Vec<ConnectionMapping>,
    expected: SavedQueryLibrary,
    updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExchangeSaveRequest {
    bundle: QueryExchange,
    reviewed: bool,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ExchangeReadOutcome {
    Cancelled,
    Loaded { bundle: QueryExchange },
}

fn invalid() -> AppError {
    AppError::new("exchangeInvalid")
}
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
fn valid_label(value: &str) -> bool {
    value.chars().count() <= 120 && !value.chars().any(char::is_control)
}

fn sensitive_text(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if [
        "authorization:",
        "authorization :",
        "proxy-authorization:",
        "keyring:",
        "keychain:",
        "credential:",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        return true;
    }
    if lower.contains("-----begin") && lower.contains("private key-----") {
        return true;
    }
    let words: Vec<_> = lower.split_whitespace().collect();
    words.windows(2).any(|pair| {
        matches!(pair[0], "bearer" | "basic" | "apikey")
            && !pair[1].is_empty()
            && pair[1]
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"+/_=-".contains(&c))
    })
}

fn check_dsl(raw: &str, parameters: Option<&QueryParameters>) -> Result<(), AppError> {
    if raw.len() > crate::query_parameters::MAX_TEMPLATE_BYTES {
        return Err(AppError::new("exchangeTooLarge"));
    }
    validate_json_body(raw, true).map_err(|_| invalid())?;
    let value: &RawValue = serde_json::from_str(raw).map_err(|_| invalid())?;
    if let Some(parameters) = parameters {
        parameters.validate().map_err(|_| invalid())?;
        if raw != parameters.template {
            return Err(invalid());
        }
    }
    let definitions: HashSet<&str> = parameters
        .map(|p| p.definitions.iter().map(|d| d.name.as_str()).collect())
        .unwrap_or_default();
    let mut used = HashSet::new();
    let mut occurrences = 0;
    let mut pending = vec![(value, true)];
    while let Some((node, root)) = pending.pop() {
        // Typed raw slices keep a literal serde private-token key an ordinary object property.
        // Decoding through Value with arbitrary_precision could instead interpret that object.
        match node.get().trim_start().as_bytes().first() {
            Some(b'{') => {
                let object: HashMap<String, &RawValue> =
                    serde_json::from_str(node.get()).map_err(|_| invalid())?;
                if let Some(marker) = object.get("$param") {
                    let name: String = serde_json::from_str(marker.get()).map_err(|_| invalid())?;
                    if root || object.len() != 1 || !definitions.contains(name.as_str()) {
                        return Err(invalid());
                    }
                    used.insert(name);
                    occurrences += 1;
                    if occurrences > 1000 {
                        return Err(AppError::new("exchangeTooLarge"));
                    }
                }
                for (key, child) in object {
                    if SENSITIVE_KEYS
                        .contains(&key.to_ascii_lowercase().replace(['_', '-'], "").as_str())
                        || sensitive_text(&key)
                    {
                        return Err(AppError::new("exchangeSensitive"));
                    }
                    pending.push((child, false));
                }
            }
            Some(b'[') => {
                let items: Vec<&RawValue> =
                    serde_json::from_str(node.get()).map_err(|_| invalid())?;
                pending.extend(items.into_iter().map(|child| (child, false)));
            }
            Some(b'"') => {
                let text: String = serde_json::from_str(node.get()).map_err(|_| invalid())?;
                if sensitive_text(&text) {
                    return Err(AppError::new("exchangeSensitive"));
                }
            }
            _ => {}
        }
    }
    if definitions.len() != used.len() || definitions.iter().any(|name| !used.contains(*name)) {
        return Err(invalid());
    }
    Ok(())
}

impl QueryExchange {
    fn validate(&self) -> Result<(), AppError> {
        if self.format != FORMAT {
            return Err(invalid());
        }
        if self.version != VERSION {
            return Err(AppError::new("exchangeVersion"));
        }
        if self.queries.is_empty() {
            return Err(invalid());
        }
        if self.queries.len() > MAX_QUERIES || self.connections.len() > MAX_QUERIES {
            return Err(AppError::new("exchangeTooLarge"));
        }
        let mut connections = HashSet::new();
        for connection in &self.connections {
            if !valid_id(&connection.key)
                || !valid_label(&connection.label)
                || !connections.insert(connection.key.as_str())
            {
                return Err(invalid());
            }
            if sensitive_text(&connection.label) {
                return Err(AppError::new("exchangeSensitive"));
            }
        }
        let mut used = HashSet::new();
        let mut keys = HashSet::new();
        for query in &self.queries {
            if !valid_id(&query.key) || !valid_label(&query.name) || !keys.insert(&query.key) {
                return Err(invalid());
            }
            if query.index.len() > 1024 {
                return Err(AppError::new("exchangeTooLarge"));
            }
            if sensitive_text(&query.name) || sensitive_text(&query.index) {
                return Err(AppError::new("exchangeSensitive"));
            }
            if let Some(connection) = &query.connection_key.0 {
                if !connections.contains(connection.as_str()) {
                    return Err(invalid());
                }
                used.insert(connection.as_str());
            }
            check_dsl(&query.dsl, query.parameters.as_ref())?;
        }
        if connections != used {
            return Err(invalid());
        }
        if serde_json::to_vec(self).map_err(|_| invalid())?.len() > MAX_BYTES {
            return Err(AppError::new("exchangeTooLarge"));
        }
        Ok(())
    }
}

fn parse_text(text: &str) -> Result<QueryExchange, AppError> {
    if text.len() > MAX_BYTES {
        return Err(AppError::new("exchangeTooLarge"));
    }
    let bundle: QueryExchange = serde_json::from_str(text).map_err(|_| invalid())?;
    bundle.validate()?;
    Ok(bundle)
}

fn read_file(path: &Path) -> Result<QueryExchange, AppError> {
    let file = File::open(path).map_err(|_| AppError::new("importFailed"))?;
    let metadata = file.metadata().map_err(|_| AppError::new("importFailed"))?;
    if !metadata.is_file() {
        return Err(AppError::new("importFailed"));
    }
    if metadata.len() > MAX_BYTES as u64 {
        return Err(AppError::new("exchangeTooLarge"));
    }
    let mut bytes = Vec::new();
    file.take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| AppError::new("importFailed"))?;
    if bytes.len() > MAX_BYTES {
        return Err(AppError::new("exchangeTooLarge"));
    }
    let text = String::from_utf8(bytes).map_err(|_| invalid())?;
    parse_text(&text)
}

pub(crate) fn import_bundle(
    database: &mut Database,
    request: ExchangeImportRequest,
) -> Result<SavedQueryLibrary, AppError> {
    let ExchangeImportRequest {
        bundle,
        mappings,
        expected,
        updated_at,
    } = request;
    bundle.validate()?;
    expected.validate()?;
    if !crate::workspace_recovery::valid_timestamp(&updated_at) {
        return Err(invalid());
    }
    if mappings.len() != bundle.connections.len() {
        return Err(AppError::new("exchangeMappingRequired"));
    }
    let mut map = HashMap::new();
    let mut targets = Vec::new();
    for mapping in &mappings {
        if !bundle
            .connections
            .iter()
            .any(|c| c.key == mapping.source_key)
            || map.contains_key(&mapping.source_key)
        {
            return Err(AppError::new("exchangeMappingRequired"));
        }
        if let Some(target) = &mapping.target.0 {
            if !valid_id(&target.connection_id) || target.endpoint.len() > 2048 {
                return Err(AppError::new("exchangeMappingRequired"));
            }
            targets.push((target.connection_id.clone(), target.endpoint.clone()));
        }
        map.insert(
            &mapping.source_key,
            mapping
                .target
                .0
                .as_ref()
                .map(|target| target.connection_id.clone()),
        );
    }
    if expected.entries.len() + bundle.queries.len() > MAX_QUERIES {
        return Err(AppError::new("exchangeTooLarge"));
    }
    let mut library = expected.clone();
    for query in bundle.queries {
        let connection_id = match &query.connection_key.0 {
            Some(key) => map
                .get(key)
                .ok_or_else(|| AppError::new("exchangeMappingRequired"))?
                .clone(),
            None => None,
        };
        library.entries.push(SavedQueryEntry {
            id: uuid::Uuid::new_v4().to_string(),
            name: query.name,
            connection_id,
            index: query.index,
            dsl: query.dsl,
            result_view: query.result_view,
            favorite: query.favorite,
            updated_at: updated_at.clone(),
            parameters: query.parameters,
            data_view: None,
        });
    }
    if serde_json::to_vec(&library).map_err(|_| invalid())?.len()
        > crate::storage::MAX_SAVED_QUERIES_BYTES
    {
        return Err(AppError::new("exchangeTooLarge"));
    }
    save_checked(database, library.clone(), expected, &targets)?;
    Ok(library)
}

#[tauri::command]
pub(crate) fn query_exchange_import(
    state: State<'_, StorageState>,
    request: ExchangeImportRequest,
) -> Result<SavedQueryLibrary, AppError> {
    with_database(&state, |database| import_bundle(database, request))
}

#[tauri::command]
pub(crate) async fn query_exchange_read(app: AppHandle) -> Result<ExchangeReadOutcome, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .add_filter("EScope JSON", &["json"])
            .blocking_pick_file()
        else {
            return Ok(ExchangeReadOutcome::Cancelled);
        };
        let path = file.as_path().ok_or_else(|| AppError::new("unsupported"))?;
        Ok(ExchangeReadOutcome::Loaded {
            bundle: read_file(path)?,
        })
    })
    .await
    .map_err(|_| AppError::new("importFailed"))?
}

#[tauri::command]
pub(crate) async fn query_exchange_save(
    app: AppHandle,
    request: ExchangeSaveRequest,
) -> Result<ExportOutcome, AppError> {
    if !request.reviewed {
        return Err(invalid());
    }
    request.bundle.validate()?;
    let bytes = serde_json::to_vec(&request.bundle).map_err(|_| invalid())?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .set_file_name("escope-queries.json")
            .add_filter("EScope JSON", &["json"])
            .blocking_save_file()
        else {
            return Ok(ExportOutcome {
                status: ExportStatus::Cancelled,
            });
        };
        let path = file.as_path().ok_or_else(|| AppError::new("unsupported"))?;
        crate::saved_queries::write_atomically(path, &bytes)?;
        Ok(ExportOutcome {
            status: ExportStatus::Saved,
        })
    })
    .await
    .map_err(|_| AppError::new("exportFailed"))?
}

#[cfg(test)]
mod tests;
