use super::*;
use crate::storage::ConnectionInput;
use rusqlite::Connection;
use serde_json::{json, Value};

fn fixture() -> DataViewLibrary {
    serde_json::from_str(include_str!("../../../tests/fixtures/data-views-v1.json")).unwrap()
}

fn formatted_fixture() -> DataViewLibrary {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/data-view-field-formats-v1.json"
    ))
    .unwrap()
}

fn runtime_fixture() -> DataViewLibrary {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/data-view-runtime-fields-v1.json"
    ))
    .unwrap()
}

fn populated(database: &mut Database) -> DataViewLibrary {
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
    library.entries.truncate(1);
    library.entries[0].connection_id = profile.id;
    library
}

#[test]
fn shared_fixture_and_selection_are_versioned_and_bound() {
    let library = fixture();
    library.validate().unwrap();
    let definition = library.entries[0].clone();
    let selection = DataViewSelection {
        version: VERSION,
        definition: definition.clone(),
    };
    selection
        .validate(Some(&definition.connection_id), &definition.index)
        .unwrap();
    assert!(selection
        .validate(Some("other"), &definition.index)
        .is_err());
    assert!(selection
        .validate(Some(&definition.connection_id), "other")
        .is_err());
    assert!(selection.validate(None, &definition.index).is_err());
    let newer = DataViewSelection {
        version: 2,
        ..selection
    };
    assert!(newer
        .validate(Some(&definition.connection_id), &definition.index)
        .is_err());
}

#[test]
fn definitions_reject_unknown_fields_duplicate_keys_and_unsupported_targets() {
    for raw in [
        r#"{"version":1,"version":1,"entries":[]}"#,
        r#"{"version":1,"entries":[],"headers":{}}"#,
        r#"{"version":2,"entries":[]}"#,
        r#"{"version":1,"entries":[{"id":"v","name":"V","connectionId":"c","index":"a","defaultTimeField":null,"credentialRef":"fixture"}]}"#,
        r#"{"version":1,"entries":[{"id":"v","name":"V","connectionId":"c","index":"a"}]}"#,
    ] {
        assert_eq!(decode_stored(raw).unwrap_err().code, "invalidResponse");
    }
    for target in [
        "",
        " a",
        "a ",
        "_all",
        "-a",
        ".",
        "..",
        "a,,b",
        "a/_search",
        "a?x=1",
        "a%2fb",
        "remote:a",
    ] {
        let mut library = fixture();
        library.entries[0].index = target.into();
        assert!(library.validate().is_err(), "{target}");
    }
    for target in ["orders-*", "orders,archive", ".hidden-*", "audit", "*"] {
        let mut library = fixture();
        library.entries[0].index = target.into();
        library.validate().unwrap();
    }
}

#[test]
fn definitions_enforce_per_field_count_and_serialized_byte_bounds() {
    let entry = fixture().entries[0].clone();
    for changed in [
        DataViewDefinition {
            id: "".into(),
            ..entry.clone()
        },
        DataViewDefinition {
            name: "n".repeat(121),
            ..entry.clone()
        },
        DataViewDefinition {
            name: "bad\nname".into(),
            ..entry.clone()
        },
        DataViewDefinition {
            default_time_field: Nullable(Some("x".repeat(1025))),
            ..entry.clone()
        },
        DataViewDefinition {
            default_time_field: Nullable(Some("".into())),
            ..entry.clone()
        },
        DataViewDefinition {
            default_time_field: Nullable(Some(" bad".into())),
            ..entry.clone()
        },
        DataViewDefinition {
            index: "x".repeat(256),
            ..entry.clone()
        },
        DataViewDefinition {
            index: vec!["x"; 65].join(","),
            ..entry.clone()
        },
    ] {
        assert!(changed.validate().is_err());
    }
    let mut library = DataViewLibrary {
        version: 1,
        entries: (0..MAX_ENTRIES)
            .map(|index| DataViewDefinition {
                id: format!("view-{index}"),
                ..entry.clone()
            })
            .collect(),
    };
    library.validate().unwrap();
    library.entries.push(DataViewDefinition {
        id: "excess".into(),
        ..entry.clone()
    });
    assert!(library.validate().is_err());
    library.entries.pop();
    library.entries[1].id = library.entries[0].id.clone();
    assert!(library.validate().is_err());
    library.entries[1].id = "view-1".into();
    for item in &mut library.entries {
        item.name = "x".repeat(120);
        item.index = vec!["x".repeat(250); 4].join(",");
        item.default_time_field = Nullable(Some("\"".repeat(1024)));
    }
    assert!(serde_json::to_vec(&library).unwrap().len() > MAX_BYTES);
    assert!(library.validate().is_err());
}

