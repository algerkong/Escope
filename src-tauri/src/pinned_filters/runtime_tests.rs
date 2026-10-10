use super::*;
use crate::runtime_fields::{RuntimeScript, RuntimeType};
use crate::storage::{ConnectionInput, Database};
use rusqlite::Connection;
use serde_json::json;

fn fixture() -> PinnedFilterLibrary {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/pinned-filters-v3.json"
    ))
    .unwrap()
}

fn owned(database: &mut Database) -> PinnedFilterLibrary {
    let connection = database
        .save_connection(
            ConnectionInput {
                display_name: "Runtime fixture".into(),
                endpoint: "https://fixture.test".into(),
                environment: "development".into(),
            },
            None,
        )
        .unwrap()
        .profile;
    let mut library = fixture();
    library.entries[0].connection_id = connection.id;
    library
}

fn one() -> PinnedFilterLibrary {
    let mut library = fixture();
    let entry = &mut library.entries[0];
    entry.filters.truncate(1);
    entry.composition = Composition {
        mode: Join::All,
        groups: vec![FilterGroup {
            id: "g".into(),
            mode: Join::All,
            filter_ids: vec!["n".into()],
            nested: None,
        }],
    };
    library
}

#[test]
fn all_versions_round_trip_without_losing_declaration_source_language_or_literal_tokens() {
    for raw in [
        include_str!("../../../tests/fixtures/pinned-filters-v1.json"),
        include_str!("../../../tests/fixtures/pinned-filters-v2.json"),
        include_str!("../../../tests/fixtures/pinned-filters-v3.json"),
    ] {
        assert_eq!(
            serde_json::to_value(decode_stored(raw).unwrap()).unwrap(),
            serde_json::from_str::<Value>(raw).unwrap()
        );
    }
    let mut library = fixture();
    assert_eq!(
        library.entries[0].filters[0].value.0.as_deref(),
        Some("9007199254740995")
    );
    assert_eq!(
        library.entries[0].filters[1].value.0.as_deref(),
        Some(r#""r\u0065ady""#)
    );
    let script = library.entries[0].filters[2]
        .runtime_mapping
        .as_ref()
        .unwrap()
        .script
        .as_ref()
        .unwrap();
    assert_eq!(script.source, "double n = 1.23e-8;\n\temit(n);");
    assert_eq!(
        script.lang,
        Some(crate::runtime_fields::RuntimeLanguage::Painless)
    );
    assert!(!library.entries[0].filters[6].enabled);
    for version in [0, 1, 2, 4] {
        library.version = version;
        assert!(library.validate().is_err(), "{version}");
    }
    assert!(!format!("{:?}", fixture()).contains("emit("));
}

#[test]
fn runtime_shape_and_options_fail_closed_even_when_the_leaf_is_disabled() {
    let base = serde_json::to_value(one()).unwrap();
    for mapping in [
        Value::Null,
        json!({}),
        json!([]),
        json!({"type":"long","extra":true}),
        json!({"type":"date_nanos"}),
        json!({"type":"lookup"}),
        json!({"type":"composite"}),
        json!({"type":"unsigned_long"}),
        json!({"type":"long","on_script_error":"continue"}),
        json!({"type":"long","script":null}),
        json!({"type":"long","script":"emit(1);"}),
        json!({"type":"long","script":{"id":"stored"}}),
        json!({"type":"long","script":{"source":"emit(1);","params":{}}}),
        json!({"type":"long","script":{"source":"emit(1);","options":{}}}),
        json!({"type":"long","script":{"source":"emit(1);","lang":null}}),
        json!({"type":"long","script":{"source":"emit(1);","lang":"expression"}}),
        json!({"type":"long","script":{"source":" "}}),
        json!({"type":"long","script":{"source":"emit(1);\u{0000}"}}),
        json!({"type":"long","script":{"source":"x".repeat(4097)}}),
        json!({"type":"long","script":{"source":"\u{00e9}".repeat(2049)}}),
    ] {
        let mut value = base.clone();
        value["entries"][0]["filters"][0]["enabled"] = json!(false);
        value["entries"][0]["filters"][0]["runtimeMapping"] = mapping;
        assert!(decode_stored(&value.to_string()).is_err());
    }
    let raw = serde_json::to_string(&one()).unwrap();
    for declaration in [
        r#""runtimeMapping":{"type":"long","type":"long","script":{"source":"emit(1);"}}}"#,
        r#""runtimeMapping":{"type":"long","\u0074ype":"long"}}"#,
        r#""runtimeMapping":{"type":"long","script":{"source":"emit(1);","source":"emit(1);"}}}"#,
        r#""runtimeMapping":{"type":"long","script":{"source":"emit(1);","lang":"painless","lang":"painless"}}}"#,
    ] {
        let malformed = raw.replace(
            r#""runtimeMapping":{"type":"long","script":{"source":"emit(9007199254740995L);"}}}"#,
            declaration,
        );
        assert_ne!(malformed, raw);
        assert!(decode_stored(&malformed).is_err());
    }
}

#[test]
fn runtime_fields_remain_flat_type_consistent_and_presence_only_for_non_scalar_families() {
    let base = serde_json::to_value(one()).unwrap();
    for patch in [
        json!({"fieldType":"keyword"}),
        json!({"field":"comments.n","nestedPath":"comments"}),
        json!({"field":"a.b"}),
        json!({"field":"$param"}),
        json!({"origin":"fields"}),
        json!({"evidence":"runtime"}),
        json!({"nestedPath":null}),
    ] {
        let mut changed = base.clone();
        changed["entries"][0]["filters"][0]
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        assert!(decode_stored(&changed.to_string()).is_err());
    }
    for kind in [RuntimeType::Date, RuntimeType::Ip, RuntimeType::GeoPoint] {
        let mut library = one();
        let filter = &mut library.entries[0].filters[0];
        filter.field_type = kind.as_str().into();
        filter.runtime_mapping = Some(RuntimeMapping {
            field_type: kind,
            script: None,
        });
        filter.operation = FilterOperation::Exists;
        filter.value = Nullable(None);
        library.validate().unwrap();
        library.entries[0].filters[0].operation = FilterOperation::Include;
        library.entries[0].filters[0].value = Nullable(Some(r#""value""#.into()));
        assert!(library.validate().is_err());
    }
    let mut library = one();
    let mut duplicate = library.entries[0].filters[0].clone();
    duplicate.id = "other".into();
    duplicate.operation = FilterOperation::Exclude;
    duplicate.enabled = false;
    library.entries[0].filters.push(duplicate);
    library.entries[0].composition.groups[0]
        .filter_ids
        .push("other".into());
    library.validate().unwrap();
    library.entries[0].filters[1]
        .runtime_mapping
        .as_mut()
        .unwrap()
        .script = None;
    assert!(library.validate().is_err());
    library.entries[0].filters[1].runtime_mapping = None;
    assert!(library.validate().is_err());
}

#[test]
fn original_count_value_script_and_aggregate_bytes_remain_bounded() {
    let many = |count: usize, source: &str| {
        let mut library = one();
        let template = library.entries[0].filters[0].clone();
        let entry = &mut library.entries[0];
        entry.filters = (0..count)
            .map(|i| PinnedFilter {
                id: format!("f{i}"),
                field: format!("f{i}"),
                enabled: false,
                runtime_mapping: Some(RuntimeMapping {
                    field_type: RuntimeType::Long,
                    script: Some(RuntimeScript {
                        source: source.into(),
                        lang: None,
                    }),
                }),
                ..template.clone()
            })
            .collect();
        entry.composition.groups[0].filter_ids =
            entry.filters.iter().map(|f| f.id.clone()).collect();
        library
    };
    many(32, "emit(1);").validate().unwrap();
    assert!(many(33, "emit(1);").validate().is_err());
    let source = format!("emit(1);{}", " ".repeat(4088));
    many(15, &source).validate().unwrap();
    assert!(many(16, &source).validate().is_err());
    assert!(many(1, &format!("{source} ")).validate().is_err());
    let mut library = one();
    library.entries[0].filters[0].value = Nullable(Some("9".repeat(4097)));
    assert!(library.validate().is_err());
    let mut library = one();
    library.entries[0].composition.groups =
        vec![library.entries[0].composition.groups[0].clone(); 9];
    assert!(library.validate().is_err());
    let mut library = one();
    let entry = library.entries[0].clone();
    library.entries = (0..100)
        .map(|i| PinnedFilterDefinition {
            id: format!("s{i}"),
            ..entry.clone()
        })
        .collect();
    library.validate().unwrap();
    library.entries.push(PinnedFilterDefinition {
        id: "extra".into(),
        ..entry
    });
    assert!(library.validate().is_err());
    let large = many(2, &source).entries.remove(0);
    library.entries = (0..100)
        .map(|i| PinnedFilterDefinition {
            id: format!("s{i}"),
            ..large.clone()
        })
        .collect();
    assert!(serde_json::to_vec(&library).unwrap().len() > MAX_BYTES);
    assert!(library.validate().is_err());
}

#[test]
fn legacy_reads_retain_original_json_then_explicit_v3_addition_preserves_every_old_definition() {
    for legacy_raw in [
        include_str!("../../../tests/fixtures/pinned-filters-v1.json"),
        include_str!("../../../tests/fixtures/pinned-filters-v2.json"),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("upgrade.sqlite");
        let mut database = Database::open(&path).unwrap();
        let runtime = owned(&mut database);
        let mut legacy = decode_stored(legacy_raw).unwrap();
        legacy.entries[0].connection_id = runtime.entries[0].connection_id.clone();
        database.save_pinned_filters(0, &legacy).unwrap();
        let original = serde_json::to_string_pretty(&legacy).unwrap();
        let raw = Connection::open(&path).unwrap();
        raw.execute("UPDATE pinned_filter_library SET json=?1", [&original])
            .unwrap();
        drop(database);
        let mut database = Database::open(&path).unwrap();
        assert_eq!(database.pinned_filters().unwrap().library, legacy);
        assert_eq!(
            raw.query_row("SELECT json FROM pinned_filter_library", [], |row| row
                .get::<_, String>(
                0
            ))
            .unwrap(),
            original
        );
        let mut upgraded = runtime;
        upgraded.entries.insert(0, legacy.entries[0].clone());
        assert_eq!(database.save_pinned_filters(1, &upgraded).unwrap(), 2);
        drop(database);
        let mut database = Database::open(&path).unwrap();
        assert_eq!(database.pinned_filters().unwrap().library, upgraded);
        for version in [1, 2] {
            assert_eq!(
                database
                    .save_pinned_filters(
                        2,
                        &PinnedFilterLibrary {
                            version,
                            entries: vec![]
                        }
                    )
                    .unwrap_err()
                    .code,
                "invalidInput"
            );
        }
        assert_eq!(
            database.save_pinned_filters(1, &upgraded).unwrap_err().code,
            "pinnedFilterConflict"
        );
        assert_eq!(
            database.pinned_filters().unwrap().library.entries[0],
            legacy.entries[0]
        );
    }
}

#[test]
fn script_language_literals_and_binding_targets_cannot_be_overwritten_and_deleted_connections_never_rebind(
) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("immutable.sqlite");
    let mut database = Database::open(&path).unwrap();
    let library = owned(&mut database);
    database.save_pinned_filters(0, &library).unwrap();
    let mut second = Database::open(&path).unwrap();
    for field in ["source", "lang", "enabled", "value", "index"] {
        let mut changed = library.clone();
        let filter = &mut changed.entries[0].filters[0];
        match field {
            "source" => {
                filter
                    .runtime_mapping
                    .as_mut()
                    .unwrap()
                    .script
                    .as_mut()
                    .unwrap()
                    .source = "emit(1);".into()
            }
            "lang" => {
                filter
                    .runtime_mapping
                    .as_mut()
                    .unwrap()
                    .script
                    .as_mut()
                    .unwrap()
                    .lang = Some(crate::runtime_fields::RuntimeLanguage::Painless)
            }
            "enabled" => filter.enabled = false,
            "value" => filter.value = Nullable(Some("1".into())),
            _ => changed.entries[0].index = "other".into(),
        }
        changed.validate().unwrap();
        assert_eq!(
            second.save_pinned_filters(1, &changed).unwrap_err().code,
            "invalidInput"
        );
    }
    assert_eq!(database.pinned_filters().unwrap().library, library);
    database
        .delete_connection(&library.entries[0].connection_id)
        .unwrap();
    assert_eq!(database.save_pinned_filters(1, &library).unwrap(), 2);
    let mut copy = library.clone();
    copy.entries[0].id = "new".into();
    assert_eq!(
        database.save_pinned_filters(2, &copy).unwrap_err().code,
        "pinnedFilterConnectionMissing"
    );
    assert_eq!(
        second
            .save_pinned_filters(1, &PinnedFilterLibrary::empty())
            .unwrap_err()
            .code,
        "pinnedFilterConflict"
    );
    database
        .save_pinned_filters(2, &PinnedFilterLibrary::empty())
        .unwrap();
    assert_eq!(
        second.pinned_filters().unwrap().library,
        PinnedFilterLibrary::empty()
    );
}

#[test]
fn corrupted_runtime_storage_and_future_versions_are_never_overwritten_by_a_matching_revision() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("damaged.sqlite");
    let mut database = Database::open(&path).unwrap();
    let library = owned(&mut database);
    database.save_pinned_filters(0, &library).unwrap();
    let raw = Connection::open(&path).unwrap();
    let mut malformed = serde_json::to_value(&library).unwrap();
    malformed["entries"][0]["filters"][0]["runtimeMapping"] = Value::Null;
    for invalid in [
        r#"{"version":4,"entries":[]}"#.to_owned(),
        malformed.to_string(),
        "invalid".into(),
    ] {
        raw.execute("UPDATE pinned_filter_library SET json=?1", [&invalid])
            .unwrap();
        assert_eq!(
            database.pinned_filters().unwrap_err().code,
            "invalidResponse"
        );
        assert_eq!(
            database.save_pinned_filters(1, &library).unwrap_err().code,
            "invalidResponse"
        );
        assert_eq!(
            raw.query_row("SELECT json FROM pinned_filter_library", [], |row| row
                .get::<_, String>(
                0
            ))
            .unwrap(),
            invalid
        );
    }
}
