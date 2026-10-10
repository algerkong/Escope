use super::*;
use crate::storage::{ConnectionInput, Database};
use rusqlite::Connection;
use serde_json::json;

fn fixture() -> PinnedFilterLibrary {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/pinned-filters-v1.json"
    ))
    .unwrap()
}

fn nested_fixture() -> PinnedFilterLibrary {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/pinned-filters-v2.json"
    ))
    .unwrap()
}

fn populated(database: &mut Database) -> PinnedFilterLibrary {
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
    library.entries[0].connection_id = profile.id;
    library
}

#[test]
fn shared_contract_preserves_literals_boolean_states_and_groups_without_execution_metadata() {
    let library = fixture();
    library.validate().unwrap();
    let raw: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/pinned-filters-v1.json"
    ))
    .unwrap();
    assert_eq!(serde_json::to_value(&library).unwrap(), raw);
    assert_eq!(
        library.entries[0].filters[1].value.0.as_deref(),
        Some("9007199254740993")
    );
    assert!(!library.entries[0].filters[2].enabled);
    assert_eq!(library.entries[0].composition.mode, Join::Any);
    assert_eq!(library.entries[0].composition.groups[0].mode, Join::Any);
}

#[test]
fn unknown_fields_duplicate_keys_future_versions_and_missing_fields_fail_closed() {
    for raw in [
        r#"{"version":1,"version":1,"entries":[]}"#,
        r#"{"version":4,"entries":[]}"#,
        r#"{"version":1,"entries":[],"binding":{}}"#,
    ] {
        assert_eq!(decode_stored(raw).unwrap_err().code, "invalidResponse");
    }
    let base = serde_json::to_value(fixture()).unwrap();
    for field in [
        "snapshot",
        "binding",
        "endpoint",
        "headers",
        "runtimeFields",
        "rawResponse",
        "dsl",
        "parameters",
    ] {
        for level in 0..3 {
            let mut value = base.clone();
            let target = match level {
                0 => &mut value,
                1 => &mut value["entries"][0],
                _ => &mut value["entries"][0]["filters"][0],
            };
            target[field] = json!({});
            assert!(
                decode_stored(&value.to_string()).is_err(),
                "{field} at {level}"
            );
        }
    }
    for field in ["id", "field", "fieldType", "operation", "value", "enabled"] {
        let mut value = base.clone();
        value["entries"][0]["filters"][0]
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(
            decode_stored(&value.to_string()).is_err(),
            "missing {field}"
        );
    }
    for enabled in [Value::Null, json!("false"), json!(0), json!([])] {
        let mut value = base.clone();
        value["entries"][0]["filters"][2]["enabled"] = enabled;
        assert!(decode_stored(&value.to_string()).is_err());
    }
}

