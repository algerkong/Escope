use super::*;
use crate::chart_definitions::{
    ChartDefinitionLibrary, ChartGroup, ChartMetric, MetricType, MAX_BYTES, MAX_ENTRIES,
    MAX_METRICS,
};
use crate::storage::ConnectionInput;
use rusqlite::Connection;
use serde_json::json;
use tempfile::TempDir;

const FIXTURE: &str = include_str!("../../../tests/fixtures/chart-definition-exchange-v1.json");

fn bundle() -> ChartDefinitionExchange {
    parse_text(FIXTURE).unwrap()
}

fn database() -> (TempDir, Database) {
    let directory = TempDir::new().unwrap();
    let database = Database::open(&directory.path().join("chart-exchange.sqlite")).unwrap();
    (directory, database)
}

#[derive(Clone)]
struct Local {
    id: String,
    endpoint: String,
}

fn local(database: &mut Database, endpoint: &str) -> Local {
    let profile = database
        .save_connection(
            ConnectionInput {
                display_name: "Local target".to_owned(),
                endpoint: endpoint.to_owned(),
                environment: "development".to_owned(),
            },
            None,
        )
        .unwrap()
        .profile;
    Local {
        id: profile.id,
        endpoint: profile.endpoint,
    }
}

fn mapping(source_key: &str, local: &Local) -> ChartConnectionMapping {
    ChartConnectionMapping {
        source_key: source_key.to_owned(),
        target: ChartMappingTarget {
            connection_id: local.id.clone(),
            endpoint: local.endpoint.clone(),
        },
    }
}

/// Both document sources mapped onto two real local connections, in bundle order.
fn mappings(first: &Local, second: &Local) -> Vec<ChartConnectionMapping> {
    vec![
        mapping("connection-1", first),
        mapping("connection-2", second),
    ]
}

fn request(
    bundle: ChartDefinitionExchange,
    mappings: Vec<ChartConnectionMapping>,
    expected_revision: u64,
) -> ChartExchangeImportRequest {
    ChartExchangeImportRequest {
        bundle,
        mappings,
        expected_revision,
    }
}

fn single(connection_id: &str, id: &str, name: &str) -> ChartDefinition {
    serde_json::from_value(json!({
        "id": id, "name": name, "connectionId": connection_id, "index": "logs-*",
        "draft": { "group": null, "metrics": [{ "name": "average", "type": "avg", "field": "bytes" }] },
        "measure": "average"
    }))
    .unwrap()
}

fn library(entries: Vec<ChartDefinition>) -> ChartDefinitionLibrary {
    ChartDefinitionLibrary {
        version: VERSION,
        entries,
    }
}

/// A definition whose literals are near the longest the stored rules allow, to reach the byte cap.
fn wide(connection_id: &str, id: &str) -> ChartDefinition {
    let mut entry = single(connection_id, id, "Wide");
    entry.draft.metrics = (0..MAX_METRICS)
        .map(|index| ChartMetric {
            name: format!("m{index}{}", "n".repeat(900)),
            kind: MetricType::Sum,
            field: "f".repeat(900),
        })
        .collect();
    entry.measure = entry.draft.metrics[0].name.clone();
    entry
}

/// The same body as the third fixture definition, but with the longest metrics the shape allows.
fn wide_document() -> ChartDefinitionExchange {
    let mut document = bundle();
    document.definitions.truncate(1);
    document.connections.truncate(1);
    let draft = &mut document.definitions[0].draft;
    draft.metrics = (0..MAX_METRICS)
        .map(|index| ChartMetric {
            name: format!("w{index}{}", "n".repeat(900)),
            kind: MetricType::Sum,
            field: "f".repeat(900),
        })
        .collect();
    document.definitions[0].measure = draft.metrics[0].name.clone();
    document.validate().unwrap();
    document
}

