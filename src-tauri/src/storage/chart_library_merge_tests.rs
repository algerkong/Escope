use super::*;

const LEGACY: &str = r#"{
  "version":1,"entries":[{"id":"legacy","name":"Previous","connectionId":"deleted_connection",
  "index":"events-*","chartType":"bar","clauses":[{"id":"clause","name":"kinds",
  "aggregationType":"terms","field":"kind","size":23}],"updatedAt":"2026-10-13T00:00:00Z"}]
}"#;
const CANONICAL: &str = r#"{
  "version":1,"entries":[{"id":"canonical","name":"Current","connectionId":"deleted_connection",
  "index":"events-*","draft":{"group":{"name":"kinds","type":"terms","field":"kind","size":"23"},
  "metrics":[]},"measure":"doc_count"}]
}"#;

fn v8(path: &Path) -> Connection {
    let conn = Connection::open(path).unwrap();
    for migration in [
        include_str!("../../migrations/001_initial.sql"),
        include_str!("../../migrations/002_credentials.sql"),
        include_str!("../../migrations/003_models.sql"),
        include_str!("../../migrations/004_model_credentials.sql"),
        include_str!("../../migrations/005_connection_settings.sql"),
        include_str!("../../migrations/006_workspace_recovery.sql"),
        include_str!("../../migrations/007_data_views.sql"),
        include_str!("../../migrations/008_pinned_filters.sql"),
    ] {
        conn.execute_batch(migration).unwrap();
    }
    conn
}

fn prior(path: &Path, legacy: bool, canonical: bool) -> Connection {
    let conn = v8(path);
    if legacy {
        conn.execute_batch(include_str!("../../migrations/009_saved_charts.sql"))
            .unwrap();
        conn.execute("INSERT INTO saved_chart_library VALUES(1,7,?1)", [LEGACY])
            .unwrap();
    }
    if canonical {
        conn.execute_batch(include_str!("../../migrations/009_chart_definitions.sql"))
            .unwrap();
        conn.execute(
            "INSERT INTO chart_definition_library VALUES(1,11,?1)",
            [CANONICAL],
        )
        .unwrap();
    }
    conn
}

fn version(conn: &Connection) -> i64 {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap()
}

fn stored(conn: &Connection, table: &str) -> (i64, String) {
    conn.query_row(
        &format!("SELECT revision,json FROM {table} WHERE singleton=1"),
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .unwrap()
}

#[test]
fn either_v9_branch_and_coexisting_libraries_upgrade_without_rewriting_rows() {
    for (legacy, canonical) in [(true, false), (false, true), (true, true)] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("prior.sqlite");
        drop(prior(&path, legacy, canonical));
        for _ in 0..2 {
            let db = Database::open(&path).unwrap();
            assert_eq!(version(&db.0), 10);
            assert_eq!(
                db.saved_charts().unwrap().revision,
                if legacy { 7 } else { 0 }
            );
            assert_eq!(
                db.chart_definitions().unwrap().revision,
                if canonical { 11 } else { 0 }
            );
            if legacy {
                assert_eq!(stored(&db.0, "saved_chart_library"), (7, LEGACY.into()));
            }
            if canonical {
                assert_eq!(
                    stored(&db.0, "chart_definition_library"),
                    (11, CANONICAL.into())
                );
            }
        }
    }
}

#[test]
fn fresh_and_v8_databases_have_two_empty_independent_bounded_libraries() {
    for existing in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("fresh.sqlite");
        if existing {
            drop(v8(&path));
        }
        let db = Database::open(&path).unwrap();
        assert_eq!(version(&db.0), 10);
        assert_eq!(db.saved_charts().unwrap().revision, 0);
        assert_eq!(db.chart_definitions().unwrap().revision, 0);
        for table in ["saved_chart_library", "chart_definition_library"] {
            for (singleton, revision, json) in [
                (2, 1_i64, "{}".to_string()),
                (1, 0, "{}".to_string()),
                (1, 9_007_199_254_740_992, "{}".to_string()),
                (1, 1, "x".repeat(262_145)),
            ] {
                assert!(db
                    .0
                    .execute(
                        &format!("INSERT INTO {table} VALUES(?1,?2,?3)"),
                        params![singleton, revision, json],
                    )
                    .is_err());
            }
        }
    }
}