#[test]
fn numeric_validation_never_rounds_large_integers_or_changes_the_original_token() {
    for (kind, raw, accepted) in [
        ("long", "9007199254740993", true),
        ("long", "9.007199254740993e15", true),
        ("long", "-9223372036854775808", true),
        ("long", "9223372036854775808", false),
        ("long", "1.1", false),
        ("byte", "127.00", true),
        ("byte", "128", false),
        ("unsigned_long", "18446744073709551615", true),
        ("unsigned_long", "-1", false),
        ("double", "1e309", false),
        ("double", "1e-999", true),
        ("boolean", "true", true),
        ("boolean", "1", false),
        ("date", r#""2026-10-10""#, false),
        ("text", r#"" ""#, false),
        ("keyword", r#""""#, true),
        ("long", "0e9999999999999999999999999999", true),
        ("long", "1e9999999999999999999999999999", false),
        ("long", "1e-9999999999999999999999999999", false),
        ("long", "01", false),
        ("long", " 127.00 ", true),
    ] {
        let mut library = fixture();
        let filter = &mut library.entries[0].filters[0];
        filter.field_type = kind.into();
        filter.value = Nullable(Some(raw.into()));
        assert_eq!(library.validate().is_ok(), accepted, "{kind} {raw}");
        assert_eq!(library.entries[0].filters[0].value.0.as_deref(), Some(raw));
    }
}

#[test]
fn all_leaves_including_disabled_are_bounded_and_require_flat_supported_definitions() {
    let base = serde_json::to_value(fixture()).unwrap();
    for (field, invalid) in [
        ("id", json!("")),
        ("field", json!("a.b")),
        ("field", json!("$param")),
        ("field", json!("_id")),
        ("field", json!(" x")),
        ("field", json!("a\n")),
        ("field", json!("a?")),
        ("field", json!("x".repeat(1025))),
        ("fieldType", json!("nested")),
        ("origin", json!("saved")),
        ("evidence", json!("mapped")),
        ("nestedPath", json!("comments")),
        ("operation", json!(["include"])),
        ("value", json!("{}")),
        ("value", json!("[]")),
        ("value", json!("null")),
        ("value", json!("true")),
        ("value", json!(format!("\"{}\"", "x".repeat(4095)))),
    ] {
        let mut value = base.clone();
        value["entries"][0]["filters"][2][field] = invalid;
        assert!(decode_stored(&value.to_string()).is_err(), "{field}");
    }
    for target in [
        "",
        " x",
        "x ",
        "remote:x",
        "x/_search",
        ".",
        "..",
        "_all",
        "x,,y",
        "x?x=1",
    ] {
        let mut library = fixture();
        library.entries[0].index = target.into();
        assert!(library.validate().is_err(), "{target}");
    }
    let mut duplicate = fixture();
    duplicate.entries[0].filters[2] = PinnedFilter {
        id: "note".into(),
        enabled: false,
        ..duplicate.entries[0].filters[0].clone()
    };
    assert!(duplicate.validate().is_err());
}

#[test]
fn count_group_membership_and_serialized_utf8_bytes_have_no_partial_acceptance() {
    let mut library = fixture();
    let base = library.entries[0].clone();
    library.entries = (0..MAX_ENTRIES)
        .map(|index| PinnedFilterDefinition {
            id: format!("set-{index}"),
            ..base.clone()
        })
        .collect();
    library.validate().unwrap();
    library.entries.push(PinnedFilterDefinition {
        id: "extra".into(),
        ..base.clone()
    });
    assert!(library.validate().is_err());
    library.entries.pop();
    for entry in &mut library.entries {
        entry.filters[0].value = Nullable(Some(serde_json::to_string(&"\"".repeat(1900)).unwrap()));
    }
    assert!(serde_json::to_vec(&library).unwrap().len() > MAX_BYTES);
    assert!(library.validate().is_err());
    for members in [
        vec![],
        vec!["status"],
        vec!["status", "status", "amount", "note", "date"],
        vec!["status", "amount", "note", "date", "unknown"],
    ] {
        let mut library = fixture();
        library.entries[0].composition.groups = vec![FilterGroup {
            id: "g".into(),
            mode: Join::Any,
            filter_ids: members.into_iter().map(str::to_owned).collect(),
            nested: None,
        }];
        assert!(library.validate().is_err());
    }
    let mut library = fixture();
    library.entries[0].filters = vec![base.filters[0].clone(); 33];
    assert!(library.validate().is_err());
    library.entries[0] = base.clone();
    library.entries[0].composition.groups = vec![base.composition.groups[0].clone(); 9];
    assert!(library.validate().is_err());
    let mut value = serde_json::to_value(fixture()).unwrap();
    value["entries"][0]["composition"]["groups"][0]["nested"] =
        json!({"path":"x","match":"include"});
    assert!(decode_stored(&value.to_string()).is_err());
}

#[test]
fn empty_reads_do_not_write_and_literal_definitions_survive_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pinned.sqlite");
    let mut database = Database::open(&path).unwrap();
    assert_eq!(database.pinned_filters().unwrap().revision, 0);
    let raw = Connection::open(&path).unwrap();
    assert_eq!(
        raw.query_row("SELECT count(*) FROM pinned_filter_library", [], |row| row
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        0
    );
    let library = populated(&mut database);
    assert_eq!(database.save_pinned_filters(0, &library).unwrap(), 1);
    drop(database);
    let reopened = Database::open(&path).unwrap().pinned_filters().unwrap();
    assert_eq!(reopened.revision, 1);
    assert_eq!(reopened.library, library);
}

#[test]
fn cas_is_atomic_and_existing_ids_cannot_be_overwritten_or_retargeted() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("cas.sqlite");
    let mut first = Database::open(&path).unwrap();
    let mut second = Database::open(&path).unwrap();
    let library = populated(&mut first);
    first.save_pinned_filters(0, &library).unwrap();
    assert_eq!(
        second
            .save_pinned_filters(0, &PinnedFilterLibrary::empty())
            .unwrap_err()
            .code,
        "pinnedFilterConflict"
    );
    for field in ["connectionId", "index", "name"] {
        let mut value = serde_json::to_value(&library).unwrap();
        value["entries"][0][field] = json!("different");
        let changed = serde_json::from_value(value).unwrap();
        assert_eq!(
            second.save_pinned_filters(1, &changed).unwrap_err().code,
            "invalidInput"
        );
    }
    let mut changed = library.clone();
    changed.entries[0].filters[0].enabled = false;
    assert_eq!(
        second.save_pinned_filters(1, &changed).unwrap_err().code,
        "invalidInput"
    );
    assert_eq!(first.pinned_filters().unwrap().library, library);
    assert_eq!(
        second
            .save_pinned_filters(1, &PinnedFilterLibrary::empty())
            .unwrap(),
        2
    );
    assert_eq!(
        first.save_pinned_filters(1, &library).unwrap_err().code,
        "pinnedFilterConflict"
    );
    assert!(first.pinned_filters().unwrap().library.entries.is_empty());
}

#[test]
fn deleted_connections_retain_old_definitions_but_new_definitions_cannot_bind_to_them() {
    let directory = tempfile::tempdir().unwrap();
    let mut database = Database::open(&directory.path().join("owners.sqlite")).unwrap();
    let library = populated(&mut database);
    database.save_pinned_filters(0, &library).unwrap();
    database
        .delete_connection(&library.entries[0].connection_id)
        .unwrap();
    assert_eq!(database.pinned_filters().unwrap().library, library);
    assert_eq!(database.save_pinned_filters(1, &library).unwrap(), 2);
    let mut changed = library.clone();
    changed.entries[0].id = "new-definition".into();
    assert_eq!(
        database.save_pinned_filters(2, &changed).unwrap_err().code,
        "pinnedFilterConnectionMissing"
    );
    assert_eq!(database.pinned_filters().unwrap().library, library);
    database
        .save_pinned_filters(2, &PinnedFilterLibrary::empty())
        .unwrap();
}

#[test]
fn malformed_or_future_storage_is_not_overwritten_even_with_the_matching_revision() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("damaged.sqlite");
    let mut database = Database::open(&path).unwrap();
    let library = populated(&mut database);
    database.save_pinned_filters(0, &library).unwrap();
    let raw = Connection::open(&path).unwrap();
    for invalid in [
        "not-json",
        r#"{"version":4,"entries":[]}"#,
        r#"{"version":1,"entries":[],"entries":[]}"#,
        r#"{"version":1,"entries":[],"auth":{}}"#,
    ] {
        raw.execute("UPDATE pinned_filter_library SET json=?1", [invalid])
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

#[test]
fn revision_sql_byte_bounds_and_read_only_failures_do_not_claim_success() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("bounds.sqlite");
    let mut database = Database::open(&path).unwrap();
    let library = populated(&mut database);
    database.save_pinned_filters(0, &library).unwrap();
    assert_eq!(
        database
            .save_pinned_filters(MAX_REVISION, &library)
            .unwrap_err()
            .code,
        "invalidInput"
    );
    let raw = Connection::open(&path).unwrap();
    assert!(raw
        .execute("UPDATE pinned_filter_library SET revision=0", [])
        .is_err());
    assert!(raw
        .execute(
            "UPDATE pinned_filter_library SET json=?1",
            ["x".repeat(MAX_BYTES + 1)]
        )
        .is_err());
    raw.execute_batch("PRAGMA ignore_check_constraints=ON")
        .unwrap();
    for revision in [0_i64, -1, 9_007_199_254_740_992] {
        raw.execute("UPDATE pinned_filter_library SET revision=?1", [revision])
            .unwrap();
        assert_eq!(
            database.pinned_filters().unwrap_err().code,
            "invalidResponse"
        );
        assert_eq!(
            database.save_pinned_filters(1, &library).unwrap_err().code,
            "invalidResponse"
        );
    }
    raw.execute(
        "UPDATE pinned_filter_library SET revision=1, json=?1",
        ["x".repeat(MAX_BYTES + 1)],
    )
    .unwrap();
    assert_eq!(
        database.pinned_filters().unwrap_err().code,
        "invalidResponse"
    );
    assert_eq!(
        database.save_pinned_filters(1, &library).unwrap_err().code,
        "invalidResponse"
    );
    raw.execute(
        "UPDATE pinned_filter_library SET json=?1",
        [serde_json::to_string(&library).unwrap()],
    )
    .unwrap();
    database.run_sql_for_test("PRAGMA query_only=ON").unwrap();
    assert_eq!(
        database
            .save_pinned_filters(1, &PinnedFilterLibrary::empty())
            .unwrap_err()
            .code,
        "storageUnavailable"
    );
    assert_eq!(database.pinned_filters().unwrap().library, library);
}

#[test]
fn shared_v2_contract_round_trips_explicit_scopes_negation_and_disabled_literals() {
    let library = nested_fixture();
    library.validate().unwrap();
    let raw: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/pinned-filters-v2.json"
    ))
    .unwrap();
    assert_eq!(serde_json::to_value(&library).unwrap(), raw);
    assert_eq!(
        library.entries[0].filters[2].value.0.as_deref(),
        Some("9007199254740993")
    );
    assert_eq!(
        library.entries[0].filters[1].value.0.as_deref(),
        Some(r#""a\u006cice""#)
    );
    assert_eq!(
        library.entries[0].composition.groups[2].nested,
        Some(NestedScope {
            path: "comments".into(),
            r#match: ParentMatch::Exclude
        })
    );
    assert!(!library.entries[0].filters[5].enabled);
    let mut downgraded = library.clone();
    downgraded.version = 1;
    assert!(downgraded.validate().is_err());
    let mut mixed = fixture();
    mixed.version = VERSION;
    mixed.entries.extend(library.entries);
    mixed.validate().unwrap();
}

#[test]
fn nested_leaf_scope_requires_explicit_direct_paths_even_when_disabled() {
    let base = serde_json::to_value(nested_fixture()).unwrap();
    for (key, value) in [
        ("nestedPath", Value::Null),
        ("nestedPath", json!(["comments"])),
        ("nestedPath", json!("")),
        ("nestedPath", json!("comments.author")),
        ("nestedPath", json!("comments[0]")),
        ("nestedPath", json!("comments/child")),
        ("nestedPath", json!("_comments")),
        ("nestedPath", json!("$param")),
        ("nestedPath", json!("other")),
        ("field", json!("comments.author.name")),
        ("field", json!("comments.")),
        ("field", json!("comments.author[0]")),
        ("field", json!("comments.$param")),
        ("field", json!("comments._id")),
        ("field", json!("comments.author/name")),
        ("field", json!(format!("comments.{}", "x".repeat(1024)))),
        ("fieldType", json!("nested")),
        ("evidence", json!("runtime")),
        ("origin", json!("saved")),
        ("runtime_mappings", json!({})),
        ("value", json!("{}")),
        ("value", json!("[]")),
        ("value", json!("null")),
        ("value", json!(format!("\"{}\"", "x".repeat(4096)))),
    ] {
        let mut copy = base.clone();
        copy["entries"][0]["filters"][1]["enabled"] = json!(false);
        copy["entries"][0]["filters"][1][key] = value;
        assert!(decode_stored(&copy.to_string()).is_err(), "{key}");
    }
    let mut unscoped = base;
    unscoped["entries"][0]["filters"][1]
        .as_object_mut()
        .unwrap()
        .remove("nestedPath");
    assert!(decode_stored(&unscoped.to_string()).is_err());
}

#[test]
fn nested_group_shape_is_strict_and_never_silently_drops_parent_negation() {
    let base = serde_json::to_value(nested_fixture()).unwrap();
    for nested in [
        Value::Null,
        json!([]),
        json!({}),
        json!({"path":"comments","match":["include"]}),
        json!({"path":"comments","match":"all"}),
        json!({"path":"comments.author","match":"include"}),
        json!({"path":"other","match":"include"}),
        json!({"path":"comments","match":"include","score_mode":"avg"}),
        json!({"path":"comments","match":"exclude","ignore_unmapped":true}),
        json!({"path":"comments","match":"exclude","minimum_should_match":2}),
    ] {
        let mut value = base.clone();
        value["entries"][0]["composition"]["groups"][1]["nested"] = nested;
        assert!(decode_stored(&value.to_string()).is_err());
    }
    let mut value = base;
    value["entries"][0]["composition"]["groups"][1]
        .as_object_mut()
        .unwrap()
        .remove("nested");
    assert!(decode_stored(&value.to_string()).is_err());
    for raw in [
        r#"{"version":2,"entries":[],"nested":{}}"#,
        r#"{"version":2,"version":2,"entries":[]}"#,
        r#"{"version":4,"entries":[]}"#,
    ] {
        assert!(decode_stored(raw).is_err());
    }
}

#[test]
fn independent_nested_groups_may_repeat_literals_but_same_object_duplicates_are_rejected() {
    let mut library = nested_fixture();
    library.validate().unwrap();
    let entry = &mut library.entries[0];
    entry.filters[3].enabled = false;
    entry.composition.groups[1]
        .filter_ids
        .push("other-author".into());
    entry.composition.groups[2].filter_ids = vec!["missing".into()];
    assert!(library.validate().is_err());
    for members in [
        vec!["status", "n"],
        vec!["author", "tag"],
        vec!["author", "author"],
        vec!["author", "absent"],
    ] {
        let mut library = nested_fixture();
        library.entries[0].composition.groups[1].filter_ids =
            members.into_iter().map(str::to_owned).collect();
        assert!(library.validate().is_err());
    }
}

#[test]
fn v2_disabled_scopes_still_count_toward_definition_and_serialized_byte_limits() {
    let mut library = nested_fixture();
    let definition = library.entries[0].clone();
    library.entries = (0..MAX_ENTRIES)
        .map(|index| PinnedFilterDefinition {
            id: format!("set-{index}"),
            ..definition.clone()
        })
        .collect();
    library.validate().unwrap();
    library.entries.push(PinnedFilterDefinition {
        id: "extra".into(),
        ..definition.clone()
    });
    assert!(library.validate().is_err());
    library.entries.pop();
    for entry in &mut library.entries {
        entry.filters[5].value = Nullable(Some(serde_json::to_string(&"\"".repeat(1000)).unwrap()));
    }
    assert!(serde_json::to_vec(&library).unwrap().len() > MAX_BYTES);
    assert!(library.validate().is_err());
    library.entries = vec![definition.clone()];
    library.entries[0].filters = vec![definition.filters[1].clone(); MAX_FILTERS + 1];
    assert!(library.validate().is_err());
    library.entries[0] = definition.clone();
    library.entries[0].composition.groups =
        vec![definition.composition.groups[1].clone(); MAX_GROUPS + 1];
    assert!(library.validate().is_err());
}

#[test]
fn legacy_reads_do_not_rewrite_storage_and_explicit_upgrade_keeps_every_old_definition() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("upgrade.sqlite");
    let mut database = Database::open(&path).unwrap();
    let legacy = populated(&mut database);
    database.save_pinned_filters(0, &legacy).unwrap();
    let raw = Connection::open(&path).unwrap();
    let original = serde_json::to_string_pretty(&legacy).unwrap();
    raw.execute("UPDATE pinned_filter_library SET json=?1", [&original])
        .unwrap();
    assert_eq!(database.pinned_filters().unwrap().library, legacy);
    drop(database);
    let mut database = Database::open(&path).unwrap();
    assert_eq!(database.pinned_filters().unwrap().library.version, 1);
    assert_eq!(
        raw.query_row("SELECT json FROM pinned_filter_library", [], |row| row
            .get::<_, String>(
            0
        ))
        .unwrap(),
        original
    );
    let mut upgraded = nested_fixture();
    upgraded.entries[0].connection_id = legacy.entries[0].connection_id.clone();
    upgraded.entries.insert(0, legacy.entries[0].clone());
    assert_eq!(database.save_pinned_filters(1, &upgraded).unwrap(), 2);
    drop(database);
    let mut database = Database::open(&path).unwrap();
    assert_eq!(database.pinned_filters().unwrap().library, upgraded);
    assert_eq!(
        database.save_pinned_filters(1, &legacy).unwrap_err().code,
        "pinnedFilterConflict"
    );
    for candidate in [
        legacy.clone(),
        PinnedFilterLibrary {
            version: 1,
            entries: vec![],
        },
    ] {
        assert_eq!(
            database
                .save_pinned_filters(2, &candidate)
                .unwrap_err()
                .code,
            "invalidInput"
        );
    }
    assert_eq!(database.pinned_filters().unwrap().library, upgraded);
}

