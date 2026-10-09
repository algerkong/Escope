//! Constrained remote model discovery (A02.3).
//!
//! Discovery answers one question: which model ids does this user-entered HTTP(S) base endpoint
//! list? It is triggered only by an explicit user action, it never downloads a model and it never
//! generates text. The transport is fixed: one `GET` to the validated base plus the protocol's
//! list path (`/models` for OpenAI-compatible, `/api/tags` for Ollama), optionally with one
//! bearer header, no redirects, no environment proxy, no retries, a 10s deadline, a 1 MiB body
//! cap and two concurrent requests.
//!
//! Credentials: `none` sends no header; `provided` uses the one-shot key for this fetch only;
//! `stored` resolves the reference from the saved profile and is refused with `aiTargetChanged`
//! unless that profile's endpoint and protocol exactly match the normalized draft target, before
//! any key lookup happens. Discovery never falls back to another endpoint, provider or secret.
//!
//! Results: at most 512 unique model ids in stable order, each non-empty and at most 200 code
//! points. `truncated` is true when the provider says there is more or the cap was reached. A
//! legitimate empty list is a success; malformed shapes, provider errors and HTTP failures are
//! explicit structured errors so the UI can offer manual model-id entry instead.

use crate::ai::ai_transport::{status_error, transport_client, transport_error};
use crate::credentials::CredentialStore;
use crate::error::AppError;
use crate::model_api_key::OneShotApiKey;
use crate::model_credentials::stored_bearer_header;
use crate::read_only::{validate_uuid, Cancellation, RequestRegistry};
use crate::storage::{clean_endpoint, ModelProtocol};
use crate::{with_database, StorageState};
use reqwest::header::HeaderValue;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tauri::State;
use tokio::sync::{Semaphore, SemaphorePermit};
use url::Url;

/// Hard cap on returned model ids; the list is a menu, not a mirror of the provider.
pub(crate) const MAX_DISCOVERED_MODELS: usize = 512;
/// One model id bound, in code points, matching the saved model id bound.
pub(crate) const MAX_MODEL_ID_CHARS: usize = 200;
const MAX_DISCOVERY_BODY: usize = 1024 * 1024;
/// Second registry key component. Discovery has its own registry, so a discovery request is
/// effectively scoped by its `requestId` alone and a chat or Elasticsearch cancel can never reach
/// it (and vice versa) even for colliding identifiers.
const DISCOVERY_SCOPE: &str = "model-discovery";

/// Discovery limits. The production values are the product contract; tests override them to
/// exercise expiry and cap paths without large payloads or real seconds.
#[derive(Clone, Copy, Debug)]
pub(crate) struct DiscoveryLimits {
    pub(crate) connect: Duration,
    pub(crate) overall: Duration,
    pub(crate) max_body: usize,
    pub(crate) max_inflight: usize,
}

impl Default for DiscoveryLimits {
    fn default() -> Self {
        Self {
            connect: Duration::from_secs(10),
            overall: Duration::from_secs(10),
            max_body: MAX_DISCOVERY_BODY,
            max_inflight: 2,
        }
    }
}

/// One HTTP client with the shared transport rules plus the discovery permit pool.
pub(crate) struct DiscoveryNetwork {
    client: reqwest::Client,
    permits: Semaphore,
    limits: DiscoveryLimits,
}

impl DiscoveryNetwork {
    pub(crate) fn new() -> Result<Self, AppError> {
        Self::with_limits(DiscoveryLimits::default())
    }

    pub(crate) fn with_limits(limits: DiscoveryLimits) -> Result<Self, AppError> {
        Ok(Self {
            client: transport_client(limits.connect)?,
            permits: Semaphore::new(limits.max_inflight),
            limits,
        })
    }

    fn limits(&self) -> &DiscoveryLimits {
        &self.limits
    }

    /// Take one permit without waiting; a third concurrent discovery is refused with `busy`.
    fn acquire(&self) -> Result<SemaphorePermit<'_>, AppError> {
        self.permits
            .try_acquire()
            .map_err(|_| AppError::new("busy"))
    }

    /// The only method discovery ever uses.
    async fn get(
        &self,
        url: Url,
        bearer: Option<HeaderValue>,
    ) -> Result<reqwest::Response, AppError> {
        let mut request = self
            .client
            .get(url)
            .header(reqwest::header::ACCEPT, "application/json");
        if let Some(bearer) = bearer {
            request = request.header(reqwest::header::AUTHORIZATION, bearer);
        }
        request
            .send()
            .await
            .map_err(|error| transport_error(&error))
    }
}

/// Backend state for model discovery: its own client and its own cancellation registry.
pub struct DiscoveryState {
    pub(crate) network: Result<DiscoveryNetwork, AppError>,
    pub(crate) requests: RequestRegistry,
}

impl DiscoveryState {
    pub fn new() -> Self {
        Self {
            network: DiscoveryNetwork::new(),
            requests: RequestRegistry::default(),
        }
    }
}

/// One discovery call. `requestId` is validated before it is echoed; the credential is validated
/// as a closed union before any lookup.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelDiscoveryRequest {
    pub(crate) request_id: String,
    pub(crate) protocol: ModelProtocol,
    pub(crate) endpoint: String,
    pub(crate) credential: RawDiscoveryCredential,
}

