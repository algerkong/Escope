use crate::error::AppError;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashSet;

const MAX_ENTRIES: usize = 32;
const MAX_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DateInput {
    Iso,
    EpochMillis,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FieldFormat {
    Number { grouping: bool },
    Percent { grouping: bool },
    Bytes { grouping: bool },
    Date { input: DateInput },
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FieldFormatEntry {
    pub field: String,
    pub format: FieldFormat,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FieldFormats {
    pub version: u32,
    pub entries: Vec<FieldFormatEntry>,
}

impl FieldFormats {
    pub(super) fn validate(&self) -> Result<(), AppError> {
        if self.version != 1 || self.entries.len() > MAX_ENTRIES {
            return Err(AppError::new("invalidInput"));
        }
        let mut fields = HashSet::new();
        for entry in &self.entries {
            if entry.field.is_empty()
                || entry.field.trim() != entry.field
                || entry.field.len() > 1024
                || entry.field.chars().any(char::is_control)
                || !fields.insert(&entry.field)
            {
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

pub(super) fn optional_formats<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<FieldFormats>, D::Error> {
    FieldFormats::deserialize(deserializer).map(Some)
}
