use super::*;
use crate::connection_auth::EsAuthMaterial;
use crate::credentials::{CredentialError, CredentialRef, Secret};
use crate::storage::{AuthKind, ConnectionInput, Database};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::fs;
use std::io::{Read as IoRead, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Mutex};
use tempfile::tempdir;
use tokio::sync::Notify;

const FIXTURE: &str = include_str!("../../../tests/fixtures/query-export-v1.json");
const OPEN: &str = r#"{"id":"export-pit-1"}"#;
const CLOSE: &str = r#"{"succeeded":true,"num_freed":1}"#;

fn request() -> SnapshotExportRequest {
    serde_json::from_value::<SnapshotExportRequest>(
        serde_json::from_str::<Value>(FIXTURE).unwrap()["request"].clone(),
    )
    .unwrap()
}

fn hit(id: u64, cursor: &str) -> String {
    format!(
        r#"{{"_index":"orders-1","_id":"{id}","_source":{{"n":9007199254740993,"x":-0,"p":1.234567890123456789,"escape":"\u0061"}},"sort":{cursor}}}"#
    )
}

fn page(hits: &[String], pit: &str) -> String {
    format!(
        r#"{{"pit_id":"{pit}","timed_out":false,"_shards":{{"total":1,"successful":1,"skipped":0,"failed":0}},"hits":{{"total":{{"value":0,"relation":"gte"}},"hits":[{}]}}}}"#,
        hits.join(",")
    )
}

#[derive(Debug)]
enum Recorded {
    Open(String),
    Page(String),
    Close(String),
}
enum Reply {
    Raw(String),
    Error(&'static str),
    Wait,
    Change(String),
}

struct MockTransport {
    replies: Mutex<VecDeque<Reply>>,
    requests: Mutex<Vec<Recorded>>,
    valid: AtomicBool,
    waiting: Notify,
}

impl MockTransport {
    fn new(replies: Vec<Reply>) -> Self {
        Self {
            replies: Mutex::new(replies.into()),
            requests: Mutex::new(vec![]),
            valid: AtomicBool::new(true),
            waiting: Notify::new(),
        }
    }
    fn success(pages: Vec<String>) -> Self {
        Self::new(
            std::iter::once(Reply::Raw(OPEN.into()))
                .chain(pages.into_iter().map(Reply::Raw))
                .chain(std::iter::once(Reply::Raw(CLOSE.into())))
                .collect(),
        )
    }
}

impl ExportTransport for MockTransport {
    fn check_target(&self) -> Result<(), AppError> {
        if self.valid.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(AppError::new("exportTargetChanged"))
        }
    }
    async fn send(&self, read: Read, cancel: &mut Cancellation) -> Result<Vec<u8>, AppError> {
        self.requests.lock().unwrap().push(match read {
            Read::Open(index) => Recorded::Open(index.as_str().into()),
            Read::Page(body) => Recorded::Page(String::from_utf8(body).unwrap()),
            Read::Close(id) => Recorded::Close(id),
        });
        let reply = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("no unplanned reads");
        match reply {
            Reply::Raw(raw) => Ok(raw.into_bytes()),
            Reply::Error(code) => Err(AppError::new(code)),
            Reply::Wait => {
                self.waiting.notify_one();
                cancel.cancelled().await;
                Err(AppError::new("cancelled"))
            }
            Reply::Change(raw) => {
                self.valid.store(false, Ordering::SeqCst);
                Ok(raw.into_bytes())
            }
        }
    }
}

async fn execute(
    request: &SnapshotExportRequest,
    path: &Path,
    transport: &impl ExportTransport,
) -> SnapshotExportOutcome {
    run_export(
        request,
        &request.prepare().unwrap(),
        path,
        transport,
        &mut Cancellation::never(),
        Instant::now() + MAX_DURATION,
        &|_| Ok(()),
    )
    .await
}

