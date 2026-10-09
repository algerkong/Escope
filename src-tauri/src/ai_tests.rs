//! Tests for the A02.1/A04.1 AI chat backend.
//!
//! Everything here runs against loopback fixture servers that are started per test and stopped
//! before the test ends: no persistent service, no actual model provider, no secrets. The shared
//! TypeScript contract fixtures (`tests/fixtures/ai-chat-*.json`) are the wire oracle.
//!
//! One opt-in test (`live_authorized_gateway_stream_and_cancel`) targets the user-authorized local
//! gateway; it is `#[ignore]`d and additionally gated behind `ESCOPE_TEST_MODEL_GATEWAY=1`, so a
//! normal run never reaches a real endpoint.

use super::ai_protocol::{complete, ChatPayload, Completion};
use super::ai_transport::{chat_body, chat_url, AiLimits, AiNetwork, AiTarget};
use super::{
    chat, AiChatAuthorization, AiChatCancelRequest, AiChatDelta, AiChatMessage, AiChatOutcome,
    AiChatRequest, AiChatResponse, AiChatRole, AiDeltaSink, AiState, MAX_CONTEXT_BYTES,
    MAX_HISTORY_MESSAGES, MAX_HISTORY_MESSAGE_BYTES, MAX_PROMPT_BYTES,
};
use crate::credentials::{CredentialError, CredentialStore, Secret};
use crate::error::AppError;
use crate::model_api_key::OneShotApiKey;
use crate::model_credentials::test_store::{Faults, TestCredentialStore};
use crate::model_credentials::{ModelCredentialChange, ModelCredentials};
use crate::model_discovery::{
    discover, DiscoveryState, ModelDiscoveryRequest, RawDiscoveryCredential,
};
use crate::read_only::{Cancellation, RequestRegistry};
use crate::storage::{Database, ModelInput, ModelProfile, ModelProtocol};
use crate::{with_database, StorageState};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const REQUEST_FIXTURE: &str = include_str!("../../tests/fixtures/ai-chat-request.json");
const CONVERSATION_FIXTURE: &str =
    include_str!("../../tests/fixtures/ai-conversation-request.json");
const RESPONSE_FIXTURE: &str = include_str!("../../tests/fixtures/ai-chat-response.json");
const PROFILE_MODEL: &str = "fixture-model";
const SSE_CONTENT_TYPE: &str = "text/event-stream";
const NDJSON_CONTENT_TYPE: &str = "application/x-ndjson";
/// A fictitious one-shot token, never a real credential.
const FIXTURE_TOKEN: &str = "fixture-one-shot-token";
/// The user-authorized local gateway for the opt-in live test.
const LIVE_ENDPOINT: &str = "http://127.0.0.1:8788/v1";
const LIVE_MODEL: &str = "glm-5.3-flash";

// --- sinks ------------------------------------------------------------------

/// Records deltas in order; optionally notifies an async receiver and/or fails on a given send.
#[derive(Default)]
struct Recorder {
    deltas: Mutex<Vec<AiChatDelta>>,
    notify: Option<tokio::sync::mpsc::UnboundedSender<AiChatDelta>>,
    fail_on: Option<usize>,
}

impl Recorder {
    fn new() -> Self {
        Self::default()
    }

    fn with_notify(notify: tokio::sync::mpsc::UnboundedSender<AiChatDelta>) -> Self {
        Self {
            notify: Some(notify),
            ..Self::default()
        }
    }

    /// Fail the `index`-th delta delivery (0-based), simulating a closed IPC channel.
    fn failing_on(index: usize) -> Self {
        Self {
            fail_on: Some(index),
            ..Self::default()
        }
    }

    fn deltas(&self) -> Vec<AiChatDelta> {
        self.deltas.lock().unwrap().clone()
    }

    fn texts(&self) -> Vec<String> {
        self.deltas().into_iter().map(|delta| delta.text).collect()
    }
}

impl AiDeltaSink for Recorder {
    fn send(&self, delta: AiChatDelta) -> Result<(), AppError> {
        let index = self.deltas.lock().unwrap().len();
        if self.fail_on == Some(index) {
            return Err(AppError::new("cancelled"));
        }
        if let Some(notify) = &self.notify {
            let _ = notify.send(delta.clone());
        }
        self.deltas.lock().unwrap().push(delta);
        Ok(())
    }
}

/// Cancels the registered request from inside the delivery of its first delta, then records like
/// [`Recorder`]. It models a stop that reaches the backend while records of the same network
/// chunk are still being handled.
struct CancelOnFirstDelta {
    registry: Arc<RequestRegistry>,
    request_id: String,
    key: String,
    deltas: Mutex<Vec<AiChatDelta>>,
}

impl CancelOnFirstDelta {
    fn new(registry: Arc<RequestRegistry>, request_id: &str, key: &str) -> Self {
        Self {
            registry,
            request_id: request_id.to_owned(),
            key: key.to_owned(),
            deltas: Mutex::new(Vec::new()),
        }
    }

    fn texts(&self) -> Vec<String> {
        self.deltas
            .lock()
            .unwrap()
            .iter()
            .map(|delta| delta.text.clone())
            .collect()
    }
}

impl AiDeltaSink for CancelOnFirstDelta {
    fn send(&self, delta: AiChatDelta) -> Result<(), AppError> {
        let mut deltas = self.deltas.lock().unwrap();
        let first = deltas.is_empty();
        deltas.push(delta);
        drop(deltas);
        if first {
            assert!(self.registry.cancel(&self.request_id, &self.key));
        }
        Ok(())
    }
}

// --- state and storage ------------------------------------------------------

fn ai_state() -> AiState {
    AiState::new()
}

fn chat_target(endpoint: &str, protocol: ModelProtocol, model_id: &str) -> AiTarget {
    AiTarget {
        profile_id: uuid::Uuid::new_v4().to_string(),
        protocol,
        endpoint: endpoint.into(),
        model_id: model_id.into(),
        credential_ref: None,
    }
}

fn storage_with_profile(
    endpoint: &str,
    protocol: ModelProtocol,
    model_id: &str,
) -> (tempfile::TempDir, StorageState, ModelProfile) {
    let directory = tempfile::tempdir().unwrap();
    let mut database = Database::open(&directory.path().join("ai-test.sqlite")).unwrap();
    let profile = database
        .save_model(
            ModelInput {
                display_name: "Fixture".into(),
                protocol,
                endpoint: endpoint.into(),
                model_id: model_id.into(),
            },
            None,
        )
        .unwrap();
    (directory, StorageState(Mutex::new(Ok(database))), profile)
}

fn approval(profile: &ModelProfile) -> AiChatAuthorization {
    AiChatAuthorization {
        scope: "userTextOnly".into(),
        protocol: profile.protocol,
        endpoint: profile.endpoint.clone(),
        model_id: profile.model_id.clone(),
    }
}

fn chat_request(profile: &ModelProfile, prompt: &str) -> AiChatRequest {
    AiChatRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        model_profile_id: profile.id.clone(),
        prompt: prompt.into(),
        authorization: approval(profile),
        history: None,
        api_key: None,
    }
}

// --- loopback fixture servers -----------------------------------------------

/// Read one HTTP request (headers plus the announced body) from an accepted socket.
fn read_request(stream: &mut TcpStream) -> String {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut request = Vec::new();
    let headers_end = loop {
        if let Some(index) = header_boundary(&request) {
            break index;
        }
        let mut chunk = [0; 1024];
        let length = stream.read(&mut chunk).unwrap();
        assert!(length > 0, "request closed before headers completed");
        request.extend_from_slice(&chunk[..length]);
        assert!(request.len() <= 64 * 1024);
    };
    let mut content_length = 0;
    for line in String::from_utf8_lossy(&request[..headers_end]).lines() {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().unwrap_or(0);
            }
        }
    }
    while request.len() < headers_end + content_length {
        let mut chunk = [0; 1024];
        let length = stream.read(&mut chunk).unwrap();
        assert!(length > 0, "request closed before the body completed");
        request.extend_from_slice(&chunk[..length]);
    }
    String::from_utf8(request).unwrap()
}

/// Offset just past the end of the HTTP header block, if it has arrived.
fn header_boundary(request: &[u8]) -> Option<usize> {
    request
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
}

/// One loopback server: accepts a single connection, captures the request, then writes the
/// response through `write`. Returns the base URL, the captured request and the join handle.
fn server<F>(write: F) -> (String, Receiver<String>, thread::JoinHandle<()>)
where
    F: FnOnce(&mut TcpStream) + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (sender, receiver) = mpsc::channel();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let request = read_request(&mut stream);
        sender.send(request).unwrap();
        write(&mut stream);
    });
    (endpoint, receiver, handle)
}

/// Like [`server`], but signals the captured request through an async channel so a test can act
/// while the chat is still in flight.
fn signaling_server<F>(
    write: F,
) -> (
    String,
    tokio::sync::oneshot::Receiver<String>,
    thread::JoinHandle<()>,
)
where
    F: FnOnce(&mut TcpStream) + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let request = read_request(&mut stream);
        let _ = sender.send(request);
        write(&mut stream);
    });
    (endpoint, receiver, handle)
}

/// Keep the connection open without writing anything until the client gives up and closes its
/// side. This is how the cancellation, timeout and callback-failure tests prove the request is
/// dropped locally instead of waiting for a provider answer.
fn stall(stream: &mut TcpStream) {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut buffer = [0u8; 64];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
    }
}

/// A complete HTTP response with a body (used for non-streaming statuses).
fn http_response(status: &str, body: &str) -> Vec<u8> {
    let mut response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    response.extend_from_slice(body.as_bytes());
    response
}

fn chunked_head(content_type: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
    )
}

fn write_chunk(stream: &mut TcpStream, piece: &[u8]) {
    let _ = stream.write_all(format!("{:x}\r\n", piece.len()).as_bytes());
    let _ = stream.write_all(piece);
    let _ = stream.write_all(b"\r\n");
}

/// A 200 response whose body is streamed with chunked transfer encoding, one HTTP chunk per
/// `chunk_size` bytes (`0` = the whole body as one chunk). Chunked framing lets a test pick
/// exactly where the wire splits, including inside a multibyte character or an SSE line.
fn chunked_response(content_type: &str, body: &[u8], chunk_size: usize) -> Vec<u8> {
    let mut response = chunked_head(content_type).into_bytes();
    if chunk_size == 0 {
        response.extend_from_slice(format!("{:x}\r\n", body.len()).as_bytes());
        response.extend_from_slice(body);
        response.extend_from_slice(b"\r\n");
    } else {
        for piece in body.chunks(chunk_size) {
            response.extend_from_slice(format!("{:x}\r\n", piece.len()).as_bytes());
            response.extend_from_slice(piece);
            response.extend_from_slice(b"\r\n");
        }
    }
    response.extend_from_slice(b"0\r\n\r\n");
    response
}

/// Write the chunked stream frame by frame with `pace` between writes, so the client observes
/// the chosen chunk boundaries instead of one coalesced read.
fn write_chunked_paced(
    stream: &mut TcpStream,
    content_type: &str,
    body: &[u8],
    chunk_size: usize,
    pace: Duration,
) {
    let _ = stream.write_all(chunked_head(content_type).as_bytes());
    for piece in body.chunks(chunk_size.max(1)) {
        write_chunk(stream, piece);
        if !pace.is_zero() {
            thread::sleep(pace);
        }
    }
    let _ = stream.write_all(b"0\r\n\r\n");
}

/// Answers the first request with `status` and then watches briefly for retries, returning how
/// many connections were accepted in total.
fn counting_server(status: &'static str) -> (String, thread::JoinHandle<usize>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let response = http_response(status, "{\"error\":\"fixture-secret\"}");
    let handle = thread::spawn(move || {
        let mut count = 0;
        let (mut stream, _) = listener.accept().unwrap();
        let _ = read_request(&mut stream);
        count += 1;
        let _ = stream.write_all(&response);
        drop(stream);
        listener.set_nonblocking(true).unwrap();
        let deadline = Instant::now() + Duration::from_millis(300);
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = read_request(&mut stream);
                    count += 1;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
            }
        }
        count
    });
    (endpoint, handle)
}

// --- protocol payload helpers -----------------------------------------------

/// Assemble an SSE body: one `data:` frame per payload, LF separated.
fn sse(payloads: &[String]) -> Vec<u8> {
    let mut body = Vec::new();
    for payload in payloads {
        body.extend_from_slice(b"data: ");
        body.extend_from_slice(payload.as_bytes());
        body.extend_from_slice(b"\n\n");
    }
    body
}

/// An SSE answer: one content frame with the given finish reason, then the `[DONE]` marker.
fn openai_answer(content: &str, reason: &str) -> Vec<String> {
    vec![
        json!({"choices":[{"index":0,"delta":{"content":content},"finish_reason":reason}]})
            .to_string(),
        "[DONE]".into(),
    ]
}

fn ndjson(frames: &[Value]) -> Vec<u8> {
    let mut body = Vec::new();
    for frame in frames {
        body.extend_from_slice(frame.to_string().as_bytes());
        body.push(b'\n');
    }
    body
}

/// Drive one full streaming round trip against a fixture server on a random port, asserting the
/// per-protocol append path on the captured request line, and return the result with the deltas
/// the sink recorded.
async fn roundtrip(
    protocol: ModelProtocol,
    body: Vec<u8>,
    chunk_size: usize,
    limits: AiLimits,
) -> (Result<Completion, AppError>, Vec<AiChatDelta>) {
    let content_type = match protocol {
        ModelProtocol::OpenaiCompatible => SSE_CONTENT_TYPE,
        ModelProtocol::Ollama => NDJSON_CONTENT_TYPE,
    };
    let (endpoint, received, handle) = server(move |stream| {
        let _ = stream.write_all(&chunked_response(content_type, &body, chunk_size));
    });
    let network = AiNetwork::with_limits(limits).unwrap();
    let registry = RequestRegistry::default();
    let sink = Recorder::new();
    let request_id = uuid::Uuid::new_v4().to_string();
    let target = chat_target(&endpoint, protocol, PROFILE_MODEL);
    let mut guard = registry.register(&request_id, &target.profile_id).unwrap();
    let result = complete(
        &network,
        &target,
        ChatPayload {
            request_id: &request_id,
            prompt: "hi",
            history: &[],
            bearer: None,
        },
        &sink,
        guard.cancellation(),
    )
    .await;
    let deltas = sink.deltas();
    drop(guard);
    let expected_path = match protocol {
        ModelProtocol::OpenaiCompatible => "/chat/completions",
        ModelProtocol::Ollama => "/api/chat",
    };
    let wire = received.recv().unwrap();
    assert!(
        wire.starts_with(&format!("POST {expected_path} HTTP/1.1\r\n")),
        "{wire}"
    );
    handle.join().unwrap();
    (result, deltas)
}

