use super::{AppError, ExportFormat, MAX_PAGE_SIZE};
use crate::query;
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::BTreeMap;

pub(super) const CSV_HEADER: &[u8] = b"_index,_id,_source,fields\r\n";
const MAX_CURSOR_BYTES: usize = 4096;
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
];

#[derive(Debug)]
struct SortSpec {
    descending: bool,
    missing_first: bool,
}

#[derive(Debug)]
pub(super) struct PreparedBody {
    pub page_size: usize,
    sorts: Vec<SortSpec>,
}

fn unsupported() -> AppError {
    AppError::new("exportUnsupportedQuery")
}
fn invalid() -> AppError {
    AppError::new("invalidResponse")
}

pub(super) fn prepare_body(raw: &str) -> Result<PreparedBody, AppError> {
    query::validate_search_body(raw)?;
    let body: Value = serde_json::from_str(raw).map_err(|_| unsupported())?;
    let object = body.as_object().ok_or_else(unsupported)?;
    if object
        .keys()
        .any(|name| !ROOT_KEYS.contains(&name.as_str()))
    {
        return Err(unsupported());
    }
    let size = object
        .get("size")
        .and_then(Value::as_u64)
        .ok_or_else(unsupported)?;
    if size == 0
        || size > MAX_PAGE_SIZE as u64
        || object
            .get("from")
            .is_some_and(|value| value.as_u64() != Some(0))
    {
        return Err(unsupported());
    }
    if unstable(&body) {
        return Err(unsupported());
    }
    let sort = object
        .get("sort")
        .and_then(Value::as_array)
        .ok_or_else(unsupported)?;
    if sort.is_empty() || sort.len() > 16 {
        return Err(unsupported());
    }
    let mut sorts = Vec::with_capacity(sort.len());
    for (position, value) in sort.iter().enumerate() {
        let (name, options) = match value {
            Value::String(name) if !name.trim().is_empty() => (name.as_str(), None),
            Value::Object(object) if object.len() == 1 => {
                let (name, options) = object.iter().next().ok_or_else(unsupported)?;
                if name.trim().is_empty() {
                    return Err(unsupported());
                }
                (name.as_str(), Some(options))
            }
            _ => return Err(unsupported()),
        };
        let last = position + 1 == sort.len();
        if (name == "_shard_doc") != last {
            return Err(unsupported());
        }
        let default_order = if name == "_score" { "desc" } else { "asc" };
        let (order, missing_first) = match options {
            None => (default_order, false),
            Some(Value::String(order)) => (order.as_str(), false),
            Some(Value::Object(options)) if !last => {
                if options.contains_key("format") {
                    return Err(unsupported());
                }
                let order = match options.get("order") {
                    None => default_order,
                    Some(Value::String(order)) => order.as_str(),
                    _ => return Err(unsupported()),
                };
                (
                    order,
                    options.get("missing").and_then(Value::as_str) == Some("_first"),
                )
            }
            _ => return Err(unsupported()),
        };
        if !matches!(order, "asc" | "desc") {
            return Err(unsupported());
        }
        sorts.push(SortSpec {
            descending: order == "desc",
            missing_first,
        });
    }
    Ok(PreparedBody {
        page_size: size as usize,
        sorts,
    })
}

fn unstable(value: &Value) -> bool {
    match value {
        Value::String(text) => moving_time(text),
        Value::Array(values) => values.iter().any(unstable),
        Value::Object(fields) => fields.iter().any(|(name, value)| {
            name == "script"
                || name.ends_with("_script")
                || [
                    "random_score",
                    "function_score",
                    "indexed_shape",
                    "percolate",
                    "more_like_this",
                ]
                .contains(&name.as_str())
                || name == "terms"
                    && value
                        .as_object()
                        .is_some_and(|fields| fields.values().any(Value::is_object))
                || unstable(value)
        }),
        _ => false,
    }
}

fn moving_time(text: &str) -> bool {
    let word = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_';
    text.match_indices("now").any(|(at, _)| {
        (at == 0 || !word(text.as_bytes()[at - 1]))
            && (at + 3 == text.len() || !word(text.as_bytes()[at + 3]))
    })
}

#[derive(Deserialize)]
struct OpenHint {
    #[serde(default, deserialize_with = "present_id")]
    id: Option<String>,
}
#[derive(Deserialize)]
struct PageHint {
    #[serde(default, deserialize_with = "present_id")]
    pit_id: Option<String>,
}

fn present_id<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