#[test]
fn nested_existing_ids_remain_immutable_across_group_mode_enabled_and_scope_changes() {
    let directory = tempfile::tempdir().unwrap();
    let mut database = Database::open(&directory.path().join("immutable.sqlite")).unwrap();
    let legacy = populated(&mut database);
    let mut library = nested_fixture();
    library.entries[0].connection_id = legacy.entries[0].connection_id.clone();
    database.save_pinned_filters(0, &library).unwrap();
    for field in ["parent", "enabled", "mode", "value"] {
        let mut changed = library.clone();
        let entry = &mut changed.entries[0];
        match field {
            "parent" => {
                entry.composition.groups[1].nested.as_mut().unwrap().r#match = ParentMatch::Exclude
            }
            "enabled" => entry.filters[1].enabled = false,
            "mode" => entry.composition.groups[1].mode = Join::Any,
            _ => entry.filters[1].value = Nullable(Some(r#""different""#.into())),
        }
        changed.validate().unwrap();
        assert_eq!(
            database.save_pinned_filters(1, &changed).unwrap_err().code,
            "invalidInput"
        );
    }
    assert_eq!(database.pinned_filters().unwrap().library, library);
    database
        .delete_connection(&library.entries[0].connection_id)
        .unwrap();
    assert_eq!(database.save_pinned_filters(1, &library).unwrap(), 2);
    let mut changed = library.clone();
    changed.entries[0].id = "new".into();
    assert_eq!(
        database.save_pinned_filters(2, &changed).unwrap_err().code,
        "pinnedFilterConnectionMissing"
    );
    assert_eq!(database.pinned_filters().unwrap().library, library);
    database
        .save_pinned_filters(2, &PinnedFilterLibrary::empty())
        .unwrap();
    assert!(database
        .pinned_filters()
        .unwrap()
        .library
        .entries
        .is_empty());
}