#[test]
fn shared_fixture_carries_definition_bodies_and_no_connection_or_query_data() {
    let bundle = bundle();
    assert_eq!(bundle.definitions.len(), 3);
    assert_eq!(bundle.connections.len(), 2);
    let serialized = serde_json::to_string(&bundle).unwrap();
    for key in [
        "\"intervalValue\":\"30d\"",
        "\"timeZone\":\"UTC\"",
        "\"type\":\"date_histogram\"",
        "\"measure\":\"doc_count\"",
        "\"group\":null",
        "\"field\":\"bytes.total\"",
        "实验室 观察",
    ] {
        assert!(serialized.contains(key), "missing {key}");
    }
    // No endpoint, real connection ID, DSL, results, history or credential reference can ride along.
    for absent in [
        "endpoint",
        "connectionId",
        "credentialRef",
        "dsl",
        "results",
        "Authorization",
        "https://",
        "PIT",
    ] {
        assert!(!serialized.contains(absent), "leaked {absent}");
    }
    let read_back = parse_text(&serialized).unwrap();
    assert_eq!(read_back.definitions, bundle.definitions);
    assert_eq!(read_back.connections, bundle.connections);
    // The debug form is a count summary, never a literal dump.
    assert!(!format!("{bundle:?}").contains("Latency per day"));
}

#[test]
fn versions_duplicate_keys_and_closed_shapes_are_refused() {
    assert_eq!(
        parse_text(&FIXTURE.replace("\"version\": 1", "\"version\": 2"))
            .unwrap_err()
            .code,
        "exchangeVersion"
    );
    for (index, bad) in [
        FIXTURE.replace("\"version\": 1", "\"version\": 1, \"version\": 1"),
        FIXTURE.replace("\"version\": 1", "\"version\": \"1\""),
        FIXTURE.replace("\"version\": 1", "\"version\": -1"),
        FIXTURE.replace("escope-chart-definitions", "escope-query-definitions"),
        // a chart document never carries a DSL, a result page or a time boundary
        FIXTURE.replace(
            "\"measure\": \"total\"",
            "\"measure\": \"total\", \"dsl\": {\"query\":{}}",
        ),
        FIXTURE.replace(
            "\"measure\": \"total\"",
            "\"measure\": \"total\", \"results\": []",
        ),
        FIXTURE.replace(
            "\"measure\": \"total\"",
            "\"measure\": \"total\", \"timeRange\": {\"from\":\"now-1d\"}",
        ),
        FIXTURE.replace(
            "\"measure\": \"total\"",
            "\"measure\": \"total\", \"fieldCaps\": []",
        ),
        FIXTURE.replace(
            "\"connectionKey\": \"connection-1\"",
            "\"connectionKey\": null",
        ),
        FIXTURE.replace(
            "\"connectionKey\": \"connection-1\"",
            "\"connectionKey\": \"\"",
        ),
        // literals stay literal: size is never a JSON number, types are never invented
        FIXTURE.replace("\"size\": \"20\"", "\"size\": 20"),
        FIXTURE.replace("\"type\": \"sum\"", "\"type\": \"percentiles\""),
        // a terms group never carries histogram options
        FIXTURE.replace(
            "\"size\": \"20\"",
            "\"size\": \"20\", \"timeZone\": \"UTC\"",
        ),
        format!("{FIXTURE}garbage"),
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(
            parse_text(&bad).unwrap_err().code,
            "exchangeInvalid",
            "case {index}: {}",
            &bad[..bad.len().min(240)]
        );
    }
}

#[test]
fn sensitive_keys_and_authentication_literals_are_refused_at_every_depth() {
    for key in [
        "credentialRef",
        "authorization",
        "api-key",
        "password",
        "headers",
        "auth",
    ] {
        let bad = FIXTURE.replace(
            "\"measure\": \"doc_count\"",
            &format!("\"measure\": \"doc_count\", \"{key}\": \"fixture\""),
        );
        assert_eq!(
            parse_text(&bad).unwrap_err().code,
            "exchangeSensitive",
            "key {key}"
        );
    }
    for literal in [
        "Bearer fixture-only",
        "Authorization: fixture-only",
        "-----BEGIN RSA PRIVATE KEY-----",
        "credential:fixture",
    ] {
        for slot in [
            FIXTURE.replace("\"name\": \"Top hosts\"", &format!("\"name\": {literal:?}")),
            FIXTURE.replace("\"index\": \"events\"", &format!("\"index\": {literal:?}")),
            FIXTURE.replace(
                "\"measure\": \"doc_count\"",
                &format!("\"measure\": {literal:?}"),
            ),
            FIXTURE.replace("\"field\": \"host\"", &format!("\"field\": {literal:?}")),
            FIXTURE.replace(
                "\"label\": \"Fixture source\"",
                &format!("\"label\": {literal:?}"),
            ),
        ] {
            assert_eq!(
                parse_text(&slot).unwrap_err().code,
                "exchangeSensitive",
                "literal {literal}"
            );
            // A typed IPC request skips the text reader, so validation scans it too.
            let typed: ChartDefinitionExchange =
                serde_json::from_str(&slot).unwrap_or_else(|error| panic!("{error}"));
            assert_eq!(typed.validate().unwrap_err().code, "exchangeSensitive");
        }
    }
}