#[test]
fn v9_without_a_chart_table_is_not_silently_treated_as_a_fresh_database() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("missing.sqlite");
    let conn = v8(&path);
    conn.pragma_update(None, "user_version", 9).unwrap();
    drop(conn);
    assert!(Database::open(&path).is_err());
    let conn = Connection::open(&path).unwrap();
    assert_eq!(version(&conn), 9);
    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name IN ('saved_chart_library','chart_definition_library')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn malformed_known_tables_are_refused_without_repair_or_version_changes() {
    for ddl in [
        "CREATE TABLE saved_chart_library(singleton INTEGER PRIMARY KEY,revision INTEGER,json TEXT)",
        "CREATE TABLE saved_chart_library(singleton INTEGER PRIMARY KEY,revision INTEGER,json BLOB)",
        "CREATE VIEW saved_chart_library AS SELECT 1 AS singleton,1 AS revision,'{}' AS json",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("malformed.sqlite");
        let conn = prior(&path, false, true);
        conn.execute_batch(ddl).unwrap();
        drop(conn);
        assert!(Database::open(&path).is_err());
        let conn = Connection::open(&path).unwrap();
        assert_eq!(version(&conn), 9);
        assert_eq!(
            stored(&conn, "chart_definition_library"),
            (11, CANONICAL.into())
        );
    }
}

#[test]
fn rolling_back_the_upgrade_restores_the_original_tables_and_version() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("rollback.sqlite");
    let mut conn = prior(&path, true, false);
    {
        let tx = conn.transaction().unwrap();
        merge_chart_library_schemas(&tx).unwrap();
        assert_eq!(version(&tx), 10);
        assert!(tx
            .execute("INSERT INTO missing_table VALUES(1)", [])
            .is_err());
    }
    assert_eq!(version(&conn), 9);
    assert_eq!(stored(&conn, "saved_chart_library"), (7, LEGACY.into()));
    assert!(read_chart_definitions(&conn).is_err());
}

#[test]
fn a_corrupt_document_is_preserved_and_still_refuses_reads_and_writes() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("corrupt-document.sqlite");
    let conn = prior(&path, true, false);
    conn.execute(
        "UPDATE saved_chart_library SET json=?1 WHERE singleton=1",
        [r#"{"version":99,"entries":[]}"#],
    )
    .unwrap();
    drop(conn);
    let mut db = Database::open(&path).unwrap();
    assert_eq!(version(&db.0), 10);
    assert!(db.saved_charts().is_err());
    assert!(db
        .save_saved_charts(7, &SavedChartLibrary::empty())
        .is_err());
    assert_eq!(
        stored(&db.0, "saved_chart_library"),
        (7, r#"{"version":99,"entries":[]}"#.into())
    );
    assert_eq!(db.chart_definitions().unwrap().revision, 0);
}

#[test]
fn the_two_libraries_keep_independent_cas_and_connection_ownership() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("cas.sqlite");
    let mut db = Database::open(&path).unwrap();
    let profile = db
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
    let mut legacy: SavedChartLibrary = serde_json::from_str(LEGACY).unwrap();
    legacy.entries[0].connection_id = crate::workspace_recovery::Nullable(Some(profile.id.clone()));
    let mut canonical: ChartDefinitionLibrary = serde_json::from_str(CANONICAL).unwrap();
    canonical.entries[0].connection_id = profile.id;
    assert_eq!(db.save_saved_charts(0, &legacy).unwrap(), 1);
    assert_eq!(db.chart_definitions().unwrap().revision, 0);
    assert_eq!(db.save_chart_definitions(0, &canonical).unwrap(), 1);
    assert_eq!(
        db.save_saved_charts(0, &legacy).unwrap_err().code,
        "savedChartConflict"
    );
    assert_eq!(
        db.save_chart_definitions(0, &canonical).unwrap_err().code,
        "chartDefinitionConflict"
    );
    let before = canonical.clone();
    canonical.entries[0].connection_id = "different".into();
    assert!(db.save_chart_definitions(1, &canonical).is_err());
    assert_eq!(db.chart_definitions().unwrap().library, before);
    assert_eq!(db.saved_charts().unwrap().library, legacy);
}

#[test]
fn future_versions_are_refused_without_touching_either_document() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("future.sqlite");
    let conn = prior(&path, true, true);
    conn.pragma_update(None, "user_version", 11).unwrap();
    drop(conn);
    assert_eq!(Database::open(&path).err().unwrap().code, "unsupported");
    let conn = Connection::open(&path).unwrap();
    assert_eq!(version(&conn), 11);
    assert_eq!(stored(&conn, "saved_chart_library"), (7, LEGACY.into()));
    assert_eq!(
        stored(&conn, "chart_definition_library"),
        (11, CANONICAL.into())
    );
}
