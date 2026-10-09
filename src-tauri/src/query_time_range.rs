//! Versioned local time-range metadata. Only the already-applied DSL wrapper is managed.
//! This module validates recovery/library data; it adds no transport, clock or write operation.

use crate::error::AppError;
use chrono::{DateTime, Datelike, Duration, FixedOffset, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use std::fmt;

const MAX_DSL_BYTES: usize = 256 * 1024;
const MAX_AMOUNT: u32 = 10000;
const NANOS: i128 = 1_000_000_000;
const MAX_SPAN: i128 = 3660 * 86400 * NANOS;
const ROOT_KEYS: &[&str] = &[
    "query",
    "post_filter",
    "sort",
    "size",
    "from",
    "_source",
    "fields",
    "docvalue_fields",
    "stored_fields",
    "track_scores",
    "track_total_hits",
    "version",
    "seq_no_primary_term",
    "min_score",
    "highlight",
    "explain",
    "timeout",
    "terminate_after",
    "profile",
    "aggs",
    "aggregations",
    "runtime_mappings",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimeFieldType {
    Date,
    DateNanos,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TimeUnit {
    Seconds,
    Minutes,
    Hours,
    Days,
}

impl TimeUnit {
    fn seconds(self) -> i64 {
        match self {
            Self::Seconds => 1,
            Self::Minutes => 60,
            Self::Hours => 3600,
            Self::Days => 86400,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum TimeRangeValue {
    Relative { amount: u32, unit: TimeUnit },
    Absolute { from: String, to: String },
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeRangeDefinition {
    pub field: String,
    pub field_type: TimeFieldType,
    pub time_zone: String,
    pub range: TimeRangeValue,
}

impl fmt::Debug for TimeRangeDefinition {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TimeRangeDefinition")
            .field("field_type", &self.field_type)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeRangeBounds {
    pub resolved_at: String,
    pub from: String,
    pub to: String,
}

impl fmt::Debug for TimeRangeBounds {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TimeRangeBounds([redacted])")
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeRangeBinding {
    pub connection_id: String,
    pub index: String,
}

impl fmt::Debug for TimeRangeBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TimeRangeBinding([redacted])")
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionTimeRange {
    pub version: u32,
    pub definition: TimeRangeDefinition,
    pub bounds: TimeRangeBounds,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryTimeRange {
    pub version: u32,
    pub definition: TimeRangeDefinition,
    pub bounds: TimeRangeBounds,
    pub binding: TimeRangeBinding,
    pub had_query: bool,
}

pub(crate) fn optional_query_time_range<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<QueryTimeRange>, D::Error> {
    QueryTimeRange::deserialize(deserializer).map(Some)
}

pub(crate) fn optional_execution_time_range<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<ExecutionTimeRange>, D::Error> {
    ExecutionTimeRange::deserialize(deserializer).map(Some)
}

fn invalid() -> AppError {
    AppError::new("invalidInput")
}

enum Zone {
    Fixed(FixedOffset),
    Named(Tz),
}

impl Zone {
    fn parse(value: &str) -> Result<Self, AppError> {
        if value == "UTC" {
            return Ok(Self::Fixed(FixedOffset::east_opt(0).ok_or_else(invalid)?));
        }
        let bytes = value.as_bytes();
        if value.len() > 100 || value == "-00:00" {
            return Err(invalid());
        }
        if matches!(bytes.first(), Some(b'+' | b'-')) {
            if bytes.len() != 6
                || bytes[3] != b':'
                || ![bytes[1], bytes[2], bytes[4], bytes[5]]
                    .iter()
                    .all(u8::is_ascii_digit)
            {
                return Err(invalid());
            }
            let hours = i32::from(bytes[1] - b'0') * 10 + i32::from(bytes[2] - b'0');
            let minutes = i32::from(bytes[4] - b'0') * 10 + i32::from(bytes[5] - b'0');
            if hours >= 24 || minutes >= 60 {
                return Err(invalid());
            }
            let seconds = (hours * 3600 + minutes * 60) * if bytes[0] == b'-' { -1 } else { 1 };
            return FixedOffset::east_opt(seconds)
                .map(Self::Fixed)
                .ok_or_else(invalid);
        }
        let mut parts = value.split('/');
        let head = parts.next().unwrap_or("");
        let tail: Vec<_> = parts.collect();
        if head.is_empty()
            || !head.bytes().all(|b| b.is_ascii_alphabetic() || b == b'_')
            || tail.is_empty()
            || tail.iter().any(|part| {
                part.is_empty()
                    || !part
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'+' | b'-'))
            })
        {
            return Err(invalid());
        }
        value.parse::<Tz>().map(Self::Named).map_err(|_| invalid())
    }

    fn resolve(&self, value: &str) -> Result<DateTime<Utc>, AppError> {
        let local = local_date(value)?;
        // Neither a gap nor a fold is silently interpreted as an earlier/later instant.
        match self {
            Self::Fixed(zone) => zone
                .from_local_datetime(&local)
                .single()
                .map(|date| date.with_timezone(&Utc)),
            Self::Named(zone) => zone
                .from_local_datetime(&local)
                .single()
                .map(|date| date.with_timezone(&Utc)),
        }
        .ok_or_else(invalid)
    }
}

fn local_date(value: &str) -> Result<NaiveDateTime, AppError> {
    let bytes = value.as_bytes();
    if !(bytes.len() == 19 || (21..=29).contains(&bytes.len())) || value.starts_with("0000-") {
        return Err(invalid());
    }
    for (index, byte) in bytes[..19].iter().enumerate() {
        let literal = match index {
            4 | 7 => Some(b'-'),
            10 => Some(b'T'),
            13 | 16 => Some(b':'),
            _ => None,
        };
        if literal.map_or_else(|| !byte.is_ascii_digit(), |expected| *byte != expected) {
            return Err(invalid());
        }
    }
    if bytes[17] > b'5'
        || bytes.len() > 19 && (bytes[19] != b'.' || !bytes[20..].iter().all(u8::is_ascii_digit))
    {
        return Err(invalid());
    }
    NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f").map_err(|_| invalid())
}

fn utc_stamp(value: &str, digits: usize) -> Result<DateTime<Utc>, AppError> {
    if value.len() != 21 + digits || !value.ends_with('Z') || value.as_bytes()[19] != b'.' {
        return Err(invalid());
    }
    Ok(local_date(&value[..value.len() - 1])?.and_utc())
}

fn nanos(value: &DateTime<Utc>) -> i128 {
    i128::from(value.timestamp()) * NANOS + i128::from(value.timestamp_subsec_nanos())
}

fn validate_parts(
    version: u32,
    definition: &TimeRangeDefinition,
    bounds: &TimeRangeBounds,
) -> Result<(), AppError> {
    let field = &definition.field;
    if version != 1
        || field.is_empty()
        || field.len() > 1024
        || field != field.trim()
        || field == "$param"
        || field.starts_with('_')
        || field.contains(['*', '?'])
        || field.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    let zone = Zone::parse(&definition.time_zone)?;
    let anchor = utc_stamp(&bounds.resolved_at, 3)?;
    let from = utc_stamp(&bounds.from, 9)?;
    let to = utc_stamp(&bounds.to, 9)?;
    let (expected_from, expected_to) = match &definition.range {
        TimeRangeValue::Relative { amount, unit } => {
            let seconds = i64::from(*amount) * unit.seconds();
            if !(1..=MAX_AMOUNT).contains(amount) || i128::from(seconds) * NANOS > MAX_SPAN {
                return Err(invalid());
            }
            (
                anchor
                    .checked_sub_signed(Duration::seconds(seconds))
                    .ok_or_else(invalid)?,
                anchor,
            )
        }
        TimeRangeValue::Absolute { from, to } => (zone.resolve(from)?, zone.resolve(to)?),
    };
    let start = nanos(&from);
    let end = nanos(&to);
    if start != nanos(&expected_from)
        || end != nanos(&expected_to)
        || start >= end
        || end - start > MAX_SPAN
        || !(1..=9999).contains(&from.year())
        || !(1..=9999).contains(&to.year())
        || match definition.field_type {
            TimeFieldType::Date => start % 1_000_000 != 0 || end % 1_000_000 != 0,
            TimeFieldType::DateNanos => start < 0 || end > i128::from(i64::MAX),
        }
    {
        return Err(invalid());
    }
    Ok(())
}

fn exact_object<'a>(value: &'a Value, keys: &[&str]) -> Result<&'a Map<String, Value>, AppError> {
    let object = value.as_object().ok_or_else(invalid)?;
    if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
        return Err(invalid());
    }
    Ok(object)
}

fn validate_body(
    dsl: &str,
    definition: &TimeRangeDefinition,
    bounds: &TimeRangeBounds,
    had_query: Option<bool>,
) -> Result<(), AppError> {
    if dsl.len() > MAX_DSL_BYTES {
        return Err(invalid());
    }
    crate::query::validate_json_body(dsl, false).map_err(|_| invalid())?;
    crate::runtime_fields::validate_body(dsl).map_err(|_| invalid())?;
    let body: Value = serde_json::from_str(dsl).map_err(|_| invalid())?;
    let root = body.as_object().ok_or_else(invalid)?;
    if root.keys().any(|key| !ROOT_KEYS.contains(&key.as_str())) {
        return Err(invalid());
    }
    let query = exact_object(root.get("query").ok_or_else(invalid)?, &["bool"])?;
    let boolean = exact_object(&query["bool"], &["must", "filter"])?;
    let must = boolean["must"].as_array().ok_or_else(invalid)?;
    let filter = boolean["filter"].as_array().ok_or_else(invalid)?;
    if must.len() != 1 || !must[0].is_object() || filter.len() != 1 {
        return Err(invalid());
    }
    let clause = exact_object(&filter[0], &["range"])?;
    let fields = exact_object(&clause["range"], &[&definition.field])?;
    let range = exact_object(&fields[&definition.field], &["gte", "lt", "format"])?;
    if range["gte"].as_str() != Some(bounds.from.as_str())
        || range["lt"].as_str() != Some(bounds.to.as_str())
        || range["format"].as_str() != Some("strict_date_optional_time_nanos")
    {
        return Err(invalid());
    }
    if let Some(mapping) = root
        .get("runtime_mappings")
        .and_then(|value| value.get(&definition.field))
    {
        if mapping.get("type").and_then(Value::as_str) != Some("date")
            || definition.field_type != TimeFieldType::Date
        {
            return Err(invalid());
        }
    }
    if had_query == Some(false) {
        let original = exact_object(&must[0], &["match_all"])?;
        exact_object(&original["match_all"], &[])?;
    }
    Ok(())
}

impl ExecutionTimeRange {
    pub(crate) fn validate(&self, dsl: &str) -> Result<(), AppError> {
        validate_parts(self.version, &self.definition, &self.bounds)?;
        validate_body(dsl, &self.definition, &self.bounds, None)
    }
}

impl QueryTimeRange {
    pub(crate) fn validate(
        &self,
        connection_id: Option<&str>,
        index: &str,
        dsl: &str,
    ) -> Result<(), AppError> {
        let id = &self.binding.connection_id;
        if connection_id != Some(id.as_str())
            || self.binding.index != index
            || id.is_empty()
            || id.len() > 64
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            || index.trim().is_empty()
            || index.len() > 1024
        {
            return Err(invalid());
        }
        validate_parts(self.version, &self.definition, &self.bounds)?;
        validate_body(dsl, &self.definition, &self.bounds, Some(self.had_query))
    }
}

#[cfg(test)]
mod tests;
