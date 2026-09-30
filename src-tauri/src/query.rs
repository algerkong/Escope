//! `query_execute` IPC: one strictly validated `_search` execution.
//!
//! The endpoint is fixed at `{index}/_search`, so nothing in the request body can select another
//! API: the body is passed through verbatim (ES owns query semantics) and only the envelope is
//! validated here. The response is never re-serialized, so number literals keep their exact text.

use crate::connection::decode_response;
use crate::error::AppError;
use crate::operation::{self, IndexTarget, RequestPlan};
use crate::read_only::validate_uuid;
use crate::storage::ConnectionProfile;
use serde::de::{self, DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cell::Cell;
use std::collections::HashSet;

/// One request body may not exceed this size, matching the response bound: both directions are
/// bounded so a single call cannot turn into an unbounded allocation.
pub const MAX_BODY_BYTES: usize = 1024 * 1024;
/// Nesting and node bounds. Both fail closed with `invalidQuery`; the node bound also bounds the
/// work a hostile body can cause before Elasticsearch ever sees it.
const MAX_DEPTH: usize = 64;
const MAX_NODES: usize = 200_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryExecuteRequest {
    pub request_id: String,
    pub connection_id: String,
    pub index: String,
    pub raw_dsl: String,
}

/// The validated execution target: a checked index expression plus the exact body bytes.
#[derive(Debug)]
pub struct PreparedQuery {
    pub index: IndexTarget,
    pub body: Vec<u8>,
}

impl QueryExecuteRequest {
    /// Validate the identifiers. The command calls this before its error mapper can attach a
    /// request ID, so an invalid ID is never echoed back through IPC.
    pub fn validate_ids(&self) -> Result<(), AppError> {
        validate_uuid(&self.request_id)?;
        validate_uuid(&self.connection_id)
    }

    /// Validate the target and the body.
    pub fn prepare(&self) -> Result<PreparedQuery, AppError> {
        self.validate_ids()?;
        Ok(PreparedQuery {
            index: IndexTarget::parse(&self.index)?,
            body: validate_search_body(&self.raw_dsl)?,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryExecuteResponse {
    pub request_id: String,
    pub connection_id: String,
    pub endpoint: String,
    pub raw_response: String,
    /// True when the cluster reported a timeout, a failed shard or an early termination, so the
    /// UI never presents a partial result as a complete success.
    pub partial: bool,
}

impl QueryExecuteResponse {
    pub fn new(
        request: &QueryExecuteRequest,
        profile: &ConnectionProfile,
        raw: Vec<u8>,
    ) -> Result<Self, AppError> {
        let partial = is_partial(&raw)?;
        Ok(Self {
            request_id: request.request_id.clone(),
            connection_id: request.connection_id.clone(),
            endpoint: profile.endpoint.clone(),
            raw_response: decode_response(raw)?,
            partial,
        })
    }
}

/// Build the single search plan from an already validated target and body.
pub fn search_plan(
    profile: &ConnectionProfile,
    index: &IndexTarget,
    body: Vec<u8>,
) -> Result<RequestPlan, AppError> {
    operation::search_request(profile, index, body)
}

/// Read the execution state from a `_search` response without rewriting it.
///
/// The minimal shape Elasticsearch returns is required: a body without it is an error rather than
/// an empty success, so a malformed, truncated or unexpected response can never be presented as
/// "no results". Only these flags are read; no document, field or message from the response is
/// copied out.
pub fn is_partial(raw: &[u8]) -> Result<bool, AppError> {
    let value: Value = serde_json::from_slice(raw).map_err(|_| AppError::new("invalidResponse"))?;
    let object = value
        .as_object()
        .ok_or_else(|| AppError::new("invalidResponse"))?;
    let timed_out = match object.get("timed_out") {
        Some(value) => value
            .as_bool()
            .ok_or_else(|| AppError::new("invalidResponse"))?,
        None => return Err(AppError::new("invalidResponse")),
    };
    let failed = shard_counts(object.get("_shards"))?;
    let terminated_early = match object.get("terminated_early") {
        Some(value) => value
            .as_bool()
            .ok_or_else(|| AppError::new("invalidResponse"))?,
        None => false,
    };
    validate_hits(object.get("hits"))?;
    Ok(timed_out || failed > 0 || terminated_early)
}

/// `_shards` must be present with non-negative, consistent counts; returns the failure count.
fn shard_counts(value: Option<&Value>) -> Result<u64, AppError> {
    let object = value
        .and_then(Value::as_object)
        .ok_or_else(|| AppError::new("invalidResponse"))?;
    let total = count(object.get("total"))?;
    let successful = count(object.get("successful"))?;
    let failed = count(object.get("failed"))?;
    let skipped = match object.get("skipped") {
        Some(value) => count(Some(value))?,
        None => 0,
    };
    // Compared as `u128`: a hostile pair of huge counts must not overflow into a false success.
    let within_total = |left: u64, right: u64| (left as u128) + (right as u128) <= total as u128;
    if successful > total || failed > total || skipped > total || !within_total(successful, failed)
    {
        return Err(AppError::new("invalidResponse"));
    }
    Ok(failed)
}

/// A count is a non-negative integer; a missing, negative, fractional or non-numeric value fails.
fn count(value: Option<&Value>) -> Result<u64, AppError> {
    value
        .and_then(Value::as_u64)
        .ok_or_else(|| AppError::new("invalidResponse"))
}

/// `hits.hits` is always an array; `hits.total` is a count object (or a bare number on older
/// servers). Neither is trusted for the partial decision, only for the shape check.
fn validate_hits(value: Option<&Value>) -> Result<(), AppError> {
    let object = value
        .and_then(Value::as_object)
        .ok_or_else(|| AppError::new("invalidResponse"))?;
    if !object.get("hits").is_some_and(Value::is_array) {
        return Err(AppError::new("invalidResponse"));
    }
    if let Some(total) = object.get("total") {
        let valid = match total {
            Value::Number(number) => number.as_u64().is_some(),
            Value::Object(total) => total.get("value").and_then(Value::as_u64).is_some(),
            _ => false,
        };
        if !valid {
            return Err(AppError::new("invalidResponse"));
        }
    }
    Ok(())
}

/// Validate a `_search` request body: strict JSON, object root, no repeated key anywhere, and
/// bounded depth and size. The bytes are returned unchanged — this never reformats, reorders or
/// re-serializes the draft, so number literals and key order survive exactly.
pub fn validate_search_body(raw: &str) -> Result<Vec<u8>, AppError> {
    if raw.trim().is_empty() || raw.len() > MAX_BODY_BYTES {
        return Err(AppError::new("invalidQuery"));
    }
    let nodes = Cell::new(0);
    let mut deserializer = serde_json::Deserializer::from_str(raw);
    // The root must be an object. `deserialize_map` rejects every other token, including a bare
    // number — which `arbitrary_precision` would otherwise hand back as a one-entry map.
    Deserializer::deserialize_map(
        &mut deserializer,
        BodyVisitor {
            depth: 0,
            nodes: &nodes,
        },
    )
    .map_err(|_| AppError::new("invalidQuery"))?;
    deserializer
        .end()
        .map_err(|_| AppError::new("invalidQuery"))?;
    Ok(raw.as_bytes().to_vec())
}

fn budget<E: de::Error>(depth: usize, nodes: &Cell<usize>) -> Result<(), E> {
    let used = nodes.get() + 1;
    if used > MAX_NODES {
        // The message is discarded by the caller: a parser message can quote the input.
        return Err(E::custom("query body is too large"));
    }
    nodes.set(used);
    if depth > MAX_DEPTH {
        return Err(E::custom("query body is too deep"));
    }
    Ok(())
}

struct BodySeed<'a> {
    depth: usize,
    nodes: &'a Cell<usize>,
}

impl<'de, 'a> DeserializeSeed<'de> for BodySeed<'a> {
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<(), D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(BodyVisitor {
            depth: self.depth,
            nodes: self.nodes,
        })
    }
}

struct BodyVisitor<'a> {
    depth: usize,
    nodes: &'a Cell<usize>,
}

impl BodyVisitor<'_> {
    /// A scalar only consumes a node; the root itself is handled by `deserialize_map`.
    fn scalar<E: de::Error>(&self) -> Result<(), E> {
        budget(self.depth, self.nodes)
    }
}

impl<'de> Visitor<'de> for BodyVisitor<'_> {
    type Value = ();

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("an Elasticsearch search request body")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        budget::<A::Error>(self.depth, self.nodes)?;
        let mut seen = HashSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if !seen.insert(key) {
                return Err(de::Error::custom("query body repeats a key"));
            }
            map.next_value_seed(BodySeed {
                depth: self.depth + 1,
                nodes: self.nodes,
            })?;
        }
        Ok(())
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        budget::<A::Error>(self.depth, self.nodes)?;
        while seq
            .next_element_seed(BodySeed {
                depth: self.depth + 1,
                nodes: self.nodes,
            })?
            .is_some()
        {}
        Ok(())
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<(), E> {
        self.scalar()
    }

    fn visit_i64<E: de::Error>(self, _: i64) -> Result<(), E> {
        self.scalar()
    }

    fn visit_u64<E: de::Error>(self, _: u64) -> Result<(), E> {
        self.scalar()
    }

    fn visit_f64<E: de::Error>(self, _: f64) -> Result<(), E> {
        self.scalar()
    }

    fn visit_str<E: de::Error>(self, _: &str) -> Result<(), E> {
        self.scalar()
    }

    fn visit_string<E: de::Error>(self, _: String) -> Result<(), E> {
        self.scalar()
    }

    fn visit_unit<E: de::Error>(self) -> Result<(), E> {
        self.scalar()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{AuthKind, ConnectionAuth};

    const REQUEST: &str = "6f3b2f1c-4f3e-4a5b-8c9d-0e1f2a3b4c5d";
    const CONNECTION: &str = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e";

    fn profile() -> ConnectionProfile {
        ConnectionProfile {
            id: CONNECTION.into(),
            display_name: "Fixture".into(),
            endpoint: "https://example.test/proxy/es".into(),
            environment: "development".into(),
            sort_order: 0,
            auth: "none",
            auth_state: ConnectionAuth::none(),
        }
    }

    fn request(index: &str, raw_dsl: &str) -> QueryExecuteRequest {
        QueryExecuteRequest {
            request_id: REQUEST.into(),
            connection_id: CONNECTION.into(),
            index: index.into(),
            raw_dsl: raw_dsl.into(),
        }
    }

    #[test]
    fn valid_bodies_are_forwarded_byte_for_byte() {
        for raw in [
            r#"{"query":{"match_all":{}},"size":25}"#,
            "{\n  \"size\": 0\n}",
            r#"{"aggs":{"a":{"terms":{"field":"f","size":1}},"b":{"avg":{"field":"g"}}}}"#,
            r#"{"query":{"bool":{"should":[{"term":{"a":1}},{"range":{"b":{"gte":2}}}]}}}"#,
        ] {
            assert_eq!(validate_search_body(raw).unwrap(), raw.as_bytes());
        }
    }

    #[test]
    fn the_root_must_be_an_object_even_for_arbitrary_precision_numbers() {
        for raw in [
            "1.1",
            "1e400",
            "123456789012345678901234567890",
            "-9223372036854775809",
            "1",
            "0",
            "[]",
            "[1]",
            "\"query\"",
            "true",
            "null",
        ] {
            assert_eq!(
                validate_search_body(raw).unwrap_err().code,
                "invalidQuery",
                "{raw} should be refused"
            );
        }
    }

    #[test]
    fn a_private_number_token_key_cannot_bypass_the_checks() {
        // A real JSON object may name the `arbitrary_precision` token itself; it must be treated
        // like any other key, so the repeated `x` is still detected.
        for raw in [
            r#"{"$serde_json::private::Number":"1","x":1,"x":2}"#,
            r#"{"a":{"$serde_json::private::Number":"1","x":1,"x":2}}"#,
        ] {
            assert_eq!(
                validate_search_body(raw).unwrap_err().code,
                "invalidQuery",
                "{raw} should be refused"
            );
        }
    }

    #[test]
    fn number_literals_keep_their_exact_text() {
        // Precision beyond `f64`/`u64`, an exponent beyond `f64` range and a negative long are all
        // accepted and never rewritten.
        for raw in [
            r#"{"size":123456789012345678901234567890}"#,
            r#"{"boost":1e400}"#,
            r#"{"long":-9223372036854775809}"#,
            r#"{"nested":{"v":[1.1000000000000000001,2e-400]}}"#,
        ] {
            assert_eq!(validate_search_body(raw).unwrap(), raw.as_bytes());
        }
    }

    #[test]
    fn bodies_that_are_not_one_strict_object_are_refused() {
        for raw in [
            "",
            "   ",
            "[]",
            "[1]",
            "1",
            "\"query\"",
            "null",
            "true",
            r#"{"size":1} trailing"#,
            r#"{"size":1,}"#,
            "{/*comment*/}",
            r#"{'size':1}"#,
            r#"{"size":1"#,
        ] {
            assert_eq!(
                validate_search_body(raw).unwrap_err().code,
                "invalidQuery",
                "{raw} should be refused"
            );
        }
    }

    #[test]
    fn repeated_keys_anywhere_in_the_body_are_refused() {
        for raw in [
            r#"{"size":1,"size":2}"#,
            r#"{"query":{"match_all":{},"match_all":{}}}"#,
            r#"{"a":{"b":[{"c":1,"c":2}]}}"#,
            // Escape-decoded names collide, exactly as Elasticsearch would see them.
            r#"{"size":1,"\u0073ize":2}"#,
        ] {
            assert_eq!(
                validate_search_body(raw).unwrap_err().code,
                "invalidQuery",
                "{raw} should be refused"
            );
        }
        // Sibling array items may legitimately repeat a key.
        assert!(validate_search_body(r#"{"k":[{"a":1},{"a":2}]}"#).is_ok());
    }

    #[test]
    fn depth_size_and_node_bounds_fail_closed() {
        let deep = format!(
            "{}1{}",
            "{\"a\":".repeat(MAX_DEPTH + 2),
            "}".repeat(MAX_DEPTH + 2)
        );
        assert_eq!(
            validate_search_body(&deep).unwrap_err().code,
            "invalidQuery"
        );
        let ok_depth = format!("{}1{}", "{\"a\":".repeat(8), "}".repeat(8));
        assert!(validate_search_body(&ok_depth).is_ok());

        let oversize = format!("{{\"pad\":\"{}\"}}", "x".repeat(MAX_BODY_BYTES));
        assert_eq!(
            validate_search_body(&oversize).unwrap_err().code,
            "invalidQuery"
        );

        let wide = format!("{{\"k\":[{}]}}", vec!["1"; MAX_NODES + 1].join(","));
        assert!(wide.len() < MAX_BODY_BYTES);
        assert_eq!(
            validate_search_body(&wide).unwrap_err().code,
            "invalidQuery"
        );
    }

    /// Minimal `_search` shape Elasticsearch actually returns; each case varies one part of it.
    const OK_RESPONSE: &str = r#"{"took":1,"timed_out":false,"_shards":{"total":1,"successful":1,"skipped":0,"failed":0},"hits":{"total":{"value":0,"relation":"eq"},"max_score":null,"hits":[]}}"#;
    const OK_SHARDS: &str = r#""_shards":{"total":1,"successful":1,"skipped":0,"failed":0}"#;

    #[test]
    fn partial_results_are_detected_from_shard_failures_timeouts_and_early_termination() {
        for (raw, partial) in [
            (OK_RESPONSE.to_string(), false),
            (OK_RESPONSE.replace(r#""timed_out":false"#, r#""timed_out":true"#), true),
            (
                OK_RESPONSE.replace(
                    OK_SHARDS,
                    r#""_shards":{"total":5,"successful":4,"skipped":0,"failed":1}"#,
                ),
                true,
            ),
            (
                OK_RESPONSE.replace(
                    OK_SHARDS,
                    r#""_shards":{"total":1,"successful":1,"skipped":0,"failed":0},"terminated_early":true"#,
                ),
                true,
            ),
            // `skipped` is optional, and a numeric `hits.total` is still a valid shape.
            (
                r#"{"timed_out":false,"_shards":{"total":2,"successful":2,"failed":0},"hits":{"total":7,"hits":[]}}"#
                    .to_string(),
                false,
            ),
        ] {
            assert_eq!(is_partial(raw.as_bytes()).unwrap(), partial, "{raw}");
        }
    }

    #[test]
    fn a_response_without_the_minimal_search_schema_is_never_a_success() {
        for raw in [
            "{}",
            r#"{"timed_out":false}"#,
            r#"{"timed_out":false,"_shards":{"total":1,"successful":1,"failed":0}}"#,
            r#"{"timed_out":"false","_shards":{"total":1,"successful":1,"failed":0},"hits":{"hits":[]}}"#,
            r#"{"_shards":{"total":1,"successful":1,"failed":0},"hits":{"hits":[]}}"#,
            r#"{"timed_out":false,"_shards":{"successful":1,"failed":0},"hits":{"hits":[]}}"#,
            r#"{"timed_out":false,"_shards":{"total":1,"failed":0},"hits":{"hits":[]}}"#,
            r#"{"timed_out":false,"_shards":{"total":1,"successful":1},"hits":{"hits":[]}}"#,
            r#"{"timed_out":false,"_shards":{"total":1,"successful":1,"failed":-1},"hits":{"hits":[]}}"#,
            r#"{"timed_out":false,"_shards":{"total":1,"successful":2,"failed":0},"hits":{"hits":[]}}"#,
            r#"{"timed_out":false,"_shards":{"total":1,"successful":1,"failed":0,"skipped":-1},"hits":{"hits":[]}}"#,
            // Huge counts must not overflow into a false success.
            r#"{"timed_out":false,"_shards":{"total":18446744073709551615,"successful":18446744073709551615,"failed":18446744073709551615},"hits":{"hits":[]}}"#,
            r#"{"timed_out":false,"_shards":{"total":1,"successful":99999999999999999999,"failed":0},"hits":{"hits":[]}}"#,
            r#"{"timed_out":false,"_shards":"1","hits":{"hits":[]}}"#,
            r#"{"timed_out":false,"_shards":{"total":1,"successful":1,"failed":0},"hits":[]}"#,
            r#"{"timed_out":false,"_shards":{"total":1,"successful":1,"failed":0},"hits":{}}"#,
            r#"{"timed_out":false,"_shards":{"total":1,"successful":1,"failed":0},"hits":{"hits":{}}}"#,
            r#"{"timed_out":false,"_shards":{"total":1,"successful":1,"failed":0},"hits":{"hits":[],"total":"7"}}"#,
            r#"{"timed_out":false,"_shards":{"total":1,"successful":1,"failed":0},"hits":{"hits":[],"total":{"value":-1,"relation":"eq"}}}"#,
            r#"{"timed_out":false,"_shards":{"total":1,"successful":1,"failed":0},"terminated_early":"yes","hits":{"hits":[]}}"#,
            "[]",
            "not json",
            "",
        ] {
            assert_eq!(
                is_partial(raw.as_bytes()).unwrap_err().code,
                "invalidResponse",
                "{raw} must not read as a successful search"
            );
        }
    }

    #[test]
    fn the_search_plan_posts_the_verbatim_body_to_the_fixed_path() {
        let raw = r#"{"query":{"match_all":{}},"size":0}"#;
        let prepared = request("logs-*", raw).prepare().unwrap();
        let built = search_plan(&profile(), &prepared.index, prepared.body)
            .unwrap()
            .build(&reqwest::Client::new())
            .build()
            .unwrap();
        assert_eq!(built.method(), reqwest::Method::POST);
        assert_eq!(
            built.url().as_str(),
            "https://example.test/proxy/es/logs-*/_search"
        );
        assert_eq!(
            built
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .unwrap()
                .to_str()
                .unwrap(),
            "application/json"
        );
        assert_eq!(built.body().unwrap().as_bytes().unwrap(), raw.as_bytes());
    }

    #[test]
    fn execute_requests_validate_ids_targets_and_bodies_before_any_plan() {
        assert!(request("logs-*", r#"{"size":0}"#).prepare().is_ok());
        assert_eq!(
            request("../_delete", r#"{"size":0}"#)
                .prepare()
                .unwrap_err()
                .code,
            "invalidIndex"
        );
        assert_eq!(
            request("logs-*", "[]").prepare().unwrap_err().code,
            "invalidQuery"
        );
        // An invalid identifier is refused before the target or the body is even looked at, and it
        // carries no request ID for the command to echo back.
        for (request_id, connection_id) in [("secret", CONNECTION), (REQUEST, "secret")] {
            let mut invalid = request("logs-*", "not json");
            invalid.request_id = request_id.into();
            invalid.connection_id = connection_id.into();
            let error = invalid.validate_ids().unwrap_err();
            assert_eq!(error.code, "invalidInput");
            assert_eq!(error.request_id, None);
        }
        // With valid identifiers the body error is the one reported, and it does carry the ID.
        let invalid = request("logs-*", "not json");
        assert!(invalid.validate_ids().is_ok());
        assert_eq!(invalid.prepare().unwrap_err().code, "invalidQuery");
    }

    #[test]
    fn an_authenticated_connection_never_builds_a_search_plan() {
        let mut profile = profile();
        profile.auth_state = ConnectionAuth {
            kind: AuthKind::ApiKey,
            credential_ref: Some(crate::credentials::CredentialRef::generate()),
        };
        let target = IndexTarget::parse("logs-*").unwrap();
        assert_eq!(
            search_plan(&profile, &target, b"{}".to_vec())
                .err()
                .unwrap()
                .code,
            "unsupported"
        );
    }

    #[test]
    fn the_execution_contract_uses_the_exact_camel_case_keys() {
        let value = serde_json::to_value(QueryExecuteResponse {
            request_id: REQUEST.into(),
            connection_id: CONNECTION.into(),
            endpoint: "https://example.test/proxy/es".into(),
            raw_response: "{}".into(),
            partial: true,
        })
        .unwrap();
        let object = value.as_object().unwrap();
        assert_eq!(object.len(), 5);
        for key in [
            "requestId",
            "connectionId",
            "endpoint",
            "rawResponse",
            "partial",
        ] {
            assert!(object.contains_key(key), "{key} is missing");
        }
        // The request side is camelCase only: a snake_case draft is not silently accepted.
        assert!(serde_json::from_str::<QueryExecuteRequest>(
            r#"{"requestId":"6f3b2f1c-4f3e-4a5b-8c9d-0e1f2a3b4c5d","connectionId":"1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e","index":"logs-*","raw_dsl":"{}"}"#
        )
        .is_err());
    }

    #[test]
    fn ipc_payloads_reject_unknown_fields_and_arbitrary_targets() {
        let valid = format!(
            r#"{{"requestId":"{REQUEST}","connectionId":"{CONNECTION}","index":"logs-*","rawDsl":"{{}}"}}"#
        );
        assert!(serde_json::from_str::<QueryExecuteRequest>(&valid).is_ok());
        for payload in [
            format!(
                r#"{{"requestId":"{REQUEST}","connectionId":"{CONNECTION}","index":"logs-*","rawDsl":"{{}}","endpoint":"/secret"}}"#
            ),
            format!(
                r#"{{"requestId":"{REQUEST}","connectionId":"{CONNECTION}","index":"logs-*","rawDsl":"{{}}","method":"DELETE"}}"#
            ),
            format!(
                r#"{{"requestId":"{REQUEST}","connectionId":"{CONNECTION}","index":"logs-*","rawDsl":"{{}}","headers":{{"authorization":"secret"}}}}"#
            ),
            format!(
                r#"{{"requestId":"{REQUEST}","connectionId":"{CONNECTION}","index":"logs-*","rawDsl":"{{}}","path":"/_cat/indices"}}"#
            ),
        ] {
            assert!(
                serde_json::from_str::<QueryExecuteRequest>(&payload).is_err(),
                "{payload} should be refused"
            );
        }
    }
}
