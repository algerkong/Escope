use super::*;
use crate::storage::ConnectionInput;
use rusqlite::Connection;
use serde_json::{json, Value};

fn fixture() -> ChartDefinitionLibrary {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/chart-definitions-v1.json"
    ))
    .unwrap()
}

fn grouped(mut library: ChartDefinitionLibrary) -> ChartDefinitionLibrary {
    let value = json!({
        "type": "terms", "name": "by_host", "field": "host", "size": "20"
    });
    library.entries[0].draft.group = serde_json::from_value(value).unwrap();
    library
}

fn definition(value: Value) -> ChartDefinition {
    serde_json::from_value(value).unwrap()
}

fn draft_value(group: Value, metrics: Vec<Value>) -> ChartDraft {
    serde_json::from_value(json!({ "group": group, "metrics": metrics })).unwrap()
}

fn populated(database: &mut Database) -> ChartDefinitionLibrary {
    let profile = database
        .save_connection(
            ConnectionInput {
                display_name: "Fixture".into(),
                endpoint: "https://fixture.test".into(),
                environment: "development".into(),
            },
            None,
        )
        .unwrap()
        .profile;
    let mut library = fixture();
    library.entries.truncate(2);
    library.entries[0].connection_id = profile.id.clone();
    library.entries[1].connection_id = profile.id;
    library
}

#[test]
fn shared_fixture_validates_and_round_trips_through_the_document_keys() {
    let library = fixture();
    library.validate().unwrap();
    let text = serde_json::to_string(&library).unwrap();
    for key in [
        "\"intervalValue\":\"30d\"",
        "\"timeZone\":\"UTC\"",
        "\"type\":\"date_histogram\"",
        "\"measure\":\"doc_count\"",
        "\"group\":null",
    ] {
        assert!(text.contains(key), "missing {key}");
    }
    assert_eq!(decode_stored(&text).unwrap(), library);
}

#[test]
fn groups_refuse_option_mixing_unknown_fields_and_unsupported_shapes() {
    for value in [
        // terms never carries histogram options
        json!({ "type": "terms", "name": "g", "field": "f", "size": "5", "interval": "fixed_interval" }),
        json!({ "type": "terms", "name": "g", "field": "f", "size": "5", "intervalValue": "1d", "timeZone": "" }),
        // histogram has no size option in this shape
        json!({ "type": "date_histogram", "name": "g", "field": "f", "interval": "fixed_interval",
            "intervalValue": "1d", "timeZone": "", "size": "5" }),
        // missing and unknown keys
        json!({ "type": "terms", "name": "g", "field": "f" }),
        json!({ "type": "terms", "name": "g", "field": "f", "size": "5", "order": "_count" }),
        json!({ "type": "date_histogram", "name": "g", "field": "f", "interval": "interval",
            "intervalValue": "1d", "timeZone": "" }),
        json!({ "type": "histogram", "name": "g", "field": "f", "size": "" }),
        // non-literal options
        json!({ "type": "terms", "name": "g", "field": "f", "size": 5 }),
        json!({ "type": "date_histogram", "name": "g", "field": "f", "interval": "fixed_interval",
            "intervalValue": 86_400_000, "timeZone": "" }),
    ] {
        let parsed = serde_json::from_value::<ChartGroup>(value.clone());
        assert!(parsed.is_err(), "accepted {value}");
    }
}