/// The wire spelling of a discovery credential. Converted by [`ModelDiscoveryRequest::into_parts`],
/// which closes every combination the contract does not allow.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RawDiscoveryCredential {
    pub(crate) kind: String,
    #[serde(default)]
    pub(crate) model_profile_id: Option<String>,
    #[serde(default)]
    pub(crate) api_key: Option<OneShotApiKey>,
}

#[derive(Debug)]
enum DiscoveryCredential {
    None,
    Stored { model_profile_id: String },
    Provided(OneShotApiKey),
}

impl ModelDiscoveryRequest {
    /// Validate identifiers, normalize the draft endpoint and close the credential union.
    fn into_parts(self) -> Result<(String, ModelProtocol, String, DiscoveryCredential), AppError> {
        validate_uuid(&self.request_id)?;
        let endpoint = clean_endpoint(&self.endpoint)?;
        let credential = match (
            self.credential.kind.as_str(),
            self.credential.model_profile_id,
            self.credential.api_key,
        ) {
            ("none", None, None) => DiscoveryCredential::None,
            ("stored", Some(model_profile_id), None) => {
                validate_uuid(&model_profile_id)?;
                DiscoveryCredential::Stored { model_profile_id }
            }
            ("provided", None, Some(key)) => DiscoveryCredential::Provided(key),
            _ => return Err(AppError::new("invalidInput")),
        };
        Ok((self.request_id, self.protocol, endpoint, credential))
    }
}

/// One discovery answer, serialized exactly as `tests/fixtures/model-discovery-response.json`.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelDiscoveryResponse {
    pub(crate) request_id: String,
    pub(crate) protocol: ModelProtocol,
    pub(crate) endpoint: String,
    pub(crate) model_ids: Vec<String>,
    pub(crate) truncated: bool,
}

/// `models_discover_cancel` payload: the request to stop, identified by its own id.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelDiscoveryCancelRequest {
    pub(crate) request_id: String,
}

/// List the models of one user-entered endpoint. Only an explicit caller runs this; it never
/// writes, downloads or generates anything.
#[tauri::command]
pub(crate) async fn models_discover(
    state: State<'_, StorageState>,
    discovery: State<'_, DiscoveryState>,
    request: ModelDiscoveryRequest,
) -> Result<ModelDiscoveryResponse, AppError> {
    let raw_id = request.request_id.clone();
    let store = crate::credentials::SystemCredentialStore::new();
    let result = discover(&state, &discovery, &store, request).await;
    result.map_err(|mut error: AppError| {
        // Reflected only when the identifier itself passed validation.
        if validate_uuid(&raw_id).is_ok() {
            error.request_id = Some(raw_id);
        }
        error
    })
}

/// Cancel a discovery request registered under this exact `requestId`.
#[tauri::command]
pub(crate) fn models_discover_cancel(
    discovery: State<'_, DiscoveryState>,
    request: ModelDiscoveryCancelRequest,
) -> Result<bool, AppError> {
    validate_uuid(&request.request_id)?;
    Ok(discovery
        .requests
        .cancel(&request.request_id, DISCOVERY_SCOPE))
}

/// The command body without the IPC wrapper, so tests can drive the exact same flow.
pub(crate) async fn discover(
    storage: &StorageState,
    discovery: &DiscoveryState,
    store: &dyn CredentialStore,
    request: ModelDiscoveryRequest,
) -> Result<ModelDiscoveryResponse, AppError> {
    let (request_id, protocol, endpoint, credential) = request.into_parts()?;
    // Registered before any lookup or I/O: an early cancel blocks this start, and a duplicate id
    // can never hijack a running request's cancellation.
    let mut guard = discovery.requests.register(&request_id, DISCOVERY_SCOPE)?;
    let bearer = resolve_bearer(storage, protocol, &endpoint, credential, store)?;
    let network = discovery.network.as_ref().map_err(Clone::clone)?;
    let url = discovery_url(protocol, &endpoint)?;
    let _permit = network.acquire()?;
    let limits = *network.limits();
    let outcome = tokio::time::timeout(limits.overall, async {
        let response = tokio::select! {
            biased;
            () = guard.cancellation().cancelled() => return Err(AppError::new("cancelled")),
            response = network.get(url, bearer) => response?,
        };
        let status = response.status();
        if !status.is_success() {
            // The provider's error body is never read, logged or returned.
            return Err(status_error(status));
        }
        let body = read_body(response, limits.max_body, guard.cancellation()).await?;
        parse_models(protocol, &body)
    })
    .await;
    let (model_ids, truncated) = match outcome {
        Ok(result) => result?,
        Err(_) => return Err(AppError::new("timeout")),
    };
    Ok(ModelDiscoveryResponse {
        request_id,
        protocol,
        endpoint,
        model_ids,
        truncated,
    })
}

