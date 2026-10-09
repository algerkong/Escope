//! Bounded local Data Views. No network, mappings, credentials or result bodies.
//! Drafts retain a versioned copy of their selected definition; library edits never rebind it.

use crate::error::AppError;
use crate::operation::IndexTarget;
use crate::storage::Database;
use crate::workspace_recovery::Nullable;
use crate::{with_database, StorageState};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashSet;
use tauri::State;

mod field_formats;
pub use field_formats::FieldFormats;

pub(crate) const VERSION: u32 = 1;
pub(crate) const MAX_BYTES: usize = 256 * 1024;
pub(crate) const MAX_REVISION: u64 = 9_007_199_254_740_991;
const MAX_ENTRIES: usize = 100;

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DataViewDefinition {
    pub id: String,
    pub name: String,
    pub connection_id: String,
    pub index: String,
    pub default_time_field: Nullable<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "field_formats::optional_formats"
    )]
    pub field_formats: Option<FieldFormats>,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
}

impl DataViewDefinition {
    pub(crate) fn validate(&self) -> Result<(), AppError> {
        if !valid_id(&self.id)
            || !valid_id(&self.connection_id)
            || self.name.is_empty()
            || self.name.trim() != self.name
            || self.name.chars().count() > 120
            || self.name.chars().any(char::is_control)
            || self.index.len() > 1024
            || self.index.trim() != self.index
        {
            return Err(AppError::new("invalidInput"));
        }
        IndexTarget::parse(&self.index).map_err(|_| AppError::new("invalidInput"))?;
        if let Some(field) = &self.default_time_field.0 {
            if field.is_empty()
                || field.trim() != field
                || field.len() > 1024
                || field.chars().any(char::is_control)
            {
                return Err(AppError::new("invalidInput"));
            }
        }
        if let Some(formats) = &self.field_formats {
            formats.validate()?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DataViewSelection {
    version: u32,
    pub definition: DataViewDefinition,
}

impl DataViewSelection {
    pub(crate) fn validate(
        &self,
        connection_id: Option<&str>,
        index: &str,
    ) -> Result<(), AppError> {
        self.definition.validate()?;
        if self.version != VERSION
            || Some(self.definition.connection_id.as_str()) != connection_id
            || self.definition.index != index
        {
            return Err(AppError::new("invalidInput"));
        }
        Ok(())
    }
}

pub(crate) fn optional_selection<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<DataViewSelection>, D::Error> {
    DataViewSelection::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DataViewLibrary {
    pub version: u32,
    pub entries: Vec<DataViewDefinition>,
}

impl DataViewLibrary {
    pub(crate) fn empty() -> Self {
        Self {
            version: VERSION,
            entries: Vec::new(),
        }
    }

    pub(crate) fn validate(&self) -> Result<(), AppError> {
        if self.version != VERSION || self.entries.len() > MAX_ENTRIES {
            return Err(AppError::new("invalidInput"));
        }
        let mut ids = HashSet::new();
        for entry in &self.entries {
            entry.validate()?;
            if !ids.insert(&entry.id) {
                return Err(AppError::new("invalidInput"));
            }
        }
        if serde_json::to_vec(self)
            .map_err(|_| AppError::new("invalidInput"))?
            .len()
            > MAX_BYTES
        {
            return Err(AppError::new("invalidInput"));
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataViewRecord {
    pub revision: u64,
    pub library: DataViewLibrary,
}

#[derive(Serialize)]
pub struct SaveOutcome {
    revision: u64,
}

pub(crate) fn decode_stored(json: &str) -> Result<DataViewLibrary, AppError> {
    if json.len() > MAX_BYTES {
        return Err(AppError::new("invalidResponse"));
    }
    let library: DataViewLibrary =
        serde_json::from_str(json).map_err(|_| AppError::new("invalidResponse"))?;
    library
        .validate()
        .map_err(|_| AppError::new("invalidResponse"))?;
    Ok(library)
}

#[tauri::command]
pub(crate) fn data_views_load(state: State<'_, StorageState>) -> Result<DataViewRecord, AppError> {
    with_database(&state, |database| database.data_views())
}

#[tauri::command]
pub(crate) fn data_views_save(
    state: State<'_, StorageState>,
    expected_revision: u64,
    library: DataViewLibrary,
) -> Result<SaveOutcome, AppError> {
    with_database(&state, |database: &mut Database| {
        database
            .save_data_views(expected_revision, &library)
            .map(|revision| SaveOutcome { revision })
    })
}

#[cfg(test)]
mod tests;
