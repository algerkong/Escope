use super::*;
use crate::saved_queries::{load_library, save_checked};
use crate::storage::ConnectionInput;
use tempfile::tempdir;

const FIXTURE: &str = include_str!("../../../tests/fixtures/query-exchange-v1.json");
const NOW: &str = "2026-10-09T12:00:00.000Z";

fn bundle() -> QueryExchange {
    parse_text(FIXTURE).unwrap()
}
fn request(expected: SavedQueryLibrary, target: Option<(String, String)>) -> ExchangeImportRequest {
    ExchangeImportRequest {
        bundle: bundle(),
        expected,
        updated_at: NOW.to_owned(),
        mappings: vec![ConnectionMapping {
            source_key: "source-a".to_owned(),
            target: Nullable(target.map(|(connection_id, endpoint)| MappingTarget {
                connection_id,
                endpoint,
            })),
        }],
    }
}
fn database() -> (tempfile::TempDir, Database) {
    let directory = tempdir().unwrap();
    let database = Database::open(&directory.path().join("exchange.sqlite")).unwrap();
    (directory, database)
}

#[test]
fn shared_fixture_preserves_exact_literals_templates_and_closed_wire_shape() {
    let bundle = bundle();
    assert!(bundle.queries[0].dsl.contains("1.234567890123456789"));
    assert!(bundle.queries[1].dsl.contains("900719925474099312345"));
    assert!(bundle.queries[1].dsl.contains(r#"\u0061"#));
    let serialized = serde_json::to_string(&bundle).unwrap();
    assert_eq!(
        parse_text(&serialized).unwrap().queries[1].dsl,
        bundle.queries[1].dsl
    );
    assert!(!format!("{bundle:?}").contains("900719925474099312345"));
}

#[test]
fn unknown_versions_duplicate_keys_and_unknown_fields_are_refused() {
    assert_eq!(
        parse_text(&FIXTURE.replacen("\"version\": 1", "\"version\": 3", 1))
            .unwrap_err()
            .code,
        "exchangeVersion"
    );
    for bad in [
        FIXTURE.replacen("\"version\": 1", "\"version\": 1, \"version\": 1", 1),
        FIXTURE.replacen("\"version\": 1", "\"version\": 1, \"headers\": {}", 1),
        FIXTURE.replace(
            "\"label\": \"Fixture source\"",
            "\"label\": \"Fixture source\", \"credentialRef\": \"fixture\"",
        ),
        FIXTURE.replace(
            "\"favorite\": false",
            "\"favorite\": false, \"results\": []",
        ),
        FIXTURE.replace(
            "\"type\": \"number\"",
            "\"type\": \"number\", \"value\": \"fixture\"",
        ),
        FIXTURE.replace("\"type\": \"number\"", "\"type\": \"secret\""),
        FIXTURE.replace(
            "\"connectionKey\": null",
            "\"connectionKey\": null, \"connectionKey\": null",
        ),
        format!("{FIXTURE}garbage"),
    ] {
        assert_eq!(parse_text(&bad).unwrap_err().code, "exchangeInvalid");
    }
}

#[test]
fn sensitive_keys_and_authentication_literals_are_refused_at_every_depth() {
    for key in [
        "authorization",
        "Authorization",
        "credential_ref",
        "api-key",
        "password",
        "headers",
        "privateKey",
    ] {
        let raw = serde_json::json!({"query":{"term":{key:"fixture"}}}).to_string();
        assert_eq!(check_dsl(&raw, None).unwrap_err().code, "exchangeSensitive");
    }
    assert_eq!(
        check_dsl(r#"{"q":{"\u0061uthorization":"fixture"}}"#, None)
            .unwrap_err()
            .code,
        "exchangeSensitive"
    );
    for literal in [
        "Bearer fixture-only",
        "Authorization: fixture-only",
        "-----BEGIN RSA PRIVATE KEY-----",
        "credential:fixture",
    ] {
        let raw = serde_json::json!({"query":{"term":{"value":literal}}}).to_string();
        assert_eq!(check_dsl(&raw, None).unwrap_err().code, "exchangeSensitive");
    }
}

#[test]
fn serde_private_number_tags_cannot_hide_sensitive_fields_or_placeholders() {
    for raw in [
        r#"{"$serde_json::private::Number":"1","authorization":"fixture"}"#,
        r#"{"query":{"$serde_json::private::Number":"1","authorization":"fixture"}}"#,
    ] {
        assert_eq!(check_dsl(raw, None).unwrap_err().code, "exchangeSensitive");
    }
    assert!(check_dsl(
        r#"{"q":{"$serde_json::private::Number":"1","$param":"x"}}"#,
        None
    )
    .is_err());
    assert!(check_dsl(
        r#"{"q":{"$serde_json::private::Number":"1","other":900719925474099312345}}"#,
        None
    )
    .is_ok());
}

#[test]
fn templates_require_declared_whole_value_placeholders_and_no_bound_values() {
    let good = bundle();
    let parameters = good.queries[0].parameters.as_ref().unwrap();
    assert!(check_dsl(&parameters.template, Some(parameters)).is_ok());
    assert!(check_dsl(&parameters.template, None).is_err());
    assert!(check_dsl("{}", Some(parameters)).is_err());
    for raw in [
        r#"{"query":{"$param":"missing"}}"#,
        r#"{"$param":"minimum"}"#,
        r#"{"query":{"$param":"minimum","extra":1}}"#,
        r#"{"query":{},"query":{}}"#,
    ] {
        let mut changed = parameters.clone();
        changed.template = raw.to_owned();
        assert!(check_dsl(raw, Some(&changed)).is_err());
    }
}

#[test]
fn missing_or_duplicate_mapping_never_guesses_from_existing_names() {
    let (_directory, mut database) = database();
    database
        .save_connection(
            ConnectionInput {
                display_name: "Fixture source".to_owned(),
                endpoint: "https://fixture.test".to_owned(),
                environment: "development".to_owned(),
            },
            None,
        )
        .unwrap();
    let mut missing = request(SavedQueryLibrary::empty(), None);
    missing.mappings.clear();
    assert_eq!(
        import_bundle(&mut database, missing).unwrap_err().code,
        "exchangeMappingRequired"
    );
    let mut duplicate = request(SavedQueryLibrary::empty(), None);
    duplicate.mappings.push(ConnectionMapping {
        source_key: "source-a".to_owned(),
        target: Nullable(None),
    });
    assert_eq!(
        import_bundle(&mut database, duplicate).unwrap_err().code,
        "exchangeMappingRequired"
    );
    assert!(database.saved_queries_json().unwrap().is_none());
    let explicit = import_bundle(&mut database, request(SavedQueryLibrary::empty(), None)).unwrap();
    assert!(explicit
        .entries
        .iter()
        .all(|entry| entry.connection_id.is_none()));
}

#[test]
fn import_is_one_append_with_new_ids_exact_values_and_no_workspace_write() {
    let (_directory, mut database) = database();
    let target = database
        .save_connection(
            ConnectionInput {
                display_name: "Local target".to_owned(),
                endpoint: "https://local.test/es".to_owned(),
                environment: "staging".to_owned(),
            },
            None,
        )
        .unwrap()
        .profile;
    let imported = import_bundle(
        &mut database,
        request(
            SavedQueryLibrary::empty(),
            Some((target.id.clone(), target.endpoint)),
        ),
    )
    .unwrap();
    assert_eq!(imported.entries.len(), 2);
    assert_eq!(
        imported.entries[0].connection_id.as_deref(),
        Some(target.id.as_str())
    );
    assert!(imported.entries[1].connection_id.is_none());
    assert_ne!(imported.entries[0].id, bundle().queries[0].key);
    assert_ne!(imported.entries[0].id, imported.entries[1].id);
    assert_eq!(imported.entries[0].updated_at, NOW);
    assert_eq!(imported.entries[1].dsl, bundle().queries[1].dsl);
    assert_eq!(imported, load_library(&mut database).unwrap());
    assert!(database.workspace_recovery_row().unwrap().is_none());
    assert!(crate::query::validate_search_body(&imported.entries[0].dsl).is_err());
    assert_eq!(database.connection_summaries().unwrap().len(), 1);
}

#[test]
fn changed_or_removed_mapping_is_checked_in_the_same_transaction_and_keeps_library() {
    let (_directory, mut database) = database();
    let profile = database
        .save_connection(
            ConnectionInput {
                display_name: "Local".to_owned(),
                endpoint: "https://old.test/".to_owned(),
                environment: "development".to_owned(),
            },
            None,
        )
        .unwrap()
        .profile;
    database
        .save_connection(
            ConnectionInput {
                display_name: "Local".to_owned(),
                endpoint: "https://new.test/".to_owned(),
                environment: "development".to_owned(),
            },
            Some(profile.id.clone()),
        )
        .unwrap();
    let error = import_bundle(
        &mut database,
        request(
            SavedQueryLibrary::empty(),
            Some((profile.id.clone(), profile.endpoint.clone())),
        ),
    )
    .unwrap_err();
    assert_eq!(error.code, "exchangeTargetChanged");
    assert!(database.saved_queries_json().unwrap().is_none());
    database
        .run_sql_for_test("DELETE FROM connections")
        .unwrap();
    let error = import_bundle(
        &mut database,
        request(
            SavedQueryLibrary::empty(),
            Some((profile.id, profile.endpoint)),
        ),
    )
    .unwrap_err();
    assert_eq!(error.code, "exchangeTargetChanged");
    assert!(database.saved_queries_json().unwrap().is_none());
}

#[test]
fn old_saves_and_repeated_imports_conflict_without_overwriting_or_duplicating() {
    let (_directory, mut database) = database();
    let first = import_bundle(&mut database, request(SavedQueryLibrary::empty(), None)).unwrap();
    let bytes = database.saved_queries_json().unwrap();
    assert_eq!(
        import_bundle(&mut database, request(SavedQueryLibrary::empty(), None))
            .unwrap_err()
            .code,
        "libraryConflict"
    );
    assert_eq!(
        save_checked(
            &mut database,
            SavedQueryLibrary::empty(),
            SavedQueryLibrary::empty(),
            &[]
        )
        .unwrap_err()
        .code,
        "libraryConflict"
    );
    assert_eq!(bytes, database.saved_queries_json().unwrap());
    let second = import_bundle(&mut database, request(first.clone(), None)).unwrap();
    assert_eq!(&second.entries[..2], first.entries.as_slice());
    assert_eq!(second.entries.len(), 4);
    assert_eq!(
        second
            .entries
            .iter()
            .map(|entry| &entry.id)
            .collect::<HashSet<_>>()
            .len(),
        4
    );
}

#[test]
fn corrupt_or_future_library_is_never_repaired_by_import_or_save() {
    let (_directory, mut database) = database();
    for raw in [
        r#"{"version":9,"entries":[]}"#,
        "damaged",
        r#"{"version":1,"entries":[],"headers":{}}"#,
    ] {
        database.save_saved_queries_json(raw).unwrap();
        assert_eq!(
            import_bundle(&mut database, request(SavedQueryLibrary::empty(), None))
                .unwrap_err()
                .code,
            "invalidResponse"
        );
        assert_eq!(
            save_checked(
                &mut database,
                SavedQueryLibrary::empty(),
                SavedQueryLibrary::empty(),
                &[]
            )
            .unwrap_err()
            .code,
            "invalidResponse"
        );
        assert_eq!(database.saved_queries_json().unwrap().as_deref(), Some(raw));
    }
}

#[test]
fn file_size_encoding_and_count_limits_fail_without_importing_a_subset() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("definitions.json");
    std::fs::write(&path, FIXTURE).unwrap();
    assert_eq!(read_file(&path).unwrap().queries.len(), 2);
    std::fs::write(&path, [0xff, 0xfe]).unwrap();
    assert_eq!(read_file(&path).unwrap_err().code, "exchangeInvalid");
    std::fs::write(&path, vec![b' '; MAX_BYTES + 1]).unwrap();
    assert_eq!(read_file(&path).unwrap_err().code, "exchangeTooLarge");
    assert_eq!(
        read_file(&directory.path().join("missing"))
            .unwrap_err()
            .code,
        "importFailed"
    );
    let mut too_many = bundle();
    too_many.queries = (0..101)
        .map(|i| {
            let mut query = too_many.queries[1].clone();
            query.key = format!("q{i}");
            query
        })
        .collect();
    assert_eq!(too_many.validate().unwrap_err().code, "exchangeTooLarge");
    let (_directory, mut database) = database();
    let imported = import_bundle(&mut database, request(SavedQueryLibrary::empty(), None)).unwrap();
    let mut full = imported;
    full.entries = (0..99)
        .map(|i| {
            let mut entry = full.entries[1].clone();
            entry.id = format!("entry{i}");
            entry
        })
        .collect();
    let expected = load_library(&mut database).unwrap();
    save_checked(&mut database, full.clone(), expected, &[]).unwrap();
    let bytes = database.saved_queries_json().unwrap();
    assert_eq!(
        import_bundle(&mut database, request(full, None))
            .unwrap_err()
            .code,
        "exchangeTooLarge"
    );
    assert_eq!(database.saved_queries_json().unwrap(), bytes);
}