/// Resolve the one optional header discovery may send. A stored key is only readable from the
/// saved profile that owns it, and only when that profile names the exact draft target.
fn resolve_bearer(
    storage: &StorageState,
    protocol: ModelProtocol,
    endpoint: &str,
    credential: DiscoveryCredential,
    store: &dyn CredentialStore,
) -> Result<Option<HeaderValue>, AppError> {
    match credential {
        DiscoveryCredential::None => Ok(None),
        DiscoveryCredential::Provided(key) => Ok(Some(key.bearer_header()?)),
        DiscoveryCredential::Stored { model_profile_id } => {
            let profile = with_database(storage, |db| db.model_profile(&model_profile_id))?;
            if profile.protocol != protocol || profile.endpoint != endpoint {
                return Err(AppError::new("aiTargetChanged"));
            }
            let Some(reference) = profile.credential_ref.as_ref() else {
                return Err(AppError::new("credentialNotFound"));
            };
            Ok(Some(stored_bearer_header(store, reference)?))
        }
    }
}

/// The one GET URL discovery may use: the validated base plus the protocol's fixed list path.
fn discovery_url(protocol: ModelProtocol, endpoint: &str) -> Result<Url, AppError> {
    let mut url = Url::parse(endpoint).map_err(|_| AppError::new("invalidInput"))?;
    // Only the configured base path is preserved; the appended path is closed per protocol.
    let path = format!("{}/", url.path().trim_end_matches('/'));
    url.set_path(&path);
    let relative = match protocol {
        ModelProtocol::OpenaiCompatible => "models",
        ModelProtocol::Ollama => "api/tags",
    };
    url.join(relative)
        .map_err(|_| AppError::new("invalidInput"))
}