/// Read a usable rotation before validating the rest of the envelope, so malformed hits still
/// close the latest known token. Duplicate ID keys are rejected by the derived reader.
pub(super) fn pit_hint(raw: &[u8], opening: bool) -> Result<Option<String>, AppError> {
    let id = if opening {
        serde_json::from_slice::<OpenHint>(raw)
            .map_err(|_| invalid())?
            .id
    } else {
        serde_json::from_slice::<PageHint>(raw)
            .map_err(|_| invalid())?
            .pit_id
    };
    id.map(|id| query::validate_pit_id(&id).map_err(|_| invalid()))
        .transpose()
}

fn strict_json(raw: &[u8]) -> Result<(), AppError> {
    let text = std::str::from_utf8(raw).map_err(|_| invalid())?;
    query::validate_search_body(text)
        .map(|_| ())
        .map_err(|_| invalid())
}

fn shards(value: &Value) -> Result<bool, AppError> {
    let count = |name| value.get(name).and_then(Value::as_u64).ok_or_else(invalid);
    let total = count("total")?;
    let successful = count("successful")?;
    let failed = count("failed")?;
    let skipped = match value.get("skipped") {
        None => 0,
        Some(value) => value.as_u64().ok_or_else(invalid)?,
    };
    if u128::from(successful) + u128::from(failed) != u128::from(total) || skipped > successful {
        return Err(invalid());
    }
    Ok(failed > 0)
}

pub(super) fn validate_open(raw: &[u8]) -> Result<(), AppError> {
    strict_json(raw)?;
    let value: Value = serde_json::from_slice(raw).map_err(|_| invalid())?;
    if let Some(value) = value.get("_shards") {
        if shards(value)? {
            return Err(AppError::new("partialResponse"));
        }
    }
    if pit_hint(raw, true)?.is_none() {
        return Err(invalid());
    }
    Ok(())
}

pub(super) fn closed(raw: &[u8]) -> bool {
    if strict_json(raw).is_err() {
        return false;
    }
    let Ok(value) = serde_json::from_slice::<Value>(raw) else {
        return false;
    };
    value.get("succeeded").and_then(Value::as_bool) == Some(true)
        && value.get("num_freed").and_then(Value::as_u64).is_some()
}

/// Exact decimal ordering without f64. Exponents outside i64 are refused, not rounded; the
/// cursor itself is bounded to 4 KiB, so digit comparisons and padding stay finite.
#[derive(Debug)]
struct Decimal {
    negative: bool,
    digits: Vec<u8>,
    exponent: i64,
}

impl Decimal {
    fn parse(raw: &str) -> Result<Self, AppError> {
        let negative = raw.starts_with('-');
        let unsigned = raw.strip_prefix('-').unwrap_or(raw);
        let (mantissa, exponent) = match unsigned.find(['e', 'E']) {
            Some(at) => (
                &unsigned[..at],
                unsigned[at + 1..].parse::<i64>().map_err(|_| invalid())?,
            ),
            None => (unsigned, 0),
        };
        let fraction = mantissa.find('.').map_or(0, |at| mantissa.len() - at - 1) as i64;
        let all: Vec<u8> = mantissa.bytes().filter(|byte| *byte != b'.').collect();
        let first = all.iter().position(|byte| *byte != b'0');
        let Some(first) = first else {
            return Ok(Self {
                negative: false,
                digits: vec![],
                exponent: 0,
            });
        };
        let mut digits = all[first..].to_vec();
        let exponent = exponent
            .checked_sub(fraction)
            .and_then(|value| value.checked_add(digits.len() as i64 - 1))
            .ok_or_else(invalid)?;
        while digits.last() == Some(&b'0') {
            digits.pop();
        }
        Ok(Self {
            negative,
            digits,
            exponent,
        })
    }

    fn compare(&self, other: &Self) -> Ordering {
        let sign = |value: &Self| {
            if value.digits.is_empty() {
                0
            } else if value.negative {
                -1
            } else {
                1
            }
        };
        let order = sign(self).cmp(&sign(other));
        if order != Ordering::Equal {
            return order;
        }
        if self.digits.is_empty() {
            return Ordering::Equal;
        }
        let magnitude = self.exponent.cmp(&other.exponent).then_with(|| {
            (0..self.digits.len().max(other.digits.len()))
                .map(|at| {
                    self.digits
                        .get(at)
                        .unwrap_or(&b'0')
                        .cmp(other.digits.get(at).unwrap_or(&b'0'))
                })
                .find(|order| *order != Ordering::Equal)
                .unwrap_or(Ordering::Equal)
        });
        if self.negative {
            magnitude.reverse()
        } else {
            magnitude
        }
    }
}