#[test]
fn empty_reads_never_insert_and_saved_definitions_survive_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("views.sqlite");
    let mut database = Database::open(&path).unwrap();
    let empty = database.data_views().unwrap();
    assert_eq!(empty.revision, 0);
    assert_eq!(empty.library, DataViewLibrary::empty());
    let raw = Connection::open(&path).unwrap();
    assert_eq!(
        raw.query_row("SELECT count(*) FROM data_view_library", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let library = populated(&mut database);
    assert_eq!(database.save_data_views(0, &library).unwrap(), 1);
    drop(database);
    let reopened = Database::open(&path).unwrap().data_views().unwrap();
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
    first.save_data_views(0, &library).unwrap();
    assert_eq!(
        second
            .save_data_views(0, &DataViewLibrary::empty())
            .unwrap_err()
            .code,
        "dataViewConflict"
    );
    let mut changed = library.clone();
    changed.entries[0].connection_id = "other-id".into();
    assert_eq!(
        second.save_data_views(1, &changed).unwrap_err().code,
        "invalidInput"
    );
    assert_eq!(first.data_views().unwrap().library, library);
    changed = library.clone();
    changed.entries[0].name = "Updated".into();
    assert_eq!(second.save_data_views(1, &changed).unwrap(), 2);
    assert_eq!(
        first.save_data_views(1, &library).unwrap_err().code,
        "dataViewConflict"
    );
    assert_eq!(first.data_views().unwrap().library, changed);
}

#[test]
fn new_definitions_require_existing_ids_and_deleted_owners_are_retained() {
    let directory = tempfile::tempdir().unwrap();
    let mut database = Database::open(&directory.path().join("owners.sqlite")).unwrap();
    let library = populated(&mut database);
    database.save_data_views(0, &library).unwrap();
    database
        .delete_connection(&library.entries[0].connection_id)
        .unwrap();
    assert_eq!(database.data_views().unwrap().library, library);
    let mut renamed = library.clone();
    renamed.entries[0].name = "Historical".into();
    assert_eq!(database.save_data_views(1, &renamed).unwrap(), 2);
    let mut new_entry = renamed.clone();
    new_entry.entries[0].id = "new-view".into();
    assert_eq!(
        database.save_data_views(2, &new_entry).unwrap_err().code,
        "dataViewConnectionMissing"
    );
    assert_eq!(database.data_views().unwrap().library, renamed);
    assert_eq!(
        database
            .save_data_views(2, &DataViewLibrary::empty())
            .unwrap(),
        3
    );
}

#[test]
fn damaged_future_or_duplicate_stored_documents_are_not_overwritten_even_with_matching_revision() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("invalid.sqlite");
    let mut database = Database::open(&path).unwrap();
    let library = populated(&mut database);
    database.save_data_views(0, &library).unwrap();
    let raw = Connection::open(&path).unwrap();
    for invalid in [
        "not-json",
        r#"{"version":2,"entries":[]}"#,
        r#"{"version":1,"entries":[],"entries":[]}"#,
        r#"{"version":1,"entries":[],"auth":{}}"#,
    ] {
        raw.execute("UPDATE data_view_library SET json=?1", [invalid])
            .unwrap();
        assert_eq!(database.data_views().unwrap_err().code, "invalidResponse");
        assert_eq!(
            database.save_data_views(1, &library).unwrap_err().code,
            "invalidResponse"
        );
        assert_eq!(
            raw.query_row("SELECT json FROM data_view_library", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            invalid
        );
    }
}

#[test]
fn invalid_counters_and_over_limit_rows_fail_closed_and_sql_checks_stay_bounded() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("bounds.sqlite");
    let mut database = Database::open(&path).unwrap();
    let library = populated(&mut database);
    database.save_data_views(0, &library).unwrap();
    assert_eq!(
        database
            .save_data_views(MAX_REVISION, &library)
            .unwrap_err()
            .code,
        "invalidInput"
    );
    let raw = Connection::open(&path).unwrap();
    assert!(raw
        .execute("UPDATE data_view_library SET revision=0", [])
        .is_err());
    assert!(raw
        .execute(
            "UPDATE data_view_library SET json=?1",
            ["x".repeat(MAX_BYTES + 1)]
        )
        .is_err());
    raw.execute_batch("PRAGMA ignore_check_constraints=ON")
        .unwrap();
    for revision in [0, -1, MAX_REVISION as i64 + 1] {
        raw.execute("UPDATE data_view_library SET revision=?1", [revision])
            .unwrap();
        assert_eq!(database.data_views().unwrap_err().code, "invalidResponse");
        assert_eq!(
            database.save_data_views(1, &library).unwrap_err().code,
            "invalidResponse"
        );
    }
    raw.execute(
        "UPDATE data_view_library SET revision=1,json=?1",
        ["x".repeat(MAX_BYTES + 1)],
    )
    .unwrap();
    assert_eq!(database.data_views().unwrap_err().code, "invalidResponse");
}

