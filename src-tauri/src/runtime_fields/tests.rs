use super::*;
use crate::query;
use serde_json::{json, Value};

fn fixture() -> RuntimeFields {
    let value: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/data-view-runtime-fields-v1.json"
    ))
    .unwrap();
    serde_json::from_value(value["entries"][0]["runtimeFields"].clone()).unwrap()
}

#[test]
fn shared_fixture_accepts_all_seven_types_and_preserves_inline_source_as_text() {
    let fields = fixture();
    fields.validate().unwrap();
    assert_eq!(fields.entries.len(), 7);
    assert_eq!(
        fields.entries[0].script.as_ref().unwrap().source,
        "emit(9007199254740993L);"
    );
    assert!(!format!("{fields:?}").contains("9007199254740993"));
    let encoded = serde_json::to_string(&fields).unwrap();
    assert_eq!(
        serde_json::from_str::<RuntimeFields>(&encoded).unwrap(),
        fields
    );
}

#[test]
fn query_body_preserves_numbers_source_and_names_with_no_mapping_write_contract() {
    let raw = r#"{"runtime_mappings":{"n":{"type":"long","script":{"lang":"painless","source":"emit(9007199254740993L);"}},"tag":{"type":"keyword"}},"query":{"term":{"id":9007199254740993}},"boost":1E+400,"fields":["n"]}"#;
    assert_eq!(query::validate_search_body(raw).unwrap(), raw.as_bytes());
    for raw in [
        r#"{}"#,
        r#"{"runtime_mappings":{}}"#,
        r#"{"runtime_mappings":{"n":{"type":"long","script":{"source":"emit(1);"}}}}"#,
    ] {
        query::validate_search_body(raw).unwrap();
    }
}

#[test]
fn unsupported_types_scripts_nulls_and_unknown_options_are_refused() {
    for mapping in [
        json!(null),
        json!({}),
        json!({"type":"lookup","target_index":"other"}),
        json!({"type":"composite","fields":{}}),
        json!({"type":"date_nanos"}),
        json!({"type":"long","on_script_error":"continue"}),
        json!({"type":"long","script":null}),
        json!({"type":"long","script":"emit(1)"}),
        json!({"type":"long","script":{"id":"stored-script"}}),
        json!({"type":"long","script":{"source":""}}),
        json!({"type":"long","script":{"source":"emit(1);","lang":"javascript"}}),
        json!({"type":"long","script":{"source":"emit(1);","lang":null}}),
        json!({"type":"long","script":{"source":"emit(params.n);","params":{"n":1}}}),
        json!({"type":"long","script":{"source":"emit(1);","options":{}}}),
        json!({"type":"long","script":{"source":"emit(1);\u{0}"}}),
    ] {
        let raw = json!({"runtime_mappings":{"n":mapping}}).to_string();
        assert_eq!(
            query::validate_search_body(&raw).unwrap_err().code,
            "invalidRuntimeFields"
        );
    }
    for raw in [r#"{"runtime_mappings":null}"#, r#"{"runtime_mappings":[]}"#] {
        assert_eq!(
            query::validate_search_body(raw).unwrap_err().code,
            "invalidRuntimeFields"
        );
    }
}

#[test]
fn duplicate_names_escaped_keys_and_nested_script_keys_fail_before_deserialization() {
    for raw in [
        r#"{"runtime_mappings":{},"runtime_mappings":{}}"#,
        r#"{"runtime_mappings":{"n":{"type":"long"},"\u006e":{"type":"long"}}}"#,
        r#"{"runtime_mappings":{"n":{"type":"long","type":"keyword"}}}"#,
        r#"{"runtime_mappings":{"n":{"type":"long","script":{"source":"emit(1);","source":"emit(2);"}}}}"#,
    ] {
        assert_eq!(
            query::validate_search_body(raw).unwrap_err().code,
            "invalidQuery"
        );
    }
}

#[test]
fn definitions_reject_unknown_versions_nulls_options_and_duplicate_fields() {
    for raw in [
        r#"{"version":2,"entries":[]}"#,
        r#"{"version":1,"entries":[],"endpoint":"https://fixture.test"}"#,
        r#"{"version":1,"entries":[{"field":"n","type":"long","script":null}]}"#,
        r#"{"version":1,"entries":[{"field":"n","type":"long","script":{"source":"emit(1);","source":"emit(2);"}}]}"#,
        r#"{"version":1,"version":1,"entries":[]}"#,
        r#"{"version":1,"entries":[{"field":"n","type":"long"},{"field":"n","type":"long"}]}"#,
    ] {
        assert!(match serde_json::from_str::<RuntimeFields>(raw) {
            Ok(fields) => fields.validate().is_err(),
            Err(_) => true,
        });
    }
}

#[test]
fn field_names_scripts_count_and_serialized_bytes_are_bounded() {
    for name in [
        "",
        " n",
        "n ",
        "$param",
        "_source",
        "_id",
        "x*",
        "?",
        "\u{7f}",
        "\u{85}",
        &"x".repeat(1025),
        &"\u{4e2d}".repeat(342),
    ] {
        let raw = json!({"runtime_mappings":{name:{"type":"keyword"}}}).to_string();
        assert!(query::validate_search_body(&raw).is_err());
    }
    for source in ["x".repeat(4097), "\u{4e2d}".repeat(1366)] {
        let raw = json!({"runtime_mappings":{"n":{"type":"long","script":{"source":source}}}})
            .to_string();
        assert!(query::validate_search_body(&raw).is_err());
    }
    let raw =
        json!({"runtime_mappings":{"n":{"type":"long","script":{"source":"x".repeat(4096)}}}})
            .to_string();
    query::validate_search_body(&raw).unwrap();
    let mut fields = fixture();
    let base = fields.entries[0].clone();
    fields.entries = (0..32)
        .map(|i| RuntimeField {
            field: format!("n{i}"),
            ..base.clone()
        })
        .collect();
    fields.validate().unwrap();
    fields.entries.push(RuntimeField {
        field: "extra".into(),
        ..base
    });
    assert!(fields.validate().is_err());
    fields.entries.pop();
    for entry in &mut fields.entries {
        entry.script.as_mut().unwrap().source = "\"".repeat(2048);
    }
    assert!(serde_json::to_vec(&fields).unwrap().len() > MAX_BYTES);
    assert!(fields.validate().is_err());
    let mappings: BTreeMap<_, _> = fields
        .entries
        .iter()
        .map(|field| {
            (
                &field.field,
                RuntimeMapping {
                    field_type: field.field_type.clone(),
                    script: field.script.clone(),
                },
            )
        })
        .collect();
    assert!(
        query::validate_search_body(&json!({"runtime_mappings":mappings}).to_string()).is_err()
    );
}