#[test]
fn bundles_are_checked_with_the_stored_definition_rules() {
    let cases: Vec<Box<dyn Fn(&mut ChartDefinitionExchange)>> = vec![
        // a measure that is not part of its own definition
        Box::new(|bundle| bundle.definitions[0].measure = "absent".to_owned()),
        // a definition with neither a group nor a metric charts nothing
        Box::new(|bundle| {
            bundle.definitions[2].draft.group = None;
            bundle.definitions[2].draft.metrics.clear();
        }),
        // size stays a literal token inside 1..=1000
        Box::new(|bundle| {
            bundle.definitions[1].draft.group = Some(ChartGroup::Terms {
                name: "by_host".to_owned(),
                field: "host".to_owned(),
                size: "0".to_owned(),
            });
        }),
        // metric names inside one definition must stay distinct
        Box::new(|bundle| {
            bundle.definitions[0].draft.metrics.push(ChartMetric {
                name: "total".to_owned(),
                kind: MetricType::Avg,
                field: "bytes".to_owned(),
            });
        }),
        // names and targets are trimmed display literals, never padded or multiline text
        Box::new(|bundle| bundle.definitions[0].name = " Padded".to_owned()),
        Box::new(|bundle| bundle.definitions[0].name = "Line\nbreak".to_owned()),
        // a target follows the index grammar, not arbitrary text
        Box::new(|bundle| bundle.definitions[0].index = "../etc".to_owned()),
        Box::new(|bundle| bundle.definitions[0].index = String::new()),
    ];
    for case in cases {
        let mut changed = bundle();
        case(&mut changed);
        assert_eq!(changed.validate().unwrap_err().code, "exchangeInvalid");
    }
    // The same body rules apply to a document that arrives typed over IPC.
    bundle().validate().unwrap();
}

#[test]
fn every_source_must_be_used_and_known_and_definitions_are_counted() {
    let mut unused = bundle();
    unused
        .definitions
        .retain(|definition| definition.connection_key != "connection-2");
    assert_eq!(unused.validate().unwrap_err().code, "exchangeInvalid");
    let mut unknown = bundle();
    unknown.definitions[0].connection_key = "connection-9".to_owned();
    assert_eq!(unknown.validate().unwrap_err().code, "exchangeInvalid");
    let mut duplicated = bundle();
    duplicated.definitions[1].key = duplicated.definitions[0].key.clone();
    assert_eq!(duplicated.validate().unwrap_err().code, "exchangeInvalid");
    let mut empty = bundle();
    empty.definitions.clear();
    assert_eq!(empty.validate().unwrap_err().code, "exchangeInvalid");
    let mut anonymous = bundle();
    anonymous.connections.remove(1);
    assert_eq!(anonymous.validate().unwrap_err().code, "exchangeInvalid");
    let mut nameless = bundle();
    nameless.connections[1].label = String::new();
    assert_eq!(nameless.validate().unwrap_err().code, "exchangeInvalid");
    let mut crowded = bundle();
    let base = crowded.definitions[1].clone();
    while crowded.definitions.len() <= MAX_ENTRIES {
        let mut extra = base.clone();
        extra.key = format!("chart-{}", crowded.definitions.len() + 1);
        crowded.definitions.push(extra);
    }
    assert_eq!(crowded.validate().unwrap_err().code, "exchangeTooLarge");
}