#[test]
fn group_literals_are_validated_with_the_builders_own_bounds() {
    let cases: Vec<(Value, bool)> = vec![
        (
            json!({ "type": "terms", "name": "g", "field": "f", "size": "" }),
            true,
        ),
        (
            json!({ "type": "terms", "name": "g", "field": "f", "size": "1" }),
            true,
        ),
        (
            json!({ "type": "terms", "name": "g", "field": "f", "size": "1000" }),
            true,
        ),
        (
            json!({ "type": "terms", "name": "g", "field": "f", "size": "0" }),
            false,
        ),
        (
            json!({ "type": "terms", "name": "g", "field": "f", "size": "05" }),
            false,
        ),
        (
            json!({ "type": "terms", "name": "g", "field": "f", "size": "1001" }),
            false,
        ),
        (
            json!({ "type": "terms", "name": "g", "field": "f", "size": "-1" }),
            false,
        ),
        (
            json!({ "type": "terms", "name": "g", "field": "f", "size": "1e2" }),
            false,
        ),
        (
            json!({ "type": "date_histogram", "name": "g", "field": "f", "interval": "calendar_interval",
                "intervalValue": "1M", "timeZone": "" }),
            true,
        ),
        (
            json!({ "type": "date_histogram", "name": "g", "field": "f", "interval": "fixed_interval",
                "intervalValue": "1d", "timeZone": "UTC" }),
            true,
        ),
        (
            json!({ "type": "date_histogram", "name": "g", "field": "f", "interval": "fixed_interval",
                "intervalValue": "", "timeZone": "" }),
            false,
        ),
        (
            json!({ "type": "date_histogram", "name": "g", "field": "f", "interval": "fixed_interval",
                "intervalValue": " 1d", "timeZone": "" }),
            false,
        ),
        (
            json!({ "type": "date_histogram", "name": "g", "field": "f", "interval": "fixed_interval",
                "intervalValue": "1d", "timeZone": " UTC" }),
            false,
        ),
        (
            json!({ "type": "date_histogram", "name": "g", "field": "f", "interval": "fixed_interval",
                "intervalValue": "1d", "timeZone": "Z".repeat(101) }),
            false,
        ),
        (
            json!({ "type": "date_histogram", "name": "g", "field": "f", "interval": "fixed_interval",
                "intervalValue": "1".repeat(65), "timeZone": "" }),
            false,
        ),
        (
            json!({ "type": "terms", "name": "g", "field": "", "size": "" }),
            false,
        ),
        (
            json!({ "type": "terms", "name": "", "field": "f", "size": "" }),
            false,
        ),
    ];
    for (value, expected) in cases {
        let group: ChartGroup = serde_json::from_value(value.clone())
            .unwrap_or_else(|error| panic!("shape rejected before validation: {error}"));
        assert_eq!(group.validate().is_ok(), expected, "case {value}");
    }
}

#[test]
fn measures_must_exist_in_the_definition_they_belong_to() {
    let metric = json!({ "name": "total", "type": "sum", "field": "bytes" });
    let terms = json!({ "type": "terms", "name": "by_host", "field": "host", "size": "" });
    let cases: Vec<(Value, String, bool)> = vec![
        (terms.clone(), "doc_count".into(), true),
        (terms.clone(), "total".into(), true),
        (terms.clone(), "absent".into(), false),
        (
            json!({ "type": "date_histogram", "name": "per_day", "field": "@timestamp",
                "interval": "fixed_interval", "intervalValue": "1d", "timeZone": "" }),
            "doc_count".into(),
            true,
        ),
        (Value::Null, "doc_count".into(), false),
        (Value::Null, "total".into(), true),
    ];
    for (group, measure, expected) in cases {
        let value = json!({
            "id": "chart-one", "name": "Shape", "connectionId": "connection-1", "index": "logs-*",
            "draft": { "group": group, "metrics": [metric] }, "measure": measure
        });
        let parsed = definition(value.clone());
        assert_eq!(parsed.validate().is_ok(), expected, "case {value}");
    }
    // An empty draft charts nothing at all and is never accepted.
    let empty = json!({
        "id": "chart-one", "name": "Shape", "connectionId": "connection-1", "index": "logs-*",
        "draft": { "group": Value::Null, "metrics": [] }, "measure": "doc_count"
    });
    assert_eq!(
        definition(empty).validate().unwrap_err().code,
        "invalidInput"
    );
}