/// Read the body with the byte cap and cancellation between chunks, so a stalled list read can be
/// stopped and an oversized list never turns into an unbounded allocation.
async fn read_body(
    mut response: reqwest::Response,
    max: usize,
    cancellation: &mut Cancellation,
) -> Result<Vec<u8>, AppError> {
    let mut bytes = Vec::new();
    loop {
        let chunk = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(AppError::new("cancelled")),
            outcome = response.chunk() => match outcome {
                Ok(chunk) => chunk,
                Err(error) => return Err(transport_error(&error)),
            },
        };
        let Some(chunk) = chunk else {
            break;
        };
        if bytes.len() + chunk.len() > max {
            return Err(AppError::new("responseTooLarge"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Parse one model list. Shapes are strict (a provider error or an unusable list must be visible),
/// while ids that can never be selected are skipped and unknown metadata is ignored as inert data.
fn parse_models(protocol: ModelProtocol, body: &[u8]) -> Result<(Vec<String>, bool), AppError> {
    let frame: Value =
        serde_json::from_slice(body).map_err(|_| AppError::new("invalidResponse"))?;
    if frame.get("error").is_some_and(|error| !error.is_null()) {
        return Err(AppError::new("aiProviderError"));
    }
    let frame = frame
        .as_object()
        .ok_or_else(|| AppError::new("aiUnsupportedResponse"))?;
    let (entries, provider_more) = match protocol {
        ModelProtocol::OpenaiCompatible => {
            let data = frame
                .get("data")
                .and_then(Value::as_array)
                .ok_or_else(|| AppError::new("aiUnsupportedResponse"))?;
            (
                data,
                frame
                    .get("has_more")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            )
        }
        ModelProtocol::Ollama => {
            let models = frame
                .get("models")
                .and_then(Value::as_array)
                .ok_or_else(|| AppError::new("aiUnsupportedResponse"))?;
            (models, false)
        }
    };
    let mut seen = std::collections::HashSet::new();
    let mut model_ids: Vec<String> = Vec::new();
    let mut truncated = provider_more;
    for entry in entries {
        let entry = entry
            .as_object()
            .ok_or_else(|| AppError::new("aiUnsupportedResponse"))?;
        let id = match protocol {
            ModelProtocol::OpenaiCompatible => entry
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::new("aiUnsupportedResponse"))?,
            ModelProtocol::Ollama => entry
                .get("name")
                .and_then(Value::as_str)
                .or_else(|| entry.get("model").and_then(Value::as_str))
                .ok_or_else(|| AppError::new("aiUnsupportedResponse"))?,
        };
        // An id outside the saved-model bounds can never be selected; skip it instead of failing
        // the whole list.
        if id.is_empty() || id.chars().count() > MAX_MODEL_ID_CHARS {
            continue;
        }
        if model_ids.len() >= MAX_DISCOVERED_MODELS {
            truncated = true;
            break;
        }
        if seen.insert(id.to_owned()) {
            model_ids.push(id.to_owned());
        }
    }
    Ok((model_ids, truncated))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_credentials::test_store::TestCredentialStore;
    use crate::model_credentials::ModelCredentials;
    use crate::storage::ModelInput;
    use crate::storage::{Database, ModelProfile};
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc::{self, Receiver};
    use std::sync::Mutex;
    use std::thread;
    use std::time::Instant;

    const REQUEST_FIXTURE: &str = include_str!("../../tests/fixtures/model-discovery-request.json");
    const RESPONSE_FIXTURE: &str =
        include_str!("../../tests/fixtures/model-discovery-response.json");
    const TOKEN: &str = "fixture-discovery-token";
    const STORED_TOKEN: &str = "fixture-stored-token";

    // --- helpers -------------------------------------------------------------

    fn temp_storage() -> (tempfile::TempDir, StorageState) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("discovery.sqlite")).unwrap();
        (directory, StorageState(Mutex::new(Ok(database))))
    }

    fn state_with(limits: DiscoveryLimits) -> DiscoveryState {
        DiscoveryState {
            network: Ok(DiscoveryNetwork::with_limits(limits).unwrap()),
            requests: RequestRegistry::default(),
        }
    }

    fn credential_none() -> RawDiscoveryCredential {
        RawDiscoveryCredential {
            kind: "none".into(),
            model_profile_id: None,
            api_key: None,
        }
    }

    fn credential_provided() -> RawDiscoveryCredential {
        RawDiscoveryCredential {
            kind: "provided".into(),
            model_profile_id: None,
            api_key: Some(OneShotApiKey::new(TOKEN.as_bytes().to_vec()).unwrap()),
        }
    }

    fn credential_stored(id: &str) -> RawDiscoveryCredential {
        RawDiscoveryCredential {
            kind: "stored".into(),
            model_profile_id: Some(id.into()),
            api_key: None,
        }
    }

    fn request(
        protocol: ModelProtocol,
        endpoint: &str,
        credential: RawDiscoveryCredential,
    ) -> ModelDiscoveryRequest {
        ModelDiscoveryRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            protocol,
            endpoint: endpoint.into(),
            credential,
        }
    }

    fn sse_like_list(protocol: ModelProtocol, entries: &[(&str, &str)]) -> Vec<u8> {
        // entries are (id-or-name, extra) pairs; `extra` can add provider metadata for openai.
        match protocol {
            ModelProtocol::OpenaiCompatible => {
                let data: Vec<Value> = entries
                    .iter()
                    .map(|(id, extra)| {
                        let mut entry = serde_json::json!({"id": id, "object": "model"});
                        if *extra == "more" {
                            entry["has_more"] = serde_json::json!(true);
                        }
                        entry
                    })
                    .collect();
                serde_json::json!({"object": "list", "data": data})
                    .to_string()
                    .into_bytes()
            }
            ModelProtocol::Ollama => serde_json::json!({
                "models": entries
                    .iter()
                    .map(|(name, _)| serde_json::json!({"name": name, "model": name, "size": 1}))
                    .collect::<Vec<_>>()
            })
            .to_string()
            .into_bytes(),
        }
    }

    fn stale_read_fault_store() -> TestCredentialStore {
        let store = TestCredentialStore::new();
        store.set_faults(crate::model_credentials::test_store::Faults {
            read: Some(crate::credentials::CredentialError::Unavailable),
            ..crate::model_credentials::test_store::Faults::default()
        });
        store
    }

    /// One loopback server: accepts a single connection, captures the request, then writes the
    /// response.
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

    fn header_boundary(request: &[u8]) -> Option<usize> {
        request
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|index| index + 4)
    }

    fn http_response(status: &str, body: &[u8]) -> Vec<u8> {
        let mut response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend_from_slice(body);
        response
    }

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

    /// Run one discovery against a fixture server that answers with `body`.
    async fn roundtrip(
        protocol: ModelProtocol,
        credential: RawDiscoveryCredential,
        body: Vec<u8>,
        limits: DiscoveryLimits,
    ) -> (Result<ModelDiscoveryResponse, AppError>, String) {
        let (base, received, handle) = server(move |stream| {
            let _ = stream.write_all(&http_response("200 OK", &body));
        });
        let endpoint = match protocol {
            ModelProtocol::OpenaiCompatible => format!("{base}/custom/v1"),
            ModelProtocol::Ollama => base.clone(),
        };
        let (_directory, storage) = temp_storage();
        let discovery = state_with(limits);
        let store = TestCredentialStore::new();
        let result = discover(
            &storage,
            &discovery,
            &store,
            request(protocol, &endpoint, credential),
        )
        .await;
        let wire = received.recv().unwrap();
        handle.join().unwrap();
        (result, wire)
    }

    // --- fixtures and validation --------------------------------------------

    #[test]
    fn discovery_fixtures_are_the_wire_contract() {
        let request: ModelDiscoveryRequest = serde_json::from_str(REQUEST_FIXTURE).unwrap();
        let (request_id, protocol, endpoint, credential) = request.into_parts().unwrap();
        assert_eq!(request_id, "6f3b2f1c-4f3e-4a5b-8c9d-0e1f2a3b4c5d");
        assert_eq!(protocol, ModelProtocol::OpenaiCompatible);
        assert_eq!(endpoint, "http://gateway.example.test/custom/v1");
        assert!(matches!(credential, DiscoveryCredential::None));

        let response = ModelDiscoveryResponse {
            request_id: request_id.clone(),
            protocol,
            endpoint: endpoint.clone(),
            model_ids: vec!["fixture-model-a".into(), "fixture-model-b".into()],
            truncated: false,
        };
        let expected = RESPONSE_FIXTURE.trim_end_matches('\n');
        assert_eq!(serde_json::to_string(&response).unwrap(), expected);

        // Unknown fields are refused at every level, and the credential union is closed.
        let mut payload: Value = serde_json::from_str(REQUEST_FIXTURE).unwrap();
        payload["headers"] = serde_json::json!({"authorization": "secret"});
        assert!(serde_json::from_value::<ModelDiscoveryRequest>(payload).is_err());
        let mut payload: Value = serde_json::from_str(REQUEST_FIXTURE).unwrap();
        payload["credential"]["key"] = serde_json::json!("secret");
        assert!(serde_json::from_value::<ModelDiscoveryRequest>(payload).is_err());
        assert!(serde_json::from_str::<ModelDiscoveryCancelRequest>(
            r#"{"requestId":"6f3b2f1c-4f3e-4a5b-8c9d-0e1f2a3b4c5d","extra":1}"#
        )
        .is_err());

        for (kind, profile, key) in [
            ("none", Some("6f3b2f1c-4f3e-4a5b-8c9d-0e1f2a3b4c5d"), None),
            ("stored", None, None),
            ("stored", Some("not-a-uuid"), None),
            (
                "provided",
                Some("6f3b2f1c-4f3e-4a5b-8c9d-0e1f2a3b4c5d"),
                None,
            ),
            ("other", None, None),
        ] {
            let mut request: ModelDiscoveryRequest = serde_json::from_str(REQUEST_FIXTURE).unwrap();
            request.credential = RawDiscoveryCredential {
                kind: kind.into(),
                model_profile_id: profile.map(str::to_owned),
                api_key: key,
            };
            assert_eq!(
                request.into_parts().unwrap_err().code,
                "invalidInput",
                "{kind}/{profile:?}"
            );
        }
        // An invalid request id or endpoint is refused before anything is echoed or sent.
        let mut request: ModelDiscoveryRequest = serde_json::from_str(REQUEST_FIXTURE).unwrap();
        request.request_id = "secret".into();
        assert_eq!(request.into_parts().unwrap_err().code, "invalidInput");
        let mut request: ModelDiscoveryRequest = serde_json::from_str(REQUEST_FIXTURE).unwrap();
        request.endpoint = "https://user:secret@example.test".into();
        assert_eq!(request.into_parts().unwrap_err().code, "invalidEndpoint");
    }

    // --- transport -----------------------------------------------------------

    #[tokio::test]
    async fn discovery_sends_only_a_get_to_the_fixed_list_path() {
        for (protocol, path) in [
            (ModelProtocol::OpenaiCompatible, "/custom/v1/models"),
            (ModelProtocol::Ollama, "/api/tags"),
        ] {
            let body = sse_like_list(protocol, &[("fixture-model-a", "")]);
            let (result, wire) = roundtrip(
                protocol,
                credential_none(),
                body,
                DiscoveryLimits::default(),
            )
            .await;
            let response = result.unwrap();
            assert_eq!(response.protocol, protocol);
            assert_eq!(response.model_ids, vec!["fixture-model-a".to_string()]);
            assert!(!response.truncated);
            assert!(
                wire.starts_with(&format!("GET {path} HTTP/1.1\r\n")),
                "{wire}"
            );
            assert!(!wire.to_lowercase().contains("authorization:"));
            assert_eq!(
                wire.find("\r\n\r\n").unwrap() + 4,
                wire.len(),
                "GET carries no body"
            );
            assert!(response.endpoint.starts_with("http://127.0.0.1:"));
        }
    }

    #[tokio::test]
    async fn discovery_auth_modes_send_only_the_expected_header() {
        // Provided: exactly one bearer header with the one-shot key.
        let body = sse_like_list(ModelProtocol::Ollama, &[("m1", "")]);
        let (result, wire) = roundtrip(
            ModelProtocol::Ollama,
            credential_provided(),
            body,
            DiscoveryLimits::default(),
        )
        .await;
        assert!(result.is_ok());
        let lowered = wire.to_lowercase();
        assert_eq!(lowered.matches("authorization:").count(), 1);
        assert!(lowered.contains(&format!("authorization: bearer {TOKEN}")));

        // Stored: the saved profile's own secret is used, never the draft or another profile's.
        let (base, received, handle) = server(move |stream| {
            let body = sse_like_list(ModelProtocol::OpenaiCompatible, &[("m1", "")]);
            let _ = stream.write_all(&http_response("200 OK", &body));
        });
        let endpoint = format!("{base}/v1");
        let (_directory, storage) = temp_storage();
        let store = TestCredentialStore::new();
        let profile = with_database(&storage, |db| {
            ModelCredentials::new(db, &store)
                .save(
                    ModelInput {
                        display_name: "Gateway".into(),
                        protocol: ModelProtocol::OpenaiCompatible,
                        endpoint: endpoint.clone(),
                        model_id: "m1".into(),
                    },
                    None,
                    crate::model_credentials::ModelCredentialChange::Replace(
                        OneShotApiKey::new(STORED_TOKEN.as_bytes().to_vec()).unwrap(),
                    ),
                )
                .map(|write| write.profile)
        })
        .unwrap();
        let discovery = state_with(DiscoveryLimits::default());
        let response = discover(
            &storage,
            &discovery,
            &store,
            request(
                ModelProtocol::OpenaiCompatible,
                &endpoint,
                credential_stored(&profile.id),
            ),
        )
        .await
        .unwrap();
        assert_eq!(response.model_ids, vec!["m1".to_string()]);
        let lowered = received.recv().unwrap().to_lowercase();
        assert!(lowered.contains(&format!("authorization: bearer {STORED_TOKEN}")));
        assert!(!lowered.contains(TOKEN));
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn discovery_stored_credential_requires_the_exact_saved_target() {
        // A read fault would surface as credentialUnavailable; seeing aiTargetChanged proves the
        // store was never consulted for a draft target the profile does not match.
        let store = stale_read_fault_store();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let (_directory, storage) = temp_storage();
        let profile: ModelProfile = with_database(&storage, |db| {
            ModelCredentials::new(db, &store)
                .save(
                    ModelInput {
                        display_name: "Gateway".into(),
                        protocol: ModelProtocol::OpenaiCompatible,
                        endpoint: format!("{endpoint}/v1"),
                        model_id: "m1".into(),
                    },
                    None,
                    crate::model_credentials::ModelCredentialChange::Replace(
                        OneShotApiKey::new(STORED_TOKEN.as_bytes().to_vec()).unwrap(),
                    ),
                )
                .map(|write| write.profile)
        })
        .unwrap();
        let discovery = state_with(DiscoveryLimits::default());

        // Wrong endpoint draft.
        let error = discover(
            &storage,
            &discovery,
            &store,
            request(
                ModelProtocol::OpenaiCompatible,
                &format!("{endpoint}/v2"),
                credential_stored(&profile.id),
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "aiTargetChanged");
        // Wrong protocol draft.
        let error = discover(
            &storage,
            &discovery,
            &store,
            request(
                ModelProtocol::Ollama,
                &format!("{endpoint}/v1"),
                credential_stored(&profile.id),
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "aiTargetChanged");
        // Correct target but a keyring that cannot answer: a stable credential error, never a
        // request without the header.
        let error = discover(
            &storage,
            &discovery,
            &store,
            request(
                ModelProtocol::OpenaiCompatible,
                &format!("{endpoint}/v1"),
                credential_stored(&profile.id),
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "credentialUnavailable");
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );

        // A profile without a stored reference is credentialNotFound.
        let (_directory2, storage2) = temp_storage();
        let plain = with_database(&storage2, |db| {
            db.save_model(
                ModelInput {
                    display_name: "Plain".into(),
                    protocol: ModelProtocol::OpenaiCompatible,
                    endpoint: format!("{endpoint}/v1"),
                    model_id: "m1".into(),
                },
                None,
            )
        })
        .unwrap();
        let error = discover(
            &storage2,
            &discovery,
            &store,
            request(
                ModelProtocol::OpenaiCompatible,
                &format!("{endpoint}/v1"),
                credential_stored(&plain.id),
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "credentialNotFound");
    }

    #[tokio::test]
    async fn discovery_parses_dedupes_and_truncates() {
        let limits = DiscoveryLimits::default();
        let body =
            serde_json::json!({"data": [{"id":"a"},{"id":"a"},{"id":"b"}], "has_more": true})
                .to_string()
                .into_bytes();
        let (result, _) = roundtrip(
            ModelProtocol::OpenaiCompatible,
            credential_none(),
            body,
            limits,
        )
        .await;
        let response = result.unwrap();
        assert_eq!(response.model_ids, vec!["a".to_string(), "b".to_string()]);
        assert!(response.truncated);

        // The cap is 512 unique ids.
        let entries: Vec<Value> = (0..600)
            .map(|index| serde_json::json!({"id": format!("model-{index:04}")}))
            .collect();
        let body = serde_json::json!({"data": entries})
            .to_string()
            .into_bytes();
        let (result, _) = roundtrip(
            ModelProtocol::OpenaiCompatible,
            credential_none(),
            body,
            limits,
        )
        .await;
        let response = result.unwrap();
        assert_eq!(response.model_ids.len(), MAX_DISCOVERED_MODELS);
        assert_eq!(response.model_ids[0], "model-0000");
        assert!(response.truncated);

        // Ollama accepts `name` and falls back to `model`.
        let body = serde_json::json!({"models": [
            {"model": "only-model-field"},
            {"name": "named-model", "model": "named-model"},
            {"name": "", "model": ""}
        ]})
        .to_string()
        .into_bytes();
        let (result, _) = roundtrip(ModelProtocol::Ollama, credential_none(), body, limits).await;
        assert_eq!(
            result.unwrap().model_ids,
            vec!["only-model-field".to_string(), "named-model".to_string()]
        );

        // A legitimate empty list is a success.
        let body = serde_json::json!({"object": "list", "data": []})
            .to_string()
            .into_bytes();
        let (result, _) = roundtrip(
            ModelProtocol::OpenaiCompatible,
            credential_none(),
            body,
            limits,
        )
        .await;
        let response = result.unwrap();
        assert!(response.model_ids.is_empty());
        assert!(!response.truncated);

        // Unusable ids are skipped; a non-string id is a malformed shape.
        let long = "m".repeat(MAX_MODEL_ID_CHARS + 1);
        let body = serde_json::json!({"data": [{"id": ""}, {"id": long}, {"id": "ok"}]})
            .to_string()
            .into_bytes();
        let (result, _) = roundtrip(
            ModelProtocol::OpenaiCompatible,
            credential_none(),
            body,
            limits,
        )
        .await;
        assert_eq!(result.unwrap().model_ids, vec!["ok".to_string()]);
        let body = serde_json::json!({"data": [{"id": 7}]})
            .to_string()
            .into_bytes();
        let (result, _) = roundtrip(
            ModelProtocol::OpenaiCompatible,
            credential_none(),
            body,
            limits,
        )
        .await;
        assert_eq!(result.unwrap_err().code, "aiUnsupportedResponse");
    }

    #[tokio::test]
    async fn discovery_failures_are_structured_redacted_and_not_retried() {
        let limits = DiscoveryLimits::default();
        for (status, code) in [
            ("401 Unauthorized", "authenticationFailed"),
            ("403 Forbidden", "serverForbidden"),
            ("404 Not Found", "notFound"),
            ("429 Too Many Requests", "rateLimited"),
            ("500 Internal Server Error", "httpError"),
        ] {
            let (base, _received, handle) = server(move |stream| {
                let _ = stream.write_all(&http_response(status, b"{\"error\":\"fixture-secret\"}"));
            });
            let endpoint = format!("{base}/v1");
            let (_directory, storage) = temp_storage();
            let discovery = state_with(limits);
            let store = TestCredentialStore::new();
            let error = discover(
                &storage,
                &discovery,
                &store,
                request(
                    ModelProtocol::OpenaiCompatible,
                    &endpoint,
                    credential_none(),
                ),
            )
            .await
            .unwrap_err();
            assert_eq!(error.code, code, "{status}");
            let serialized = serde_json::to_string(&error).unwrap();
            assert!(!serialized.contains("fixture-secret"));
            assert!(!serialized.contains("127.0.0.1"));
            handle.join().unwrap();
        }

        // A redirect is refused and its destination is never contacted.
        let destination = TcpListener::bind("127.0.0.1:0").unwrap();
        destination.set_nonblocking(true).unwrap();
        let location = format!("http://{}/v1/models", destination.local_addr().unwrap());
        let (base, _received, handle) = server(move |stream| {
            let response = format!(
                "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            let _ = stream.write_all(response.as_bytes());
        });
        let (_directory, storage) = temp_storage();
        let discovery = state_with(limits);
        let store = TestCredentialStore::new();
        let error = discover(
            &storage,
            &discovery,
            &store,
            request(
                ModelProtocol::OpenaiCompatible,
                &format!("{base}/v1"),
                credential_none(),
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "redirectBlocked");
        assert_eq!(
            destination.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        handle.join().unwrap();

        // Malformed JSON, provider errors and wrong shapes are distinct structured failures.
        for (body, code) in [
            (b"not-json".to_vec(), "invalidResponse"),
            (
                b"{\"error\":\"fixture-secret\"}".to_vec(),
                "aiProviderError",
            ),
            (b"{\"data\":{}}".to_vec(), "aiUnsupportedResponse"),
            (b"[]".to_vec(), "aiUnsupportedResponse"),
        ] {
            let (result, _) = roundtrip(
                ModelProtocol::OpenaiCompatible,
                credential_none(),
                body,
                limits,
            )
            .await;
            assert_eq!(result.unwrap_err().code, code);
        }

        // Oversized lists and stalled reads are bounded by the injected limits.
        let limits = DiscoveryLimits {
            max_body: 64,
            ..DiscoveryLimits::default()
        };
        let (result, _) = roundtrip(
            ModelProtocol::OpenaiCompatible,
            credential_none(),
            vec![b'x'; 200],
            limits,
        )
        .await;
        assert_eq!(result.unwrap_err().code, "responseTooLarge");

        let (base, _started, handle) = signaling_server(|stream| {
            let _ = stream.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{\"data\":[",
            );
            stall(stream);
        });
        let limits = DiscoveryLimits {
            overall: Duration::from_millis(200),
            ..DiscoveryLimits::default()
        };
        let (_directory, storage) = temp_storage();
        let discovery = state_with(limits);
        let store = TestCredentialStore::new();
        let started_at = Instant::now();
        let error = discover(
            &storage,
            &discovery,
            &store,
            request(
                ModelProtocol::OpenaiCompatible,
                &format!("{base}/v1"),
                credential_none(),
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "timeout");
        assert!(started_at.elapsed() < Duration::from_secs(2));
        handle.join().unwrap();

        // No retries: one failed request, one connection.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let count_handle = thread::spawn(move || {
            let mut count = 0;
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_request(&mut stream);
            count += 1;
            let _ = stream.write_all(&http_response("500 Internal Server Error", b"{}"));
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
        let (_directory, storage) = temp_storage();
        let discovery = state_with(limits);
        let store = TestCredentialStore::new();
        let error = discover(
            &storage,
            &discovery,
            &store,
            request(ModelProtocol::Ollama, &endpoint, credential_none()),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "httpError");
        assert_eq!(count_handle.join().unwrap(), 1);
    }

    #[tokio::test]
    async fn discovery_cancellation_is_real_and_isolated() {
        // Cancel before start: the request never opens a socket.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let (_directory, storage) = temp_storage();
        let discovery = state_with(DiscoveryLimits::default());
        let store = TestCredentialStore::new();
        let request_id = uuid::Uuid::new_v4().to_string();
        assert!(discovery.requests.cancel(&request_id, DISCOVERY_SCOPE));
        let mut early = request(ModelProtocol::Ollama, &endpoint, credential_none());
        early.request_id = request_id.clone();
        assert_eq!(
            discover(&storage, &discovery, &store, early)
                .await
                .unwrap_err()
                .code,
            "cancelled"
        );
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );

        // Mid-read: the cancel reaches the running read and releases the permit.
        let (base, started, handle) = signaling_server(|stream| {
            let _ = stream.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{\"data\":[",
            );
            stall(stream);
        });
        let discovery = state_with(DiscoveryLimits::default());
        let request_id = uuid::Uuid::new_v4().to_string();
        let mut streaming = request(
            ModelProtocol::OpenaiCompatible,
            &format!("{base}/v1"),
            credential_none(),
        );
        streaming.request_id = request_id.clone();
        let started_at = Instant::now();
        let mut executing = Box::pin(discover(&storage, &discovery, &store, streaming));
        let mut started = started;
        tokio::select! {
            _ = &mut executing => panic!("the discovery must still be in flight"),
            _ = &mut started => {}
        }
        assert!(discovery.requests.cancel(&request_id, DISCOVERY_SCOPE));
        assert_eq!(executing.await.unwrap_err().code, "cancelled");
        assert!(
            started_at.elapsed() < Duration::from_secs(1),
            "cancellation must not wait for the provider"
        );
        assert!(!discovery.requests.cancel(&request_id, DISCOVERY_SCOPE));
        handle.join().unwrap();

        // The discovery registry is independent from a chat registry with the same identifiers.
        let chat_like = RequestRegistry::default();
        let discovery_like = RequestRegistry::default();
        let key = uuid::Uuid::new_v4().to_string();
        let mut chat_guard = chat_like.register(&request_id, &key).unwrap();
        let mut discovery_guard = discovery_like.register(&request_id, &key).unwrap();
        assert!(discovery_like.cancel(&request_id, &key));
        assert!(tokio::time::timeout(
            Duration::from_millis(100),
            discovery_guard.cancellation().cancelled()
        )
        .await
        .is_ok());
        assert!(tokio::time::timeout(
            Duration::from_millis(25),
            chat_guard.cancellation().cancelled()
        )
        .await
        .is_err());
        assert!(chat_like.cancel(&request_id, &key));
    }

    #[tokio::test]
    async fn discovery_concurrency_limit_refuses_before_a_socket() {
        let (base_a, started_a, handle_a) = signaling_server(|stream| {
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n");
            stall(stream);
        });
        let (base_b, started_b, handle_b) = signaling_server(|stream| {
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n");
            stall(stream);
        });
        let (_directory, storage) = temp_storage();
        let discovery = state_with(DiscoveryLimits::default());
        let store = TestCredentialStore::new();

        let first_id = uuid::Uuid::new_v4().to_string();
        let mut first_request = request(
            ModelProtocol::OpenaiCompatible,
            &format!("{base_a}/v1"),
            credential_none(),
        );
        first_request.request_id = first_id.clone();
        let first = discover(&storage, &discovery, &store, first_request);
        tokio::pin!(first);
        let mut started_a = started_a;
        tokio::select! {
            _ = &mut first => panic!("the first discovery must still be in flight"),
            _ = &mut started_a => {}
        }

        let second_id = uuid::Uuid::new_v4().to_string();
        let mut second_request = request(
            ModelProtocol::OpenaiCompatible,
            &format!("{base_b}/v1"),
            credential_none(),
        );
        second_request.request_id = second_id.clone();
        let second = discover(&storage, &discovery, &store, second_request);
        tokio::pin!(second);
        let mut started_b = started_b;
        tokio::select! {
            _ = &mut second => panic!("the second discovery must still be in flight"),
            _ = &mut started_b => {}
        }

        // Both permits are held; the third is refused before it can open a socket.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let error = discover(
            &storage,
            &discovery,
            &store,
            request(
                ModelProtocol::OpenaiCompatible,
                &format!("http://{}/v1", listener.local_addr().unwrap()),
                credential_none(),
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "busy");
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );

        // Cancelling both releases the permits and finishes the stalled requests.
        assert!(discovery.requests.cancel(&first_id, DISCOVERY_SCOPE));
        assert_eq!(first.await.unwrap_err().code, "cancelled");
        assert!(discovery.requests.cancel(&second_id, DISCOVERY_SCOPE));
        assert_eq!(second.await.unwrap_err().code, "cancelled");
        handle_a.join().unwrap();
        handle_b.join().unwrap();
    }

    #[tokio::test]
    async fn discovery_limits_match_the_product_contract() {
        let limits = DiscoveryLimits::default();
        assert_eq!(limits.connect, Duration::from_secs(10));
        assert_eq!(limits.overall, Duration::from_secs(10));
        assert_eq!(limits.max_body, 1024 * 1024);
        assert_eq!(limits.max_inflight, 2);
        // The production client path builds through the shared defensive builder.
        assert!(DiscoveryNetwork::new().is_ok());
    }
}