#[test]
fn an_import_never_offers_an_unbound_chart_definition() {
    // A stored definition carries its connection ID, so an unbound import is refused on the wire
    // instead of quietly creating a definition no tab can ever reuse.
    for value in [
        json!({ "sourceKey": "connection-1", "target": null }),
        json!({ "sourceKey": "connection-1" }),
        json!({ "sourceKey": "connection-1", "target": { "connectionId": "11111111-1111-4111-8111-111111111111" } }),
        json!({ "sourceKey": "connection-1", "target": { "connectionId": "11111111-1111-4111-8111-111111111111", "endpoint": "https://local.test", "credentialRef": "x" } }),
    ] {
        assert!(serde_json::from_value::<ChartConnectionMapping>(value).is_err());
    }
    // A syntactically shaped target is still refused by the import: the local id grammar is checked,
    // and an unknown or malformed connection never silently becomes a binding.
    let (_directory, mut database) = database();
    let first = local(&mut database, "https://one.test");
    let second = local(&mut database, "https://two.test");
    let stored = database.chart_definitions().unwrap();
    let malformed = ChartConnectionMapping {
        source_key: "connection-1".to_owned(),
        target: ChartMappingTarget {
            connection_id: "has space".to_owned(),
            endpoint: "https://one.test".to_owned(),
        },
    };
    assert_eq!(
        import_bundle(
            &mut database,
            request(
                bundle(),
                vec![malformed, mapping("connection-2", &second)],
                stored.revision
            )
        )
        .unwrap_err()
        .code,
        "exchangeMappingRequired"
    );
    assert_eq!(
        import_bundle(
            &mut database,
            request(
                bundle(),
                vec![
                    mapping("connection-1", &first),
                    mapping("connection-2", &second)
                ],
                4
            )
        )
        .unwrap_err()
        .code,
        "chartDefinitionConflict"
    );
    assert_eq!(
        database.chart_definitions().unwrap().library,
        stored.library
    );
}

#[test]
fn incomplete_or_duplicate_mappings_are_refused_without_writing() {
    let (_directory, mut database) = database();
    let first = local(&mut database, "https://one.test");
    let second = local(&mut database, "https://two.test");
    let stored = database.chart_definitions().unwrap();
    for refused in [
        vec![],
        vec![mapping("connection-1", &first)],
        vec![
            mapping("connection-1", &first),
            mapping("connection-1", &second),
        ],
        vec![
            mapping("connection-9", &first),
            mapping("connection-2", &second),
        ],
        vec![
            mapping("connection-2", &first),
            mapping("connection-2", &second),
        ],
    ] {
        let error =
            import_bundle(&mut database, request(bundle(), refused, stored.revision)).unwrap_err();
        assert_eq!(error.code, "exchangeMappingRequired");
        assert_eq!(
            database.chart_definitions().unwrap().library,
            stored.library
        );
    }
}

#[test]
fn mapped_connections_are_rechecked_in_the_write_transaction() {
    let (_directory, mut database) = database();
    let first = local(&mut database, "https://one.test");
    let second = local(&mut database, "https://two.test");
    let stored = database.chart_definitions().unwrap();
    // The endpoint moved under a connection ID that still exists.
    database
        .save_connection(
            ConnectionInput {
                display_name: "Moved".to_owned(),
                endpoint: "https://moved.test".to_owned(),
                environment: "development".to_owned(),
            },
            Some(first.id.clone()),
        )
        .unwrap();
    assert_eq!(
        import_bundle(
            &mut database,
            request(bundle(), mappings(&first, &second), stored.revision)
        )
        .unwrap_err()
        .code,
        "exchangeTargetChanged"
    );
    assert_eq!(
        database.chart_definitions().unwrap().library,
        stored.library
    );
    // The connection was removed altogether: the review is stale, not silently rebound.
    database
        .run_sql_for_test(&format!("DELETE FROM connections WHERE id='{}'", second.id))
        .unwrap();
    let current = Local {
        id: first.id.clone(),
        endpoint: "https://moved.test".to_owned(),
    };
    assert_eq!(
        import_bundle(
            &mut database,
            request(bundle(), mappings(&current, &second), stored.revision)
        )
        .unwrap_err()
        .code,
        "exchangeTargetChanged"
    );
    assert_eq!(
        database.chart_definitions().unwrap().library,
        stored.library
    );
    // A revision the reviewer no longer holds conflicts before any connection is consulted.
    assert_eq!(
        import_bundle(
            &mut database,
            request(bundle(), mappings(&current, &current), 99)
        )
        .unwrap_err()
        .code,
        "chartDefinitionConflict"
    );
    assert_eq!(
        database.chart_definitions().unwrap().library,
        stored.library
    );
}