#[test]
fn definitions_reject_moved_targets_unknown_metrics_and_duplicate_rows() {
    let cases: Vec<Value> = vec![
        json!({ "id": "", "name": "Shape", "connectionId": "connection-1", "index": "logs-*",
            "draft": { "group": Value::Null, "metrics": [{ "name": "total", "type": "sum", "field": "b" }] },
            "measure": "total" }),
        json!({ "id": "chart-one", "name": " Padded", "connectionId": "connection-1", "index": "logs-*",
            "draft": { "group": Value::Null, "metrics": [{ "name": "total", "type": "sum", "field": "b" }] },
            "measure": "total" }),
        json!({ "id": "chart-one", "name": "Line\nbreak", "connectionId": "connection-1", "index": "logs-*",
            "draft": { "group": Value::Null, "metrics": [{ "name": "total", "type": "sum", "field": "b" }] },
            "measure": "total" }),
        json!({ "id": "chart-one", "name": "Shape", "connectionId": "has space", "index": "logs-*",
            "draft": { "group": Value::Null, "metrics": [{ "name": "total", "type": "sum", "field": "b" }] },
            "measure": "total" }),
        // unknown aggregation types are not part of this shape
        json!({ "id": "chart-one", "name": "Shape", "connectionId": "connection-1", "index": "logs-*",
            "draft": { "group": Value::Null,
                "metrics": [{ "name": "p", "type": "percentiles", "field": "b" }] },
            "measure": "p" }),
        // duplicate row names would silently overwrite one definition in the built DSL
        json!({ "id": "chart-one", "name": "Shape", "connectionId": "connection-1", "index": "logs-*",
            "draft": { "group": Value::Null,
                "metrics": [{ "name": "total", "type": "sum", "field": "b" },
                            { "name": "total", "type": "avg", "field": "b" }] },
            "measure": "total" }),
        // an unbuildable group/metric mix inside one definition
        json!({ "id": "chart-one", "name": "Shape", "connectionId": "connection-1", "index": "logs-*",
            "draft": { "group": { "type": "terms", "name": "total", "field": "b", "size": "" },
                "metrics": [{ "name": "total", "type": "sum", "field": "b" }] },
            "measure": "total" }),
        // targets follow the index grammar, not arbitrary text
        json!({ "id": "chart-one", "name": "Shape", "connectionId": "connection-1", "index": "",
            "draft": { "group": Value::Null, "metrics": [{ "name": "total", "type": "sum", "field": "b" }] },
            "measure": "total" }),
        json!({ "id": "chart-one", "name": "Shape", "connectionId": "connection-1", "index": "../etc",
            "draft": { "group": Value::Null, "metrics": [{ "name": "total", "type": "sum", "field": "b" }] },
            "measure": "total" }),
    ];
    for value in cases {
        // Rejection is either a refused document (unknown type/field) or a failed validation;
        // both must refuse outright, never normalize the value into something storable.
        let rejected = match serde_json::from_value::<ChartDefinition>(value.clone()) {
            Err(_) => true,
            Ok(parsed) => parsed.validate().is_err(),
        };
        assert!(rejected, "accepted {value}");
    }
    // unknown fields are refused rather than silently dropped on the way in
    let extra = json!({ "id": "chart-one", "name": "Shape", "connectionId": "connection-1",
        "index": "logs-*", "draft": { "group": Value::Null,
            "metrics": [{ "name": "total", "type": "sum", "field": "b" }] },
        "measure": "total", "endpoint": "https://leak.test" });
    assert!(serde_json::from_value::<ChartDefinition>(extra).is_err());
}

#[test]
fn libraries_are_counted_identified_and_byte_bounded() {
    fixture().validate().unwrap();
    let mut wrong_version = fixture();
    wrong_version.version = 2;
    assert_eq!(wrong_version.validate().unwrap_err().code, "invalidInput");

    let mut duplicated = fixture();
    duplicated.entries[1].id = duplicated.entries[0].id.clone();
    assert_eq!(duplicated.validate().unwrap_err().code, "invalidInput");

    let mut oversized = fixture();
    let base = oversized.entries[0].clone();
    while oversized.entries.len() <= MAX_ENTRIES {
        oversized.entries.push(base.clone());
    }
    assert_eq!(oversized.validate().unwrap_err().code, "invalidInput");

    let mut crowded = fixture();
    // Longest legal literals inside the smallest legal entry count: only the byte cap can stop this.
    let wide = {
        let mut entry = crowded.entries[0].clone();
        entry.draft.metrics = (0..MAX_METRICS)
            .map(|index| ChartMetric {
                name: format!("m{index}{}", "n".repeat(900)),
                kind: MetricType::Sum,
                field: "f".repeat(900),
            })
            .collect();
        entry.measure = entry.draft.metrics[0].name.clone();
        entry
    };
    while crowded.entries.len() < MAX_ENTRIES {
        crowded.entries.push(wide.clone());
    }
    assert!(serde_json::to_string(&crowded).unwrap().len() > MAX_BYTES);
    assert!(crowded.entries.len() <= MAX_ENTRIES);
    assert_eq!(
        crowded.validate().unwrap_err().code,
        "invalidInput",
        "the byte cap must reject, never truncate"
    );
}

