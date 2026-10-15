//! Bounded local saved chart and aggregation definitions.
//! Never reads ES, executes queries, or mutates executed snapshots.

use crate::error::AppError;
use crate::storage::Database;
use crate::workspace_recovery::Nullable;
use crate::{with_database, StorageState};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri::State;

pub(crate) const VERSION: u32 = 1;
pub(crate) const MAX_BYTES: usize = 256 * 1024;
pub(crate) const MAX_REVISION: u64 = 9_007_199_254_740_991;
pub(crate) const MAX_ENTRIES: usize = 100;
pub(crate) const MAX_CLAUSES: usize = 32;
pub(crate) const MAX_SUB_METRICS: usize = 16;

const VALID_METRICS: &[&str] = &["sum", "avg", "min", "max", "value_count", "cardinality"];

const VALID_BUCKETS: &[&str] = &["terms", "date_histogram"];

const VALID_CHART_TYPES: &[&str] = &["metric", "bar", "line", "table"];

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartSubMetric {
    pub id: String,
    pub name: String,
    pub metric_type: String,
    pub field: String,
}

impl ChartSubMetric {
    pub fn validate(&self) -> Result<(), AppError> {
        if !valid_id(&self.id)
            || self.name.is_empty()
            || self.name.trim() != self.name
            || self.name.chars().count() > 120
            || self.name.chars().any(char::is_control)
            || !VALID_METRICS.contains(&self.metric_type.as_str())
            || self.field.is_empty()
            || self.field.trim() != self.field
            || self.field.len() > 1024
            || self.field.chars().any(char::is_control)
        {
            return Err(AppError::new("invalidInput"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartAggregationClause {
    pub id: String,
    pub name: String,
    pub aggregation_type: String,
    pub field: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order_direction: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order_metric: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_doc_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub_metrics: Option<Vec<ChartSubMetric>>,
}

impl ChartAggregationClause {
    pub fn validate(&self) -> Result<(), AppError> {
        if !valid_id(&self.id)
            || self.name.is_empty()
            || self.name.trim() != self.name
            || self.name.chars().count() > 120
            || self.name.chars().any(char::is_control)
            || self.field.is_empty()
            || self.field.trim() != self.field
            || self.field.len() > 1024
            || self.field.chars().any(char::is_control)
        {
            return Err(AppError::new("invalidInput"));
        }

        let is_metric = VALID_METRICS.contains(&self.aggregation_type.as_str());
        let is_bucket = VALID_BUCKETS.contains(&self.aggregation_type.as_str());

        if !is_metric && !is_bucket {
            return Err(AppError::new("invalidInput"));
        }

        if let Some(size) = self.size {
            if !(1..=10000).contains(&size) {
                return Err(AppError::new("invalidInput"));
            }
        }

        if let Some(dir) = &self.order_direction {
            if dir != "asc" && dir != "desc" {
                return Err(AppError::new("invalidInput"));
            }
        }

        if let Some(sub) = &self.sub_metrics {
            if sub.len() > MAX_SUB_METRICS {
                return Err(AppError::new("invalidInput"));
            }
            let mut sub_ids = HashSet::new();
            let mut sub_names = HashSet::new();
            for item in sub {
                item.validate()?;
                if !sub_ids.insert(&item.id) || !sub_names.insert(&item.name) {
                    return Err(AppError::new("invalidInput"));
                }
            }
        }

        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedChartDefinition {
    pub id: String,
    pub name: String,
    pub connection_id: Nullable<String>,
    pub index: String,
    pub chart_type: String,
    pub clauses: Vec<ChartAggregationClause>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_metric: Option<Nullable<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<Nullable<String>>,
    pub updated_at: String,
}

impl SavedChartDefinition {
    pub fn validate(&self) -> Result<(), AppError> {
        if !valid_id(&self.id)
            || self.name.is_empty()
            || self.name.trim() != self.name
            || self.name.chars().count() > 120
            || self.name.chars().any(char::is_control)
            || self.index.len() > 1024
            || !VALID_CHART_TYPES.contains(&self.chart_type.as_str())
            || self.clauses.is_empty()
            || self.clauses.len() > MAX_CLAUSES
            || self.updated_at.is_empty()
            || self.updated_at.len() > 40
        {
            return Err(AppError::new("invalidInput"));
        }

        if let Nullable(Some(ref cid)) = self.connection_id {
            if !valid_id(cid) {
                return Err(AppError::new("invalidInput"));
            }
        }

        if let Some(Nullable(Some(ref desc))) = self.description {
            if desc.chars().count() > 500 {
                return Err(AppError::new("invalidInput"));
            }
        }

        let mut clause_ids = HashSet::new();
        let mut clause_names = HashSet::new();
        for clause in &self.clauses {
            clause.validate()?;
            if !clause_ids.insert(&clause.id) || !clause_names.insert(&clause.name) {
                return Err(AppError::new("invalidInput"));
            }
        }

        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedChartLibrary {
    pub version: u32,
    pub entries: Vec<SavedChartDefinition>,
}

impl SavedChartLibrary {
    pub fn empty() -> Self {
        Self {
            version: VERSION,
            entries: Vec::new(),
        }
    }

    pub fn validate(&self) -> Result<(), AppError> {
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
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedChartRecord {
    pub revision: u64,
    pub library: SavedChartLibrary,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevisionResponse {
    pub revision: u64,
}

pub(crate) fn decode_stored(json: &str) -> Result<SavedChartLibrary, AppError> {
    if json.len() > MAX_BYTES {
        return Err(AppError::new("storageUnavailable"));
    }
    let library: SavedChartLibrary =
        serde_json::from_str(json).map_err(|_| AppError::new("storageUnavailable"))?;
    library.validate()?;
    Ok(library)
}

#[tauri::command]
pub async fn saved_charts_load(
    state: State<'_, StorageState>,
) -> Result<SavedChartRecord, AppError> {
    with_database(&state, |db: &mut Database| db.saved_charts())
}

#[tauri::command]
pub async fn saved_charts_save(
    expected_revision: u64,
    library: SavedChartLibrary,
    state: State<'_, StorageState>,
) -> Result<RevisionResponse, AppError> {
    with_database(&state, |db: &mut Database| {
        let revision = db.save_saved_charts(expected_revision, &library)?;
        Ok(RevisionResponse { revision })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_clause() -> ChartAggregationClause {
        ChartAggregationClause {
            id: "clause_1".into(),
            name: "status_terms".into(),
            aggregation_type: "terms".into(),
            field: "status.keyword".into(),
            size: Some(10),
            order_direction: Some("desc".into()),
            order_metric: Some("_count".into()),
            interval_type: None,
            interval: None,
            min_doc_count: None,
            sub_metrics: Some(vec![ChartSubMetric {
                id: "sub_1".into(),
                name: "avg_duration".into(),
                metric_type: "avg".into(),
                field: "duration".into(),
            }]),
        }
    }

    fn sample_definition() -> SavedChartDefinition {
        SavedChartDefinition {
            id: "chart_1".into(),
            name: "Status Distribution".into(),
            connection_id: Nullable(Some("conn_1".into())),
            index: "logs-*".into(),
            chart_type: "bar".into(),
            clauses: vec![sample_clause()],
            preferred_metric: Some(Nullable(Some("_count".into()))),
            description: Some(Nullable(Some("Distribution of HTTP status codes".into()))),
            updated_at: "2026-10-13T10:00:00.000Z".into(),
        }
    }

    #[test]
    fn valid_definition_validates_and_roundtrips() {
        let def = sample_definition();
        assert!(def.validate().is_ok());

        let lib = SavedChartLibrary {
            version: VERSION,
            entries: vec![def.clone()],
        };
        assert!(lib.validate().is_ok());

        let json = serde_json::to_string(&lib).unwrap();
        let decoded = decode_stored(&json).unwrap();
        assert_eq!(decoded, lib);
    }

    #[test]
    fn empty_library_is_valid() {
        let empty = SavedChartLibrary::empty();
        assert!(empty.validate().is_ok());
        let json = serde_json::to_string(&empty).unwrap();
        let decoded = decode_stored(&json).unwrap();
        assert_eq!(decoded.entries.len(), 0);
    }

    #[test]
    fn invalid_chart_types_and_ids_are_rejected() {
        let mut def = sample_definition();
        def.chart_type = "invalid_type".into();
        assert!(def.validate().is_err());

        let mut def2 = sample_definition();
        def2.id = "bad id with spaces".into();
        assert!(def2.validate().is_err());

        let mut def3 = sample_definition();
        def3.name = "".into();
        assert!(def3.validate().is_err());

        let mut def4 = sample_definition();
        def4.clauses = vec![];
        assert!(def4.validate().is_err());
    }

    #[test]
    fn invalid_aggregation_clauses_are_rejected() {
        let mut clause = sample_clause();
        clause.aggregation_type = "unsupported_type".into();
        assert!(clause.validate().is_err());

        let mut clause2 = sample_clause();
        clause2.size = Some(99999);
        assert!(clause2.validate().is_err());

        let mut clause3 = sample_clause();
        clause3.order_direction = Some("diagonal".into());
        assert!(clause3.validate().is_err());
    }

    #[test]
    fn invalid_sub_metric_is_rejected() {
        let mut clause = sample_clause();
        clause.sub_metrics = Some(vec![ChartSubMetric {
            id: "sub_1".into(),
            name: "invalid_sub".into(),
            metric_type: "terms".into(), // bucket instead of metric
            field: "duration".into(),
        }]);
        assert!(clause.validate().is_err());
    }

    #[test]
    fn over_sized_stored_json_fails_closed() {
        let huge = " ".repeat(MAX_BYTES + 1);
        assert!(decode_stored(&huge).is_err());
    }
}
