//! Bounded local chart-definition exchange: selected saved definitions become one reviewable JSON
//! document, and such a document becomes new local definitions.
//!
//! The document carries definition bodies (target pattern, grouping and metric literals, plotted
//! measure) plus an opaque per-source label. It never carries an endpoint, a real connection ID,
//! authentication, credential references, parsed aggregation values, plotted numbers, field
//! capability evidence, time boundaries, result bodies, PIT ids or execution history. Import appends
//! every definition with a fresh id under the library's revision compare, re-checks each mapped
//! connection inside the same transaction, and never rewrites an existing definition. Nothing here
//! runs a query or opens a PIT; reuse still goes through the aggregation build review.

use crate::chart_definitions::{valid_id, ChartDefinition, ChartDefinitionRecord, ChartDraft};
use crate::error::AppError;
use crate::query_exchange::{sensitive_text, SENSITIVE_KEYS};
use crate::saved_queries::{write_atomically, ExportOutcome, ExportStatus};
use crate::storage::Database;
use crate::{with_database, StorageState};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

const FORMAT: &str = "escope-chart-definitions";
const VERSION: u32 = 1;
const MAX_BUNDLE_BYTES: usize = 1024 * 1024;
const MAX_SOURCE_LABEL_CHARS: usize = 120;
const MAX_ENDPOINT_CHARS: usize = 2048;

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableChartConnection {
    key: String,
    label: String,
}

/// A definition without local identity. `connection_key` is an opaque source label, never an ID.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableChartDefinition {
    key: String,
    name: String,
    connection_key: String,
    index: String,
    draft: ChartDraft,
    measure: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartDefinitionExchange {
    format: String,
    version: u32,
    connections: Vec<PortableChartConnection>,
    definitions: Vec<PortableChartDefinition>,
}