#[derive(Debug)]
enum Scalar {
    Null,
    Bool(bool),
    Text(String),
    Number(Decimal),
}

#[derive(Debug)]
pub(super) struct Cursor {
    pub raw: String,
    values: Vec<Scalar>,
}

impl Cursor {
    fn parse(raw: &str, count: usize) -> Result<Self, AppError> {
        if raw.len() > MAX_CURSOR_BYTES {
            return Err(invalid());
        }
        let values: Vec<Box<RawValue>> = serde_json::from_str(raw).map_err(|_| invalid())?;
        if values.len() != count {
            return Err(invalid());
        }
        let mut parsed = Vec::with_capacity(count);
        for value in &values {
            parsed.push(
                match serde_json::from_str::<Value>(value.get()).map_err(|_| invalid())? {
                    Value::Null => Scalar::Null,
                    Value::Bool(value) => Scalar::Bool(value),
                    Value::String(value) => Scalar::Text(value),
                    Value::Number(_) => Scalar::Number(Decimal::parse(value.get())?),
                    _ => return Err(invalid()),
                },
            );
        }
        // The explicit PIT tie-breaker is an unsigned shard/doc ordinal, not an arbitrary scalar.
        if values
            .last()
            .is_none_or(|value| serde_json::from_str::<u64>(value.get()).is_err())
        {
            return Err(invalid());
        }
        Ok(Self {
            raw: raw.to_owned(),
            values: parsed,
        })
    }

    fn advances(&self, previous: &Self, sorts: &[SortSpec]) -> Result<bool, AppError> {
        for ((current, previous), spec) in self.values.iter().zip(&previous.values).zip(sorts) {
            let order = match (current, previous) {
                (Scalar::Null, Scalar::Null) => Ordering::Equal,
                (Scalar::Null, _) => {
                    if spec.missing_first {
                        Ordering::Less
                    } else {
                        Ordering::Greater
                    }
                }
                (_, Scalar::Null) => {
                    if spec.missing_first {
                        Ordering::Greater
                    } else {
                        Ordering::Less
                    }
                }
                _ => {
                    let order = match (current, previous) {
                        (Scalar::Bool(current), Scalar::Bool(previous)) => current.cmp(previous),
                        (Scalar::Text(current), Scalar::Text(previous)) => {
                            current.as_bytes().cmp(previous.as_bytes())
                        }
                        (Scalar::Number(current), Scalar::Number(previous)) => {
                            current.compare(previous)
                        }
                        _ => return Err(invalid()),
                    };
                    if spec.descending {
                        order.reverse()
                    } else {
                        order
                    }
                }
            };
            if order != Ordering::Equal {
                return Ok(order == Ordering::Greater);
            }
        }
        Ok(false)
    }
}

pub(super) struct ExportPage {
    pub records: Vec<Vec<u8>>,
    pub cursor: Option<Cursor>,
}

#[derive(Deserialize)]
struct Hits {
    hits: Vec<Box<RawValue>>,
}
#[derive(Deserialize)]
struct Envelope {
    hits: Hits,
}