#[test]
fn read_only_storage_does_not_report_a_successful_save() {
    let directory = tempfile::tempdir().unwrap();
    let mut database = Database::open(&directory.path().join("readonly.sqlite")).unwrap();
    let library = populated(&mut database);
    database.save_data_views(0, &library).unwrap();
    database.run_sql_for_test("PRAGMA query_only=ON").unwrap();
    assert_eq!(
        database
            .save_data_views(1, &DataViewLibrary::empty())
            .unwrap_err()
            .code,
        "storageUnavailable"
    );
    assert_eq!(database.data_views().unwrap().library, library);
}

#[test]
fn selections_round_trip_through_saved_queries_but_never_cross_targets_or_accept_null() {
    let directory = tempfile::tempdir().unwrap();
    let mut database = Database::open(&directory.path().join("queries.sqlite")).unwrap();
    let definition = fixture().entries[0].clone();
    let base = json!({
        "version": 1, "entries": [{
            "id": "query", "name": "Draft", "connectionId": definition.connection_id,
            "index": definition.index, "dsl": "{ incomplete", "resultView": "table", "favorite": false,
            "updatedAt": "2026-10-10T00:00:00.000Z",
            "dataView": { "version": 1, "definition": definition }
        }]
    });
    let library =
        serde_json::from_value::<crate::saved_queries::SavedQueryLibrary>(base.clone()).unwrap();
    crate::saved_queries::save_checked(
        &mut database,
        library.clone(),
        crate::saved_queries::SavedQueryLibrary::empty(),
        &[],
    )
    .unwrap();
    assert_eq!(
        crate::saved_queries::load_library(&mut database).unwrap(),
        library
    );
    for invalid in [
        Value::Null,
        json!({"version":2,"definition":definition}),
        json!({"version":1,"definition":definition,"credentialRef":"fixture"}),
    ] {
        let mut changed = base.clone();
        changed["entries"][0]["dataView"] = invalid;
        assert!(crate::saved_queries::decode_library(&changed.to_string()).is_err());
    }
    for key in ["connectionId", "index"] {
        let mut changed = base.clone();
        changed["entries"][0][key] = json!("other");
        assert!(crate::saved_queries::decode_library(&changed.to_string()).is_err());
    }
}

#[test]
fn field_format_fixture_round_trips_without_changing_legacy_definitions() {
    let formatted = formatted_fixture();
    formatted.validate().unwrap();
    let raw: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/data-view-field-formats-v1.json"
    ))
    .unwrap();
    assert_eq!(serde_json::to_value(&formatted).unwrap(), raw);
    assert!(fixture().entries[0].field_formats.is_none());
    let serialized = serde_json::to_value(fixture()).unwrap();
    assert!(serialized["entries"][0].get("fieldFormats").is_none());
}

