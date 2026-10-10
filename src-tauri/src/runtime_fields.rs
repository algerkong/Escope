//! Query-local runtime fields, never Mapping writes or client-side scripts.
//! The same whitelist bounds persisted definitions and final `_search` bodies.

use crate::error::AppError;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{BTreeMap, HashSet};

const MAX_ENTRIES: usize = 32;
const MAX_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeType {
    Keyword,
    Long,
    Double,
    Boolean,
    Date,
    Ip,
    GeoPoint,
}

impl RuntimeType {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Keyword => "keyword",
            Self::Long => "long",
            Self::Double => "double",
            Self::Boolean => "boolean",
            Self::Date => "date",
            Self::Ip => "ip",
            Self::GeoPoint => "geo_point",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeLanguage {
    Painless,
}

#[derive(Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeScript {
    pub source: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_language"
    )]
    pub lang: Option<RuntimeLanguage>,
}

impl std::fmt::Debug for RuntimeScript {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RuntimeScript")
            .field("source", &"[redacted]")
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeMapping {
    #[serde(rename = "type")]
    pub field_type: RuntimeType,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_script"
    )]
    pub script: Option<RuntimeScript>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeField {
    pub field: String,
    #[serde(rename = "type")]
    pub field_type: RuntimeType,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_script"
    )]
    pub script: Option<RuntimeScript>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeFields {
    pub version: u32,
    pub entries: Vec<RuntimeField>,
}

fn present_language<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<RuntimeLanguage>, D::Error> {
    RuntimeLanguage::deserialize(deserializer).map(Some)
}

fn present_script<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<RuntimeScript>, D::Error> {
    RuntimeScript::deserialize(deserializer).map(Some)
}

pub(crate) fn optional_fields<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<RuntimeFields>, D::Error> {
    RuntimeFields::deserialize(deserializer).map(Some)
}

fn valid_name(field: &str) -> bool {
    !field.is_empty()
        && field.len() <= 1024
        && field.trim() == field
        && field != "$param"
        && !field.starts_with('_')
        && !field.contains(['*', '?'])
        && !field.chars().any(char::is_control)
}

fn valid_script(script: &Option<RuntimeScript>) -> bool {
    script.as_ref().is_none_or(|script| {
        !script.source.trim().is_empty()
            && script.source.len() <= 4096
            && !script
                .source
                .chars()
                .any(|char| char.is_control() && !matches!(char, '\n' | '\r' | '\t'))
    })
}

fn bounded<T: Serialize>(value: &T) -> bool {
    serde_json::to_vec(value).is_ok_and(|encoded| encoded.len() <= MAX_BYTES)
}

impl RuntimeFields {
    pub(crate) fn validate(&self) -> Result<(), AppError> {
        let mut names = HashSet::new();
        if self.version != 1
            || self.entries.len() > MAX_ENTRIES
            || !bounded(self)
            || self.entries.iter().any(|entry| {
                !valid_name(&entry.field)
                    || !valid_script(&entry.script)
                    || !names.insert(&entry.field)
            })
        {
            return Err(AppError::new("invalidInput"));
        }
        Ok(())
    }
}

pub(crate) type RuntimeMappings = BTreeMap<String, RuntimeMapping>;

pub(crate) fn validate_mappings(mappings: &RuntimeMappings) -> Result<(), AppError> {
    if mappings.len() > MAX_ENTRIES
        || !bounded(mappings)
        || mappings
            .iter()
            .any(|(name, mapping)| !valid_name(name) || !valid_script(&mapping.script))
    {
        return Err(AppError::new("invalidRuntimeFields"));
    }
    Ok(())
}

#[derive(Deserialize)]
struct Body {
    #[serde(default, deserialize_with = "present_mappings")]
    runtime_mappings: Option<RuntimeMappings>,
}

fn present_mappings<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<RuntimeMappings>, D::Error> {
    RuntimeMappings::deserialize(deserializer).map(Some)
}

/// Call after strict JSON/depth/duplicate-key validation. No values are evaluated or rewritten.
pub(crate) fn validate_body(raw: &str) -> Result<(), AppError> {
    let body: Body =
        serde_json::from_str(raw).map_err(|_| AppError::new("invalidRuntimeFields"))?;
    if let Some(mappings) = body.runtime_mappings {
        validate_mappings(&mappings)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