pub(super) fn page(
    raw: &[u8],
    prepared: &PreparedBody,
    previous: Option<&Cursor>,
    format: ExportFormat,
) -> Result<ExportPage, AppError> {
    strict_json(raw)?;
    if query::is_partial(raw)? {
        return Err(AppError::new("partialResponse"));
    }
    let root: Value = serde_json::from_slice(raw).map_err(|_| invalid())?;
    if shards(root.get("_shards").ok_or_else(invalid)?)? {
        return Err(AppError::new("partialResponse"));
    }
    if let Some(Value::Object(total)) = root.get("hits").and_then(|hits| hits.get("total")) {
        if !matches!(
            total.get("relation").and_then(Value::as_str),
            Some("eq" | "gte")
        ) {
            return Err(invalid());
        }
    }
    let envelope: Envelope = serde_json::from_slice(raw).map_err(|_| invalid())?;
    if envelope.hits.hits.len() > prepared.page_size {
        return Err(invalid());
    }
    let mut records = Vec::with_capacity(envelope.hits.hits.len());
    let mut cursor = None;
    for hit in envelope.hits.hits {
        let fields: BTreeMap<String, Box<RawValue>> =
            serde_json::from_str(hit.get()).map_err(|_| invalid())?;
        let text = |name: &str| -> Result<String, AppError> {
            let value = fields.get(name).ok_or_else(invalid)?;
            let decoded: String = serde_json::from_str(value.get()).map_err(|_| invalid())?;
            if decoded.is_empty() {
                return Err(invalid());
            }
            Ok(decoded)
        };
        let index = text("_index")?;
        let id = text("_id")?;
        for name in ["_source", "fields"] {
            if let Some(value) = fields.get(name) {
                if !matches!(
                    serde_json::from_str::<Value>(value.get()).map_err(|_| invalid())?,
                    Value::Object(_) | Value::Null
                ) {
                    return Err(invalid());
                }
            }
        }
        let next = Cursor::parse(
            fields.get("sort").ok_or_else(invalid)?.get(),
            prepared.sorts.len(),
        )?;
        if let Some(previous) = cursor.as_ref().or(previous) {
            if !next.advances(previous, &prepared.sorts)? {
                return Err(invalid());
            }
        }
        let record = match format {
            ExportFormat::Jsonl => {
                let mut bytes = compact(hit.get());
                bytes.push(b'\n');
                bytes
            }
            ExportFormat::Csv => {
                let mut bytes = Vec::new();
                csv_cell(&mut bytes, &guard_formula(&index));
                bytes.push(b',');
                csv_cell(&mut bytes, &guard_formula(&id));
                for name in ["_source", "fields"] {
                    bytes.push(b',');
                    if let Some(value) = fields.get(name) {
                        let raw = compact(value.get());
                        let raw = std::str::from_utf8(&raw).map_err(|_| invalid())?;
                        csv_cell(&mut bytes, raw);
                    }
                }
                bytes.extend_from_slice(b"\r\n");
                bytes
            }
        };
        records.push(record);
        cursor = Some(next);
    }
    Ok(ExportPage { records, cursor })
}

fn compact(raw: &str) -> Vec<u8> {
    let mut result = Vec::with_capacity(raw.len());
    let mut quoted = false;
    let mut escaped = false;
    for byte in raw.bytes() {
        if quoted {
            result.push(byte);
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
            }
        } else if byte == b'"' {
            quoted = true;
            result.push(byte);
        } else if !matches!(byte, b' ' | b'\t' | b'\r' | b'\n') {
            result.push(byte);
        }
    }
    result
}

fn guard_formula(text: &str) -> String {
    let trimmed = text.trim_start_matches(|value: char| {
        value.is_whitespace() || value.is_control() || value == '\u{feff}'
    });
    if trimmed.starts_with(['=', '+', '-', '@']) || text.starts_with(['\t', '\n', '\r']) {
        format!("'{text}")
    } else {
        text.to_owned()
    }
}

fn csv_cell(output: &mut Vec<u8>, text: &str) {
    let quote = text.contains([',', '"', '\r', '\n']);
    if quote {
        output.push(b'"');
    }
    for byte in text.bytes() {
        output.push(byte);
        if byte == b'"' {
            output.push(b'"');
        }
    }
    if quote {
        output.push(b'"');
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    #[test]
    fn decimal_comparison_never_rounds_significands_or_exponents() {
        for (left, right, order) in [
            ("9007199254740993", "9007199254740992", Ordering::Greater),
            (
                "1.0000000000000000001",
                "1.0000000000000000002",
                Ordering::Less,
            ),
            ("-1e99", "-9e98", Ordering::Less),
            ("-0", "0.0", Ordering::Equal),
            ("1e-999", "0", Ordering::Greater),
            ("1.20e2", "120", Ordering::Equal),
            ("1e999", "9e998", Ordering::Greater),
        ] {
            assert_eq!(
                Decimal::parse(left)
                    .unwrap()
                    .compare(&Decimal::parse(right).unwrap()),
                order
            );
        }
        assert!(Decimal::parse("1e9999999999999999999999").is_err());
    }

    #[test]
    fn moving_time_is_decoded_and_bounded_by_word_characters() {
        for text in ["now", "now-1d", "time:[2026 TO now]", "now/d", "(now)"] {
            assert!(moving_time(text));
        }
        for text in ["snow", "knowledge", "nowhere", "_now", "annow"] {
            assert!(!moving_time(text));
        }
    }

    #[test]
    fn csv_formula_guard_covers_controls_unicode_and_line_leads() {
        for text in [
            "=1",
            "+1",
            "-1",
            "@sum",
            " \u{feff}\u{2000}=x",
            "\0\u{85} +1",
            "\tplain",
            "\nplain",
            "\rplain",
        ] {
            assert!(guard_formula(text).starts_with('\''));
        }
        assert_eq!(guard_formula("ordinary"), "ordinary");
        let mut output = vec![];
        csv_cell(&mut output, "a,\"b\"\r\nc");
        assert_eq!(output, b"\"a,\"\"b\"\"\r\nc\"");
    }
}