// --- wire contract ----------------------------------------------------------

#[test]
fn ai_shared_contract_fixtures_round_trip_exactly() {
    let request: AiChatRequest = serde_json::from_str(REQUEST_FIXTURE).unwrap();
    request.validate().unwrap();
    assert_eq!(request.request_id, "6f3b2f1c-4f3e-4a5b-8c9d-0e1f2a3b4c5d");
    assert_eq!(
        request.model_profile_id,
        "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e"
    );
    assert_eq!(request.prompt, "Explain a term query.");
    assert_eq!(request.authorization.scope, "userTextOnly");
    assert_eq!(request.authorization.protocol, ModelProtocol::Ollama);
    assert_eq!(request.authorization.endpoint, "http://127.0.0.1:11434");
    assert_eq!(request.authorization.model_id, "fixture-model");

    // The response fixture deserializes and serializes back byte-identically, field order
    // included, and an extra key is refused.
    let expected: AiChatResponse = serde_json::from_str(RESPONSE_FIXTURE).unwrap();
    assert_eq!(
        format!("{}\n", serde_json::to_string(&expected).unwrap()),
        RESPONSE_FIXTURE
    );
    let mut extra: Value = serde_json::from_str(RESPONSE_FIXTURE).unwrap();
    extra["usage"] = json!({"total_tokens": 1});
    assert!(serde_json::from_value::<AiChatResponse>(extra).is_err());

    // The delta event carries exactly the four contract fields.
    let delta = AiChatDelta {
        request_id: request.request_id.clone(),
        model_profile_id: request.model_profile_id.clone(),
        sequence: 3,
        text: "hi".into(),
    };
    assert_eq!(
        serde_json::to_string(&delta).unwrap(),
        r#"{"requestId":"6f3b2f1c-4f3e-4a5b-8c9d-0e1f2a3b4c5d","modelProfileId":"1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e","sequence":3,"text":"hi"}"#
    );

    // An unavailable actual model is serialized as an explicit null, never omitted.
    let unknown_model = AiChatResponse {
        actual_model_id: None,
        ..expected
    };
    assert!(serde_json::to_string(&unknown_model)
        .unwrap()
        .contains("\"actualModelId\":null"));
    assert_eq!(
        serde_json::to_string(&AiChatOutcome::Complete).unwrap(),
        "\"complete\""
    );
    assert_eq!(
        serde_json::to_string(&AiChatOutcome::Length).unwrap(),
        "\"length\""
    );
    assert_eq!(
        serde_json::to_string(&AiChatOutcome::Filtered).unwrap(),
        "\"filtered\""
    );
}

#[test]
fn ai_payloads_reject_unknown_fields_and_invalid_ids() {
    // A caller cannot smuggle headers, a URL, context documents or extra provider parameters
    // through either payload.
    for (key, value) in [
        ("headers", json!({"authorization": "secret"})),
        ("url", json!("http://example.test")),
        ("context", json!(["secret document"])),
        ("parameters", json!({"temperature": 0})),
    ] {
        let mut payload: Value = serde_json::from_str(REQUEST_FIXTURE).unwrap();
        payload[key] = value;
        assert!(
            serde_json::from_value::<AiChatRequest>(payload).is_err(),
            "{key}"
        );
    }
    for (key, value) in [
        ("apiKey", json!("secret")),
        ("headers", json!({"authorization": "secret"})),
        ("scope", json!(7)),
    ] {
        let mut payload: Value = serde_json::from_str(REQUEST_FIXTURE).unwrap();
        payload["authorization"][key] = value;
        assert!(
            serde_json::from_value::<AiChatRequest>(payload).is_err(),
            "{key}"
        );
    }
    // An unknown protocol spelling is refused by the closed protocol list.
    let mut payload: Value = serde_json::from_str(REQUEST_FIXTURE).unwrap();
    payload["authorization"]["protocol"] = json!("anthropic");
    assert!(serde_json::from_value::<AiChatRequest>(payload).is_err());

    // The cancel payload denies unknown fields and requires UUIDs.
    let extra = r#"{"requestId":"6f3b2f1c-4f3e-4a5b-8c9d-0e1f2a3b4c5d","modelProfileId":"1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e","url":"https://example.test"}"#;
    assert!(serde_json::from_str::<AiChatCancelRequest>(extra).is_err());
    for payload in [
        r#"{"requestId":"secret","modelProfileId":"1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e"}"#,
        r#"{"requestId":"6f3b2f1c-4f3e-4a5b-8c9d-0e1f2a3b4c5d","modelProfileId":"secret"}"#,
    ] {
        let cancel: AiChatCancelRequest = serde_json::from_str(payload).unwrap();
        assert_eq!(cancel.validate().unwrap_err().code, "invalidInput");
    }
    let mut chat: AiChatRequest = serde_json::from_str(REQUEST_FIXTURE).unwrap();
    chat.request_id = "secret".into();
    assert_eq!(chat.validate().unwrap_err().code, "invalidInput");
    chat.request_id = "6f3b2f1c-4f3e-4a5b-8c9d-0e1f2a3b4c5d".into();
    chat.model_profile_id = "secret".into();
    assert_eq!(chat.validate().unwrap_err().code, "invalidInput");
}

#[test]
fn ai_prompt_bounds_are_enforced_in_bytes_without_trimming() {
    let mut request: AiChatRequest = serde_json::from_str(REQUEST_FIXTURE).unwrap();
    request.prompt = "  padded  ".into();
    request.validate().unwrap();
    request.prompt = "   \n\t ".into();
    assert_eq!(request.validate().unwrap_err().code, "invalidInput");
    // The bound is UTF-8 bytes, so a multibyte prompt counts its encoded length.
    request.prompt = "é".repeat(MAX_PROMPT_BYTES / 2);
    request.validate().unwrap();
    request.prompt.push('é');
    assert_eq!(request.validate().unwrap_err().code, "invalidInput");
}

// --- multi-turn conversation contract ----------------------------------------

/// The conversation fixture pins the multi-turn contract: history is the closed user/assistant
/// transcript, the scope is `conversation`, and the body is history followed by the prompt.
#[test]
fn ai_conversation_fixture_pins_the_multi_turn_contract() {
    let request: AiChatRequest = serde_json::from_str(CONVERSATION_FIXTURE).unwrap();
    request.validate().unwrap();
    assert_eq!(request.prompt, "How does it differ from match?");
    assert_eq!(request.authorization.scope, "conversation");
    let history = request.history.as_deref().unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].role, AiChatRole::User);
    assert_eq!(history[0].content, "Explain a term query.");
    assert_eq!(history[1].role, AiChatRole::Assistant);
    assert_eq!(history[1].content, "A term query matches an exact value.");
    assert_eq!(
        String::from_utf8(chat_body("fixture-model", &request.prompt, history)).unwrap(),
        r#"{"model":"fixture-model","messages":[{"role":"user","content":"Explain a term query."},{"role":"assistant","content":"A term query matches an exact value."},{"role":"user","content":"How does it differ from match?"}],"stream":true}"#
    );

    // The legacy fixture stays valid byte-for-byte: no history and the legacy scope.
    let legacy: AiChatRequest = serde_json::from_str(REQUEST_FIXTURE).unwrap();
    legacy.validate().unwrap();
    assert!(legacy.history.is_none());
    assert!(legacy.history().is_empty());
    assert_eq!(legacy.authorization.scope, "userTextOnly");

    // Debug redacts the prompt and the history alike.
    let debugged = format!("{request:?}");
    assert!(!debugged.contains("How does it differ"));
    assert!(!debugged.contains("Explain a term query"));
    assert!(debugged.contains("history_messages"));
    assert!(!format!("{history:?}").contains("Explain a term query"));
}

#[tokio::test]
async fn ai_history_shape_and_bounds_fail_before_any_socket() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (_directory, storage, profile) =
        storage_with_profile(&endpoint, ModelProtocol::Ollama, PROFILE_MODEL);
    let ai = ai_state();
    let sink = Recorder::new();

    let user = |content: &str| AiChatMessage {
        role: AiChatRole::User,
        content: content.into(),
    };
    let assistant = |content: &str| AiChatMessage {
        role: AiChatRole::Assistant,
        content: content.into(),
    };
    let pairs = |count: usize| {
        (0..count)
            .map(|index| {
                if index % 2 == 0 {
                    user("q")
                } else {
                    assistant("a")
                }
            })
            .collect::<Vec<_>>()
    };

    // The scope must cover the payload: history requires `conversation`.
    let mut legacy_scope = chat_request(&profile, "hi");
    legacy_scope.history = Some(vec![user("q"), assistant("a")]);
    assert_eq!(legacy_scope.authorization.scope, "userTextOnly");
    assert_eq!(
        chat(&storage, &ai, legacy_scope, &sink)
            .await
            .unwrap_err()
            .code,
        "aiApprovalRequired"
    );
    let mut unknown_scope = chat_request(&profile, "hi");
    unknown_scope.authorization.scope = "clusterRead".into();
    assert_eq!(
        chat(&storage, &ai, unknown_scope, &sink)
            .await
            .unwrap_err()
            .code,
        "aiApprovalRequired"
    );

    // Shape and bounds are refused by the shared validation.
    let oversized_message = "m".repeat(MAX_HISTORY_MESSAGE_BYTES + 1);
    let largest_message = "x".repeat(MAX_HISTORY_MESSAGE_BYTES);
    for (label, history) in [
        ("more than the message cap", pairs(MAX_HISTORY_MESSAGES + 2)),
        ("an odd number of messages", pairs(3)),
        (
            "a transcript that starts with assistant",
            vec![assistant("a"), user("u")],
        ),
        ("a blank message", vec![user("   "), assistant("a")]),
        (
            "an oversized message",
            vec![user(&oversized_message), assistant("a")],
        ),
        (
            "more context than the bound",
            vec![user(&largest_message), assistant(&largest_message)],
        ),
    ] {
        let mut request = chat_request(&profile, "hi");
        request.authorization.scope = "conversation".into();
        request.history = Some(history);
        assert_eq!(
            request.validate().unwrap_err().code,
            "invalidInput",
            "{label}"
        );
    }

    // The largest allowed transcript and the exact context boundary are accepted.
    let mut full_transcript = chat_request(&profile, "Hello");
    full_transcript.authorization.scope = "conversation".into();
    full_transcript.history = Some(pairs(MAX_HISTORY_MESSAGES));
    full_transcript.validate().unwrap();
    let room = MAX_CONTEXT_BYTES - MAX_PROMPT_BYTES;
    let half = "h".repeat(room / 2);
    let mut boundary = chat_request(&profile, &"p".repeat(MAX_PROMPT_BYTES));
    boundary.authorization.scope = "conversation".into();
    boundary.history = Some(vec![user(&half), assistant(&half)]);
    boundary.validate().unwrap();
    let mut bigger = half.clone();
    bigger.push('h');
    let mut overflow = chat_request(&profile, &"p".repeat(MAX_PROMPT_BYTES));
    overflow.authorization.scope = "conversation".into();
    overflow.history = Some(vec![user(&bigger), assistant(&half)]);
    assert_eq!(
        overflow.validate().unwrap_err().code,
        "invalidInput",
        "one byte past the context bound"
    );

    // An empty history is the same as no history; explicit null is not an array.
    let mut empty = chat_request(&profile, "hi");
    empty.history = Some(Vec::new());
    empty.validate().unwrap();
    assert!(!empty.has_history());
    let mut direct = chat_request(&profile, "hi");
    direct.authorization.scope = "conversation".into();
    direct.validate().unwrap();
    let mut payload: Value = serde_json::from_str(REQUEST_FIXTURE).unwrap();
    payload["history"] = Value::Null;
    assert!(serde_json::from_value::<AiChatRequest>(payload).is_err());

    // Unknown roles and extra or mistyped message fields never reach validation at all.
    for mutate in ["role", "extra", "content"] {
        let mut payload: Value = serde_json::from_str(CONVERSATION_FIXTURE).unwrap();
        payload["history"][0][mutate] = match mutate {
            "role" => json!("system"),
            "extra" => json!(1),
            _ => json!(7),
        };
        assert!(
            serde_json::from_value::<AiChatRequest>(payload).is_err(),
            "{mutate}"
        );
    }

    // Nothing above opened a socket or emitted a delta.
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert!(sink.deltas().is_empty());
}