#[test]
fn field_formats_refuse_unknown_executable_or_ambiguous_options() {
    let base = serde_json::to_value(formatted_fixture()).unwrap();
    for format in [
        json!(null),
        json!({"kind": "number"}),
        json!({"kind": "number", "grouping": "true"}),
        json!({"kind": "number", "grouping": true, "decimals": 2}),
        json!({"kind": "date", "input": "local"}),
        json!({"kind": "date", "input": "iso", "timezone": "auto"}),
        json!({"kind": "html", "template": "<b>value</b>"}),
        json!({"kind": "script", "source": "fetch('/')"}),
        json!({"kind": "url", "url": "https://fixture.test"}),
    ] {
        let mut value = base.clone();
        value["entries"][0]["fieldFormats"]["entries"][0]["format"] = format;
        assert!(decode_stored(&value.to_string()).is_err());
    }
    for formats in [
        json!(null),
        json!({"version": 2, "entries": []}),
        json!({"version": 1, "entries": [], "headers": {}}),
    ] {
        let mut value = base.clone();
        value["entries"][0]["fieldFormats"] = formats;
        assert!(decode_stored(&value.to_string()).is_err());
    }
    let duplicate_option = r#"{"version":1,"entries":[{"id":"v","name":"V","connectionId":"c","index":"a","defaultTimeField":null,"fieldFormats":{"version":1,"entries":[{"field":"n","format":{"kind":"number","grouping":true,"grouping":false}}]}}]}"#;
    assert!(decode_stored(duplicate_option).is_err());
    let duplicate_version = r#"{"version":1,"entries":[{"id":"v","name":"V","connectionId":"c","index":"a","defaultTimeField":null,"fieldFormats":{"version":1,"version":1,"entries":[]}}]}"#;
    assert!(decode_stored(duplicate_version).is_err());
}

#[test]
fn field_formats_bound_field_names_count_and_serialized_bytes() {
    let base = serde_json::to_value(formatted_fixture()).unwrap();
    for field in ["", " n", "n ", "\u{7f}", "\u{85}", &"x".repeat(1025)] {
        let mut value = base.clone();
        value["entries"][0]["fieldFormats"]["entries"][0]["field"] = json!(field);
        assert!(decode_stored(&value.to_string()).is_err());
    }
    let mut value = base.clone();
    let entries: Vec<Value> = (0..32)
        .map(|index| json!({"field": format!("n{index}"), "format": {"kind":"number","grouping":true}}))
        .collect();
    value["entries"][0]["fieldFormats"]["entries"] = json!(entries);
    decode_stored(&value.to_string()).unwrap();
    value["entries"][0]["fieldFormats"]["entries"][1]["field"] = json!("n0");
    assert!(decode_stored(&value.to_string()).is_err());
    let mut too_many = entries.clone();
    too_many.push(json!({"field":"extra","format":{"kind":"number","grouping":true}}));
    value["entries"][0]["fieldFormats"]["entries"] = json!(too_many);
    assert!(decode_stored(&value.to_string()).is_err());
    let large: Vec<Value> = entries
        .into_iter()
        .enumerate()
        .map(|(index, mut entry)| {
            entry["field"] = json!(format!("{index}{}", "x".repeat(600)));
            entry
        })
        .collect();
    value["entries"][0]["fieldFormats"]["entries"] = json!(large);
    assert!(value["entries"][0]["fieldFormats"].to_string().len() > 16 * 1024);
    assert!(decode_stored(&value.to_string()).is_err());
}

#[test]
fn formatted_definitions_survive_cas_reopen_and_do_not_overwrite_invalid_stored_options() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("formats.sqlite");
    let mut database = Database::open(&path).unwrap();
    let mut library = populated(&mut database);
    library.entries[0].field_formats = formatted_fixture().entries[0].field_formats.clone();
    database.save_data_views(0, &library).unwrap();
    drop(database);
    let mut database = Database::open(&path).unwrap();
    assert_eq!(database.data_views().unwrap().library, library);
    assert_eq!(
        database.save_data_views(0, &library).unwrap_err().code,
        "dataViewConflict"
    );
    let raw = Connection::open(&path).unwrap();
    let mut invalid = serde_json::to_value(&library).unwrap();
    invalid["entries"][0]["fieldFormats"]["entries"][0]["format"]["script"] = json!("fixture");
    let invalid = invalid.to_string();
    raw.execute("UPDATE data_view_library SET json=?1", [&invalid])
        .unwrap();
    assert_eq!(database.data_views().unwrap_err().code, "invalidResponse");
    assert_eq!(
        database.save_data_views(1, &library).unwrap_err().code,
        "invalidResponse"
    );
    assert_eq!(
        raw.query_row("SELECT json FROM data_view_library", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        invalid
    );
}