impl std::fmt::Debug for ChartDefinitionExchange {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChartDefinitionExchange")
            .field("version", &self.version)
            .field("connection_count", &self.connections.len())
            .field("definition_count", &self.definitions.len())
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartMappingTarget {
    connection_id: String,
    endpoint: String,
}

/// A chart definition is bound to a connection by construction, so an import needs a real local
/// target: `null` is not representable here, unlike the query-definition exchange.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartConnectionMapping {
    source_key: String,
    target: ChartMappingTarget,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartExchangeImportRequest {
    bundle: ChartDefinitionExchange,
    mappings: Vec<ChartConnectionMapping>,
    expected_revision: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartExchangeSaveRequest {
    bundle: ChartDefinitionExchange,
    reviewed: bool,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ChartExchangeReadOutcome {
    Cancelled,
    Loaded { bundle: ChartDefinitionExchange },
}

fn invalid() -> AppError {
    AppError::new("exchangeInvalid")
}
fn mapping_required() -> AppError {
    AppError::new("exchangeMappingRequired")
}
fn too_large() -> AppError {
    AppError::new("exchangeTooLarge")
}
fn sensitive() -> AppError {
    AppError::new("exchangeSensitive")
}

fn valid_source_label(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_SOURCE_LABEL_CHARS
        && !value.chars().any(char::is_control)
}

/// Known sensitive key names and authentication-shaped literals anywhere in the raw document.
/// Walking typed raw slices keeps a private serde tag from being read as anything but an object.
fn scan_literals(value: &RawValue) -> Result<(), AppError> {
    let mut pending = vec![value];
    while let Some(node) = pending.pop() {
        match node.get().trim_start().as_bytes().first() {
            Some(b'{') => {
                let object: HashMap<String, &RawValue> =
                    serde_json::from_str(node.get()).map_err(|_| invalid())?;
                for (key, child) in object {
                    if SENSITIVE_KEYS
                        .contains(&key.to_ascii_lowercase().replace(['_', '-'], "").as_str())
                        || sensitive_text(&key)
                    {
                        return Err(sensitive());
                    }
                    pending.push(child);
                }
            }
            Some(b'[') => {
                let items: Vec<&RawValue> =
                    serde_json::from_str(node.get()).map_err(|_| invalid())?;
                pending.extend(items);
            }
            Some(b'"') => {
                let text: String = serde_json::from_str(node.get()).map_err(|_| invalid())?;
                if sensitive_text(&text) {
                    return Err(sensitive());
                }
            }
            _ => {}
        }
    }
    Ok(())
}

impl ChartDefinitionExchange {
    /// Rules shared by every entry: the stored-definition validator judges the whole body, so the
    /// document and the local library can never disagree on a literal.
    fn entry(&self, definition: &PortableChartDefinition) -> ChartDefinition {
        ChartDefinition {
            id: definition.key.clone(),
            name: definition.name.clone(),
            connection_id: definition.connection_key.clone(),
            index: definition.index.clone(),
            draft: definition.draft.clone(),
            measure: definition.measure.clone(),
        }
    }

    pub(crate) fn validate(&self) -> Result<(), AppError> {
        let serialized = serde_json::to_string(self).map_err(|_| invalid())?;
        // Literals are checked before the shape, exactly as the TS reader does, so a
        // credential-like value is reported as sensitive rather than as a structure problem.
        scan_literals(serde_json::from_str::<&RawValue>(&serialized).map_err(|_| invalid())?)?;
        if self.format != FORMAT {
            return Err(invalid());
        }
        if self.version != VERSION {
            return Err(AppError::new("exchangeVersion"));
        }
        if self.definitions.is_empty() || self.connections.is_empty() {
            return Err(invalid());
        }
        if self.definitions.len() > crate::chart_definitions::MAX_ENTRIES
            || self.connections.len() > crate::chart_definitions::MAX_ENTRIES
        {
            return Err(too_large());
        }
        let mut keys: HashSet<&str> = HashSet::new();
        for connection in &self.connections {
            if !valid_id(&connection.key)
                || !valid_source_label(&connection.label)
                || !keys.insert(connection.key.as_str())
            {
                return Err(invalid());
            }
        }
        let mut ids: HashSet<&str> = HashSet::new();
        let mut used: HashSet<&str> = HashSet::new();
        for definition in &self.definitions {
            if !valid_id(&definition.key)
                || !ids.insert(definition.key.as_str())
                || !keys.contains(definition.connection_key.as_str())
            {
                return Err(invalid());
            }
            used.insert(definition.connection_key.as_str());
            // Body rules are the stored-definition rules; a document problem stays `exchangeInvalid`.
            self.entry(definition).validate().map_err(|_| invalid())?;
        }
        // A source nobody uses is a document that was rewritten on the way out, and a definition
        // without a source explains nothing: both are refused rather than repaired.
        if keys != used {
            return Err(invalid());
        }
        if serialized.len() > MAX_BUNDLE_BYTES {
            return Err(too_large());
        }
        Ok(())
    }
}

fn parse_text(text: &str) -> Result<ChartDefinitionExchange, AppError> {
    if text.len() > MAX_BUNDLE_BYTES {
        return Err(too_large());
    }
    // The literal scan runs on the raw document, so a sensitive key is reported as such and not
    // as a shape problem; anything else still has to pass the closed typed shape afterwards.
    let raw: &RawValue = serde_json::from_str(text).map_err(|_| invalid())?;
    scan_literals(raw)?;
    let bundle: ChartDefinitionExchange = serde_json::from_str(text).map_err(|_| invalid())?;
    bundle.validate()?;
    Ok(bundle)
}

fn read_file(path: &Path) -> Result<ChartDefinitionExchange, AppError> {
    let file = File::open(path).map_err(|_| AppError::new("importFailed"))?;
    let metadata = file.metadata().map_err(|_| AppError::new("importFailed"))?;
    if !metadata.is_file() {
        return Err(AppError::new("importFailed"));
    }
    if metadata.len() > MAX_BUNDLE_BYTES as u64 {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    file.take((MAX_BUNDLE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| AppError::new("importFailed"))?;
    if bytes.len() > MAX_BUNDLE_BYTES {
        return Err(too_large());
    }
    let text = String::from_utf8(bytes).map_err(|_| invalid())?;
    parse_text(&text)
}

/// Fresh ids, one append, and no write when any mapped connection is missing or has moved.
pub(crate) fn import_bundle(
    database: &mut Database,
    request: ChartExchangeImportRequest,
) -> Result<ChartDefinitionRecord, AppError> {
    let ChartExchangeImportRequest {
        bundle,
        mappings,
        expected_revision,
    } = request;
    bundle.validate()?;
    if mappings.len() != bundle.connections.len() {
        return Err(mapping_required());
    }
    let mut targets = Vec::new();
    let mut mapped: HashMap<&str, String> = HashMap::new();
    for mapping in &mappings {
        if !bundle
            .connections
            .iter()
            .any(|connection| connection.key == mapping.source_key)
            || mapped.contains_key(mapping.source_key.as_str())
        {
            return Err(mapping_required());
        }
        if !valid_id(&mapping.target.connection_id)
            || mapping.target.endpoint.chars().count() > MAX_ENDPOINT_CHARS
        {
            return Err(mapping_required());
        }
        targets.push((
            mapping.target.connection_id.clone(),
            mapping.target.endpoint.clone(),
        ));
        mapped.insert(
            mapping.source_key.as_str(),
            mapping.target.connection_id.clone(),
        );
    }
    let additions: Vec<ChartDefinition> = bundle
        .definitions
        .into_iter()
        .map(|definition| {
            let connection_id = mapped
                .get(definition.connection_key.as_str())
                .ok_or_else(mapping_required)?;
            Ok(ChartDefinition {
                id: uuid::Uuid::new_v4().to_string(),
                name: definition.name,
                connection_id: connection_id.clone(),
                index: definition.index,
                draft: definition.draft,
                measure: definition.measure,
            })
        })
        .collect::<Result<_, AppError>>()?;
    database.append_chart_definitions(expected_revision, &additions, &targets)
}

#[tauri::command]
pub(crate) fn chart_definition_exchange_import(
    state: State<'_, StorageState>,
    request: ChartExchangeImportRequest,
) -> Result<ChartDefinitionRecord, AppError> {
    with_database(&state, |database| import_bundle(database, request))
}

#[tauri::command]
pub(crate) async fn chart_definition_exchange_read(
    app: AppHandle,
) -> Result<ChartExchangeReadOutcome, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .add_filter("EScope JSON", &["json"])
            .blocking_pick_file()
        else {
            return Ok(ChartExchangeReadOutcome::Cancelled);
        };
        let path = file.as_path().ok_or_else(|| AppError::new("unsupported"))?;
        Ok(ChartExchangeReadOutcome::Loaded {
            bundle: read_file(path)?,
        })
    })
    .await
    .map_err(|_| AppError::new("importFailed"))?
}

#[tauri::command]
pub(crate) async fn chart_definition_exchange_save(
    app: AppHandle,
    request: ChartExchangeSaveRequest,
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
            .set_file_name("escope-chart-definitions.json")
            .add_filter("EScope JSON", &["json"])
            .blocking_save_file()
        else {
            return Ok(ExportOutcome {
                status: ExportStatus::Cancelled,
            });
        };
        let path = file.as_path().ok_or_else(|| AppError::new("unsupported"))?;
        write_atomically(path, &bytes)?;
        Ok(ExportOutcome {
            status: ExportStatus::Saved,
        })
    })
    .await
    .map_err(|_| AppError::new("exportFailed"))?
}

#[cfg(test)]
mod tests;