#[test]
fn import_appends_fresh_ids_once_and_never_rewrites_an_existing_definition() {
    let (directory, mut database) = database();
    let first = local(&mut database, "https://one.test");
    let second = local(&mut database, "https://two.test");
    // A definition the reviewer already stores, whose name the bundle repeats on purpose.
    let kept = single(&first.id, "chart-kept", "Latency per day");
    database
        .save_chart_definitions(0, &library(vec![kept.clone()]))
        .unwrap();
    let record = import_bundle(
        &mut database,
        request(bundle(), mappings(&first, &second), 1),
    )
    .unwrap();
    assert_eq!(record.revision, 2);
    assert_eq!(record.library.entries.len(), 4);
    assert_eq!(record.library.entries[0], kept);
    let source = bundle();
    for (index, entry) in record.library.entries[1..].iter().enumerate() {
        let definition = &source.definitions[index];
        assert_ne!(entry.id, definition.key);
        assert_eq!(entry.name, definition.name);
        assert_eq!(entry.index, definition.index);
        assert_eq!(entry.measure, definition.measure);
        assert_eq!(entry.draft, definition.draft);
    }
    let ids: HashSet<&str> = record
        .library
        .entries
        .iter()
        .map(|entry| entry.id.as_str())
        .collect();
    assert_eq!(ids.len(), 4, "every imported definition gets a fresh id");
    assert_eq!(record.library.entries[1].connection_id, first.id);
    assert_eq!(record.library.entries[2].connection_id, second.id);
    assert_eq!(record.library.entries[3].connection_id, first.id);
    assert_eq!(
        database.chart_definitions().unwrap().library,
        record.library
    );
    // Exactly one store is written: no recovery, query library or execution side effects.
    assert!(database.workspace_recovery_row().unwrap().is_none());
    assert!(database.saved_queries_json().unwrap().is_none());
    let path = directory.path().join("chart-exchange.sqlite");
    drop(database);
    let reopened = Database::open(&path).unwrap();
    assert_eq!(reopened.chart_definitions().unwrap().revision, 2);
    assert_eq!(
        reopened.chart_definitions().unwrap().library,
        record.library
    );
}

#[test]
fn repeated_import_after_a_reload_appends_again_without_touching_the_first_batch() {
    let (_directory, mut database) = database();
    let first = local(&mut database, "https://one.test");
    let second = local(&mut database, "https://two.test");
    let imported = import_bundle(
        &mut database,
        request(bundle(), mappings(&first, &second), 0),
    )
    .unwrap();
    assert_eq!(imported.revision, 1);
    // Reviewing the same document against the revision it already replaced never double-writes.
    assert_eq!(
        import_bundle(
            &mut database,
            request(bundle(), mappings(&first, &second), 0)
        )
        .unwrap_err()
        .code,
        "chartDefinitionConflict"
    );
    assert_eq!(
        database.chart_definitions().unwrap().library,
        imported.library
    );
    let again = import_bundle(
        &mut database,
        request(bundle(), mappings(&first, &second), imported.revision),
    )
    .unwrap();
    assert_eq!(again.revision, 2);
    assert_eq!(again.library.entries.len(), 6);
    assert_eq!(
        &again.library.entries[..3],
        imported.library.entries.as_slice()
    );
    let ids: HashSet<&str> = again
        .library
        .entries
        .iter()
        .map(|entry| entry.id.as_str())
        .collect();
    assert_eq!(ids.len(), 6);
}