#[test]
fn saved_query_copies_validate_format_options_and_preserve_exact_dsl() {
    let directory = tempfile::tempdir().unwrap();
    let mut database = Database::open(&directory.path().join("saved-formats.sqlite")).unwrap();
    let definition = formatted_fixture().entries[0].clone();
    let base = json!({
        "version": 1, "entries": [{
            "id": "query", "name": "Draft", "connectionId": definition.connection_id,
            "index": definition.index, "dsl": "{\"query\":{\"term\":{\"sequence\":9007199254740993}}}",
            "resultView": "table", "favorite": false, "updatedAt": "2026-10-10T00:00:00.000Z",
            "dataView": {"version": 1, "definition": definition}
        }]
    });
    let library = crate::saved_queries::decode_library(&base.to_string()).unwrap();
    crate::saved_queries::save_checked(
        &mut database,
        library.clone(),
        crate::saved_queries::SavedQueryLibrary::empty(),
        &[],
    )
    .unwrap();
    assert_eq!(
        crate::saved_queries::load_library(&mut database).unwrap(),
        library
    );
    let mut invalid = base.clone();
    invalid["entries"][0]["dataView"]["definition"]["fieldFormats"]["version"] = json!(2);
    assert!(crate::saved_queries::decode_library(&invalid.to_string()).is_err());
}

#[test]
fn runtime_definitions_survive_cas_reopen_and_invalid_stored_scripts_are_not_repaired() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("runtime.sqlite");
    let mut database = Database::open(&path).unwrap();
    let mut library = populated(&mut database);
    library.entries[0].runtime_fields = runtime_fixture().entries[0].runtime_fields.clone();
    library.validate().unwrap();
    database.save_data_views(0, &library).unwrap();
    drop(database);
    let mut database = Database::open(&path).unwrap();
    assert_eq!(database.data_views().unwrap().library, library);
    assert_eq!(
        database.save_data_views(0, &library).unwrap_err().code,
        "dataViewConflict"
    );
    let raw = Connection::open(&path).unwrap();
    let mut invalid = serde_json::to_value(&library).unwrap();
    invalid["entries"][0]["runtimeFields"]["entries"][0]["script"]["id"] = json!("stored-script");
    let invalid = invalid.to_string();
    raw.execute("UPDATE data_view_library SET json=?1", [&invalid])
        .unwrap();
    assert_eq!(database.data_views().unwrap_err().code, "invalidResponse");
    assert_eq!(
        database.save_data_views(1, &library).unwrap_err().code,
        "invalidResponse"
    );
    assert_eq!(
        raw.query_row("SELECT json FROM data_view_library", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        invalid
    );
}

#[test]
fn saved_queries_keep_runtime_copies_and_refuse_null_unknown_or_cross_target_definitions() {
    let directory = tempfile::tempdir().unwrap();
    let mut database = Database::open(&directory.path().join("saved-runtime.sqlite")).unwrap();
    let definition = runtime_fixture().entries[0].clone();
    let base = json!({
        "version": 1, "entries": [{
            "id": "query", "name": "Runtime", "connectionId": definition.connection_id,
            "index": definition.index, "dsl": "{\"runtime_mappings\":{\"n\":{\"type\":\"long\"}},\"query\":{\"term\":{\"id\":9007199254740993}}}",
            "resultView": "table", "favorite": false, "updatedAt": "2026-10-10T00:00:00.000Z",
            "dataView": {"version": 1, "definition": definition}
        }]
    });
    let library = crate::saved_queries::decode_library(&base.to_string()).unwrap();
    crate::saved_queries::save_checked(
        &mut database,
        library.clone(),
        crate::saved_queries::SavedQueryLibrary::empty(),
        &[],
    )
    .unwrap();
    assert_eq!(
        crate::saved_queries::load_library(&mut database).unwrap(),
        library
    );
    for runtime in [
        json!(null),
        json!({"version":2,"entries":[]}),
        json!({"version":1,"entries":[{"field":"n","type":"long","script":{"source":"emit(1);","lang":"js"}}]}),
    ] {
        let mut invalid = base.clone();
        invalid["entries"][0]["dataView"]["definition"]["runtimeFields"] = runtime;
        assert!(crate::saved_queries::decode_library(&invalid.to_string()).is_err());
    }
    let mut invalid = base.clone();
    invalid["entries"][0]["dataView"]["definition"]["connectionId"] = json!("other");
    assert!(crate::saved_queries::decode_library(&invalid.to_string()).is_err());
    assert!(fixture().entries[0].runtime_fields.is_none());
}
