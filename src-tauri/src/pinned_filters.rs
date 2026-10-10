//! Local, immutable mapped filter literals. This module never reads Elasticsearch or executes DSL.
use crate::error::AppError;
use crate::operation::IndexTarget;
use crate::workspace_recovery::Nullable;
use crate::{with_database, StorageState};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use tauri::State;

pub(crate) const VERSION: u32 = 1;
pub(crate) const MAX_BYTES: usize = 256 * 1024;
pub(crate) const MAX_REVISION: u64 = 9_007_199_254_740_991;
const MAX_ENTRIES: usize = 100;
const MAX_FILTERS: usize = 32;
const MAX_GROUPS: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FilterOperation {
    Include,
    Exclude,
    Exists,
    Missing,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Join {
    All,
    Any,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PinnedFilter {
    id: String,
    field: String,
    field_type: String,
    operation: FilterOperation,
    value: Nullable<String>,
    enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FilterGroup {
    id: String,
    mode: Join,
    filter_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Composition {
    mode: Join,
    groups: Vec<FilterGroup>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PinnedFilterDefinition {
    pub id: String,
    name: String,
    pub connection_id: String,
    index: String,
    filters: Vec<PinnedFilter>,
    composition: Composition,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
}

fn integer_bounds(field_type: &str) -> Option<(i128, i128)> {
    match field_type {
        "byte" => Some((-128, 127)),
        "short" => Some((-32768, 32767)),
        "integer" => Some((i32::MIN.into(), i32::MAX.into())),
        "long" => Some((i64::MIN.into(), i64::MAX.into())),
        "unsigned_long" => Some((0, u64::MAX.into())),
        _ => None,
    }
}

// JSON syntax is checked by serde first. Reduce exact decimal/exponent notation to a bounded
// integer without ever rounding through f64 or allocating exponent-sized padding.
fn exact_integer(raw: &str) -> Option<i128> {
    let raw = raw.trim();
    let negative = raw.starts_with('-');
    let unsigned = raw.strip_prefix('-').unwrap_or(raw);
    let (mantissa, exponent) = unsigned.split_once(['e', 'E']).unwrap_or((unsigned, "0"));
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let mut digits = format!("{whole}{fraction}")
        .trim_start_matches('0')
        .to_owned();
    if digits.is_empty() {
        return Some(0);
    }
    let shift = exponent
        .parse::<i32>()
        .ok()?
        .checked_sub(fraction.len() as i32)?;
    if shift < 0 {
        let remove = shift.unsigned_abs() as usize;
        if remove >= digits.len()
            || !digits[digits.len() - remove..]
                .bytes()
                .all(|byte| byte == b'0')
        {
            return None;
        }
        digits.truncate(digits.len() - remove);
    } else {
        if digits.len() + shift as usize > 20 {
            return None;
        }
        digits.extend(std::iter::repeat_n('0', shift as usize));
    }
    let value = digits.parse::<i128>().ok()?;
    Some(if negative { -value } else { value })
}

impl PinnedFilter {
    fn validate(&self) -> Result<(), AppError> {
        let invalid = || AppError::new("invalidInput");
        if !valid_id(&self.id)
            || self.field.is_empty()
            || self.field.trim() != self.field
            || self.field.len() > 1024
            || self.field == "$param"
            || self.field.starts_with('_')
            || self.field.contains(['.', '*', '?'])
            || self.field.chars().any(char::is_control)
        {
            return Err(invalid());
        }
        let keyword = matches!(
            self.field_type.as_str(),
            "keyword" | "constant_keyword" | "wildcard"
        );
        let text = matches!(self.field_type.as_str(), "text" | "match_only_text");
        let integer = integer_bounds(&self.field_type);
        let float = matches!(
            self.field_type.as_str(),
            "half_float" | "float" | "double" | "scaled_float"
        );
        let boolean = self.field_type == "boolean";
        let presence_only = matches!(self.field_type.as_str(), "date" | "date_nanos" | "ip");
        if !(keyword || text || integer.is_some() || float || boolean || presence_only) {
            return Err(invalid());
        }
        if matches!(
            self.operation,
            FilterOperation::Exists | FilterOperation::Missing
        ) {
            return if self.value.0.is_none() {
                Ok(())
            } else {
                Err(invalid())
            };
        }
        let raw = self.value.0.as_deref().ok_or_else(invalid)?;
        if raw.len() > 4096 || presence_only {
            return Err(invalid());
        }
        let value: Value = serde_json::from_str(raw).map_err(|_| invalid())?;
        let valid = match value {
            Value::String(value) => keyword || text && !value.trim().is_empty(),
            Value::Bool(_) => boolean,
            Value::Number(_) => {
                if let Some((min, max)) = integer {
                    exact_integer(raw).is_some_and(|value| value >= min && value <= max)
                } else {
                    float && raw.trim().parse::<f64>().is_ok_and(f64::is_finite)
                }
            }
            _ => false,
        };
        if valid {
            Ok(())
        } else {
            Err(invalid())
        }
    }
}

impl PinnedFilterDefinition {
    fn validate(&self) -> Result<(), AppError> {
        let invalid = || AppError::new("invalidInput");
        if !valid_id(&self.id)
            || !valid_id(&self.connection_id)
            || self.name.is_empty()
            || self.name.trim() != self.name
            || self.name.chars().count() > 120
            || self.name.chars().any(char::is_control)
            || self.index.len() > 1024
            || self.index.trim() != self.index
            || self.filters.is_empty()
            || self.filters.len() > MAX_FILTERS
            || self.composition.groups.is_empty()
            || self.composition.groups.len() > MAX_GROUPS
        {
            return Err(invalid());
        }
        IndexTarget::parse(&self.index).map_err(|_| invalid())?;
        let mut filters = HashMap::new();
        let mut definitions = HashSet::new();
        for filter in &self.filters {
            filter.validate()?;
            if filters.insert(&filter.id, filter).is_some()
                || !definitions.insert((&filter.field, filter.operation, &filter.value.0))
            {
                return Err(invalid());
            }
        }
        let mut group_ids = HashSet::new();
        for group in &self.composition.groups {
            if !valid_id(&group.id)
                || !group_ids.insert(&group.id)
                || group.filter_ids.is_empty()
                || group.filter_ids.len() > MAX_FILTERS
            {
                return Err(invalid());
            }
            for id in &group.filter_ids {
                if filters.remove(id).is_none() {
                    return Err(invalid());
                }
            }
        }
        if filters.is_empty() {
            Ok(())
        } else {
            Err(invalid())
        }
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PinnedFilterLibrary {
    pub version: u32,
    pub entries: Vec<PinnedFilterDefinition>,
}

impl PinnedFilterLibrary {
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
pub struct PinnedFilterRecord {
    pub revision: u64,
    pub library: PinnedFilterLibrary,
}

#[derive(Serialize)]
pub struct SaveOutcome {
    revision: u64,
}

pub(crate) fn decode_stored(json: &str) -> Result<PinnedFilterLibrary, AppError> {
    if json.len() > MAX_BYTES {
        return Err(AppError::new("invalidResponse"));
    }
    let library: PinnedFilterLibrary =
        serde_json::from_str(json).map_err(|_| AppError::new("invalidResponse"))?;
    library
        .validate()
        .map_err(|_| AppError::new("invalidResponse"))?;
    Ok(library)
}

#[tauri::command]
pub(crate) fn pinned_filters_load(
    state: State<'_, StorageState>,
) -> Result<PinnedFilterRecord, AppError> {
    with_database(&state, |database| database.pinned_filters())
}

#[tauri::command]
pub(crate) fn pinned_filters_save(
    state: State<'_, StorageState>,
    expected_revision: u64,
    library: PinnedFilterLibrary,
) -> Result<SaveOutcome, AppError> {
    with_database(&state, |database| {
        database
            .save_pinned_filters(expected_revision, &library)
            .map(|revision| SaveOutcome { revision })
    })
}

#[cfg(test)]
mod tests;