#[test]
fn a_combined_library_over_the_cap_is_refused_without_a_partial_append() {
    let (_directory, mut database) = database();
    let first = local(&mut database, "https://one.test");
    let second = local(&mut database, "https://two.test");
    // Count cap: ninety-nine stored definitions plus a three-definition document.
    let kept = (0..MAX_ENTRIES - 1)
        .map(|index| single(&first.id, &format!("chart-{index}"), "Kept"))
        .collect::<Vec<_>>();
    database.save_chart_definitions(0, &library(kept)).unwrap();
    let stored = database.chart_definitions().unwrap();
    assert_eq!(stored.library.entries.len(), MAX_ENTRIES - 1);
    assert_eq!(
        import_bundle(
            &mut database,
            request(bundle(), mappings(&first, &second), stored.revision)
        )
        .unwrap_err()
        .code,
        "exchangeTooLarge"
    );
    assert_eq!(
        database.chart_definitions().unwrap().library,
        stored.library
    );

    // Byte cap: a document inside the exchange limit that no longer fits the 256 KiB library.
    let crowded = (0..4)
        .map(|index| wide(&first.id, &format!("chart-wide-{index}")))
        .collect::<Vec<_>>();
    database
        .save_chart_definitions(1, &library(crowded))
        .unwrap();
    let wide_stored = database.chart_definitions().unwrap();
    let stored_bytes = serde_json::to_string(&wide_stored.library).unwrap().len();
    let document = wide_document();
    let document_bytes = serde_json::to_string(&document.definitions[0])
        .unwrap()
        .len();
    assert!(
        stored_bytes < MAX_BYTES,
        "the stored library still fits: {stored_bytes}"
    );
    assert!(
        document_bytes < MAX_BUNDLE_BYTES,
        "the document fits its own limit: {document_bytes}"
    );
    assert!(
        stored_bytes + document_bytes > MAX_BYTES,
        "the fixture no longer reaches the library cap: {stored_bytes} + {document_bytes}"
    );
    assert_eq!(
        import_bundle(
            &mut database,
            request(
                document,
                vec![mapping("connection-1", &first)],
                wide_stored.revision
            )
        )
        .unwrap_err()
        .code,
        "exchangeTooLarge"
    );
    assert_eq!(
        database.chart_definitions().unwrap().library,
        wide_stored.library
    );
}

#[test]
fn a_damaged_or_future_stored_library_is_never_repaired_by_an_import() {
    let (directory, mut database) = database();
    let first = local(&mut database, "https://one.test");
    let second = local(&mut database, "https://two.test");
    let path = directory.path().join("chart-exchange.sqlite");
    database
        .save_chart_definitions(0, &library(vec![single(&first.id, "chart-kept", "Kept")]))
        .unwrap();
    for raw in [
        "damaged",
        r#"{"version":2,"entries":[]}"#,
        r#"{"version":1,"entries":[],"endpoint":"https://leak.test"}"#,
    ] {
        let writer = Connection::open(&path).unwrap();
        writer
            .execute(
                "UPDATE chart_definition_library SET json=?1 WHERE singleton=1",
                [raw],
            )
            .unwrap();
        drop(writer);
        assert_eq!(
            import_bundle(
                &mut database,
                request(bundle(), mappings(&first, &second), 1)
            )
            .unwrap_err()
            .code,
            "invalidResponse"
        );
        let stored = Connection::open(&path)
            .unwrap()
            .query_row(
                "SELECT json FROM chart_definition_library WHERE singleton=1",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        assert_eq!(stored, raw, "a damaged row is never rewritten");
    }
}

#[test]
fn file_limits_and_encoding_fail_before_any_definition_is_read() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("definitions.json");
    std::fs::write(&path, FIXTURE).unwrap();
    assert_eq!(read_file(&path).unwrap().definitions.len(), 3);
    std::fs::write(&path, [0xff, 0xfe]).unwrap();
    assert_eq!(read_file(&path).unwrap_err().code, "exchangeInvalid");
    std::fs::write(&path, vec![b' '; MAX_BUNDLE_BYTES + 1]).unwrap();
    assert_eq!(read_file(&path).unwrap_err().code, "exchangeTooLarge");
    assert_eq!(
        read_file(&directory.path().join("missing"))
            .unwrap_err()
            .code,
        "importFailed"
    );
    assert_eq!(
        read_file(directory.path()).unwrap_err().code,
        "importFailed"
    );
}

#[test]
fn a_written_bundle_round_trips_without_normalizing_literals() {
    let good = bundle();
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("escope-chart-definitions.json");
    write_atomically(&path, &serde_json::to_vec(&good).unwrap()).unwrap();
    let read = read_file(&path).unwrap();
    assert_eq!(read.definitions, good.definitions);
    assert_eq!(read.connections, good.connections);
    // `size` stays the typed token: never a number, never a reformatted value.
    assert!(serde_json::to_string(&read)
        .unwrap()
        .contains("\"size\":\"20\""));
    // An atomic replace leaves no half-written temporary sibling behind.
    let leftovers: Vec<String> = std::fs::read_dir(directory.path())
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.starts_with('.') && name.contains(".tmp-"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "temporary files left behind: {leftovers:?}"
    );
}