#[tokio::test]
async fn ai_conversation_body_is_sent_verbatim_to_both_protocols() {
    let request: AiChatRequest = serde_json::from_str(CONVERSATION_FIXTURE).unwrap();
    let history = request.history.clone().unwrap();
    let expected_body = r#"{"model":"fixture-model","messages":[{"role":"user","content":"Explain a term query."},{"role":"assistant","content":"A term query matches an exact value."},{"role":"user","content":"How does it differ from match?"}],"stream":true}"#;

    // OpenAI-compatible SSE, using the gateway's empty finish reasons on intermediate chunks.
    let payloads = vec![
        json!({"model":"fixture-model","choices":[{"index":0,"delta":{"content":"It differs "},"finish_reason":""}]}).to_string(),
        json!({"choices":[{"index":0,"delta":{"content":"in matching."},"finish_reason":""}]}).to_string(),
        json!({"choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}]}).to_string(),
        "[DONE]".into(),
    ];
    let (endpoint, received, handle) = server(move |stream| {
        let _ = stream.write_all(&chunked_response(SSE_CONTENT_TYPE, &sse(&payloads), 0));
    });
    let (_directory, storage, profile) =
        storage_with_profile(&endpoint, ModelProtocol::OpenaiCompatible, PROFILE_MODEL);
    let ai = ai_state();
    let sink = Recorder::new();
    let mut outbound = chat_request(&profile, &request.prompt);
    outbound.authorization.scope = "conversation".into();
    outbound.history = Some(history.clone());
    let response = chat(&storage, &ai, outbound, &sink).await.unwrap();
    assert_eq!(response.text, "It differs in matching.");
    assert_eq!(response.outcome, AiChatOutcome::Complete);
    let wire = received.recv().unwrap();
    assert!(wire.starts_with("POST /chat/completions HTTP/1.1\r\n"));
    assert_eq!(&wire[wire.find("\r\n\r\n").unwrap() + 4..], expected_body);
    handle.join().unwrap();

    // Ollama shares the same body builder.
    let frames = ndjson(&[
        json!({"model":"fixture-model","message":{"role":"assistant","content":"same answer"},"done":false}),
        json!({"model":"fixture-model","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop"}),
    ]);
    let (endpoint, received, handle) = server(move |stream| {
        let _ = stream.write_all(&chunked_response(NDJSON_CONTENT_TYPE, &frames, 0));
    });
    let (_directory, storage, profile) =
        storage_with_profile(&endpoint, ModelProtocol::Ollama, PROFILE_MODEL);
    let ai = ai_state();
    let sink = Recorder::new();
    let mut outbound = chat_request(&profile, &request.prompt);
    outbound.authorization.scope = "conversation".into();
    outbound.history = Some(history);
    let response = chat(&storage, &ai, outbound, &sink).await.unwrap();
    assert_eq!(response.text, "same answer");
    let wire = received.recv().unwrap();
    assert!(wire.starts_with("POST /api/chat HTTP/1.1\r\n"));
    assert_eq!(&wire[wire.find("\r\n\r\n").unwrap() + 4..], expected_body);
    handle.join().unwrap();
}

#[test]
fn ai_urls_and_bodies_are_fixed_by_the_saved_target() {
    let ollama = chat_target(
        "http://127.0.0.1:11434",
        ModelProtocol::Ollama,
        "llama3.1:8b",
    );
    assert_eq!(
        chat_url(&ollama).unwrap().as_str(),
        "http://127.0.0.1:11434/api/chat"
    );
    let prefixed = chat_target(
        "http://127.0.0.1:1234/v1/",
        ModelProtocol::OpenaiCompatible,
        "m",
    );
    assert_eq!(
        chat_url(&prefixed).unwrap().as_str(),
        "http://127.0.0.1:1234/v1/chat/completions"
    );
    let base = chat_target(
        "https://example.test/v1",
        ModelProtocol::OpenaiCompatible,
        "m",
    );
    assert_eq!(
        chat_url(&base).unwrap().as_str(),
        "https://example.test/v1/chat/completions"
    );
    // A corrupted profile can never become a request: credentials, query, fragment and non-HTTP
    // schemes are all refused.
    for endpoint in [
        "ftp://example.test",
        "http://user:pass@example.test",
        "http://example.test/?a=1",
        "http://example.test/#fragment",
    ] {
        assert_eq!(
            chat_url(&chat_target(endpoint, ModelProtocol::Ollama, "m"))
                .unwrap_err()
                .code,
            "invalidInput",
            "{endpoint}"
        );
    }
    // The body is exactly `model`, one user message and `stream`, with the prompt unaltered.
    assert_eq!(
        String::from_utf8(chat_body("m", "  keep  ", &[])).unwrap(),
        r#"{"model":"m","messages":[{"role":"user","content":"  keep  "}],"stream":true}"#
    );
    assert_eq!(
        String::from_utf8(chat_body("m", "a\"b\n", &[])).unwrap(),
        r#"{"model":"m","messages":[{"role":"user","content":"a\"b\n"}],"stream":true}"#
    );
    // History is sent as the leading messages, in order, and only with the pinned fields.
    let history = [
        AiChatMessage {
            role: AiChatRole::User,
            content: "Explain a term query.".into(),
        },
        AiChatMessage {
            role: AiChatRole::Assistant,
            content: "A term query matches an exact value.".into(),
        },
    ];
    assert_eq!(
        String::from_utf8(chat_body("m", "How does it differ from match?", &history)).unwrap(),
        r#"{"model":"m","messages":[{"role":"user","content":"Explain a term query."},{"role":"assistant","content":"A term query matches an exact value."},{"role":"user","content":"How does it differ from match?"}],"stream":true}"#
    );
}

#[test]
fn ai_limits_match_the_product_contract() {
    let limits = AiLimits::default();
    assert_eq!(limits.connect, Duration::from_secs(10));
    assert_eq!(limits.overall, Duration::from_secs(120));
    assert_eq!(limits.idle, Duration::from_secs(30));
    assert_eq!(limits.max_raw, 1024 * 1024);
    assert_eq!(limits.max_text, 256 * 1024);
    assert_eq!(limits.max_inflight, 2);
}

// --- approval and authorization ---------------------------------------------

#[tokio::test]
async fn ai_approval_binds_to_the_saved_profile_before_any_socket() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (_directory, storage, profile) =
        storage_with_profile(&endpoint, ModelProtocol::Ollama, PROFILE_MODEL);
    let ai = ai_state();
    let sink = Recorder::new();

    // Only the two approved scopes exist; anything else needs a fresh approval.
    let mut wrong_scope = chat_request(&profile, "hello");
    wrong_scope.authorization.scope = "clusterRead".into();
    assert_eq!(
        chat(&storage, &ai, wrong_scope, &sink)
            .await
            .unwrap_err()
            .code,
        "aiApprovalRequired"
    );

    // The approval must name the saved target exactly.
    for mutate in ["endpoint", "modelId", "protocol"] {
        let mut stale = chat_request(&profile, "hello");
        match mutate {
            "endpoint" => stale.authorization.endpoint = "http://127.0.0.1:9".into(),
            "modelId" => stale.authorization.model_id = "other-model".into(),
            "protocol" => stale.authorization.protocol = ModelProtocol::OpenaiCompatible,
            other => unreachable!("{other}"),
        }
        assert_eq!(
            chat(&storage, &ai, stale, &sink).await.unwrap_err().code,
            "aiTargetChanged",
            "{mutate}"
        );
    }

    // Editing the saved profile invalidates an approval issued for the old target.
    let approved = chat_request(&profile, "hello");
    let updated = with_database(&storage, |db| {
        db.save_model(
            ModelInput {
                display_name: "Fixture".into(),
                protocol: ModelProtocol::Ollama,
                endpoint: format!("{endpoint}/edited"),
                model_id: PROFILE_MODEL.into(),
            },
            Some(profile.id.clone()),
        )
    })
    .unwrap();
    assert_eq!(updated.endpoint, format!("{endpoint}/edited"));
    assert_eq!(
        chat(&storage, &ai, approved, &sink).await.unwrap_err().code,
        "aiTargetChanged"
    );

    // A profile that does not exist is notFound, not a request to the approval's endpoint.
    let mut missing = chat_request(&profile, "hello");
    missing.model_profile_id = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        chat(&storage, &ai, missing, &sink).await.unwrap_err().code,
        "notFound"
    );

    // None of the refused requests opened a socket, and none emitted a delta.
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert!(sink.deltas().is_empty());
}

// --- OpenAI-compatible SSE ---------------------------------------------------