#[test]
fn dotted_fields_are_stored_as_literals_and_the_build_gate_refuses_them() {
    // The library judges shape, not mapping evidence: a dotted path stays exactly as typed and
    // surfaces as `fieldPath` when the definition is previewed through the aggregation builder.
    let value = json!({ "id": "chart-one", "name": "Shape", "connectionId": "connection-1", "index": "logs-*",
        "draft": { "group": Value::Null,
            "metrics": [{ "name": "total", "type": "sum", "field": "bytes.total" }] },
        "measure": "total" });
    let parsed = definition(value);
    parsed.validate().unwrap();
    assert_eq!(parsed.draft.metrics[0].field, "bytes.total");
    let rebuilt = serde_json::to_string(&parsed).unwrap();
    assert!(rebuilt.contains("\"field\":\"bytes.total\""));
}

#[test]
fn stored_documents_decode_strictly_and_are_never_repaired() {
    assert!(decode_stored("not json").is_err());
    assert!(decode_stored("{}").is_err());
    assert!(decode_stored("{\"version\":1,\"entries\":{}}").is_err());
    assert!(decode_stored(&json!({ "version": 2, "entries": [] }).to_string()).is_err());
    let mut tampered = fixture();
    tampered.entries[0].measure = "absent".into();
    assert!(decode_stored(&serde_json::to_string(&tampered).unwrap()).is_err());
    let leak = serde_json::to_string(&fixture()).unwrap() + ",{\"endpoint\":\"https://leak.test\"}";
    assert!(decode_stored(&leak).is_err());
    assert!(decode_stored(&format!("[{}]", "x".repeat(MAX_BYTES + 1))).is_err());
}

#[test]
fn empty_reads_never_insert_and_saved_definitions_survive_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("charts.sqlite");
    let mut database = Database::open(&path).unwrap();
    let empty = database.chart_definitions().unwrap();
    assert_eq!(empty.revision, 0);
    assert_eq!(empty.library, ChartDefinitionLibrary::empty());
    let raw = Connection::open(&path).unwrap();
    assert_eq!(
        raw.query_row("SELECT count(*) FROM chart_definition_library", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap(),
        0
    );
    drop(raw);
    let library = populated(&mut database);
    assert_eq!(database.save_chart_definitions(0, &library).unwrap(), 1);
    drop(database);
    let reopened = Database::open(&path).unwrap().chart_definitions().unwrap();
    assert_eq!(reopened.revision, 1);
    assert_eq!(reopened.library, library);
}

#[test]
fn writes_compare_revisions_and_never_change_an_existing_connection_owner() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("cas.sqlite");
    let mut first = Database::open(&path).unwrap();
    let mut second = Database::open(&path).unwrap();
    let library = populated(&mut first);
    first.save_chart_definitions(0, &library).unwrap();
    assert_eq!(
        second
            .save_chart_definitions(0, &ChartDefinitionLibrary::empty())
            .unwrap_err()
            .code,
        "chartDefinitionConflict"
    );
    let mut moved = library.clone();
    moved.entries[0].connection_id = "other-id".into();
    assert_eq!(
        second.save_chart_definitions(1, &moved).unwrap_err().code,
        "invalidInput"
    );
    assert_eq!(first.chart_definitions().unwrap().library, library);
    let mut renamed = library.clone();
    renamed.entries[0].name = "Updated".into();
    assert_eq!(second.save_chart_definitions(1, &renamed).unwrap(), 2);
    assert_eq!(
        first.save_chart_definitions(1, &library).unwrap_err().code,
        "chartDefinitionConflict"
    );
    assert_eq!(first.chart_definitions().unwrap().library, renamed);
}

