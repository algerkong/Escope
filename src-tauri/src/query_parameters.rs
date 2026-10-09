//! Versioned local parameter definitions. No input values or execution state are stored here.

use crate::error::AppError;
use serde::{de, Deserialize, Deserializer, Serialize};
use std::collections::HashSet;

pub(crate) const MAX_TEMPLATE_BYTES: usize = 256 * 1024;
const MAX_PARAMETERS: usize = 32;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ParameterType {
    String,
    Number,
    Boolean,
    Null,
    Object,
    Array,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParameterDefinition {
    pub name: String,
    pub r#type: ParameterType,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryParameters {
    pub version: u32,
    pub template: String,
    pub definitions: Vec<ParameterDefinition>,
}

impl std::fmt::Debug for QueryParameters {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("QueryParameters")
            .field("version", &self.version)
            .field("template_bytes", &self.template.len())
            .field("definition_count", &self.definitions.len())
            .finish()
    }
}

pub(crate) fn valid_parameter_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
        && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

impl QueryParameters {
    pub(crate) fn validate(&self) -> Result<(), AppError> {
        if self.version != 1
            || self.template.len() > MAX_TEMPLATE_BYTES
            || self.definitions.len() > MAX_PARAMETERS
        {
            return Err(AppError::new("invalidInput"));
        }
        let mut names = HashSet::new();
        for definition in &self.definitions {
            if !valid_parameter_name(&definition.name) || !names.insert(&definition.name) {
                return Err(AppError::new("invalidInput"));
            }
        }
        Ok(())
    }
}

/** Absent preserves v1 compatibility; present null or unknown nested fields are not repaired. */
pub(crate) fn optional_parameters<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<QueryParameters>, D::Error> {
    let value = Option::<QueryParameters>::deserialize(deserializer)?
        .ok_or_else(|| de::Error::custom("invalid parameter definition"))?;
    value
        .validate()
        .map_err(|_| de::Error::custom("invalid parameter definition"))?;
    Ok(Some(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn definitions_are_closed_bounded_and_values_are_never_a_stored_field() {
        let raw = r#"{"version":1,"template":"{\"query\":{\"term\":{\"id\":{\"$param\":\"id\"}}}}","definitions":[{"name":"id","type":"number"}]}"#;
        let definition: QueryParameters = serde_json::from_str(raw).unwrap();
        definition.validate().unwrap();
        assert_eq!(serde_json::to_string(&definition).unwrap(), raw);
        for wrong in [
            raw.replace("\"version\":1", "\"version\":2"),
            raw.replace("\"name\":\"id\"", "\"name\":\"1id\""),
            raw.replace("\"type\":\"number\"", "\"type\":\"secret\""),
            raw.replace(
                "\"type\":\"number\"",
                "\"type\":\"number\",\"value\":\"sensitive\"",
            ),
            raw.replace("\"template\":", "\"credentials\":{},\"template\":"),
        ] {
            assert!(!serde_json::from_str::<QueryParameters>(&wrong)
                .map(|value| value.validate().is_ok())
                .unwrap_or(false));
        }
        let mut wrong = definition.clone();
        wrong.definitions.push(wrong.definitions[0].clone());
        assert!(wrong.validate().is_err());
        wrong = definition.clone();
        wrong.template = "x".repeat(MAX_TEMPLATE_BYTES + 1);
        assert!(wrong.validate().is_err());
        assert!(!format!("{definition:?}").contains("$param"));
    }
}