#[test]
fn shared_contract_and_closed_request_envelope() {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    assert!(request().prepare().is_ok());
    assert!(request().raw_dsl.contains("9007199254740993"));
    let info = FileInfo {
        name: Some("escope-orders.jsonl".into()),
        rows: 2,
        bytes: 256,
        state: FileState::Complete,
    };
    assert_eq!(
        serde_json::to_value(SnapshotExportOutcome::new(
            &request(),
            info,
            None,
            PitCleanup::Closed
        ))
        .unwrap(),
        fixture["outcome"]
    );
    let progress = SnapshotExportProgress {
        request_id: request().request_id,
        connection_id: request().connection_id,
        phase: Phase::Writing,
        rows: 2,
        bytes: 256,
    };
    assert_eq!(serde_json::to_value(progress).unwrap(), fixture["progress"]);
    for (key, value) in [
        ("path", json!("arbitrary")),
        ("pitId", json!("workbench")),
        ("headers", json!({})),
        ("method", json!("DELETE")),
        ("url", json!("https://other.test")),
    ] {
        let mut raw = fixture["request"].clone();
        raw[key] = value;
        assert!(serde_json::from_value::<SnapshotExportRequest>(raw).is_err());
    }
    let duplicate = serde_json::to_string(&fixture["request"])
        .unwrap()
        .replacen('{', r#"{"requestId":"bad","#, 1);
    assert!(serde_json::from_str::<SnapshotExportRequest>(&duplicate).is_err());
}

#[test]
fn envelopes_and_scan_bodies_are_bounded_and_fail_closed() {
    for (rows, bytes) in [(0, 1), (MAX_ROWS + 1, 1), (1, 0), (1, MAX_BYTES + 1)] {
        let mut input = request();
        input.max_rows = rows;
        input.max_bytes = bytes;
        assert!(input.prepare().is_err());
    }
    for name in ["../x.jsonl", "C:\\x.jsonl", "NUL.jsonl", ".jsonl", "x.csv"] {
        let mut input = request();
        input.file_name = name.into();
        assert!(input.prepare().is_err());
    }
    for endpoint in [
        "https://user:secret@es.test",
        "https://es.test/?key=x",
        "file:///x",
        "https://es.test/#x",
    ] {
        assert!(normalized_endpoint(endpoint).is_err());
    }
    assert_eq!(
        normalized_endpoint("HTTPS://ES.TEST:443/base").unwrap(),
        "https://es.test/base/"
    );
    for raw in [
        r#"{"size":0,"sort":["_shard_doc"]}"#,
        r#"{"size":1001,"sort":["_shard_doc"]}"#,
        r#"{"size":2,"sort":["_shard_doc"],"from":1}"#,
        r#"{"size":2,"sort":["_shard_doc"],"pit":{"id":"ui"}}"#,
        r#"{"size":2,"sort":["_shard_doc"],"aggs":{}}"#,
        r#"{"size":2,"sort":["_shard_doc"],"collapse":{"field":"n"}}"#,
        r#"{"size":2,"sort":["_shard_doc"],"terminate_after":10}"#,
        r#"{"size":2,"sort":["_shard_doc"],"runtime_mappings":{}}"#,
        r#"{"size":2,"sort":["_shard_doc"],"query":{"query_string":{"query":"time:[2026 TO now]"}}}"#,
        r#"{"size":2,"sort":["_shard_doc"],"query":{"terms":{"n":{"index":"other","id":"1","path":"n"}}}}"#,
        r#"{"size":2,"sort":["_shard_doc"],"query":{"function_score":{}}}"#,
        r#"{"size":2,"sort":["_shard_doc"],"query":{"terms_set":{"n":{"minimum_should_match_script":{"source":"x"}}}}}"#,
        r#"{"size":2,"sort":["_shard_doc","n"]}"#,
        r#"{"size":2,"sort":[{"time":{"format":"dd/MM/yyyy"}},"_shard_doc"]}"#,
        r#"{"size":2,"sort":[{"a":"asc","b":"desc"},"_shard_doc"]}"#,
        r#"{"size":2,"sort":[42,"_shard_doc"]}"#,
        r#"{"size":2,"sort":["_shard_doc"],"query":{"term":{"n":1,"n":2}}}"#,
    ] {
        assert!(prepare_body(raw).is_err(), "{raw}");
    }
}

#[tokio::test]
async fn independent_pit_stream_rotates_tokens_preserves_numbers_and_requires_empty_eof() {
    let directory = tempdir().unwrap();
    let target = directory.path().join("result.jsonl");
    fs::write(&target, b"old").unwrap();
    let transport = MockTransport::success(vec![
        page(&[hit(1, "[9007199254740993]")], "export-pit-2"),
        page(&[hit(2, "[9007199254740994]")], "export-pit-3"),
        page(&[], "export-pit-4"),
    ]);
    let result = execute(&request(), &target, &transport).await;
    assert_eq!(result.status, ExportStatus::Saved);
    assert_eq!(result.pit_cleanup, PitCleanup::Closed);
    assert_eq!(result.rows, 2);
    let output = fs::read_to_string(&target).unwrap();
    assert_eq!(output.lines().count(), 2);
    for token in ["9007199254740993", "-0", "1.234567890123456789", "\\u0061"] {
        assert!(output.contains(token));
    }
    let calls = transport.requests.lock().unwrap();
    assert!(matches!(&calls[0], Recorded::Open(index) if index == "orders-*"));
    assert!(
        matches!(&calls[1], Recorded::Page(body) if body.contains("export-pit-1") && !body.contains("search_after"))
    );
    assert!(
        matches!(&calls[2], Recorded::Page(body) if body.contains("export-pit-2") && body.contains(r#""search_after":[9007199254740993]"#))
    );
    assert!(matches!(&calls[4], Recorded::Close(id) if id == "export-pit-4"));
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[tokio::test]
async fn zero_hits_and_fixed_csv_schema_do_not_require_accumulating_fields() {
    for format in [ExportFormat::Csv, ExportFormat::Jsonl] {
        let directory = tempdir().unwrap();
        let target = directory.path().join("empty");
        let mut input = request();
        input.format = format;
        input.file_name = if format == ExportFormat::Csv {
            "x.csv"
        } else {
            "x.jsonl"
        }
        .into();
        let transport = MockTransport::success(vec![page(&[], "empty-pit")]);
        let result = execute(&input, &target, &transport).await;
        assert_eq!(result.status, ExportStatus::Saved);
        assert_eq!(result.rows, 0);
        assert_eq!(
            fs::read(&target).unwrap(),
            if format == ExportFormat::Csv {
                encoding::CSV_HEADER
            } else {
                b""
            }
        );
    }
    let directory = tempdir().unwrap();
    let target = directory.path().join("rows.csv");
    let mut input = request();
    input.format = ExportFormat::Csv;
    input.file_name = "rows.csv".into();
    let rows = vec![
        r#"{"_index":"orders-1","_id":" \uFEFF=1","_source":{"early":-0,"n":9007199254740993},"sort":[1]}"#.into(),
        r#"{"_index":"orders-1","_id":"2","fields":{"new":[1.234567890123456789]},"sort":[2]}"#.into(),
    ];
    let transport = MockTransport::success(vec![
        page(&rows[..1], "csv-2"),
        page(&rows[1..], "csv-3"),
        page(&[], "csv-4"),
    ]);
    let result = execute(&input, &target, &transport).await;
    assert_eq!(result.status, ExportStatus::Saved);
    let content = fs::read_to_string(target).unwrap();
    assert!(content.starts_with(std::str::from_utf8(encoding::CSV_HEADER).unwrap()));
    assert!(content.contains("' \u{feff}=1"));
    assert!(content.contains("9007199254740993") && content.contains("1.234567890123456789"));
    assert!(content.contains("orders-1,2,,"));
}

#[tokio::test]
async fn limits_never_replace_the_previous_file_or_overrun_the_quota() {
    for row_limit in [true, false] {
        let directory = tempdir().unwrap();
        let target = directory.path().join("bounded.jsonl");
        fs::write(&target, b"keep").unwrap();
        let first = hit(1, "[1]");
        let mut input = request();
        if row_limit {
            input.max_rows = 1;
        } else {
            input.max_bytes = first.len() as u64 + 1;
        }
        let transport =
            MockTransport::success(vec![page(&[first.clone(), hit(2, "[2]")], "bounded-pit")]);
        let result = execute(&input, &target, &transport).await;
        assert_eq!(result.status, ExportStatus::Limited);
        assert_eq!(
            result.reason,
            Some(if row_limit { "rowLimit" } else { "byteLimit" })
        );
        assert_eq!(result.file_state, FileState::Partial);
        assert_eq!(result.rows, 1);
        assert_eq!(result.bytes, first.len() as u64 + 1);
        assert_eq!(fs::read(&target).unwrap(), b"keep");
        let partial = directory.path().join(result.file_name.unwrap());
        assert!(partial
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains(".partial-"));
        assert_eq!(fs::read_to_string(partial).unwrap(), format!("{first}\n"));
        assert_eq!(result.pit_cleanup, PitCleanup::Closed);
    }
}

#[tokio::test]
async fn exact_row_limit_requires_one_eof_probe_and_never_guesses_from_total_or_short_page() {
    for empty in [true, false] {
        let directory = tempdir().unwrap();
        let target = directory.path().join("limit.jsonl");
        let mut input = request();
        input.max_rows = 2;
        let next = if empty { vec![] } else { vec![hit(3, "[3]")] };
        let transport = MockTransport::success(vec![
            page(&[hit(1, "[1]"), hit(2, "[2]")], "limit-2"),
            page(&next, "limit-3"),
        ]);
        let result = execute(&input, &target, &transport).await;
        assert_eq!(
            result.status,
            if empty {
                ExportStatus::Saved
            } else {
                ExportStatus::Limited
            }
        );
        assert_eq!(result.rows, 2);
        assert_eq!(
            transport
                .requests
                .lock()
                .unwrap()
                .iter()
                .filter(|read| matches!(read, Recorded::Page(_)))
                .count(),
            2
        );
    }
}

#[tokio::test]
async fn csv_header_counts_toward_the_byte_limit_before_any_pit_is_opened() {
    let directory = tempdir().unwrap();
    let mut input = request();
    input.format = ExportFormat::Csv;
    input.file_name = "x.csv".into();
    input.max_bytes = 1;
    let transport = MockTransport::new(vec![]);
    let result = execute(&input, &directory.path().join("x.csv"), &transport).await;
    assert_eq!(result.reason, Some("byteLimit"));
    assert_eq!(result.bytes, 0);
    assert_eq!(result.file_state, FileState::Partial);
    assert_eq!(result.pit_cleanup, PitCleanup::NotOpened);
    assert!(transport.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn partial_or_malformed_pages_close_the_latest_usable_rotation_without_writing_them() {
    let good = page(&[hit(1, "[1]")], "latest");
    for raw in [
        good.replace("\"timed_out\":false", "\"timed_out\":true"),
        good.replace(
            "\"timed_out\":false",
            "\"timed_out\":false,\"terminated_early\":true",
        ),
        good.replace("\"successful\":1", "\"successful\":0")
            .replace("\"failed\":0", "\"failed\":1"),
        good.replace("\"successful\":1", "\"successful\":0"),
        good.replace("\"sort\":[1]", "\"sort\":[null]"),
        good.replace("\"_id\":\"1\"", "\"_id\":1"),
        good.replace("\"_id\":\"1\"", "\"_id\":\"1\",\"_id\":\"2\""),
    ] {
        let directory = tempdir().unwrap();
        let transport = MockTransport::success(vec![raw]);
        let result = execute(&request(), &directory.path().join("x"), &transport).await;
        assert_ne!(result.status, ExportStatus::Saved);
        assert_eq!(result.rows, 0);
        assert_eq!(result.pit_cleanup, PitCleanup::Closed);
        assert!(
            matches!(transport.requests.lock().unwrap().last(), Some(Recorded::Close(id)) if id == "latest")
        );
    }
}

#[tokio::test]
async fn repeated_or_backwards_cursors_never_become_a_successful_file() {
    for next in ["[9007199254740993]", "[9007199254740992]"] {
        let directory = tempdir().unwrap();
        let transport = MockTransport::success(vec![
            page(&[hit(1, "[9007199254740993]")], "first"),
            page(&[hit(2, next)], "second"),
        ]);
        let result = execute(&request(), &directory.path().join("x"), &transport).await;
        assert_eq!(result.reason, Some("invalidResponse"));
        assert_eq!(result.rows, 1);
        assert_eq!(result.pit_cleanup, PitCleanup::Closed);
    }
}

#[test]
fn cursor_order_uses_exact_primary_values_directions_and_missing_placement() {
    let raw = r#"{"size":2,"sort":[{"n":"desc"},"_shard_doc"]}"#;
    let prepared = prepare_body(raw).unwrap();
    let first = page(&[hit(1, "[1.0000000000000000002,9]")], "p");
    let first = encoding::page(first.as_bytes(), &prepared, None, ExportFormat::Jsonl).unwrap();
    let next = page(&[hit(2, "[1.0000000000000000001,1]")], "p");
    assert!(encoding::page(
        next.as_bytes(),
        &prepared,
        first.cursor.as_ref(),
        ExportFormat::Jsonl
    )
    .is_ok());
    let backwards = page(&[hit(2, "[1.0000000000000000003,99]")], "p");
    assert!(encoding::page(
        backwards.as_bytes(),
        &prepared,
        first.cursor.as_ref(),
        ExportFormat::Jsonl
    )
    .is_err());
    let prepared = prepare_body(
        r#"{"size":2,"sort":[{"n":{"order":"desc","missing":"_first"}},"_shard_doc"]}"#,
    )
    .unwrap();
    let first = encoding::page(
        page(&[hit(1, "[null,1]")], "p").as_bytes(),
        &prepared,
        None,
        ExportFormat::Jsonl,
    )
    .unwrap();
    assert!(encoding::page(
        page(&[hit(2, "[1,2]")], "p").as_bytes(),
        &prepared,
        first.cursor.as_ref(),
        ExportFormat::Jsonl
    )
    .is_ok());
}

#[tokio::test]
async fn target_changes_stop_the_scan_but_cleanup_still_uses_its_original_pit() {
    let directory = tempdir().unwrap();
    let transport = MockTransport::new(vec![
        Reply::Raw(OPEN.into()),
        Reply::Change(page(&[hit(1, "[1]")], "original-pit")),
        Reply::Raw(CLOSE.into()),
    ]);
    let result = execute(&request(), &directory.path().join("x"), &transport).await;
    assert_eq!(result.reason, Some("exportTargetChanged"));
    assert_eq!(result.rows, 1);
    assert!(
        matches!(transport.requests.lock().unwrap().last(), Some(Recorded::Close(id)) if id == "original-pit")
    );
}

#[tokio::test]
async fn early_cancel_and_expired_deadline_create_neither_file_nor_pit() {
    let directory = tempdir().unwrap();
    let input = request();
    let registry = RequestRegistry::default();
    let mut guard = registry
        .register(&input.request_id, &input.connection_id)
        .unwrap();
    registry.cancel(&input.request_id, &input.connection_id);
    let transport = MockTransport::new(vec![]);
    let result = run_export(
        &input,
        &input.prepare().unwrap(),
        &directory.path().join("x"),
        &transport,
        guard.cancellation(),
        Instant::now() + MAX_DURATION,
        &|_| Ok(()),
    )
    .await;
    assert_eq!(result.status, ExportStatus::Cancelled);
    assert_eq!(result.file_state, FileState::None);
    let result = run_export(
        &input,
        &input.prepare().unwrap(),
        &directory.path().join("x"),
        &transport,
        &mut Cancellation::never(),
        Instant::now(),
        &|_| Ok(()),
    )
    .await;
    assert_eq!(result.reason, Some("deadline"));
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn in_flight_cancel_retains_partial_and_reports_unseen_pit_rotation_as_pending() {
    let directory = tempdir().unwrap();
    let input = request();
    let registry = RequestRegistry::default();
    let mut guard = registry
        .register(&input.request_id, &input.connection_id)
        .unwrap();
    let transport = MockTransport::new(vec![
        Reply::Raw(OPEN.into()),
        Reply::Wait,
        Reply::Raw(CLOSE.into()),
    ]);
    let path = directory.path().join("x");
    let prepared = input.prepare().unwrap();
    let run = run_export(
        &input,
        &prepared,
        &path,
        &transport,
        guard.cancellation(),
        Instant::now() + MAX_DURATION,
        &|_| Ok(()),
    );
    let cancel = async {
        transport.waiting.notified().await;
        registry.cancel(&input.request_id, &input.connection_id);
    };
    let (result, ()) = tokio::join!(run, cancel);
    assert_eq!(result.status, ExportStatus::Cancelled);
    assert_eq!(result.file_state, FileState::Partial);
    assert_eq!(result.pit_cleanup, PitCleanup::Pending);
    assert!(
        matches!(transport.requests.lock().unwrap().last(), Some(Recorded::Close(id)) if id == "export-pit-1")
    );
}

#[tokio::test]
async fn deadline_interrupts_a_page_and_still_attempts_original_pit_cleanup() {
    let directory = tempdir().unwrap();
    let input = request();
    let transport = MockTransport::new(vec![
        Reply::Raw(OPEN.into()),
        Reply::Wait,
        Reply::Raw(CLOSE.into()),
    ]);
    let result = run_export(
        &input,
        &input.prepare().unwrap(),
        &directory.path().join("x"),
        &transport,
        &mut Cancellation::never(),
        Instant::now() + Duration::from_millis(500),
        &|_| Ok(()),
    )
    .await;
    assert_eq!(result.status, ExportStatus::Limited);
    assert_eq!(result.reason, Some("deadline"));
    assert_eq!(result.pit_cleanup, PitCleanup::Pending);
    assert!(
        matches!(transport.requests.lock().unwrap().last(), Some(Recorded::Close(id)) if id == "export-pit-1")
    );
}

#[test]
fn progress_is_throttled_but_phase_changes_publish_final_counters() {
    let input = request();
    let events = Mutex::new(vec![]);
    let sink = |event| {
        events.lock().unwrap().push(event);
        Ok(())
    };
    let mut progress = Progress {
        request: &input,
        sink: &sink,
        last: None,
    };
    let info = FileInfo::none();
    progress.emit(Phase::Writing, &info).unwrap();
    progress.emit(Phase::Writing, &info).unwrap();
    assert_eq!(events.lock().unwrap().len(), 1);
    progress
        .emit(
            Phase::Closing,
            &FileInfo {
                name: Some("x.partial-fixture".into()),
                rows: 7,
                bytes: 700,
                state: FileState::Partial,
            },
        )
        .unwrap();
    assert_eq!(events.lock().unwrap().len(), 2);
    assert_eq!(events.lock().unwrap()[1].rows, 7);
}

#[test]
fn malformed_hit_shapes_oversized_pages_and_cursor_payloads_are_refused() {
    let prepared = request().prepare().unwrap();
    let good = page(&[hit(1, "[1]")], "p");
    for raw in [
        good.replace("\"_source\":{", "\"_source\":{\"n\":2,"),
        good.replace("\"sort\":[1]", "\"sort\":[1,2]"),
        good.replace("\"sort\":[1]", "\"sort\":[{}]"),
        good.replace("\"sort\":[1]", "\"sort\":[]"),
        good.replace("\"relation\":\"gte\"", "\"relation\":\"unknown\""),
        page(&[hit(1, "[1]"), hit(2, "[2]"), hit(3, "[3]")], "p"),
    ] {
        assert!(encoding::page(raw.as_bytes(), &prepared, None, ExportFormat::Jsonl).is_err());
    }
    let huge = format!(r#"{{"padding":"{}"}}"#, "x".repeat(query::MAX_BODY_BYTES));
    assert!(encoding::page(huge.as_bytes(), &prepared, None, ExportFormat::Jsonl).is_err());
    let prepared = prepare_body(r#"{"size":2,"sort":["n","_shard_doc"]}"#).unwrap();
    let cursor = format!("[\"{}\",1]", "x".repeat(4096));
    assert!(encoding::page(
        page(&[hit(1, &cursor)], "p").as_bytes(),
        &prepared,
        None,
        ExportFormat::Jsonl
    )
    .is_err());
}

#[tokio::test]
async fn expired_pit_and_unknown_cleanup_are_never_replaced_with_a_new_snapshot() {
    for code in [
        "notFound",
        "timeout",
        "rateLimited",
        "credentialNotFound",
        "responseTooLarge",
    ] {
        let directory = tempdir().unwrap();
        let transport = MockTransport::new(vec![
            Reply::Raw(OPEN.into()),
            Reply::Error(code),
            Reply::Raw(CLOSE.into()),
        ]);
        let result = execute(&request(), &directory.path().join("x"), &transport).await;
        assert_eq!(result.reason, Some(code));
        assert_eq!(result.pit_cleanup, PitCleanup::Pending);
        assert_eq!(
            transport
                .requests
                .lock()
                .unwrap()
                .iter()
                .filter(|read| matches!(read, Recorded::Open(_)))
                .count(),
            1
        );
    }
    let directory = tempdir().unwrap();
    let transport = MockTransport::new(vec![
        Reply::Raw(OPEN.into()),
        Reply::Raw(page(&[], "done")),
        Reply::Error("networkError"),
    ]);
    let result = execute(&request(), &directory.path().join("x"), &transport).await;
    assert_eq!(result.status, ExportStatus::Saved);
    assert_eq!(result.pit_cleanup, PitCleanup::Pending);
}

#[tokio::test]
async fn invalid_open_or_rotation_and_unacknowledged_close_fail_honestly() {
    for raw in [
        r#"{"id":"opened","_shards":{"total":2,"successful":1,"failed":1}}"#,
        r#"{"id":null}"#,
        r#"{"id":"one","id":"two"}"#,
    ] {
        let directory = tempdir().unwrap();
        let replies = if raw.contains("\"opened\"") {
            vec![Reply::Raw(raw.into()), Reply::Raw(CLOSE.into())]
        } else {
            vec![Reply::Raw(raw.into())]
        };
        let result = execute(
            &request(),
            &directory.path().join("x"),
            &MockTransport::new(replies),
        )
        .await;
        assert_ne!(result.status, ExportStatus::Saved);
        assert_eq!(result.rows, 0);
    }
    assert!(encoding::pit_hint(br#"{"pit_id":null}"#, false).is_err());
    assert!(!encoding::closed(br#"{"succeeded":false,"num_freed":0}"#));
    assert!(!encoding::closed(br#"{"succeeded":true}"#));
}

#[tokio::test]
async fn channel_loss_cancels_before_commit_and_progress_has_no_payload_fields() {
    let directory = tempdir().unwrap();
    let input = request();
    let transport = MockTransport::success(vec![]);
    let events = Mutex::new(vec![]);
    let result = run_export(
        &input,
        &input.prepare().unwrap(),
        &directory.path().join("x"),
        &transport,
        &mut Cancellation::never(),
        Instant::now() + MAX_DURATION,
        &|event| {
            let phase = event.phase;
            events
                .lock()
                .unwrap()
                .push(serde_json::to_value(event).unwrap());
            if phase == Phase::Writing {
                Err(AppError::new("cancelled"))
            } else {
                Ok(())
            }
        },
    )
    .await;
    assert_eq!(result.status, ExportStatus::Cancelled);
    assert_eq!(result.pit_cleanup, PitCleanup::Closed);
    for event in events.lock().unwrap().iter() {
        assert_eq!(event.as_object().unwrap().len(), 5);
        assert!(
            event.get("rawDsl").is_none()
                && event.get("pitId").is_none()
                && event.get("path").is_none()
        );
    }
}

#[tokio::test]
async fn file_create_and_commit_failures_preserve_unrelated_paths() {
    let directory = tempdir().unwrap();
    let blocking_parent = directory.path().join("parent");
    fs::write(&blocking_parent, b"keep").unwrap();
    let transport = MockTransport::new(vec![]);
    let result = execute(&request(), &blocking_parent.join("x"), &transport).await;
    assert_eq!(result.file_state, FileState::None);
    assert_eq!(result.reason, Some("exportFailed"));
    assert!(transport.requests.lock().unwrap().is_empty());
    assert_eq!(fs::read(&blocking_parent).unwrap(), b"keep");
    let target = directory.path().join("occupied");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("keep"), b"keep").unwrap();
    let transport = MockTransport::success(vec![page(&[], "end")]);
    let result = execute(&request(), &target, &transport).await;
    assert_eq!(result.status, ExportStatus::Failed);
    assert_eq!(result.file_state, FileState::Unknown);
    assert!(directory.path().join(result.file_name.unwrap()).exists());
    assert_eq!(fs::read(target.join("keep")).unwrap(), b"keep");
}

#[test]
fn export_registry_is_separate_bounded_by_one_permit_and_rejects_duplicate_ids() {
    let state = SnapshotExportState::new();
    let input = request();
    let guard = state
        .requests
        .register(&input.request_id, &input.connection_id)
        .unwrap();
    let permit = state.permit.try_acquire().unwrap();
    assert!(state.permit.try_acquire().is_err());
    assert_eq!(
        state
            .requests
            .register(&input.request_id, &input.connection_id)
            .unwrap_err()
            .code,
        "duplicateRequest"
    );
    let unrelated = RequestRegistry::default();
    let mut query = unrelated
        .register(&input.request_id, &input.connection_id)
        .unwrap();
    state
        .requests
        .cancel(&input.request_id, &input.connection_id);
    assert!(!query.cancellation().is_cancelled());
    drop(permit);
    drop(guard);
    assert!(state.permit.try_acquire().is_ok());
    assert!(!state
        .requests
        .cancel(&input.request_id, &input.connection_id));
}

#[tokio::test]
async fn cancellation_is_sticky_after_an_await_and_in_cloned_file_checks() {
    let registry = RequestRegistry::default();
    let input = request();
    let mut guard = registry
        .register(&input.request_id, &input.connection_id)
        .unwrap();
    let clone = guard.cancellation().clone();
    registry.cancel(&input.request_id, &input.connection_id);
    guard.cancellation().cancelled().await;
    assert!(clone.is_cancelled());
    tokio::time::timeout(Duration::from_secs(1), guard.cancellation().cancelled())
        .await
        .unwrap();
}

struct FakeStore {
    gets: AtomicUsize,
    missing: AtomicBool,
}
impl CredentialStore for FakeStore {
    fn set(&self, _: &CredentialRef, _: &Secret) -> Result<(), CredentialError> {
        Ok(())
    }
    fn delete(&self, _: &CredentialRef) -> Result<(), CredentialError> {
        Ok(())
    }
    fn get(&self, _: &CredentialRef) -> Result<Secret, CredentialError> {
        self.gets.fetch_add(1, Ordering::SeqCst);
        if self.missing.load(Ordering::SeqCst) {
            return Err(CredentialError::NotFound);
        }
        Ok(EsAuthMaterial::bearer("export-fixture-only")
            .unwrap()
            .encode()
            .unwrap())
    }
}

fn storage(endpoint: &str, authenticated: bool) -> (tempfile::TempDir, StorageState, String) {
    let directory = tempdir().unwrap();
    let mut database = Database::open(&directory.path().join("test.sqlite")).unwrap();
    let profile = database
        .save_connection_metadata_only(
            ConnectionInput {
                display_name: "Fixture".into(),
                endpoint: endpoint.into(),
                environment: "development".into(),
            },
            None,
        )
        .unwrap();
    if authenticated {
        database
            .bind_credential(&profile.id, AuthKind::Bearer, &CredentialRef::generate())
            .unwrap();
    }
    (
        directory,
        StorageState(Mutex::new(Ok(database))),
        profile.id,
    )
}

/// A bounded local HTTP fixture, never a real cluster or system credential store.
fn http_fixture(
    replies: Vec<String>,
) -> (String, mpsc::Receiver<String>, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/base", listener.local_addr().unwrap());
    let (sender, received) = mpsc::channel();
    let handle = std::thread::spawn(move || {
        for reply in replies {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = Vec::new();
            let end;
            loop {
                let mut byte = [0];
                stream.read_exact(&mut byte).unwrap();
                bytes.push(byte[0]);
                if bytes.ends_with(b"\r\n\r\n") {
                    end = bytes.len();
                    break;
                }
                assert!(bytes.len() < 16 * 1024);
            }
            let header = String::from_utf8(bytes.clone()).unwrap();
            let size = header
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            assert!(size <= query::MAX_BODY_BYTES);
            bytes.resize(end + size, 0);
            stream.read_exact(&mut bytes[end..]).unwrap();
            sender.send(String::from_utf8(bytes).unwrap()).unwrap();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nX-Elastic-Product: Elasticsearch\r\nConnection: close\r\n\r\n{}", reply.len(), reply).unwrap();
        }
    });
    (endpoint, received, handle)
}

#[tokio::test]
async fn stored_transport_uses_fixed_routes_and_fresh_auth_for_every_page_and_cleanup() {
    let (endpoint, received, server) = http_fixture(vec![
        OPEN.into(),
        page(&[hit(1, "[1]")], "p2"),
        page(&[], "p3"),
        CLOSE.into(),
    ]);
    let (directory, state, id) = storage(&endpoint, true);
    let store = FakeStore {
        gets: AtomicUsize::new(0),
        missing: AtomicBool::new(false),
    };
    let snapshot = with_database(&state, |db| db.transport_snapshot(&id)).unwrap();
    let transport = StoredTransport {
        storage: &state,
        snapshot,
        client: ReadOnlyClient::new().unwrap(),
        store: &store,
    };
    let mut input = request();
    input.connection_id = id;
    input.expected_endpoint = endpoint;
    let result = execute(&input, &directory.path().join("out.jsonl"), &transport).await;
    assert_eq!(result.status, ExportStatus::Saved);
    server.join().unwrap();
    let requests: Vec<_> = received.try_iter().collect();
    assert_eq!(requests.len(), 4);
    for request in &requests {
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer export-fixture-only\r\n"));
    }
    assert!(requests[0].starts_with("POST /base/orders-*/_pit?keep_alive=1m "));
    assert!(requests[1].starts_with("POST /base/_search "));
    assert!(requests[3].starts_with("DELETE /base/_pit "));
    assert!(requests[3].contains("\"id\":\"p3\""));
    assert_eq!(store.gets.load(Ordering::SeqCst), 4);
    assert!(!serde_json::to_string(&result)
        .unwrap()
        .contains("export-fixture-only"));
}

#[tokio::test]
async fn missing_auth_and_replaced_database_targets_do_not_send_or_rebind() {
    let (_directory, state, id) = storage("http://127.0.0.1:1/base", true);
    let store = FakeStore {
        gets: AtomicUsize::new(0),
        missing: AtomicBool::new(true),
    };
    let snapshot = with_database(&state, |db| db.transport_snapshot(&id)).unwrap();
    let transport = StoredTransport {
        storage: &state,
        snapshot,
        client: ReadOnlyClient::new().unwrap(),
        store: &store,
    };
    let result = transport
        .send(
            Read::Open(IndexTarget::parse("orders-*").unwrap()),
            &mut Cancellation::never(),
        )
        .await;
    assert_eq!(result.unwrap_err().code, "credentialNotFound");
    assert_eq!(store.gets.load(Ordering::SeqCst), 1);
    with_database(&state, |db| {
        db.detach_credential(&id)?;
        Ok(())
    })
    .unwrap();
    assert_eq!(
        transport.check_target().unwrap_err().code,
        "exportTargetChanged"
    );
    let result = transport
        .send(
            Read::Open(IndexTarget::parse("orders-*").unwrap()),
            &mut Cancellation::never(),
        )
        .await;
    assert_eq!(result.unwrap_err().code, "exportTargetChanged");
    assert_eq!(store.gets.load(Ordering::SeqCst), 1);
    // Closing never uses the replacement no-auth row; the old reference still fails closed.
    let result = transport
        .send(Read::Close("old-pit".into()), &mut Cancellation::never())
        .await;
    assert_eq!(result.unwrap_err().code, "credentialNotFound");
    assert_eq!(store.gets.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn original_endpoint_and_auth_are_used_for_cleanup_after_database_replacement() {
    let (endpoint, received, server) = http_fixture(vec![OPEN.into(), CLOSE.into()]);
    let (_directory, state, id) = storage(&endpoint, true);
    let store = FakeStore {
        gets: AtomicUsize::new(0),
        missing: AtomicBool::new(false),
    };
    let snapshot = with_database(&state, |db| db.transport_snapshot(&id)).unwrap();
    let transport = StoredTransport {
        storage: &state,
        snapshot,
        client: ReadOnlyClient::new().unwrap(),
        store: &store,
    };
    transport
        .send(
            Read::Open(IndexTarget::parse("orders-*").unwrap()),
            &mut Cancellation::never(),
        )
        .await
        .unwrap();
    with_database(&state, |db| {
        db.detach_credential(&id)?;
        db.save_connection_metadata_only(
            ConnectionInput {
                display_name: "Replaced".into(),
                endpoint: "http://127.0.0.1:1/new".into(),
                environment: "development".into(),
            },
            Some(id.clone()),
        )?;
        Ok(())
    })
    .unwrap();
    assert_eq!(
        transport.check_target().unwrap_err().code,
        "exportTargetChanged"
    );
    transport
        .send(Read::Close("original".into()), &mut Cancellation::never())
        .await
        .unwrap();
    server.join().unwrap();
    let requests: Vec<_> = received.try_iter().collect();
    assert_eq!(requests.len(), 2);
    assert!(requests[1].starts_with("DELETE /base/_pit "));
    assert!(requests[1]
        .to_ascii_lowercase()
        .contains("authorization: bearer export-fixture-only\r\n"));
    assert_eq!(store.gets.load(Ordering::SeqCst), 2);
}

#[test]
fn transport_identity_ignores_names_and_active_selection_but_includes_ca_and_credentials() {
    let (_directory, state, id) = storage("https://es.test", false);
    let snapshot = with_database(&state, |db| db.transport_snapshot(&id)).unwrap();
    with_database(&state, |db| {
        db.save_connection_metadata_only(
            ConnectionInput {
                display_name: "Renamed".into(),
                endpoint: "https://es.test".into(),
                environment: "production".into(),
            },
            Some(id.clone()),
        )?;
        db.select_connection(None)?;
        Ok(())
    })
    .unwrap();
    let renamed = with_database(&state, |db| db.transport_snapshot(&id)).unwrap();
    assert!(same_transport(&snapshot, &renamed));
    let generated = rcgen::generate_simple_self_signed(vec!["es.test".into()]).unwrap();
    let ca = crate::connection_tls::CaCertificate::parse(&generated.cert.pem()).unwrap();
    let with_ca = TransportSnapshot::for_test_with_ca(snapshot.profile().clone(), ca);
    assert!(!same_transport(&snapshot, &with_ca));
    let mut profile = snapshot.profile().clone();
    profile.auth_state = crate::storage::ConnectionAuth {
        kind: AuthKind::Bearer,
        credential_ref: Some(CredentialRef::generate()),
    };
    assert!(!same_transport(
        &snapshot,
        &TransportSnapshot::for_test(profile)
    ));
}