#[test]
fn new_definitions_require_existing_ids_and_deleted_owners_are_retained() {
    let directory = tempfile::tempdir().unwrap();
    let mut database = Database::open(&directory.path().join("owners.sqlite")).unwrap();
    let library = populated(&mut database);
    database.save_chart_definitions(0, &library).unwrap();
    database
        .delete_connection(&library.entries[0].connection_id)
        .unwrap();
    // Deleting the connection keeps the definition and its historical ID; nothing rebinds.
    assert_eq!(database.chart_definitions().unwrap().library, library);
    let mut renamed = library.clone();
    renamed.entries[0].name = "Historical".into();
    assert_eq!(database.save_chart_definitions(1, &renamed).unwrap(), 2);
    let mut brand_new = renamed.clone();
    brand_new.entries[0].id = "chart-new".into();
    assert_eq!(
        database
            .save_chart_definitions(2, &brand_new)
            .unwrap_err()
            .code,
        "chartDefinitionConnectionMissing"
    );
    assert_eq!(database.chart_definitions().unwrap().library, renamed);
    assert_eq!(
        database
            .save_chart_definitions(2, &ChartDefinitionLibrary::empty())
            .unwrap(),
        3
    );
}

#[test]
fn invalid_counters_and_stored_rows_fail_closed_without_touching_the_library() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("bounds.sqlite");
    let mut database = Database::open(&path).unwrap();
    let library = populated(&mut database);
    assert_eq!(
        database
            .save_chart_definitions(MAX_REVISION, &library)
            .unwrap_err()
            .code,
        "invalidInput"
    );
    database.save_chart_definitions(0, &library).unwrap();
    // The row itself refuses an out-of-range counter, so a stored revision can never be 0 or overflow.
    let raw = Connection::open(&path).unwrap();
    for revision in ["0", "9007199254740992"] {
        assert!(raw
            .execute(
                &format!(
                    "UPDATE chart_definition_library SET revision={revision} WHERE singleton=1"
                ),
                [],
            )
            .is_err());
    }
    assert_eq!(
        raw.query_row(
            "SELECT revision FROM chart_definition_library WHERE singleton=1",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    raw.execute(
        "UPDATE chart_definition_library SET json='broken' WHERE singleton=1",
        [],
    )
    .unwrap();
    drop(raw);
    assert_eq!(
        database.chart_definitions().unwrap_err().code,
        "invalidResponse"
    );
    // A damaged row is never silently replaced, even with the revision the client last read.
    assert_eq!(
        database
            .save_chart_definitions(1, &library)
            .unwrap_err()
            .code,
        "invalidResponse"
    );
}

#[test]
fn drafts_keep_group_and_metric_identities_separately() {
    let terms = json!({ "type": "terms", "name": "by_host", "field": "host", "size": "" });
    let draft = draft_value(
        terms.clone(),
        vec![json!({ "name": "by_host", "type": "sum", "field": "bytes" })],
    );
    assert_eq!(draft.validate().unwrap_err().code, "invalidInput");
    let ok = draft_value(
        terms.clone(),
        vec![
            json!({ "name": "total", "type": "sum", "field": "bytes" }),
            json!({ "name": "distinct", "type": "cardinality", "field": "host" }),
        ],
    );
    ok.validate().unwrap();
    // The metric cap mirrors the reader's 32-definition limit.
    let many: Vec<Value> = (0..=MAX_METRICS)
        .map(|index| json!({ "name": format!("m{index}"), "type": "sum", "field": "bytes" }))
        .collect();
    assert_eq!(
        draft_value(terms.clone(), many.clone())
            .validate()
            .unwrap_err()
            .code,
        "invalidInput"
    );
    assert!(draft_value(terms, many[..MAX_METRICS].to_vec())
        .validate()
        .is_ok());
    let flat = draft_value(Value::Null, many[..MAX_METRICS].to_vec());
    flat.validate().unwrap();
    assert_eq!(
        draft_value(Value::Null, many).validate().unwrap_err().code,
        "invalidInput"
    );
}

#[test]
fn grouped_definitions_survive_a_full_store_and_reopen_cycle() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("grouped.sqlite");
    let mut database = Database::open(&path).unwrap();
    let library = grouped(populated(&mut database));
    assert_eq!(database.save_chart_definitions(0, &library).unwrap(), 1);
    drop(database);
    let reopened = Database::open(&path).unwrap().chart_definitions().unwrap();
    assert_eq!(reopened.library, library);
    let ChartGroup::Terms { size, .. } = reopened.library.entries[0].draft.group.clone().unwrap()
    else {
        panic!("group type changed through storage");
    };
    assert_eq!(size, "20");
}
