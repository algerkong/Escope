//! Bounded local chart definitions: group + metrics + plotted measure for one query target.
//!
//! Definitions are review inputs only. Nothing here runs a query, opens a PIT, reads mappings or
//! stores results, endpoints, credentials or field-capability evidence. A definition keeps its
//! connection ID; deleting a connection retains the historical ID and never rebinds it. Reads
//! never insert a row, and writes are serialised through one immediate transaction with a
//! revision compare, so a stale tab can never overwrite a newer library.

use crate::error::AppError;
use crate::operation::IndexTarget;
use crate::storage::Database;
use crate::{with_database, StorageState};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri::State;

pub(crate) const VERSION: u32 = 1;
pub(crate) const MAX_BYTES: usize = 256 * 1024;
pub(crate) const MAX_REVISION: u64 = 9_007_199_254_740_991;
pub(crate) const MAX_METRICS: usize = 31;
pub(crate) const MAX_ENTRIES: usize = 100;
const MAX_NAME_BYTES: usize = 1024;
const MAX_INTERVAL_CHARS: usize = 64;
const MAX_ZONE_CHARS: usize = 100;
const MAX_SIZE: u32 = 1000;
const DOC_COUNT: &str = "doc_count";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MetricType {
    Sum,
    Avg,
    Min,
    Max,
    ValueCount,
    Cardinality,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IntervalKind {
    CalendarInterval,
    FixedInterval,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartMetric {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: MetricType,
    pub field: String,
}

/// One single-level group with its own option literals. `type` selects which options may appear,
/// which `validate` enforces: a terms group never carries interval fields and vice versa.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ChartGroup {
    Terms {
        name: String,
        field: String,
        size: String,
    },
    #[serde(rename = "date_histogram")]
    Histogram {
        name: String,
        field: String,
        interval: IntervalKind,
        #[serde(rename = "intervalValue")]
        interval_value: String,
        #[serde(rename = "timeZone")]
        time_zone: String,
    },
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartDraft {
    pub group: Option<ChartGroup>,
    pub metrics: Vec<ChartMetric>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartDefinition {
    pub id: String,
    pub name: String,
    pub connection_id: String,
    pub index: String,
    pub draft: ChartDraft,
    pub measure: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartDefinitionLibrary {
    pub version: u32,
    pub entries: Vec<ChartDefinition>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartDefinitionRecord {
    pub revision: u64,
    pub library: ChartDefinitionLibrary,
}

#[derive(Serialize)]
pub struct SaveOutcome {
    revision: u64,
}

fn invalid() -> AppError {
    AppError::new("invalidInput")
}

/// The same identifier grammar the local ids and the exchange documents follow.
pub(crate) fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
}

fn valid_label(value: &str) -> bool {
    !value.is_empty()
        && value.trim() == value
        && value.len() <= MAX_NAME_BYTES
        && !value.chars().any(char::is_control)
}

fn valid_size(value: &str) -> bool {
    if value.is_empty() {
        return true;
    }
    let digits = value.as_bytes();
    if digits.iter().any(|byte| !byte.is_ascii_digit()) {
        return false;
    }
    // The same token grammar as the builder: no leading zeroes, at most four digits, 1..=1000.
    if digits.len() > 4 || (digits.len() > 1 && digits[0] == b'0') {
        return false;
    }
    value
        .parse::<u32>()
        .map(|number| (1..=MAX_SIZE).contains(&number))
        .unwrap_or(false)
}

impl ChartGroup {
    fn name(&self) -> &str {
        match self {
            Self::Terms { name, .. } | Self::Histogram { name, .. } => name,
        }
    }

    fn validate(&self) -> Result<(), AppError> {
        match self {
            Self::Terms { name, field, size } => {
                if valid_label(name) && valid_label(field) && valid_size(size) {
                    Ok(())
                } else {
                    Err(invalid())
                }
            }
            Self::Histogram {
                name,
                field,
                interval_value,
                time_zone,
                ..
            } => {
                let ok = valid_label(name)
                    && valid_label(field)
                    && !interval_value.is_empty()
                    && interval_value.trim() == interval_value
                    && interval_value.chars().count() <= MAX_INTERVAL_CHARS
                    && !interval_value.chars().any(char::is_control)
                    && (time_zone.is_empty()
                        || (time_zone.len() <= MAX_ZONE_CHARS
                            && time_zone.trim() == time_zone
                            && !time_zone.chars().any(char::is_control)));
                if ok {
                    Ok(())
                } else {
                    Err(invalid())
                }
            }
        }
    }
}

impl ChartDraft {
    fn validate(&self) -> Result<(), AppError> {
        if self.metrics.len() > MAX_METRICS || (self.group.is_none() && self.metrics.is_empty()) {
            return Err(invalid());
        }
        let mut names: HashSet<&str> = HashSet::new();
        if let Some(group) = &self.group {
            group.validate()?;
            if !names.insert(group.name()) {
                return Err(invalid());
            }
        }
        for metric in &self.metrics {
            if !valid_label(&metric.name)
                || !valid_label(&metric.field)
                || !names.insert(&metric.name)
            {
                return Err(invalid());
            }
        }
        Ok(())
    }
}

impl ChartDefinition {
    fn metric_names(&self) -> Vec<&str> {
        self.draft
            .metrics
            .iter()
            .map(|metric| metric.name.as_str())
            .collect()
    }

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
            return Err(invalid());
        }
        IndexTarget::parse(&self.index).map_err(|_| invalid())?;
        self.draft.validate()?;
        // The measure must exist in the definition it belongs to: a grouped chart may plot
        // `doc_count` or one of its metrics, a single value must name that metric.
        let known = self.metric_names();
        let allowed = if self.draft.group.is_some() {
            self.measure == DOC_COUNT || known.contains(&self.measure.as_str())
        } else {
            known.contains(&self.measure.as_str())
        };
        if !allowed || self.measure.is_empty() || self.measure.chars().any(char::is_control) {
            return Err(invalid());
        }
        Ok(())
    }
}

impl ChartDefinitionLibrary {
    pub(crate) fn empty() -> Self {
        Self {
            version: VERSION,
            entries: Vec::new(),
        }
    }

    pub(crate) fn validate(&self) -> Result<(), AppError> {
        if self.version != VERSION || self.entries.len() > MAX_ENTRIES {
            return Err(invalid());
        }
        let mut ids = HashSet::new();
        for entry in &self.entries {
            entry.validate()?;
            if !ids.insert(&entry.id) {
                return Err(invalid());
            }
        }
        if serde_json::to_string(self).map_err(|_| invalid())?.len() > MAX_BYTES {
            return Err(invalid());
        }
        Ok(())
    }
}

pub(crate) fn decode_stored(json: &str) -> Result<ChartDefinitionLibrary, AppError> {
    if json.len() > MAX_BYTES {
        return Err(AppError::new("invalidResponse"));
    }
    let library: ChartDefinitionLibrary =
        serde_json::from_str(json).map_err(|_| AppError::new("invalidResponse"))?;
    library
        .validate()
        .map_err(|_| AppError::new("invalidResponse"))?;
    Ok(library)
}

#[tauri::command]
pub(crate) fn chart_definitions_load(
    state: State<'_, StorageState>,
) -> Result<ChartDefinitionRecord, AppError> {
    with_database(&state, |database| database.chart_definitions())
}

#[tauri::command]
pub(crate) fn chart_definitions_save(
    state: State<'_, StorageState>,
    expected_revision: u64,
    library: ChartDefinitionLibrary,
) -> Result<SaveOutcome, AppError> {
    with_database(&state, |database: &mut Database| {
        database
            .save_chart_definitions(expected_revision, &library)
            .map(|revision| SaveOutcome { revision })
    })
}

#[cfg(test)]
mod tests;