#[tokio::test]
async fn ai_openai_chat_uses_the_saved_target_and_sends_exactly_the_approved_body() {
    let payloads = vec![
        json!({"id":"x","object":"chat.completion.chunk","created":1,"model":"fixture-model-v1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}).to_string(),
        json!({"model":"fixture-model-v1","choices":[{"index":0,"delta":{"content":"A term "},"finish_reason":null}]}).to_string(),
        json!({"choices":[{"index":0,"delta":{"content":"query."},"finish_reason":"stop"}]}).to_string(),
        // A usage-only frame carries no choices and must not produce a delta.
        json!({"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}})
            .to_string(),
        "[DONE]".into(),
    ];
    let body = sse(&payloads);
    let (endpoint, received, handle) = server(move |stream| {
        let _ = stream.write_all(&chunked_response(SSE_CONTENT_TYPE, &body, 0));
    });
    let (_directory, storage, profile) = storage_with_profile(
        &format!("{endpoint}/v1/"),
        ModelProtocol::OpenaiCompatible,
        PROFILE_MODEL,
    );
    let ai = ai_state();
    let sink = Recorder::new();
    let request = chat_request(&profile, "Explain a term query.");
    let request_id = request.request_id.clone();
    let response = chat(&storage, &ai, request, &sink).await.unwrap();

    assert_eq!(response.request_id, request_id);
    assert_eq!(response.model_profile_id, profile.id);
    assert_eq!(response.protocol, ModelProtocol::OpenaiCompatible);
    assert_eq!(response.endpoint, profile.endpoint);
    assert_eq!(response.model_id, PROFILE_MODEL);
    assert_eq!(
        response.actual_model_id.as_deref(),
        Some("fixture-model-v1")
    );
    assert_eq!(response.sequence, 2);
    assert_eq!(response.text, "A term query.");
    assert_eq!(response.outcome, AiChatOutcome::Complete);

    let deltas = sink.deltas();
    assert_eq!(sink.texts(), vec!["A term ", "query."]);
    assert_eq!(
        deltas
            .iter()
            .map(|delta| delta.sequence)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert!(deltas
        .iter()
        .all(|delta| delta.request_id == request_id && delta.model_profile_id == profile.id));

    // The saved base path is preserved and the body is exactly the approved prompt.
    let wire = received.recv().unwrap();
    assert!(
        wire.starts_with("POST /v1/chat/completions HTTP/1.1\r\n"),
        "{wire}"
    );
    assert!(wire
        .to_lowercase()
        .contains("content-type: application/json"));
    assert!(!wire.to_lowercase().contains("authorization:"));
    let body_start = wire.find("\r\n\r\n").unwrap() + 4;
    assert_eq!(
        &wire[body_start..],
        r#"{"model":"fixture-model","messages":[{"role":"user","content":"Explain a term query."}],"stream":true}"#
    );
    handle.join().unwrap();
}

#[tokio::test]
async fn ai_sse_survives_crlf_multiline_comments_and_split_utf8() {
    // CRLF separators, a comment keep-alive, a multiline data frame and multibyte text, all
    // delivered one byte per HTTP chunk.
    let mut body = Vec::new();
    body.extend_from_slice(b": keep-alive\r\n\r\n");
    body.extend_from_slice(b"data: {\"choices\":[{\"index\":0,\r\n");
    body.extend_from_slice(
        "data: \"delta\":{\"content\":\"h\u{e9}llo \u{1F642}\"}}]}\r\n\r\n".as_bytes(),
    );
    body.extend_from_slice(
        b"data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"\"},\"finish_reason\":\"stop\"}]}\r\n\r\n",
    );
    body.extend_from_slice(b"data: [DONE]\r\n\r\n");
    let (endpoint, received, handle) = server(move |stream| {
        write_chunked_paced(stream, SSE_CONTENT_TYPE, &body, 1, Duration::from_millis(1));
    });
    let network = AiNetwork::with_limits(AiLimits::default()).unwrap();
    let registry = RequestRegistry::default();
    let sink = Recorder::new();
    let request_id = uuid::Uuid::new_v4().to_string();
    let target = chat_target(&endpoint, ModelProtocol::OpenaiCompatible, PROFILE_MODEL);
    let mut guard = registry.register(&request_id, &target.profile_id).unwrap();
    let completion = complete(
        &network,
        &target,
        ChatPayload {
            request_id: &request_id,
            prompt: "hi",
            history: &[],
            bearer: None,
        },
        &sink,
        guard.cancellation(),
    )
    .await
    .unwrap();
    assert_eq!(completion.text, "héllo 🙂");
    assert_eq!(completion.sequence, 1);
    assert_eq!(completion.outcome, AiChatOutcome::Complete);
    // No frame reported a model, so the actual model stays unknown.
    assert_eq!(completion.actual_model_id, None);
    drop(guard);
    assert!(received
        .recv()
        .unwrap()
        .starts_with("POST /chat/completions"));
    handle.join().unwrap();
}

#[tokio::test]
async fn ai_openai_length_filtered_and_unsupported_terminations() {
    let limits = AiLimits::default();
    let (result, _) = roundtrip(
        ModelProtocol::OpenaiCompatible,
        sse(&openai_answer("x", "length")),
        0,
        limits,
    )
    .await;
    assert_eq!(result.unwrap().outcome, AiChatOutcome::Length);

    let (result, _) = roundtrip(
        ModelProtocol::OpenaiCompatible,
        sse(&openai_answer("x", "content_filter")),
        0,
        limits,
    )
    .await;
    assert_eq!(result.unwrap().outcome, AiChatOutcome::Filtered);

    // A tool-call termination is unsupported, not a completed answer; the emitted delta stays.
    let (result, deltas) = roundtrip(
        ModelProtocol::OpenaiCompatible,
        sse(&openai_answer("x", "tool_calls")),
        0,
        limits,
    )
    .await;
    assert_eq!(result.unwrap_err().code, "aiUnsupportedResponse");
    assert_eq!(deltas.len(), 1);

    // A delta that announces tool use is refused; nothing is executed or rendered.
    let tool_delta = vec![
        json!({"choices":[{"index":0,"delta":{"tool_calls":[{"id":"a","function":{"name":"f"}}]}}]})
            .to_string(),
        "[DONE]".into(),
    ];
    let (result, _) = roundtrip(ModelProtocol::OpenaiCompatible, sse(&tool_delta), 0, limits).await;
    assert_eq!(result.unwrap_err().code, "aiUnsupportedResponse");

    // Multimodal content parts are equally unsupported.
    let parts = vec![
        json!({"choices":[{"index":0,"delta":{"content":[{"type":"text","text":"hi"}]}}]})
            .to_string(),
        "[DONE]".into(),
    ];
    let (result, _) = roundtrip(ModelProtocol::OpenaiCompatible, sse(&parts), 0, limits).await;
    assert_eq!(result.unwrap_err().code, "aiUnsupportedResponse");
}

#[tokio::test]
async fn ai_openai_error_truncation_and_malformed_frames_fail_structured() {
    let limits = AiLimits::default();

    // A provider error frame after a delta: structured failure, the delta is kept.
    let payloads = vec![
        json!({"choices":[{"index":0,"delta":{"content":"partial"}}]}).to_string(),
        json!({"error":{"message":"fixture-secret","type":"server_error"}}).to_string(),
    ];
    let (result, deltas) =
        roundtrip(ModelProtocol::OpenaiCompatible, sse(&payloads), 0, limits).await;
    assert_eq!(result.unwrap_err().code, "aiProviderError");
    assert_eq!(deltas.len(), 1);
    assert_eq!(deltas[0].text, "partial");

    // EOF before [DONE] is a truncation, even after a supported finish reason arrived.
    let truncated = vec![
        json!({"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]})
            .to_string(),
    ];
    let (result, _) = roundtrip(ModelProtocol::OpenaiCompatible, sse(&truncated), 0, limits).await;
    assert_eq!(result.unwrap_err().code, "aiIncompleteStream");

    // [DONE] without a supported finish reason is not a completion either.
    let no_reason = vec![
        json!({"choices":[{"index":0,"delta":{"content":"hi"}}]}).to_string(),
        "[DONE]".into(),
    ];
    let (result, _) = roundtrip(ModelProtocol::OpenaiCompatible, sse(&no_reason), 0, limits).await;
    assert_eq!(result.unwrap_err().code, "aiIncompleteStream");

    // Malformed frame shapes are structured errors, never partial success.
    for (payload, code) in [
        ("not-json", "invalidResponse"),
        ("42", "aiUnsupportedResponse"),
        (
            r#"{"choices":[{"index":1,"delta":{"content":"x"}}]}"#,
            "aiUnsupportedResponse",
        ),
    ] {
        let payloads = vec![payload.to_string(), "[DONE]".to_string()];
        let (result, _) =
            roundtrip(ModelProtocol::OpenaiCompatible, sse(&payloads), 0, limits).await;
        assert_eq!(result.unwrap_err().code, code, "{payload}");
    }

    // Invalid UTF-8 poisons the SSE stream: the delta before it is kept, nothing is claimed.
    let mut body = sse(&[json!({"choices":[{"index":0,"delta":{"content":"ok"}}]}).to_string()]);
    body.extend_from_slice(b"data: \xff\xfe\n\n");
    let (result, deltas) = roundtrip(ModelProtocol::OpenaiCompatible, body, 0, limits).await;
    assert_eq!(result.unwrap_err().code, "invalidResponse");
    assert_eq!(deltas.len(), 1);
}

#[tokio::test]
async fn ai_model_identity_is_bounded_and_conflicts_are_rejected() {
    let limits = AiLimits::default();

    // An oversized model name is ignored: the answer is complete but the model stays unknown.
    let oversized = "m".repeat(201);
    let payloads = vec![
        json!({"model":oversized,"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"stop"}]})
            .to_string(),
        "[DONE]".into(),
    ];
    let (result, _) = roundtrip(ModelProtocol::OpenaiCompatible, sse(&payloads), 0, limits).await;
    let completion = result.unwrap();
    assert_eq!(completion.actual_model_id, None);
    assert_eq!(completion.text, "x");

    // A model change inside one stream is refused instead of silently adopted.
    let payloads = vec![
        json!({"model":"m1","choices":[{"index":0,"delta":{"content":"a"}}]}).to_string(),
        json!({"model":"m2","choices":[{"index":0,"delta":{"content":"b"}}]}).to_string(),
        "[DONE]".into(),
    ];
    let (result, deltas) =
        roundtrip(ModelProtocol::OpenaiCompatible, sse(&payloads), 0, limits).await;
    assert_eq!(result.unwrap_err().code, "aiUnsupportedResponse");
    assert_eq!(deltas.len(), 1);

    // The Ollama adapter reads the same field from its frames.
    let body = ndjson(&[
        json!({"model":"ollama-model","message":{"content":"a"},"done":false}),
        json!({"model":"ollama-model","message":{"content":"b"},"done":true,"done_reason":"stop"}),
    ]);
    let (result, _) = roundtrip(ModelProtocol::Ollama, body, 0, limits).await;
    assert_eq!(
        result.unwrap().actual_model_id.as_deref(),
        Some("ollama-model")
    );
}

#[tokio::test]
async fn ai_oversized_streams_fail_without_a_partial_answer() {
    // A raw-capped SSE stream: the frame never completes and no delta is reported.
    let raw_limits = AiLimits {
        max_raw: 96,
        ..AiLimits::default()
    };
    let big = json!({"choices":[{"index":0,"delta":{"content":"x".repeat(200)}}]}).to_string();
    let (result, deltas) = roundtrip(
        ModelProtocol::OpenaiCompatible,
        sse(&[big, "[DONE]".into()]),
        0,
        raw_limits,
    )
    .await;
    assert_eq!(result.unwrap_err().code, "responseTooLarge");
    assert!(deltas.is_empty());

    // A text-capped stream keeps what was emitted but never returns success.
    let text_limits = AiLimits {
        max_text: 8,
        ..AiLimits::default()
    };
    let payloads = vec![
        json!({"choices":[{"index":0,"delta":{"content":"12345"}}]}).to_string(),
        json!({"choices":[{"index":0,"delta":{"content":"67890"}}]}).to_string(),
        "[DONE]".into(),
    ];
    let (result, deltas) = roundtrip(
        ModelProtocol::OpenaiCompatible,
        sse(&payloads),
        0,
        text_limits,
    )
    .await;
    assert_eq!(result.unwrap_err().code, "responseTooLarge");
    assert_eq!(deltas.len(), 1);

    // The same caps bound the NDJSON adapter.
    let big_line =
        json!({"model":"m","message":{"role":"assistant","content":"y".repeat(300)},"done":false});
    let (result, _) = roundtrip(ModelProtocol::Ollama, ndjson(&[big_line]), 0, raw_limits).await;
    assert_eq!(result.unwrap_err().code, "responseTooLarge");

    let frames = vec![
        json!({"model":"m","message":{"content":"12345"},"done":false}),
        json!({"model":"m","message":{"content":"67890"},"done":false}),
    ];
    let (result, deltas) = roundtrip(ModelProtocol::Ollama, ndjson(&frames), 0, text_limits).await;
    assert_eq!(result.unwrap_err().code, "responseTooLarge");
    assert_eq!(deltas.len(), 1);
}

// --- Ollama NDJSON -----------------------------------------------------------

#[tokio::test]
async fn ai_ollama_chat_matches_the_shared_response_fixture() {
    let frames = ndjson(&[
        json!({"model":"fixture-model-v1","created_at":"2026-10-08T00:00:00Z","message":{"role":"assistant","content":""},"done":false}),
        json!({"model":"fixture-model-v1","created_at":"2026-10-08T00:00:00Z","message":{"role":"assistant","content":"A term query matches an exact value."},"done":false}),
        json!({"model":"fixture-model-v1","created_at":"2026-10-08T00:00:00Z","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","total_duration":123,"eval_count":7}),
    ]);
    let (endpoint, received, handle) = server(move |stream| {
        let _ = stream.write_all(&chunked_response(NDJSON_CONTENT_TYPE, &frames, 0));
    });
    let (_directory, storage, profile) =
        storage_with_profile(&endpoint, ModelProtocol::Ollama, PROFILE_MODEL);
    let ai = ai_state();
    let sink = Recorder::new();
    let request = chat_request(&profile, "Explain a term query.");
    let request_id = request.request_id.clone();
    let response = chat(&storage, &ai, request, &sink).await.unwrap();

    let expected: AiChatResponse = serde_json::from_str(RESPONSE_FIXTURE).unwrap();
    assert_eq!(response.request_id, request_id);
    assert_eq!(response.model_profile_id, profile.id);
    assert_eq!(response.endpoint, profile.endpoint);
    assert_eq!(response.protocol, expected.protocol);
    assert_eq!(response.model_id, expected.model_id);
    assert_eq!(response.actual_model_id, expected.actual_model_id);
    assert_eq!(response.sequence, expected.sequence);
    assert_eq!(response.text, expected.text);
    assert_eq!(response.outcome, expected.outcome);

    let wire = received.recv().unwrap();
    assert!(wire.starts_with("POST /api/chat HTTP/1.1\r\n"), "{wire}");
    let body_start = wire.find("\r\n\r\n").unwrap() + 4;
    assert_eq!(
        &wire[body_start..],
        r#"{"model":"fixture-model","messages":[{"role":"user","content":"Explain a term query."}],"stream":true}"#
    );
    handle.join().unwrap();
}

#[tokio::test]
async fn ai_ollama_survives_byte_splits_crlf_and_blank_lines() {
    let mut body = Vec::new();
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(
        format!(
            "{}\r\n",
            json!({"model":"m1","message":{"role":"assistant","content":"\u{65e5}\u{672c}\u{8a9e}"},"done":false})
        )
        .as_bytes(),
    );
    body.extend_from_slice(b"\n");
    body.extend_from_slice(
        format!(
            "{}\n",
            json!({"message":{"role":"assistant","content":" \u{1F642}"},"done":true,"done_reason":"stop"})
        )
        .as_bytes(),
    );
    let (endpoint, received, handle) = server(move |stream| {
        write_chunked_paced(
            stream,
            NDJSON_CONTENT_TYPE,
            &body,
            1,
            Duration::from_millis(1),
        );
    });
    let network = AiNetwork::with_limits(AiLimits::default()).unwrap();
    let registry = RequestRegistry::default();
    let sink = Recorder::new();
    let request_id = uuid::Uuid::new_v4().to_string();
    let target = chat_target(&endpoint, ModelProtocol::Ollama, PROFILE_MODEL);
    let mut guard = registry.register(&request_id, &target.profile_id).unwrap();
    let completion = complete(
        &network,
        &target,
        ChatPayload {
            request_id: &request_id,
            prompt: "hi",
            history: &[],
            bearer: None,
        },
        &sink,
        guard.cancellation(),
    )
    .await
    .unwrap();
    assert_eq!(completion.text, "日本語 🙂");
    assert_eq!(completion.sequence, 2);
    assert_eq!(completion.actual_model_id.as_deref(), Some("m1"));
    assert_eq!(completion.outcome, AiChatOutcome::Complete);
    drop(guard);
    assert!(received.recv().unwrap().starts_with("POST /api/chat"));
    handle.join().unwrap();
}

#[tokio::test]
async fn ai_ollama_error_incomplete_and_unsupported_frames() {
    let limits = AiLimits::default();

    let (result, _) = roundtrip(
        ModelProtocol::Ollama,
        ndjson(&[
            json!({"model":"m","message":{"content":"abc"},"done":true,"done_reason":"length"}),
        ]),
        0,
        limits,
    )
    .await;
    assert_eq!(result.unwrap().outcome, AiChatOutcome::Length);

    // done:true without a reason (older servers) is a normal completion.
    let (result, _) = roundtrip(
        ModelProtocol::Ollama,
        ndjson(&[json!({"message":{"content":"abc"},"done":true})]),
        0,
        limits,
    )
    .await;
    assert_eq!(result.unwrap().outcome, AiChatOutcome::Complete);

    // An unknown reason is refused instead of being guessed.
    let (result, _) = roundtrip(
        ModelProtocol::Ollama,
        ndjson(&[
            json!({"model":"m","message":{"content":"abc"},"done":true,"done_reason":"unload"}),
        ]),
        0,
        limits,
    )
    .await;
    assert_eq!(result.unwrap_err().code, "aiUnsupportedResponse");

    // An error frame is a provider error; the emitted delta stays.
    let (result, deltas) = roundtrip(
        ModelProtocol::Ollama,
        ndjson(&[
            json!({"model":"m","message":{"content":"partial"},"done":false}),
            json!({"error":"fixture-secret"}),
        ]),
        0,
        limits,
    )
    .await;
    assert_eq!(result.unwrap_err().code, "aiProviderError");
    assert_eq!(deltas.len(), 1);

    // Tool calls in a message are unsupported; nothing is executed or rendered.
    let (result, _) = roundtrip(
        ModelProtocol::Ollama,
        ndjson(&[json!({"model":"m","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"f"}}]},"done":true,"done_reason":"stop"})]),
        0,
        limits,
    )
    .await;
    assert_eq!(result.unwrap_err().code, "aiUnsupportedResponse");

    // EOF without done:true is incomplete; the delta before it stays.
    let (result, deltas) = roundtrip(
        ModelProtocol::Ollama,
        ndjson(&[json!({"model":"m","message":{"content":"partial"},"done":false})]),
        0,
        limits,
    )
    .await;
    assert_eq!(result.unwrap_err().code, "aiIncompleteStream");
    assert_eq!(deltas.len(), 1);

    // Malformed lines, invalid UTF-8 and non-object frames are structured errors.
    let (result, _) = roundtrip(
        ModelProtocol::Ollama,
        b"{\"model\":\"m\"}\nnot-json\n".to_vec(),
        0,
        limits,
    )
    .await;
    assert_eq!(result.unwrap_err().code, "invalidResponse");
    let (result, _) = roundtrip(
        ModelProtocol::Ollama,
        b"{\"model\":\"m\"}\n\xff\xfe\n".to_vec(),
        0,
        limits,
    )
    .await;
    assert_eq!(result.unwrap_err().code, "invalidResponse");
    let (result, _) = roundtrip(ModelProtocol::Ollama, b"[1,2,3]\n".to_vec(), 0, limits).await;
    assert_eq!(result.unwrap_err().code, "aiUnsupportedResponse");
}

// --- cancellation ------------------------------------------------------------

#[tokio::test]
async fn ai_cancel_before_first_token_returns_promptly_and_releases_everything() {
    let (endpoint, started, handle) = signaling_server(stall);
    let network = AiNetwork::with_limits(AiLimits::default()).unwrap();
    let registry = RequestRegistry::default();
    let sink = Recorder::new();
    let request_id = uuid::Uuid::new_v4().to_string();
    let target = chat_target(&endpoint, ModelProtocol::Ollama, PROFILE_MODEL);
    let mut guard = registry.register(&request_id, &target.profile_id).unwrap();
    let started_at = Instant::now();
    let mut executing = Box::pin(complete(
        &network,
        &target,
        ChatPayload {
            request_id: &request_id,
            prompt: "hi",
            history: &[],
            bearer: None,
        },
        &sink,
        guard.cancellation(),
    ));
    let mut started = started;
    tokio::select! {
        result = &mut executing => panic!("the chat must still be in flight: {result:?}"),
        request = &mut started => {
            assert!(request.unwrap().starts_with("POST /api/chat HTTP/1.1\r\n"));
        }
    }
    assert!(registry.cancel(&request_id, &target.profile_id));
    assert_eq!(executing.await.unwrap_err().code, "cancelled");
    assert!(
        started_at.elapsed() < Duration::from_secs(1),
        "cancellation must not wait for the provider"
    );
    // The permit and the registration were released; a late cancel reports false.
    assert!(network.acquire().is_ok());
    drop(guard);
    assert!(!registry.cancel(&request_id, &target.profile_id));
    assert!(sink.deltas().is_empty());
    handle.join().unwrap();
}

#[tokio::test]
async fn ai_midstream_cancel_keeps_emitted_deltas_and_releases_everything() {
    let first = sse(&[json!({"choices":[{"index":0,"delta":{"content":"first"}}]}).to_string()]);
    let (endpoint, started, handle) = signaling_server(move |stream| {
        let _ = stream.write_all(chunked_head(SSE_CONTENT_TYPE).as_bytes());
        write_chunk(stream, &first);
        stall(stream);
    });
    let network = AiNetwork::with_limits(AiLimits::default()).unwrap();
    let registry = RequestRegistry::default();
    let (delta_sender, mut delta_receiver) = tokio::sync::mpsc::unbounded_channel();
    let sink = Recorder::with_notify(delta_sender);
    let request_id = uuid::Uuid::new_v4().to_string();
    let target = chat_target(&endpoint, ModelProtocol::OpenaiCompatible, PROFILE_MODEL);
    let mut guard = registry.register(&request_id, &target.profile_id).unwrap();
    let mut executing = Box::pin(complete(
        &network,
        &target,
        ChatPayload {
            request_id: &request_id,
            prompt: "hi",
            history: &[],
            bearer: None,
        },
        &sink,
        guard.cancellation(),
    ));
    let mut started = started;
    tokio::select! {
        result = &mut executing => panic!("the chat must still be in flight: {result:?}"),
        _ = &mut started => {}
    }
    // The chat future must keep being polled while the first delta is awaited.
    let delta = tokio::select! {
        result = &mut executing => panic!("the chat must still be in flight: {result:?}"),
        delta = tokio::time::timeout(Duration::from_secs(2), delta_receiver.recv()) => {
            delta.unwrap().unwrap()
        }
    };
    assert_eq!(delta.text, "first");
    assert_eq!(delta.sequence, 1);
    assert!(registry.cancel(&request_id, &target.profile_id));
    assert_eq!(executing.await.unwrap_err().code, "cancelled");
    assert_eq!(sink.texts(), vec!["first"]);
    assert!(network.acquire().is_ok());
    drop(guard);
    assert!(!registry.cancel(&request_id, &target.profile_id));
    handle.join().unwrap();
}

#[tokio::test]
async fn ai_cancel_before_registration_blocks_the_start_and_duplicates_are_refused() {
    // An early cancel wins the IPC race: the chat is refused before a socket opens.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (_directory, storage, profile) =
        storage_with_profile(&endpoint, ModelProtocol::Ollama, PROFILE_MODEL);
    let ai = ai_state();
    let sink = Recorder::new();
    let request = chat_request(&profile, "hi");
    let request_id = request.request_id.clone();
    assert!(ai.requests.cancel(&request_id, &profile.id));
    assert_eq!(
        chat(&storage, &ai, request, &sink).await.unwrap_err().code,
        "cancelled"
    );
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );

    // While a chat runs, the same ID cannot be reused; after it finishes, the late cancel
    // reports false and the ID stays reserved instead of rebinding to a new request.
    let (endpoint, started, handle) = signaling_server(stall);
    let (_directory, storage, profile) =
        storage_with_profile(&endpoint, ModelProtocol::OpenaiCompatible, PROFILE_MODEL);
    let ai = ai_state();
    let sink = Recorder::new();
    let first = chat_request(&profile, "hi");
    let first_id = first.request_id.clone();
    let executing = chat(&storage, &ai, first, &sink);
    tokio::pin!(executing);
    let mut started = started;
    tokio::select! {
        result = &mut executing => panic!("the chat must still be in flight: {result:?}"),
        _ = &mut started => {}
    }
    let mut duplicate = chat_request(&profile, "hi");
    duplicate.request_id = first_id.clone();
    assert_eq!(
        chat(&storage, &ai, duplicate, &sink)
            .await
            .unwrap_err()
            .code,
        "duplicateRequest"
    );
    assert!(ai.requests.cancel(&first_id, &profile.id));
    assert_eq!(executing.await.unwrap_err().code, "cancelled");
    let mut late = chat_request(&profile, "hi");
    late.request_id = first_id.clone();
    assert_eq!(
        chat(&storage, &ai, late, &sink).await.unwrap_err().code,
        "duplicateRequest"
    );
    assert!(!ai.requests.cancel(&first_id, &profile.id));
    handle.join().unwrap();
}

#[tokio::test]
async fn ai_delta_delivery_failure_cancels_the_local_request() {
    let first = sse(&[json!({"choices":[{"index":0,"delta":{"content":"first"}}]}).to_string()]);
    let (endpoint, started, handle) = signaling_server(move |stream| {
        let _ = stream.write_all(chunked_head(SSE_CONTENT_TYPE).as_bytes());
        write_chunk(stream, &first);
        stall(stream);
    });
    let network = AiNetwork::with_limits(AiLimits::default()).unwrap();
    let registry = RequestRegistry::default();
    let sink = Recorder::failing_on(0);
    let request_id = uuid::Uuid::new_v4().to_string();
    let target = chat_target(&endpoint, ModelProtocol::OpenaiCompatible, PROFILE_MODEL);
    let mut guard = registry.register(&request_id, &target.profile_id).unwrap();
    let started_at = Instant::now();
    let mut executing = Box::pin(complete(
        &network,
        &target,
        ChatPayload {
            request_id: &request_id,
            prompt: "hi",
            history: &[],
            bearer: None,
        },
        &sink,
        guard.cancellation(),
    ));
    let mut started = started;
    tokio::select! {
        result = &mut executing => panic!("the chat must still be in flight: {result:?}"),
        _ = &mut started => {}
    }
    // The channel is gone: the invocation fails as cancelled, never as a completion, and does
    // not wait for the provider to answer.
    assert_eq!(executing.await.unwrap_err().code, "cancelled");
    assert!(
        started_at.elapsed() < Duration::from_secs(1),
        "a dead channel must not wait for the provider"
    );
    assert!(sink.deltas().is_empty());
    assert!(network.acquire().is_ok());
    drop(guard);
    assert!(!registry.cancel(&request_id, &target.profile_id));
    handle.join().unwrap();
}

#[tokio::test]
async fn ai_third_concurrent_chat_is_busy_and_permits_are_released() {
    let (endpoint_a, started_a, handle_a) = signaling_server(stall);
    let (endpoint_b, started_b, handle_b) = signaling_server(stall);
    let network = AiNetwork::with_limits(AiLimits::default()).unwrap();
    let registry = RequestRegistry::default();
    let sink = Recorder::new();
    let target_a = chat_target(&endpoint_a, ModelProtocol::Ollama, PROFILE_MODEL);
    let target_b = chat_target(&endpoint_b, ModelProtocol::Ollama, PROFILE_MODEL);
    let id_a = uuid::Uuid::new_v4().to_string();
    let id_b = uuid::Uuid::new_v4().to_string();
    let mut guard_a = registry.register(&id_a, &target_a.profile_id).unwrap();
    let mut guard_b = registry.register(&id_b, &target_b.profile_id).unwrap();

    let first = complete(
        &network,
        &target_a,
        ChatPayload {
            request_id: &id_a,
            prompt: "hi",
            history: &[],
            bearer: None,
        },
        &sink,
        guard_a.cancellation(),
    );
    tokio::pin!(first);
    let mut started_a = started_a;
    tokio::select! {
        result = &mut first => panic!("the first chat must still be in flight: {result:?}"),
        _ = &mut started_a => {}
    }
    let second = complete(
        &network,
        &target_b,
        ChatPayload {
            request_id: &id_b,
            prompt: "hi",
            history: &[],
            bearer: None,
        },
        &sink,
        guard_b.cancellation(),
    );
    tokio::pin!(second);
    let mut started_b = started_b;
    tokio::select! {
        result = &mut second => panic!("the second chat must still be in flight: {result:?}"),
        _ = &mut started_b => {}
    }

    // The third request is refused with `busy` before it can open a socket.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let target_c = chat_target(
        &format!("http://{}", listener.local_addr().unwrap()),
        ModelProtocol::Ollama,
        PROFILE_MODEL,
    );
    assert_eq!(
        complete(
            &network,
            &target_c,
            ChatPayload {
                request_id: &uuid::Uuid::new_v4().to_string(),
                prompt: "hi",
                history: &[],
                bearer: None,
            },
            &sink,
            &mut Cancellation::never(),
        )
        .await
        .unwrap_err()
        .code,
        "busy"
    );
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );

    // Cancelling the first releases its permit; a new chat can then use it.
    assert!(registry.cancel(&id_a, &target_a.profile_id));
    assert_eq!(first.await.unwrap_err().code, "cancelled");
    let body =
        ndjson(&[json!({"model":"m","message":{"content":"ok"},"done":true,"done_reason":"stop"})]);
    let (endpoint_d, _received, handle_d) = server(move |stream| {
        let _ = stream.write_all(&chunked_response(NDJSON_CONTENT_TYPE, &body, 0));
    });
    let target_d = chat_target(&endpoint_d, ModelProtocol::Ollama, PROFILE_MODEL);
    let completion = complete(
        &network,
        &target_d,
        ChatPayload {
            request_id: &uuid::Uuid::new_v4().to_string(),
            prompt: "hi",
            history: &[],
            bearer: None,
        },
        &sink,
        &mut Cancellation::never(),
    )
    .await
    .unwrap();
    assert_eq!(completion.text, "ok");

    // Clean up the second in-flight chat.
    assert!(registry.cancel(&id_b, &target_b.profile_id));
    assert_eq!(second.await.unwrap_err().code, "cancelled");
    handle_a.join().unwrap();
    handle_b.join().unwrap();
    handle_d.join().unwrap();
}

#[tokio::test]
async fn ai_idle_and_overall_timeouts_release_resources() {
    // Idle: the provider opens the body, sends one delta and then nothing.
    let first = sse(&[json!({"choices":[{"index":0,"delta":{"content":"first"}}]}).to_string()]);
    let (endpoint, started, handle) = signaling_server(move |stream| {
        let _ = stream.write_all(chunked_head(SSE_CONTENT_TYPE).as_bytes());
        write_chunk(stream, &first);
        stall(stream);
    });
    let limits = AiLimits {
        idle: Duration::from_millis(150),
        overall: Duration::from_secs(5),
        ..AiLimits::default()
    };
    let network = AiNetwork::with_limits(limits).unwrap();
    let registry = RequestRegistry::default();
    let sink = Recorder::new();
    let request_id = uuid::Uuid::new_v4().to_string();
    let target = chat_target(&endpoint, ModelProtocol::OpenaiCompatible, PROFILE_MODEL);
    let mut guard = registry.register(&request_id, &target.profile_id).unwrap();
    let started_at = Instant::now();
    let mut executing = Box::pin(complete(
        &network,
        &target,
        ChatPayload {
            request_id: &request_id,
            prompt: "hi",
            history: &[],
            bearer: None,
        },
        &sink,
        guard.cancellation(),
    ));
    let mut started = started;
    tokio::select! {
        result = &mut executing => panic!("the chat must still be in flight: {result:?}"),
        _ = &mut started => {}
    }
    assert_eq!(executing.await.unwrap_err().code, "timeout");
    assert!(
        started_at.elapsed() < Duration::from_secs(2),
        "the idle window must expire promptly"
    );
    assert_eq!(sink.texts(), vec!["first"]);
    assert!(network.acquire().is_ok());
    drop(guard);
    handle.join().unwrap();

    // Overall: the provider accepts the request and never answers at all.
    let (endpoint, started, handle) = signaling_server(stall);
    let limits = AiLimits {
        idle: Duration::from_secs(30),
        overall: Duration::from_millis(200),
        ..AiLimits::default()
    };
    let network = AiNetwork::with_limits(limits).unwrap();
    let registry = RequestRegistry::default();
    let sink = Recorder::new();
    let request_id = uuid::Uuid::new_v4().to_string();
    let target = chat_target(&endpoint, ModelProtocol::Ollama, PROFILE_MODEL);
    let mut guard = registry.register(&request_id, &target.profile_id).unwrap();
    let mut executing = Box::pin(complete(
        &network,
        &target,
        ChatPayload {
            request_id: &request_id,
            prompt: "hi",
            history: &[],
            bearer: None,
        },
        &sink,
        guard.cancellation(),
    ));
    let mut started = started;
    tokio::select! {
        result = &mut executing => panic!("the chat must still be in flight: {result:?}"),
        _ = &mut started => {}
    }
    assert_eq!(executing.await.unwrap_err().code, "timeout");
    assert!(network.acquire().is_ok());
    drop(guard);
    handle.join().unwrap();
}

#[tokio::test]
async fn ai_cancellation_is_isolated_from_the_elasticsearch_registry() {
    let ai_registry = RequestRegistry::default();
    let es_registry = RequestRegistry::default();
    let request_id = uuid::Uuid::new_v4().to_string();
    let key = uuid::Uuid::new_v4().to_string();
    let mut es_guard = es_registry.register(&request_id, &key).unwrap();
    let mut ai_guard = ai_registry.register(&request_id, &key).unwrap();

    assert!(ai_registry.cancel(&request_id, &key));
    // The AI cancel fired for its own request...
    assert!(tokio::time::timeout(
        Duration::from_millis(100),
        ai_guard.cancellation().cancelled()
    )
    .await
    .is_ok());
    // ...and never reached the Elasticsearch request, whose own cancel still works normally.
    assert!(tokio::time::timeout(
        Duration::from_millis(25),
        es_guard.cancellation().cancelled()
    )
    .await
    .is_err());
    assert!(es_registry.cancel(&request_id, &key));
    assert!(tokio::time::timeout(
        Duration::from_millis(100),
        es_guard.cancellation().cancelled()
    )
    .await
    .is_ok());
}

// --- transport rules ---------------------------------------------------------

#[tokio::test]
async fn ai_never_follows_redirects() {
    let destination = TcpListener::bind("127.0.0.1:0").unwrap();
    destination.set_nonblocking(true).unwrap();
    let location = format!(
        "http://{}/v1/chat/completions",
        destination.local_addr().unwrap()
    );
    let (endpoint, _received, handle) = server(move |stream| {
        let response = format!(
            "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        let _ = stream.write_all(response.as_bytes());
    });
    let network = AiNetwork::with_limits(AiLimits::default()).unwrap();
    let sink = Recorder::new();
    let target = chat_target(&endpoint, ModelProtocol::Ollama, PROFILE_MODEL);
    let error = complete(
        &network,
        &target,
        ChatPayload {
            request_id: &uuid::Uuid::new_v4().to_string(),
            prompt: "hi",
            history: &[],
            bearer: None,
        },
        &sink,
        &mut Cancellation::never(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "redirectBlocked");
    assert_eq!(
        destination.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock,
        "the redirect destination must never be contacted"
    );
    assert!(sink.deltas().is_empty());
    handle.join().unwrap();
}

/// Restores environment variables when the test leaves scope, even on panic.
struct EnvRestore(Vec<(&'static str, Option<String>)>);

impl Drop for EnvRestore {
    fn drop(&mut self) {
        for (name, value) in &self.0 {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}

#[tokio::test]
async fn ai_ignores_environment_proxies() {
    let proxy = TcpListener::bind("127.0.0.1:0").unwrap();
    proxy.set_nonblocking(true).unwrap();
    let proxy_address = format!("http://{}", proxy.local_addr().unwrap());
    let previous = ["HTTP_PROXY", "ALL_PROXY"]
        .into_iter()
        .map(|name| (name, std::env::var(name).ok()))
        .collect();
    let _restore = EnvRestore(previous);
    std::env::set_var("HTTP_PROXY", &proxy_address);
    std::env::set_var("ALL_PROXY", &proxy_address);

    let body =
        ndjson(&[json!({"model":"m","message":{"content":"ok"},"done":true,"done_reason":"stop"})]);
    let (endpoint, _received, handle) = server(move |stream| {
        let _ = stream.write_all(&chunked_response(NDJSON_CONTENT_TYPE, &body, 0));
    });
    let limits = AiLimits {
        connect: Duration::from_secs(2),
        idle: Duration::from_secs(2),
        overall: Duration::from_secs(3),
        ..AiLimits::default()
    };
    let network = AiNetwork::with_limits(limits).unwrap();
    let sink = Recorder::new();
    let target = chat_target(&endpoint, ModelProtocol::Ollama, PROFILE_MODEL);
    let completion = complete(
        &network,
        &target,
        ChatPayload {
            request_id: &uuid::Uuid::new_v4().to_string(),
            prompt: "hi",
            history: &[],
            bearer: None,
        },
        &sink,
        &mut Cancellation::never(),
    )
    .await
    .unwrap();
    assert_eq!(completion.text, "ok");
    assert_eq!(
        proxy.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock,
        "an environment proxy must never be contacted"
    );
    handle.join().unwrap();
}

#[tokio::test]
async fn ai_http_failures_are_not_retried() {
    let (endpoint, count) = counting_server("500 Internal Server Error");
    let network = AiNetwork::with_limits(AiLimits::default()).unwrap();
    let sink = Recorder::new();
    let target = chat_target(&endpoint, ModelProtocol::Ollama, PROFILE_MODEL);
    let error = complete(
        &network,
        &target,
        ChatPayload {
            request_id: &uuid::Uuid::new_v4().to_string(),
            prompt: "hi",
            history: &[],
            bearer: None,
        },
        &sink,
        &mut Cancellation::never(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "httpError");
    assert_eq!(count.join().unwrap(), 1, "a failed request must not retry");
    assert!(sink.deltas().is_empty());
}

#[tokio::test]
async fn ai_status_and_network_failures_are_structured_and_redacted() {
    for (status, code) in [
        ("401 Unauthorized", "authenticationFailed"),
        ("403 Forbidden", "serverForbidden"),
        ("404 Not Found", "notFound"),
        ("429 Too Many Requests", "rateLimited"),
        ("500 Internal Server Error", "httpError"),
    ] {
        let (endpoint, _received, handle) = server(move |stream| {
            let _ = stream.write_all(&http_response(status, "{\"error\":\"fixture-secret\"}"));
        });
        let network = AiNetwork::with_limits(AiLimits::default()).unwrap();
        let sink = Recorder::new();
        let target = chat_target(&endpoint, ModelProtocol::Ollama, PROFILE_MODEL);
        let error = complete(
            &network,
            &target,
            ChatPayload {
                request_id: &uuid::Uuid::new_v4().to_string(),
                prompt: "hi",
                history: &[],
                bearer: None,
            },
            &sink,
            &mut Cancellation::never(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, code, "{status}");
        let serialized = serde_json::to_string(&error).unwrap();
        assert!(
            !serialized.contains("fixture-secret"),
            "the provider error body must never be echoed"
        );
        assert!(
            !serialized.contains("127.0.0.1"),
            "the endpoint must never be echoed"
        );
        assert!(error.request_id.is_none());
        assert!(sink.deltas().is_empty());
        handle.join().unwrap();
    }

    // A connection failure is structured and carries no URL either. The product connect timeout
    // is used: this host needs about two seconds to refuse a closed loopback port.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let network = AiNetwork::with_limits(AiLimits::default()).unwrap();
    let sink = Recorder::new();
    let target = chat_target(&endpoint, ModelProtocol::Ollama, PROFILE_MODEL);
    let error = complete(
        &network,
        &target,
        ChatPayload {
            request_id: &uuid::Uuid::new_v4().to_string(),
            prompt: "hi",
            history: &[],
            bearer: None,
        },
        &sink,
        &mut Cancellation::never(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "networkError");
    assert!(!serde_json::to_string(&error).unwrap().contains(&endpoint));
}

#[tokio::test]
async fn ai_shared_path_validates_the_request_before_any_lookup() {
    // The shared chat() path refuses a malformed request itself, not only the IPC wrapper, so the
    // tests that drive it exercise the exact production validation.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (_directory, storage, profile) =
        storage_with_profile(&endpoint, ModelProtocol::Ollama, PROFILE_MODEL);
    let ai = ai_state();
    let sink = Recorder::new();
    let blank = chat_request(&profile, "   \n\t ");
    assert_eq!(
        chat(&storage, &ai, blank, &sink).await.unwrap_err().code,
        "invalidInput"
    );
    let mut malformed = chat_request(&profile, "hello");
    malformed.request_id = "not-a-uuid".into();
    assert_eq!(
        chat(&storage, &ai, malformed, &sink)
            .await
            .unwrap_err()
            .code,
        "invalidInput"
    );
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert!(sink.deltas().is_empty());
}

// --- one-shot credentials (A02.2) --------------------------------------------

#[test]
fn ai_custom_http_hosts_and_one_shot_headers_are_accepted() {
    // A user-configured custom endpoint is not restricted to HTTPS or loopback: any HTTP(S) host
    // and port is sent exactly as saved (the UI owns its own nonblocking disclosure).
    assert_eq!(
        chat_url(&chat_target(
            "http://gateway.internal:8080/v1",
            ModelProtocol::OpenaiCompatible,
            LIVE_MODEL
        ))
        .unwrap()
        .as_str(),
        "http://gateway.internal:8080/v1/chat/completions"
    );
    assert_eq!(
        chat_url(&chat_target(
            "http://models.lan:11434",
            ModelProtocol::Ollama,
            "llama3.1:8b"
        ))
        .unwrap()
        .as_str(),
        "http://models.lan:11434/api/chat"
    );

    // The one-shot key becomes exactly one sensitive bearer header and stays redacted in Debug.
    let key = OneShotApiKey::new(FIXTURE_TOKEN.as_bytes().to_vec()).unwrap();
    let header = key.bearer_header().unwrap();
    assert!(header.is_sensitive());
    assert!(header.as_bytes().ends_with(FIXTURE_TOKEN.as_bytes()));
    assert!(!format!("{header:?}").contains(FIXTURE_TOKEN));
    let longest = OneShotApiKey::new(vec![b'k'; 2048]).unwrap();
    assert!(longest.bearer_header().is_ok());
}

#[test]
fn ai_malformed_api_keys_are_refused_before_any_socket() {
    // The credential is refused while the payload is still a payload: no request, lookup,
    // registration or socket can exist for it.
    let oversized = "k".repeat(2049);
    for bad in [
        "",
        "has space",
        "line\r\ninjection",
        "non-ascii-\u{e9}",
        oversized.as_str(),
    ] {
        let mut payload: Value = serde_json::from_str(REQUEST_FIXTURE).unwrap();
        payload["apiKey"] = json!(bad);
        let result = serde_json::from_value::<AiChatRequest>(payload);
        assert!(result.is_err(), "a malformed key must be refused");
        if !bad.is_empty() {
            let message = result.unwrap_err().to_string();
            assert!(
                !message.contains(bad),
                "the refusal must not echo the rejected credential"
            );
        }
    }
    let mut payload: Value = serde_json::from_str(REQUEST_FIXTURE).unwrap();
    payload["apiKey"] = json!(7);
    assert!(serde_json::from_value::<AiChatRequest>(payload).is_err());

    // An explicit null means "no credential", and a valid key stays a single-use value.
    let mut payload: Value = serde_json::from_str(REQUEST_FIXTURE).unwrap();
    payload["apiKey"] = Value::Null;
    let request: AiChatRequest = serde_json::from_value(payload).unwrap();
    assert!(request.api_key.is_none());
    let mut payload: Value = serde_json::from_str(REQUEST_FIXTURE).unwrap();
    payload["apiKey"] = json!(FIXTURE_TOKEN);
    let request: AiChatRequest = serde_json::from_value(payload).unwrap();
    assert!(request.api_key.is_some());
    request.validate().unwrap();
    // Debug output must never contain the prompt or the credential.
    let debugged = format!("{request:?}");
    assert!(!debugged.contains(FIXTURE_TOKEN));
    assert!(!debugged.contains(request.prompt.as_str()));
}

#[tokio::test]
async fn ai_bearer_is_sent_only_to_the_approved_target() {
    let body = ndjson(&[
        json!({"model":"m","message":{"role":"assistant","content":"ok"},"done":false}),
        json!({"model":"m","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop"}),
    ]);
    let (endpoint, received, handle) = server(move |stream| {
        let _ = stream.write_all(&chunked_response(NDJSON_CONTENT_TYPE, &body, 0));
    });
    let (_directory, storage, profile) =
        storage_with_profile(&endpoint, ModelProtocol::Ollama, PROFILE_MODEL);
    let ai = ai_state();
    let sink = Recorder::new();
    let mut request = chat_request(&profile, "hi");
    request.api_key = Some(OneShotApiKey::new(FIXTURE_TOKEN.as_bytes().to_vec()).unwrap());
    let response = chat(&storage, &ai, request, &sink).await.unwrap();
    assert_eq!(response.text, "ok");

    let wire = received.recv().unwrap().to_lowercase();
    assert_eq!(
        wire.matches("authorization:").count(),
        1,
        "exactly one credential header may be sent"
    );
    assert!(
        wire.contains(&format!("authorization: bearer {FIXTURE_TOKEN}")),
        "the approved target must receive the one-shot bearer credential"
    );
    // The credential never enters the JSON body, which stays the single approved message.
    let body_start = wire.find("\r\n\r\n").unwrap() + 4;
    let sent = &wire[body_start..];
    assert!(!sent.contains(FIXTURE_TOKEN));
    assert_eq!(
        sent,
        r#"{"model":"fixture-model","messages":[{"role":"user","content":"hi"}],"stream":true}"#
    );
    // Nor does it appear in the response or any delta.
    assert!(!serde_json::to_string(&response)
        .unwrap()
        .contains(FIXTURE_TOKEN));
    assert!(sink
        .deltas()
        .iter()
        .all(|delta| !delta.text.contains(FIXTURE_TOKEN)));
    handle.join().unwrap();
}

#[tokio::test]
async fn ai_redirect_never_forwards_the_key() {
    let destination = TcpListener::bind("127.0.0.1:0").unwrap();
    destination.set_nonblocking(true).unwrap();
    let location = format!("http://{}/api/chat", destination.local_addr().unwrap());
    let (endpoint, _received, handle) = server(move |stream| {
        let response = format!(
            "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        let _ = stream.write_all(response.as_bytes());
    });
    let (_directory, storage, profile) =
        storage_with_profile(&endpoint, ModelProtocol::Ollama, PROFILE_MODEL);
    let ai = ai_state();
    let sink = Recorder::new();
    let mut request = chat_request(&profile, "hi");
    request.api_key = Some(OneShotApiKey::new(FIXTURE_TOKEN.as_bytes().to_vec()).unwrap());
    let error = chat(&storage, &ai, request, &sink).await.unwrap_err();
    assert_eq!(error.code, "redirectBlocked");
    assert_eq!(
        destination.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock,
        "a redirect destination must never receive the credential"
    );
    assert!(!serde_json::to_string(&error)
        .unwrap()
        .contains(FIXTURE_TOKEN));
    assert!(sink.deltas().is_empty());
    handle.join().unwrap();
}

#[tokio::test]
async fn ai_auth_failure_body_is_not_echoed() {
    let (endpoint, _received, handle) = server(move |stream| {
        let body = format!("{{\"error\":\"fixture-secret {FIXTURE_TOKEN}\"}}");
        let _ = stream.write_all(&http_response("401 Unauthorized", &body));
    });
    let (_directory, storage, profile) =
        storage_with_profile(&endpoint, ModelProtocol::Ollama, PROFILE_MODEL);
    let ai = ai_state();
    let sink = Recorder::new();
    let mut request = chat_request(&profile, "hi");
    request.api_key = Some(OneShotApiKey::new(FIXTURE_TOKEN.as_bytes().to_vec()).unwrap());
    let error = chat(&storage, &ai, request, &sink).await.unwrap_err();
    assert_eq!(error.code, "authenticationFailed");
    let serialized = serde_json::to_string(&error).unwrap();
    assert!(!serialized.contains("fixture-secret"));
    assert!(!serialized.contains(FIXTURE_TOKEN));
    assert!(!serialized.contains("127.0.0.1"));
    assert!(sink.deltas().is_empty());
    handle.join().unwrap();
}

// --- raw-cap regression and stricter frame handling --------------------------

#[tokio::test]
async fn ai_same_chunk_completion_over_limit_is_rejected() {
    // One HTTP chunk that both completes the stream and exceeds the cap: the completion inside
    // it must not be reported as a success.
    let limits = AiLimits {
        max_raw: 128,
        ..AiLimits::default()
    };
    let mut body = sse(&openai_answer("x", "stop"));
    body.extend_from_slice(&[b' '; 200]);
    let (result, deltas) = roundtrip(ModelProtocol::OpenaiCompatible, body, 0, limits).await;
    assert_eq!(result.unwrap_err().code, "responseTooLarge");
    assert!(deltas.is_empty());
}

#[tokio::test]
async fn ai_earlier_deltas_survive_a_later_over_limit_chunk() {
    // The first record fits and is emitted; the next chunk exceeds the cap and is rejected as a
    // whole, so the known size error wins over anything that follows.
    let limits = AiLimits {
        max_raw: 128,
        ..AiLimits::default()
    };
    let first = sse(&[json!({"choices":[{"index":0,"delta":{"content":"first"}}]}).to_string()]);
    let oversized = {
        let mut body = sse(&[
            json!({"choices":[{"index":0,"delta":{"content":"x".repeat(200)},"finish_reason":"stop"}]})
                .to_string(),
        ]);
        body.extend_from_slice(b"data: [DONE]\n\n");
        body
    };
    let (endpoint, _received, handle) = server(move |stream| {
        let _ = stream.write_all(chunked_head(SSE_CONTENT_TYPE).as_bytes());
        write_chunk(stream, &first);
        thread::sleep(Duration::from_millis(2));
        write_chunk(stream, &oversized);
        let _ = stream.write_all(b"0\r\n\r\n");
    });
    let network = AiNetwork::with_limits(limits).unwrap();
    let registry = RequestRegistry::default();
    let sink = Recorder::new();
    let request_id = uuid::Uuid::new_v4().to_string();
    let target = chat_target(&endpoint, ModelProtocol::OpenaiCompatible, PROFILE_MODEL);
    let mut guard = registry.register(&request_id, &target.profile_id).unwrap();
    let result = complete(
        &network,
        &target,
        ChatPayload {
            request_id: &request_id,
            prompt: "hi",
            history: &[],
            bearer: None,
        },
        &sink,
        guard.cancellation(),
    )
    .await;
    assert_eq!(result.unwrap_err().code, "responseTooLarge");
    assert_eq!(sink.texts(), vec!["first"]);
    handle.join().unwrap();
}

#[tokio::test]
async fn ai_sse_rejects_unsupported_frames_and_finish_conflicts() {
    let limits = AiLimits::default();
    let cases: Vec<(Vec<String>, &str, &str)> = vec![
        (
            vec![
                json!({"choices":[{"index":0,"delta":{"content":"a"},"finish_reason":"length"}]})
                    .to_string(),
                json!({"choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}]})
                    .to_string(),
                "[DONE]".into(),
            ],
            "aiUnsupportedResponse",
            "a conflicting termination must not overwrite length with stop",
        ),
        (
            vec![
                json!({"choices":[{"index":0,"delta":{"content":"a"},"finish_reason":"stop"}]})
                    .to_string(),
                json!({"choices":[{"index":0,"delta":{"content":"more"}}]}).to_string(),
                "[DONE]".into(),
            ],
            "aiUnsupportedResponse",
            "no text delta may follow a reported termination",
        ),
        (
            vec![
                json!({"choices":[{"index":0,"delta":{"content":"a"}},{"index":0,"delta":{"content":"b"}}]})
                    .to_string(),
                "[DONE]".into(),
            ],
            "aiUnsupportedResponse",
            "more than one choice entry is unsupported",
        ),
        (
            vec![
                json!({"choices":[{"index":0,"delta":{"role":"user","content":"x"}}]}).to_string(),
                "[DONE]".into(),
            ],
            "aiUnsupportedResponse",
            "a non-assistant role is unsupported",
        ),
        (
            vec![
                json!({"choices":[{"index":0,"delta":{"content":"a"},"finish_reason":"stop"}]})
                    .to_string(),
                json!({"choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}]})
                    .to_string(),
                "[DONE]".into(),
            ],
            "aiUnsupportedResponse",
            "a repeated termination is unsupported",
        ),
    ];
    for (payloads, expected, label) in cases {
        let (result, _) =
            roundtrip(ModelProtocol::OpenaiCompatible, sse(&payloads), 0, limits).await;
        assert_eq!(result.unwrap_err().code, expected, "{label}");
    }

    // Typed events are honoured: `error` is a provider failure, other extensions are unsupported.
    let error_event = {
        let mut body = b"event: error\ndata: {\"message\":\"fixture-secret\"}\n\n".to_vec();
        body.extend_from_slice(b"data: [DONE]\n\n");
        body
    };
    let (result, _) = roundtrip(ModelProtocol::OpenaiCompatible, error_event, 0, limits).await;
    assert_eq!(result.unwrap_err().code, "aiProviderError");
    let ping_event = b"event: ping\ndata: {}\n\n".to_vec();
    let (result, _) = roundtrip(ModelProtocol::OpenaiCompatible, ping_event, 0, limits).await;
    assert_eq!(result.unwrap_err().code, "aiUnsupportedResponse");
}

#[tokio::test]
async fn ai_sse_accepts_empty_finish_reasons_and_ignores_empty_placeholders() {
    let limits = AiLimits::default();
    // The gateway sends `finish_reason: ""` on every intermediate chunk; empty tool/function/audio
    // placeholders and `reasoning_content` are inert, and only `content` becomes text.
    let payloads = vec![
        json!({"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":""}]}).to_string(),
        json!({"choices":[{"index":0,"delta":{"content":"A","tool_calls":[],"function_call":{},"audio":null,"reasoning_content":"hidden reasoning"},"finish_reason":""}]}).to_string(),
        json!({"choices":[{"index":0,"delta":{"content":"B"},"finish_reason":""}]}).to_string(),
        json!({"choices":[],"usage":{"total_tokens":3}}).to_string(),
        json!({"choices":[{"index":0,"delta":{"content":"C"},"finish_reason":"stop"}]}).to_string(),
        "[DONE]".into(),
    ];
    let (result, deltas) =
        roundtrip(ModelProtocol::OpenaiCompatible, sse(&payloads), 0, limits).await;
    let completion = result.unwrap();
    assert_eq!(completion.text, "ABC");
    assert_eq!(completion.sequence, 3);
    assert_eq!(completion.outcome, AiChatOutcome::Complete);
    assert!(!completion.text.contains("hidden reasoning"));
    assert!(deltas
        .iter()
        .all(|delta| !delta.text.contains("hidden reasoning")));

    // An empty reason followed by a real `length` still maps to length.
    let payloads = vec![
        json!({"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":""}]}).to_string(),
        json!({"choices":[{"index":0,"delta":{"content":""},"finish_reason":"length"}]})
            .to_string(),
        "[DONE]".into(),
    ];
    let (result, _) = roundtrip(ModelProtocol::OpenaiCompatible, sse(&payloads), 0, limits).await;
    assert_eq!(result.unwrap().outcome, AiChatOutcome::Length);

    // A stream whose only terminations are empty never completes.
    let payloads = vec![
        json!({"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":""}]}).to_string(),
        "[DONE]".into(),
    ];
    let (result, _) = roundtrip(ModelProtocol::OpenaiCompatible, sse(&payloads), 0, limits).await;
    assert_eq!(result.unwrap_err().code, "aiIncompleteStream");

    // Ollama ignores the same empty placeholders.
    let body = ndjson(&[
        json!({"model":"m","message":{"role":"assistant","content":"ok","tool_calls":[],"images":[]},"done":false}),
        json!({"model":"m","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop"}),
    ]);
    let (result, _) = roundtrip(ModelProtocol::Ollama, body, 0, limits).await;
    assert_eq!(result.unwrap().text, "ok");
}

#[tokio::test]
async fn ai_sse_rejects_malformed_finish_reasons() {
    for reason in [
        json!(7),
        json!(true),
        json!({}),
        json!(["stop"]),
        json!("tool_calls"),
    ] {
        let payloads = vec![
            json!({"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":reason}]})
                .to_string(),
            "[DONE]".into(),
        ];
        let (result, _) = roundtrip(
            ModelProtocol::OpenaiCompatible,
            sse(&payloads),
            0,
            AiLimits::default(),
        )
        .await;
        assert_eq!(
            result.unwrap_err().code,
            "aiUnsupportedResponse",
            "{reason}"
        );
    }
    // A real tool call is refused even when the other placeholders are empty.
    let payloads = vec![
        json!({"choices":[{"index":0,"delta":{"tool_calls":[{"id":"a"}],"function_call":{}},"finish_reason":""}]})
            .to_string(),
        "[DONE]".into(),
    ];
    let (result, _) = roundtrip(
        ModelProtocol::OpenaiCompatible,
        sse(&payloads),
        0,
        AiLimits::default(),
    )
    .await;
    assert_eq!(result.unwrap_err().code, "aiUnsupportedResponse");
}

#[tokio::test]
async fn ai_ollama_strict_frames_and_final_record() {
    let limits = AiLimits::default();

    // A final done:true record without its trailing newline is a normal completion.
    let mut body = ndjson(&[
        json!({"model":"m","message":{"role":"assistant","content":"done"},"done":false}),
    ]);
    body.extend_from_slice(
        json!({"model":"m","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop"})
            .to_string()
            .as_bytes(),
    );
    let (result, _) = roundtrip(ModelProtocol::Ollama, body, 0, limits).await;
    let completion = result.unwrap();
    assert_eq!(completion.text, "done");
    assert_eq!(completion.outcome, AiChatOutcome::Complete);

    // A truncated or malformed final record fails closed instead of being guessed.
    let mut body = ndjson(&[json!({"model":"m","message":{"content":"a"},"done":false})]);
    body.extend_from_slice(b"{\"model\":\"m\",\"message\":{\"cont");
    let (result, _) = roundtrip(ModelProtocol::Ollama, body, 0, limits).await;
    assert_eq!(result.unwrap_err().code, "invalidResponse");

    // Invalid UTF-8 in the final record is rejected as well.
    let mut body = ndjson(&[json!({"model":"m","message":{"content":"a"},"done":false})]);
    body.extend_from_slice(b"\xff\xfe");
    let (result, _) = roundtrip(ModelProtocol::Ollama, body, 0, limits).await;
    assert_eq!(result.unwrap_err().code, "invalidResponse");

    // A valid final record that never said done keeps its text but stays incomplete.
    let mut body = ndjson(&[json!({"model":"m","message":{"content":"a"},"done":false})]);
    body.extend_from_slice(
        json!({"model":"m","message":{"content":"tail"},"done":false})
            .to_string()
            .as_bytes(),
    );
    let (result, deltas) = roundtrip(ModelProtocol::Ollama, body, 0, limits).await;
    assert_eq!(result.unwrap_err().code, "aiIncompleteStream");
    assert_eq!(deltas.len(), 2);

    // Non-assistant roles and non-boolean done values are refused.
    let (result, _) = roundtrip(
        ModelProtocol::Ollama,
        ndjson(&[json!({"model":"m","message":{"role":"user","content":"x"},"done":false})]),
        0,
        limits,
    )
    .await;
    assert_eq!(result.unwrap_err().code, "aiUnsupportedResponse");
    let (result, _) = roundtrip(
        ModelProtocol::Ollama,
        ndjson(&[json!({"model":"m","message":{"content":"x"},"done":"true"})]),
        0,
        limits,
    )
    .await;
    assert_eq!(result.unwrap_err().code, "aiUnsupportedResponse");
}

#[tokio::test]
async fn ai_ollama_cancel_between_lines_cannot_become_success() {
    // Two records in one network chunk: the first emits text and cancels the request from inside
    // the sink; the terminal `done:true` that follows in the same chunk must not become a
    // success. A short idle window keeps a wrong implementation failing fast.
    let body = ndjson(&[
        json!({"model":"m","message":{"role":"assistant","content":"first"},"done":false}),
        json!({"model":"m","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop"}),
    ]);
    let (endpoint, started, handle) = signaling_server(move |stream| {
        let _ = stream.write_all(chunked_head(NDJSON_CONTENT_TYPE).as_bytes());
        write_chunk(stream, &body);
        stall(stream);
    });
    let limits = AiLimits {
        idle: Duration::from_millis(300),
        overall: Duration::from_secs(3),
        ..AiLimits::default()
    };
    let network = AiNetwork::with_limits(limits).unwrap();
    let registry = Arc::new(RequestRegistry::default());
    let request_id = uuid::Uuid::new_v4().to_string();
    let target = chat_target(&endpoint, ModelProtocol::Ollama, PROFILE_MODEL);
    let mut guard = registry.register(&request_id, &target.profile_id).unwrap();
    let sink = CancelOnFirstDelta::new(registry.clone(), &request_id, &target.profile_id);
    let mut executing = Box::pin(complete(
        &network,
        &target,
        ChatPayload {
            request_id: &request_id,
            prompt: "hi",
            history: &[],
            bearer: None,
        },
        &sink,
        guard.cancellation(),
    ));
    let mut started = started;
    tokio::select! {
        result = &mut executing => panic!("the chat must still be in flight: {result:?}"),
        _ = &mut started => {}
    }
    assert_eq!(executing.await.unwrap_err().code, "cancelled");
    assert_eq!(sink.texts(), vec!["first"]);
    drop(guard);
    assert!(!registry.cancel(&request_id, &target.profile_id));
    assert!(network.acquire().is_ok());
    handle.join().unwrap();
}

// --- saved model credentials (A01.2/A02.3) -----------------------------------

/// Bind one saved key to a profile through the production credential flow and an injected store.
fn bind_saved_key(
    storage: &StorageState,
    store: &TestCredentialStore,
    profile: &ModelProfile,
    token: &str,
) -> ModelProfile {
    let input = ModelInput {
        display_name: profile.display_name.clone(),
        protocol: profile.protocol,
        endpoint: profile.endpoint.clone(),
        model_id: profile.model_id.clone(),
    };
    with_database(storage, |db| {
        ModelCredentials::new(db, store)
            .save(
                input,
                Some(profile.id.clone()),
                ModelCredentialChange::Replace(
                    OneShotApiKey::new(token.as_bytes().to_vec()).unwrap(),
                ),
            )
            .map(|write| write.profile)
    })
    .unwrap()
}

/// An `AiState` whose credential backend is the injected test store.
fn ai_state_with_store(store: &TestCredentialStore) -> AiState {
    let mut state = AiState::new();
    state.credentials = Box::new(store.clone());
    state
}

/// A completing Ollama fixture that captures the request, so a chat can assert exactly which
/// header was sent.
fn ollama_fixture() -> (String, Receiver<String>, thread::JoinHandle<()>) {
    let body = ndjson(&[
        json!({"model":"m","message":{"role":"assistant","content":"ok"},"done":false}),
        json!({"model":"m","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop"}),
    ]);
    server(move |stream| {
        let _ = stream.write_all(&chunked_response(NDJSON_CONTENT_TYPE, &body, 0));
    })
}

#[tokio::test]
async fn ai_chat_uses_the_saved_model_credential_when_no_override_is_sent() {
    let (endpoint, received, handle) = ollama_fixture();
    let (_directory, storage, profile) =
        storage_with_profile(&endpoint, ModelProtocol::Ollama, PROFILE_MODEL);
    let store = TestCredentialStore::new();
    let profile = bind_saved_key(&storage, &store, &profile, FIXTURE_TOKEN);
    assert!(profile.has_api_key);
    let ai = ai_state_with_store(&store);

    let sink = Recorder::new();
    let response = chat(&storage, &ai, chat_request(&profile, "hi"), &sink)
        .await
        .unwrap();
    assert_eq!(response.text, "ok");

    // Exactly one header, built from the saved reference, and never a JSON field.
    let wire = received.recv().unwrap().to_lowercase();
    assert_eq!(wire.matches("authorization:").count(), 1);
    assert!(wire.contains(&format!("authorization: bearer {FIXTURE_TOKEN}")));
    assert!(!wire.contains("api_key"));
    assert!(sink
        .deltas()
        .iter()
        .all(|delta| !delta.text.contains(FIXTURE_TOKEN)));
    handle.join().unwrap();
}

#[tokio::test]
async fn ai_request_override_wins_over_the_saved_credential() {
    let (endpoint, received, handle) = ollama_fixture();
    let (_directory, storage, profile) =
        storage_with_profile(&endpoint, ModelProtocol::Ollama, PROFILE_MODEL);
    let store = TestCredentialStore::new();
    let profile = bind_saved_key(&storage, &store, &profile, FIXTURE_TOKEN);
    let ai = ai_state_with_store(&store);

    let sink = Recorder::new();
    let mut request = chat_request(&profile, "hi");
    request.api_key = Some(OneShotApiKey::new(b"override-token".to_vec()).unwrap());
    chat(&storage, &ai, request, &sink).await.unwrap();

    let wire = received.recv().unwrap().to_lowercase();
    assert!(wire.contains("authorization: bearer override-token"));
    assert!(!wire.contains(FIXTURE_TOKEN));
    handle.join().unwrap();
}

#[tokio::test]
async fn ai_saved_credential_failures_are_stable_and_never_fall_back() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (_directory, storage, profile) =
        storage_with_profile(&endpoint, ModelProtocol::Ollama, PROFILE_MODEL);
    let store = TestCredentialStore::new();
    let profile = bind_saved_key(&storage, &store, &profile, FIXTURE_TOKEN);
    let ai = ai_state_with_store(&store);
    let sink = Recorder::new();

    for (faults, code) in [
        (
            Faults {
                read: Some(CredentialError::Unavailable),
                ..Faults::default()
            },
            "credentialUnavailable",
        ),
        (
            Faults {
                read: Some(CredentialError::StorageFailure),
                ..Faults::default()
            },
            "credentialFailure",
        ),
        (
            Faults {
                read: Some(CredentialError::NotFound),
                ..Faults::default()
            },
            "credentialNotFound",
        ),
    ] {
        store.set_faults(faults);
        let error = chat(&storage, &ai, chat_request(&profile, "hi"), &sink)
            .await
            .unwrap_err();
        assert_eq!(error.code, code);
        assert!(!serde_json::to_string(&error)
            .unwrap()
            .contains(FIXTURE_TOKEN));
    }

    // A stored value that cannot form a header is a stable credential failure, never a request
    // without authentication.
    store.set_faults(Faults::default());
    let reference = profile.credential_ref.clone().unwrap();
    assert!(store.contains(&reference));
    let unsafe_secret = Secret::new(b"not header safe".to_vec()).unwrap();
    store.set(&reference, &unsafe_secret).unwrap();
    let error = chat(&storage, &ai, chat_request(&profile, "hi"), &sink)
        .await
        .unwrap_err();
    assert_eq!(error.code, "credentialFailure");

    // None of these opened a socket or emitted a delta.
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert!(sink.deltas().is_empty());
}

#[tokio::test]
async fn ai_target_change_never_reuses_the_old_credential() {
    let (endpoint, received, handle) = ollama_fixture();
    let (_directory, storage, profile) =
        storage_with_profile(&endpoint, ModelProtocol::Ollama, PROFILE_MODEL);
    let store = TestCredentialStore::new();
    let profile = bind_saved_key(&storage, &store, &profile, FIXTURE_TOKEN);

    // Editing the endpoint through the normal save path detaches the credential: the old secret is
    // queued and deleted, and the profile no longer reports a key.
    let moved = with_database(&storage, |db| {
        ModelCredentials::new(db, &store)
            .save(
                ModelInput {
                    display_name: profile.display_name.clone(),
                    protocol: profile.protocol,
                    endpoint: format!("{endpoint}/moved"),
                    model_id: profile.model_id.clone(),
                },
                Some(profile.id.clone()),
                ModelCredentialChange::Keep,
            )
            .map(|write| write.profile)
    })
    .unwrap();
    assert!(!moved.has_api_key);
    assert!(moved.credential_ref.is_none());
    assert!(store.is_empty());
    assert!(
        !with_database(&storage, |db| db.models())
            .unwrap()
            .credential_cleanup_pending
    );

    // A chat approved for the new target sends no Authorization header at all.
    let ai = ai_state_with_store(&store);
    let sink = Recorder::new();
    let response = chat(&storage, &ai, chat_request(&moved, "hi"), &sink)
        .await
        .unwrap();
    assert_eq!(response.text, "ok");
    let wire = received.recv().unwrap().to_lowercase();
    assert!(
        !wire.contains("authorization:"),
        "a detached credential must never be reused at the new target"
    );
    handle.join().unwrap();
}

#[tokio::test]
async fn ai_never_reads_another_profiles_credential() {
    let (endpoint, received, handle) = ollama_fixture();
    let (_directory, storage, plain) =
        storage_with_profile(&endpoint, ModelProtocol::Ollama, PROFILE_MODEL);
    // A second profile on the same endpoint holds a key; the approved request names the first and
    // must stay unauthenticated rather than borrow it.
    let other = with_database(&storage, |db| {
        db.save_model(
            ModelInput {
                display_name: "Other".into(),
                protocol: ModelProtocol::Ollama,
                endpoint: endpoint.clone(),
                model_id: "other-model".into(),
            },
            None,
        )
    })
    .unwrap();
    let store = TestCredentialStore::new();
    bind_saved_key(&storage, &store, &other, FIXTURE_TOKEN);
    let ai = ai_state_with_store(&store);

    let sink = Recorder::new();
    let response = chat(&storage, &ai, chat_request(&plain, "hi"), &sink)
        .await
        .unwrap();
    assert_eq!(response.text, "ok");
    let wire = received.recv().unwrap().to_lowercase();
    assert!(
        !wire.contains("authorization:"),
        "only the approved profile's own reference may ever be used"
    );
    handle.join().unwrap();
}

// --- opt-in real gateway test -------------------------------------------------

/// Cancels the running chat from inside the delivery of its first delta, using the very registry
/// the chat registered with. The opt-in live test uses this so a fast gateway cannot finish the
/// stream before the stop is observed, and no polling race is possible.
struct LiveCancelSink<'a> {
    registry: &'a RequestRegistry,
    request_id: &'a str,
    model_profile_id: &'a str,
}

impl AiDeltaSink for LiveCancelSink<'_> {
    fn send(&self, _delta: AiChatDelta) -> Result<(), AppError> {
        assert!(
            self.registry.cancel(self.request_id, self.model_profile_id),
            "the live cancel must reach the running chat"
        );
        Ok(())
    }
}

/// Reads the one-shot key for the opt-in test from the process environment. Production code
/// never reads a credential from the environment; the runner supplies this through its hidden
/// input, and the value is never printed.
fn live_api_key() -> OneShotApiKey {
    let raw = std::env::var("ESCOPE_TEST_MODEL_API_KEY").unwrap_or_else(|_| {
        panic!("ESCOPE_TEST_MODEL_API_KEY must be provided by the hidden-input runner")
    });
    OneShotApiKey::new(raw.into_bytes())
        .expect("ESCOPE_TEST_MODEL_API_KEY must be a valid single-use credential")
}

/// The user-authorized opt-in check against the local gateway, driven by
/// `scripts/test-ai-gateway.mjs` through the environment only. It makes one model-list call and
/// three tiny chat calls (completion, history recall, then cancellation) over the
/// same production paths as every other test, against a temporary database. No prompt, streamed
/// text, raw event or credential value is ever printed, and a normal test run never reaches it
/// (`#[ignore]` plus the environment gate).
#[tokio::test]
#[ignore]
async fn live_authorized_gateway_stream_and_cancel() {
    assert_eq!(
        std::env::var("ESCOPE_TEST_MODEL_GATEWAY").as_deref(),
        Ok("1"),
        "opt-in required: set ESCOPE_TEST_MODEL_GATEWAY=1 and supply the key through the hidden prompt"
    );
    let (_directory, storage, profile) =
        storage_with_profile(LIVE_ENDPOINT, ModelProtocol::OpenaiCompatible, LIVE_MODEL);
    let ai = ai_state();

    // Call 1: list the authorized gateway's models with the provided key; the model the app is
    // configured for must be selectable from the list.
    let discovery = DiscoveryState::new();
    let store = TestCredentialStore::new();
    let listed = discover(
        &storage,
        &discovery,
        &store,
        ModelDiscoveryRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            protocol: ModelProtocol::OpenaiCompatible,
            endpoint: LIVE_ENDPOINT.into(),
            credential: RawDiscoveryCredential {
                kind: "provided".into(),
                model_profile_id: None,
                api_key: Some(live_api_key()),
            },
        },
    )
    .await
    .expect("the authorized gateway must list its models");
    assert_eq!(listed.protocol, ModelProtocol::OpenaiCompatible);
    assert_eq!(listed.endpoint, LIVE_ENDPOINT);
    assert!(
        listed.model_ids.iter().any(|id| id == LIVE_MODEL),
        "the authorized gateway must list the requested model"
    );

    // Call 2: a tiny harmless prompt; the stream must produce text and terminate normally.
    let sink = Recorder::new();
    let mut request = chat_request(&profile, "Reply with OK.");
    let request_id = request.request_id.clone();
    request.authorization.scope = "conversation".into();
    request.api_key = Some(live_api_key());
    let response = chat(&storage, &ai, request, &sink)
        .await
        .expect("the approved gateway request must complete");
    assert!(
        !sink.deltas().is_empty(),
        "the gateway must stream at least one delta"
    );
    assert!(
        !response.text.trim().is_empty(),
        "the gateway answer must not be empty"
    );
    assert_eq!(response.outcome, AiChatOutcome::Complete);
    assert_eq!(response.request_id, request_id);
    assert_eq!(response.model_profile_id, profile.id);
    assert_eq!(response.endpoint, LIVE_ENDPOINT);
    assert_eq!(response.model_id, LIVE_MODEL);
    assert_eq!(response.sequence as usize, sink.deltas().len());
    if let Some(actual) = &response.actual_model_id {
        assert_eq!(
            actual, LIVE_MODEL,
            "the reported model must match the target"
        );
    }

    // Call 3: the label exists only in the earlier messages, never in the current prompt.
    let mut request = chat_request(
        &profile,
        "Reply with the exact label stated earlier, and nothing else.",
    );
    request.authorization.scope = "conversation".into();
    request.history = Some(vec![
        AiChatMessage {
            role: AiChatRole::User,
            content: "The label for this conversation is ESCOPE_HISTORY_CHECK.".into(),
        },
        AiChatMessage {
            role: AiChatRole::Assistant,
            content: "I will remember that label.".into(),
        },
    ]);
    request.api_key = Some(live_api_key());
    let remembered = chat(&storage, &ai, request, &Recorder::new())
        .await
        .expect("the authorized gateway must support conversation history");
    assert_eq!(remembered.outcome, AiChatOutcome::Complete);
    assert!(
        remembered.text.contains("ESCOPE_HISTORY_CHECK"),
        "the prior label must be available"
    );

    // Call 4: the sink cancels synchronously from inside the first delta delivery, so the stop
    // cannot lose a race against a fast stream. (Whether the provider stops computing is not
    // asserted: it is not something this client observes.)
    let second_id = uuid::Uuid::new_v4().to_string();
    let mut request = chat_request(&profile, "Count from 1 to 50, one number per line.");
    request.request_id = second_id.clone();
    request.api_key = Some(live_api_key());
    let sink = LiveCancelSink {
        registry: &ai.requests,
        request_id: &second_id,
        model_profile_id: &profile.id,
    };
    let mut executing = Box::pin(chat(&storage, &ai, request, &sink));
    let outcome = tokio::time::timeout(Duration::from_secs(60), &mut executing)
        .await
        .expect("the cancelled chat must finish promptly");
    match outcome {
        Err(error) => assert_eq!(error.code, "cancelled"),
        Ok(_) => panic!("a cancelled chat must not complete"),
    }
    // Registration and permit are released; a late cancel reports false.
    assert!(!ai.requests.cancel(&second_id, &profile.id));
    assert!(ai.network.as_ref().unwrap().acquire().is_ok());
}
