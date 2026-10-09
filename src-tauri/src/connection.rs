use crate::error::AppError;
use crate::operation::{identity_request, RequestPlan};
use crate::read_only::Cancellation;
use crate::storage::ConnectionProfile;
use reqwest::{redirect::Policy, Client, StatusCode};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;
use uuid::Uuid;

/// Every response — identity, resource discovery and search — is bounded by the same limit, so a
/// single call can never turn into an unbounded allocation.
const RESPONSE_LIMIT: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionProbe {
    pub request_id: String,
    pub connection_id: String,
}

impl ConnectionProbe {
    pub fn validate(&self) -> Result<(), AppError> {
        Uuid::parse_str(&self.request_id).map_err(|_| AppError::new("invalidInput"))?;
        Uuid::parse_str(&self.connection_id).map_err(|_| AppError::new("invalidInput"))?;
        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionIdentity {
    pub request_id: String,
    pub connection_id: String,
    pub endpoint: String,
    pub cluster_name: String,
    pub cluster_uuid: String,
    pub version: String,
    pub tested_version: bool,
    pub elapsed_ms: u128,
}

#[derive(Deserialize)]
struct RootResponse {
    cluster_name: String,
    cluster_uuid: String,
    version: VersionResponse,
}

#[derive(Deserialize)]
struct VersionResponse {
    number: String,
}

#[derive(Clone)]
pub struct ReadOnlyClient {
    client: Client,
    permits: Arc<Semaphore>,
}

impl ReadOnlyClient {
    pub fn new() -> Result<Self, AppError> {
        Self::with_timeout(Duration::from_secs(10))
    }

    pub(crate) fn with_timeout(timeout: Duration) -> Result<Self, AppError> {
        let client = Client::builder()
            .redirect(Policy::none())
            .referer(false)
            .no_proxy()
            .connect_timeout(Duration::from_secs(3))
            .timeout(timeout)
            .user_agent("EScope/0.1.0")
            .build()
            .map_err(|_| AppError::new("networkError"))?;
        Ok(Self {
            client,
            permits: Arc::new(Semaphore::new(4)),
        })
    }

    pub async fn test(
        &self,
        profile: &ConnectionProfile,
        probe: ConnectionProbe,
    ) -> Result<ConnectionIdentity, AppError> {
        probe.validate()?;
        let request_id = probe.request_id.clone();
        let result = self.test_inner(profile, probe).await;
        result.map_err(|mut error| {
            error.request_id = Some(request_id);
            error
        })
    }

    async fn test_inner(
        &self,
        profile: &ConnectionProfile,
        probe: ConnectionProbe,
    ) -> Result<ConnectionIdentity, AppError> {
        if profile.id != probe.connection_id {
            return Err(AppError::new("invalidInput"));
        }
        let plan = identity_request(profile)?;
        let started = Instant::now();
        let bytes = self.execute(plan, &mut Cancellation::never()).await?;
        let root: RootResponse =
            serde_json::from_slice(&bytes).map_err(|_| AppError::new("invalidResponse"))?;
        if root.cluster_name.is_empty()
            || root.cluster_name.len() > 256
            || root.cluster_uuid.is_empty()
            || root.cluster_uuid == "_na_"
            || root.cluster_uuid.len() > 128
            || root.version.number.is_empty()
            || root.version.number.len() > 64
        {
            return Err(AppError::new("invalidResponse"));
        }
        Ok(ConnectionIdentity {
            request_id: probe.request_id,
            connection_id: probe.connection_id,
            endpoint: profile.endpoint.clone(),
            cluster_name: root.cluster_name,
            cluster_uuid: root.cluster_uuid,
            tested_version: root.version.number == "7.17.25",
            version: root.version.number,
            elapsed_ms: started.elapsed().as_millis(),
        })
    }

    /// Send one planned request and return the raw response bytes.
    ///
    /// The plan already fixes the method, the URL and the body, so this only enforces the shared
    /// transport rules: one in-flight permit, no redirect, no proxy, the product header, the
    /// response bound, and cancellation that actually drops the future and releases the socket.
    pub async fn execute(
        &self,
        plan: RequestPlan,
        cancel: &mut Cancellation,
    ) -> Result<Vec<u8>, AppError> {
        // Acquiring first keeps the concurrency limit from opening a socket it would have to drop.
        let _permit = self
            .permits
            .try_acquire()
            .map_err(|_| AppError::new("busy"))?;
        let request = async {
            let mut response = plan
                .build(&self.client)
                .send()
                .await
                .map_err(network_error)?;
            let status = response.status();
            if !status.is_success() {
                return Err(status_error(status));
            }
            if response
                .headers()
                .get("x-elastic-product")
                .and_then(|value| value.to_str().ok())
                != Some("Elasticsearch")
            {
                return Err(AppError::new("notElasticsearch"));
            }
            if response
                .content_length()
                .is_some_and(|length| length > RESPONSE_LIMIT as u64)
            {
                return Err(AppError::new("responseTooLarge"));
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(network_error)? {
                if bytes.len() + chunk.len() > RESPONSE_LIMIT {
                    return Err(AppError::new("responseTooLarge"));
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(bytes)
        };
        tokio::select! {
            biased;
            // A cancel that races with a completed response is reported as cancelled: the user
            // asked to stop, and the result is dropped rather than presented as fresh.
            () = cancel.cancelled() => Err(AppError::new("cancelled")),
            result = request => result,
        }
    }
}

/// Decode a response body without touching its contents. Invalid UTF-8 fails closed instead of
/// being replaced, so the frontend never receives a silently altered document.
pub(crate) fn decode_response(bytes: Vec<u8>) -> Result<String, AppError> {
    String::from_utf8(bytes).map_err(|_| AppError::new("invalidResponse"))
}

fn network_error(error: reqwest::Error) -> AppError {
    // reqwest errors can contain URLs. Never expose their text or source chain through IPC.
    AppError::new(if error.is_timeout() {
        "timeout"
    } else {
        "networkError"
    })
}

fn status_error(status: StatusCode) -> AppError {
    let code = match status {
        StatusCode::UNAUTHORIZED => "authenticationFailed",
        StatusCode::FORBIDDEN => "serverForbidden",
        StatusCode::NOT_FOUND => "notFound",
        StatusCode::TOO_MANY_REQUESTS => "rateLimited",
        status if status.is_redirection() => "redirectBlocked",
        _ => "httpError",
    };
    AppError::new(code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::CredentialRef;
    use crate::storage::{AuthKind, ConnectionAuth};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    const BODY: &str = r#"{"cluster_name":"Fixture","cluster_uuid":"fixture-uuid","version":{"number":"7.17.25"}}"#;

    fn profile(endpoint: String) -> ConnectionProfile {
        ConnectionProfile {
            id: Uuid::new_v4().to_string(),
            display_name: "Fixture".into(),
            endpoint,
            environment: "development".into(),
            sort_order: 0,
            auth: "none",
            auth_state: ConnectionAuth::none(),
        }
    }

    fn probe(profile: &ConnectionProfile) -> ConnectionProbe {
        ConnectionProbe {
            request_id: Uuid::new_v4().to_string(),
            connection_id: profile.id.clone(),
        }
    }

    fn fixture(
        response: String,
        delay: Duration,
    ) -> (String, mpsc::Receiver<String>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let (sender, receiver) = mpsc::channel();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            // Headers and body may arrive in the same segment, so look for the boundary instead
            // of expecting the headers to be the whole first read.
            let headers_end = loop {
                if let Some(index) = header_boundary(&request) {
                    break index;
                }
                let mut chunk = [0; 1024];
                let length = stream.read(&mut chunk).unwrap();
                assert!(length > 0, "Request closed before headers completed");
                request.extend_from_slice(&chunk[..length]);
                assert!(request.len() <= 8192);
            };
            // A POST body may arrive after the headers; read exactly what was announced so the
            // captured request is the complete one.
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
                assert!(length > 0, "Request closed before the body completed");
                request.extend_from_slice(&chunk[..length]);
            }
            sender.send(String::from_utf8(request).unwrap()).unwrap();
            thread::sleep(delay);
            let _ = stream.write_all(response.as_bytes());
        });
        (endpoint, receiver, handle)
    }

    /// Offset just past the end of the HTTP header block, if it has arrived.
    fn header_boundary(request: &[u8]) -> Option<usize> {
        request
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|index| index + 4)
    }

    fn response(status: &str, body: &str, extra: &str) -> String {
        format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}", body.len())
    }

    #[tokio::test]
    async fn identity_uses_only_get_keeps_prefix_and_request_binding() {
        let (endpoint, received, handle) = fixture(
            response("200 OK", BODY, "X-Elastic-Product: Elasticsearch\r\n"),
            Duration::ZERO,
        );
        let profile = profile(format!("{endpoint}/proxy/es"));
        let probe = probe(&profile);
        let id = probe.request_id.clone();
        let identity = ReadOnlyClient::new()
            .unwrap()
            .test(&profile, probe)
            .await
            .unwrap();
        assert_eq!(identity.request_id, id);
        assert_eq!(identity.connection_id, profile.id);
        assert_eq!(identity.version, "7.17.25");
        assert!(identity.tested_version);
        let request = received.recv().unwrap();
        assert!(request.starts_with("GET /proxy/es/ HTTP/1.1\r\n"));
        assert!(!request.to_lowercase().contains("authorization:"));
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn http_errors_are_structured_and_never_echo_server_secrets() {
        for (status, code) in [
            ("401 Unauthorized", "authenticationFailed"),
            ("403 Forbidden", "serverForbidden"),
            ("429 Too Many Requests", "rateLimited"),
            ("500 Internal Server Error", "httpError"),
        ] {
            let (endpoint, _received, handle) = fixture(
                response(status, "credential=fixture-secret", ""),
                Duration::ZERO,
            );
            let profile = profile(endpoint);
            let probe = probe(&profile);
            let id = probe.request_id.clone();
            let error = ReadOnlyClient::new()
                .unwrap()
                .test(&profile, probe)
                .await
                .unwrap_err();
            assert_eq!(error.code, code);
            assert_eq!(error.request_id, Some(id));
            assert!(!serde_json::to_string(&error)
                .unwrap()
                .contains("fixture-secret"));
            handle.join().unwrap();
        }
    }

    #[tokio::test]
    async fn redirects_never_contact_the_destination() {
        let destination = TcpListener::bind("127.0.0.1:0").unwrap();
        destination.set_nonblocking(true).unwrap();
        let (endpoint, _received, handle) = fixture(
            response(
                "302 Found",
                "",
                &format!(
                    "Location: http://{}/secret\r\n",
                    destination.local_addr().unwrap()
                ),
            ),
            Duration::ZERO,
        );
        let profile = profile(endpoint);
        let error = ReadOnlyClient::new()
            .unwrap()
            .test(&profile, probe(&profile))
            .await
            .unwrap_err();
        assert_eq!(error.code, "redirectBlocked");
        assert_eq!(
            destination.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn wrong_product_invalid_json_and_large_bodies_fail_closed() {
        for (body, headers, code) in [
            (BODY.to_string(), "", "notElasticsearch"),
            (
                "broken".into(),
                "X-Elastic-Product: Elasticsearch\r\n",
                "invalidResponse",
            ),
            (
                "x".repeat(RESPONSE_LIMIT + 1),
                "X-Elastic-Product: Elasticsearch\r\n",
                "responseTooLarge",
            ),
        ] {
            let (endpoint, _received, handle) =
                fixture(response("200 OK", &body, headers), Duration::ZERO);
            let profile = profile(endpoint);
            let error = ReadOnlyClient::new()
                .unwrap()
                .test(&profile, probe(&profile))
                .await
                .unwrap_err();
            assert_eq!(error.code, code);
            handle.join().unwrap();
        }
    }

    #[tokio::test]
    async fn timeouts_and_connection_mismatch_do_not_succeed() {
        let (endpoint, _received, handle) = fixture(
            response("200 OK", BODY, "X-Elastic-Product: Elasticsearch\r\n"),
            Duration::from_millis(150),
        );
        let profile = profile(endpoint);
        let client = ReadOnlyClient::with_timeout(Duration::from_millis(40)).unwrap();
        assert_eq!(
            client
                .test(&profile, probe(&profile))
                .await
                .unwrap_err()
                .code,
            "timeout"
        );
        handle.join().unwrap();
        let mut wrong = probe(&profile);
        wrong.connection_id = Uuid::new_v4().to_string();
        assert_eq!(
            client.test(&profile, wrong).await.unwrap_err().code,
            "invalidInput"
        );
    }

    #[test]
    fn ipc_probe_rejects_arbitrary_urls_methods_and_invalid_ids() {
        assert!(serde_json::from_str::<ConnectionProbe>(
            r#"{"requestId":"x","connectionId":"y","url":"https://example.test","method":"DELETE"}"#
        )
        .is_err());
        assert!(ConnectionProbe {
            request_id: "secret".into(),
            connection_id: "x".into()
        }
        .validate()
        .is_err());
    }

    #[tokio::test]
    async fn invalid_ids_mismatched_targets_and_auth_never_open_a_socket() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut profile = profile(format!("http://{}", listener.local_addr().unwrap()));
        let client = ReadOnlyClient::new().unwrap();
        let mut invalid = probe(&profile);
        invalid.request_id = "fixture-secret".into();
        let error = client.test(&profile, invalid).await.unwrap_err();
        assert_eq!(error.code, "invalidInput");
        assert!(error.request_id.is_none());
        let mut mismatched = probe(&profile);
        mismatched.connection_id = Uuid::new_v4().to_string();
        assert_eq!(
            client.test(&profile, mismatched).await.unwrap_err().code,
            "invalidInput"
        );
        profile.auth = "basic";
        assert_eq!(
            client
                .test(&profile, probe(&profile))
                .await
                .unwrap_err()
                .code,
            "unsupported"
        );
        // The same refusal holds for a credential bound through the internal metadata, while the
        // IPC-facing label stays "none".
        profile.auth = "none";
        profile.auth_state = ConnectionAuth {
            kind: AuthKind::Basic,
            credential_ref: Some(CredentialRef::generate()),
        };
        assert_eq!(
            client
                .test(&profile, probe(&profile))
                .await
                .unwrap_err()
                .code,
            "unsupported"
        );
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[tokio::test]
    async fn incomplete_or_unformed_cluster_identity_is_rejected() {
        for body in [
            "{}".into(),
            BODY.replace("fixture-uuid", "_na_"),
            BODY.replace("Fixture", ""),
            BODY.replace("fixture-uuid", &"x".repeat(129)),
            BODY.replace("7.17.25", ""),
        ] {
            let (endpoint, _received, handle) = fixture(
                response("200 OK", &body, "X-Elastic-Product: Elasticsearch\r\n"),
                Duration::ZERO,
            );
            let profile = profile(endpoint);
            assert_eq!(
                ReadOnlyClient::new()
                    .unwrap()
                    .test(&profile, probe(&profile))
                    .await
                    .unwrap_err()
                    .code,
                "invalidResponse"
            );
            handle.join().unwrap();
        }
    }

    #[tokio::test]
    async fn body_limit_is_enforced_without_a_content_length() {
        let body = "x".repeat(RESPONSE_LIMIT + 1);
        let response = format!(
            "HTTP/1.1 200 OK\r\nX-Elastic-Product: Elasticsearch\r\nConnection: close\r\n\r\n{body}"
        );
        let (endpoint, _received, handle) = fixture(response, Duration::ZERO);
        let profile = profile(endpoint);
        let error = ReadOnlyClient::new()
            .unwrap()
            .test(&profile, probe(&profile))
            .await
            .unwrap_err();
        assert_eq!(error.code, "responseTooLarge");
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn concurrency_limit_rejects_before_opening_a_socket() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let profile = profile(format!("http://{}", listener.local_addr().unwrap()));
        let client = ReadOnlyClient::new().unwrap();
        let _permits = client.permits.acquire_many(4).await.unwrap();
        assert_eq!(
            client
                .test(&profile, probe(&profile))
                .await
                .unwrap_err()
                .code,
            "busy"
        );
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[tokio::test]
    async fn other_versions_are_not_claimed_as_tested() {
        let body = BODY.replace("7.17.25", "9.0.0");
        let (endpoint, _received, handle) = fixture(
            response("200 OK", &body, "X-Elastic-Product: Elasticsearch\r\n"),
            Duration::ZERO,
        );
        let profile = profile(endpoint);
        let identity = ReadOnlyClient::new()
            .unwrap()
            .test(&profile, probe(&profile))
            .await
            .unwrap();
        assert!(!identity.tested_version);
        assert_eq!(identity.version, "9.0.0");
        handle.join().unwrap();
    }

    #[tokio::test]
    #[ignore = "Explicit local ES 7.17.25 authorization and running service required"]
    async fn local_elasticsearch_71725_read_only_identity() {
        assert_eq!(std::env::var("ESCOPE_TEST_ES_71725").as_deref(), Ok("1"));
        let profile = profile("http://127.0.0.1:9200".into());
        let identity = ReadOnlyClient::new()
            .unwrap()
            .test(&profile, probe(&profile))
            .await
            .unwrap();
        assert_eq!(identity.version, "7.17.25");
        assert!(identity.tested_version);
        assert!(!identity.cluster_uuid.is_empty());
        // Never print the cluster name, UUID, addresses or document contents.
    }

    const RESOURCE_BODY: &str = r#"{"indices":[{"name":"logs-000001","attributes":["open"]}],"total":123456789012345678901234567890}"#;
    const SEARCH_BODY: &str =
        r#"{"query":{"range":{"amount":{"gt":123456789012345678901234567890}}},"size":0}"#;

    fn search_body() -> Vec<u8> {
        crate::query::validate_search_body(SEARCH_BODY).unwrap()
    }

    /// The only way to build a plan target, mirroring what the IPC layer does after validation.
    fn target(raw: &str) -> crate::operation::IndexTarget {
        crate::operation::IndexTarget::parse(raw).unwrap()
    }

    #[tokio::test]
    async fn resource_reads_use_only_get_keep_the_prefix_and_return_raw_bytes() {
        let (endpoint, received, handle) = fixture(
            response(
                "200 OK",
                RESOURCE_BODY,
                "X-Elastic-Product: Elasticsearch\r\n",
            ),
            Duration::ZERO,
        );
        let profile = profile(format!("{endpoint}/proxy/es"));
        let client = ReadOnlyClient::new().unwrap();
        let bytes = client
            .execute(
                crate::resources::resource_plan(
                    &profile,
                    crate::resources::Resource::Indices,
                    Some(&target("logs-*")),
                )
                .unwrap(),
                &mut Cancellation::never(),
            )
            .await
            .unwrap();
        // The exact bytes, including a number far beyond `f64` and `u64`.
        assert_eq!(bytes, RESOURCE_BODY.as_bytes());
        assert_eq!(decode_response(bytes).unwrap(), RESOURCE_BODY);
        let request = received.recv().unwrap();
        assert!(request.starts_with("GET /proxy/es/_resolve/index/logs-* HTTP/1.1\r\n"));
        assert!(!request.to_lowercase().contains("authorization:"));
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn every_resource_kind_targets_its_own_fixed_endpoint_and_keeps_the_raw_body() {
        // Standard shapes: `_cat/shards?format=json` is an array with nullable ip/node/doc
        // counts, `_nodes/stats` reports partially failed nodes, and `_cluster/health` is an
        // object. Every body carries a number beyond `f64`/`u64` so precision is proven per kind.
        for (resource, index, expected, body) in [
            (
                crate::resources::Resource::Indices,
                Some("logs-*"),
                "GET /proxy/es/_resolve/index/logs-* HTTP/1.1\r\n",
                r#"{"indices":[{"name":"logs-000001","attributes":["open"]}],"total":123456789012345678901234567890}"#,
            ),
            (
                crate::resources::Resource::Mapping,
                Some("logs-*"),
                "GET /proxy/es/logs-*/_mapping HTTP/1.1\r\n",
                r#"{"logs-000001":{"mappings":{"properties":{"amount":{"type":"long"},"n":123456789012345678901234567890}}}}"#,
            ),
            (
                crate::resources::Resource::FieldCaps,
                Some("logs-*"),
                "GET /proxy/es/logs-*/_field_caps?fields=* HTTP/1.1\r\n",
                r#"{"indices":["logs-000001"],"fields":{"amount":{"long":{"searchable":true,"aggregatable":true,"n":123456789012345678901234567890}}}}"#,
            ),
            (
                crate::resources::Resource::IndexSettings,
                Some("logs-*"),
                "GET /proxy/es/logs-*/_settings HTTP/1.1\r\n",
                r#"{"logs-000001":{"settings":{"index":{"number_of_shards":"123456789012345678901234567890"}}}}"#,
            ),
            (
                crate::resources::Resource::ClusterHealth,
                None,
                "GET /proxy/es/_cluster/health HTTP/1.1\r\n",
                r#"{"cluster_name":"Fixture","status":"yellow","number_of_nodes":1,"active_shards":123456789012345678901234567890}"#,
            ),
            (
                crate::resources::Resource::NodesStats,
                None,
                "GET /proxy/es/_nodes/stats/jvm,fs,os,process,thread_pool HTTP/1.1\r\n",
                r#"{"_nodes":{"total":2,"successful":1,"failed":1},"nodes":{"n1":{"thread_pool":{"search":{"rejected":123456789012345678901234567890,"queue":0}}}}}"#,
            ),
            (
                crate::resources::Resource::Shards,
                None,
                "GET /proxy/es/_cat/shards?format=json&h=index,shard,prirep,state,docs,store,ip,node,unassigned.reason HTTP/1.1\r\n",
                r#"[{"index":"logs-000001","shard":"0","prirep":"p","state":"STARTED","docs":123456789012345678901234567890,"store":"1kb","ip":null,"node":null}]"#,
            ),
        ] {
            let (endpoint, received, handle) = fixture(
                response("200 OK", body, "X-Elastic-Product: Elasticsearch\r\n"),
                Duration::ZERO,
            );
            let profile = profile(format!("{endpoint}/proxy/es"));
            let target = index.map(target);
            let bytes = ReadOnlyClient::new()
                .unwrap()
                .execute(
                    crate::resources::resource_plan(&profile, resource, target.as_ref()).unwrap(),
                    &mut Cancellation::never(),
                )
                .await
                .unwrap();
            // Raw bytes, byte for byte: nothing is defaulted, filled in or dropped.
            assert_eq!(bytes, body.as_bytes(), "{resource:?}");
            assert_eq!(
                crate::resources::ResourceReadResponse::new(
                    &crate::resources::ResourceReadRequest {
                        request_id: Uuid::new_v4().to_string(),
                        connection_id: profile.id.clone(),
                        resource,
                        index: index.map(str::to_owned),
                    },
                    &profile,
                    bytes,
                )
                .unwrap()
                .raw_response,
                body,
                "{resource:?}"
            );
            let request = received.recv().unwrap();
            assert!(request.starts_with(expected), "{resource:?}");
            assert!(!request.to_lowercase().contains("authorization:"));
            handle.join().unwrap();
        }
    }

    #[tokio::test]
    async fn a_forbidden_resource_does_not_block_the_others() {
        let client = ReadOnlyClient::new().unwrap();
        // A 403 on one resource is reported for that call only, with no server text echoed.
        let (endpoint, _received, handle) = fixture(
            response("403 Forbidden", "security_exception=fixture-secret", ""),
            Duration::ZERO,
        );
        let forbidden = profile(endpoint);
        let error = client
            .execute(
                crate::resources::resource_plan(
                    &forbidden,
                    crate::resources::Resource::ClusterHealth,
                    None,
                )
                .unwrap(),
                &mut Cancellation::never(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "serverForbidden");
        assert!(!serde_json::to_string(&error)
            .unwrap()
            .contains("fixture-secret"));
        handle.join().unwrap();

        // The next resource on a healthy target still runs: no connection-wide lockout.
        let body = r#"[{"index":"logs-000001","shard":null,"docs":null,"ip":null,"node":null}]"#;
        let (endpoint, _received, handle) = fixture(
            response("200 OK", body, "X-Elastic-Product: Elasticsearch\r\n"),
            Duration::ZERO,
        );
        let healthy = profile(endpoint);
        let bytes = client
            .execute(
                crate::resources::resource_plan(&healthy, crate::resources::Resource::Shards, None)
                    .unwrap(),
                &mut Cancellation::never(),
            )
            .await
            .unwrap();
        // Nullable cat fields survive verbatim instead of being filled with zeros.
        assert_eq!(bytes, body.as_bytes());
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn search_posts_the_validated_body_verbatim_and_reports_partial_results() {
        let partial = r#"{"took":1,"timed_out":false,"_shards":{"total":5,"successful":4,"skipped":0,"failed":1},"hits":{"total":{"value":0,"relation":"eq"},"hits":[]}}"#;
        let (endpoint, received, handle) = fixture(
            response("200 OK", partial, "X-Elastic-Product: Elasticsearch\r\n"),
            Duration::ZERO,
        );
        let search_profile = profile(format!("{endpoint}/proxy/es"));
        let raw = ReadOnlyClient::new()
            .unwrap()
            .execute(
                crate::query::search_plan(&search_profile, &target("logs-*"), search_body())
                    .unwrap(),
                &mut Cancellation::never(),
            )
            .await
            .unwrap();
        assert!(crate::query::is_partial(&raw).unwrap());
        let decoded = crate::query::QueryExecuteResponse::new(
            &crate::query::QueryExecuteRequest {
                request_id: search_profile.id.clone(),
                connection_id: search_profile.id.clone(),
                index: "logs-*".into(),
                raw_dsl: SEARCH_BODY.into(),
                pit_id: None,
                search_after: None,
            },
            &search_profile,
            raw,
            None,
        )
        .unwrap();
        assert!(decoded.partial);
        assert_eq!(decoded.raw_response, partial);
        assert_eq!(decoded.endpoint, search_profile.endpoint);
        let request = received.recv().unwrap();
        assert!(request.starts_with("POST /proxy/es/logs-*/_search HTTP/1.1\r\n"));
        assert!(request.contains("content-type: application/json"));
        // The body is the draft, byte for byte; nothing was re-serialized on the way out.
        assert!(request.ends_with(SEARCH_BODY));
        handle.join().unwrap();

        let timed_out = r#"{"took":1,"timed_out":true,"_shards":{"total":1,"successful":1,"skipped":0,"failed":0},"hits":{"total":{"value":0,"relation":"eq"},"hits":[]}}"#;
        let (endpoint, _received, handle) = fixture(
            response("200 OK", timed_out, "X-Elastic-Product: Elasticsearch\r\n"),
            Duration::ZERO,
        );
        let search_profile = profile(endpoint);
        let raw = ReadOnlyClient::new()
            .unwrap()
            .execute(
                crate::query::search_plan(&search_profile, &target("logs-*"), search_body())
                    .unwrap(),
                &mut Cancellation::never(),
            )
            .await
            .unwrap();
        assert!(crate::query::is_partial(&raw).unwrap());
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn search_errors_are_structured_and_never_echo_server_text() {
        for (status, code) in [
            ("401 Unauthorized", "authenticationFailed"),
            ("403 Forbidden", "serverForbidden"),
            ("404 Not Found", "notFound"),
            ("400 Bad Request", "httpError"),
            ("429 Too Many Requests", "rateLimited"),
            ("503 Service Unavailable", "httpError"),
        ] {
            let (endpoint, _received, handle) = fixture(
                response(status, "credential=fixture-secret", ""),
                Duration::ZERO,
            );
            let profile = profile(endpoint);
            let error = ReadOnlyClient::new()
                .unwrap()
                .execute(
                    crate::query::search_plan(&profile, &target("logs-*"), search_body()).unwrap(),
                    &mut Cancellation::never(),
                )
                .await
                .unwrap_err();
            assert_eq!(error.code, code, "{status}");
            assert!(!serde_json::to_string(&error)
                .unwrap()
                .contains("fixture-secret"));
            handle.join().unwrap();
        }
    }

    #[tokio::test]
    async fn oversized_search_responses_and_invalid_utf8_fail_closed() {
        let (endpoint, _received, handle) = fixture(
            response(
                "200 OK",
                &"x".repeat(RESPONSE_LIMIT + 1),
                "X-Elastic-Product: Elasticsearch\r\n",
            ),
            Duration::ZERO,
        );
        let profile = profile(endpoint);
        assert_eq!(
            ReadOnlyClient::new()
                .unwrap()
                .execute(
                    crate::query::search_plan(&profile, &target("logs-*"), search_body()).unwrap(),
                    &mut Cancellation::never(),
                )
                .await
                .unwrap_err()
                .code,
            "responseTooLarge"
        );
        handle.join().unwrap();
        assert_eq!(
            decode_response(vec![0xff, 0xfe, 0x00]).unwrap_err().code,
            "invalidResponse"
        );
    }

    #[tokio::test]
    async fn cancellation_stops_the_in_flight_request_and_releases_its_resources() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let (started, started_receiver) = tokio::sync::oneshot::channel();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut request = Vec::new();
            while header_boundary(&request).is_none() {
                let mut chunk = [0; 1024];
                let length = stream.read(&mut chunk).unwrap();
                assert!(length > 0, "Request closed before headers completed");
                request.extend_from_slice(&chunk[..length]);
            }
            started.send(()).unwrap();
            // Answer far later than the cancel: a cancel that only pretends to work would still be
            // waiting for this response. The write may fail once the client is gone.
            thread::sleep(Duration::from_secs(2));
            let _ = stream.write_all(
                response("200 OK", "{}", "X-Elastic-Product: Elasticsearch\r\n").as_bytes(),
            );
        });

        let profile = profile(endpoint);
        let request_id = Uuid::new_v4().to_string();
        let registry = crate::read_only::RequestRegistry::default();
        let client = ReadOnlyClient::new().unwrap();
        let mut started_receiver = started_receiver;
        let started_at = Instant::now();
        {
            let mut guard = registry.register(&request_id, &profile.id).unwrap();
            let plan =
                crate::query::search_plan(&profile, &target("logs-*"), search_body()).unwrap();
            let executing = client.execute(plan, guard.cancellation());
            tokio::pin!(executing);
            tokio::select! {
                result = &mut executing => panic!("the request must still be in flight: {result:?}"),
                _ = &mut started_receiver => {}
            }
            // In flight: the cancel reaches the running future.
            assert!(registry.cancel(&request_id, &profile.id));
            let error = executing.await.unwrap_err();
            assert_eq!(error.code, "cancelled");
        }
        // The cancelled request returned without waiting for the response.
        assert!(
            started_at.elapsed() < Duration::from_secs(1),
            "cancellation must not wait for the cluster to answer"
        );
        // Its concurrency permit and its registry entry were released.
        assert!(client.permits.try_acquire_many(4).is_ok());
        assert!(!registry.cancel(&request_id, &profile.id));
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn an_already_cancelled_request_never_opens_a_socket() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let profile = profile(format!("http://{}", listener.local_addr().unwrap()));
        let request_id = Uuid::new_v4().to_string();
        let registry = crate::read_only::RequestRegistry::default();
        let mut guard = registry.register(&request_id, &profile.id).unwrap();
        assert!(registry.cancel(&request_id, &profile.id));
        let error = ReadOnlyClient::new()
            .unwrap()
            .execute(
                crate::query::search_plan(&profile, &target("logs-*"), search_body()).unwrap(),
                guard.cancellation(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "cancelled");
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[tokio::test]
    async fn a_cancel_that_arrives_before_registration_still_prevents_the_request() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let profile = profile(format!("http://{}", listener.local_addr().unwrap()));
        let request_id = Uuid::new_v4().to_string();
        let registry = crate::read_only::RequestRegistry::default();
        // The cancel wins the IPC race: the request must not be sent at all.
        assert!(registry.cancel(&request_id, &profile.id));
        assert_eq!(
            registry
                .register(&request_id, &profile.id)
                .unwrap_err()
                .code,
            "cancelled"
        );
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[tokio::test]
    async fn a_resource_read_is_cancellable_through_the_same_registry() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let profile = profile(format!("http://{}", listener.local_addr().unwrap()));
        let registry = crate::read_only::RequestRegistry::default();
        let mapping = || {
            crate::resources::resource_plan(
                &profile,
                crate::resources::Resource::Mapping,
                Some(&target("logs-*")),
            )
            .unwrap()
        };
        // A cluster-wide resource is planned without a target and is cancellable in the same way.
        let health = || {
            crate::resources::resource_plan(
                &profile,
                crate::resources::Resource::ClusterHealth,
                None,
            )
            .unwrap()
        };
        let client = ReadOnlyClient::new().unwrap();

        // An early cancel blocks the read before it can open a socket.
        let early = Uuid::new_v4().to_string();
        assert!(registry.cancel(&early, &profile.id));
        assert_eq!(
            registry.register(&early, &profile.id).unwrap_err().code,
            "cancelled"
        );
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );

        // A running read is stopped by the same registry, and its permit is released.
        for plan in [mapping(), health()] {
            let running = Uuid::new_v4().to_string();
            let mut guard = registry.register(&running, &profile.id).unwrap();
            assert!(registry.cancel(&running, &profile.id));
            assert_eq!(
                client
                    .execute(plan, guard.cancellation())
                    .await
                    .unwrap_err()
                    .code,
                "cancelled"
            );
            assert!(client.permits.try_acquire_many(4).is_ok());
        }
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[tokio::test]
    #[ignore = "Explicit local ES 7.17.25 authorization and running service required"]
    async fn local_elasticsearch_71725_read_only_resources_and_search() {
        assert_eq!(std::env::var("ESCOPE_TEST_ES_71725").as_deref(), Ok("1"));
        let profile = profile("http://127.0.0.1:9200".into());
        let client = ReadOnlyClient::new().unwrap();
        // Discovery over `*` must not need a monitoring endpoint and must return a JSON object.
        for resource in [
            crate::resources::Resource::Indices,
            crate::resources::Resource::Mapping,
            crate::resources::Resource::FieldCaps,
        ] {
            let bytes = client
                .execute(
                    crate::resources::resource_plan(&profile, resource, Some(&target("*")))
                        .unwrap(),
                    &mut Cancellation::never(),
                )
                .await
                .unwrap();
            assert!(serde_json::from_slice::<serde_json::Value>(&bytes)
                .unwrap()
                .is_object());
        }
        // A search that returns no document at all, so no index name or document is ever read.
        let body = crate::query::validate_search_body(r#"{"size":0,"_source":false}"#).unwrap();
        let bytes = client
            .execute(
                crate::query::search_plan(&profile, &target("*"), body).unwrap(),
                &mut Cancellation::never(),
            )
            .await
            .unwrap();
        assert!(serde_json::from_slice::<serde_json::Value>(&bytes)
            .unwrap()
            .is_object());
        // Never print index names, documents, addresses or response bodies.
    }

    #[tokio::test]
    #[ignore = "Explicit local ES 7.17.25 authorization and running service required"]
    async fn local_elasticsearch_71725_read_only_cluster_resources() {
        assert_eq!(std::env::var("ESCOPE_TEST_ES_71725").as_deref(), Ok("1"));
        let profile = profile("http://127.0.0.1:9200".into());
        let client = ReadOnlyClient::new().unwrap();
        let fetch = |resource, target: Option<crate::operation::IndexTarget>| {
            let client = &client;
            let profile = &profile;
            async move {
                client
                    .execute(
                        crate::resources::resource_plan(profile, resource, target.as_ref())
                            .unwrap(),
                        &mut Cancellation::never(),
                    )
                    .await
                    .unwrap()
            }
        };

        // Cluster health, node stats and the shard list are cluster-wide: no target, JSON only.
        for resource in [
            crate::resources::Resource::ClusterHealth,
            crate::resources::Resource::NodesStats,
            crate::resources::Resource::Shards,
        ] {
            let bytes = fetch(resource, None).await;
            assert!(
                serde_json::from_slice::<serde_json::Value>(&bytes).is_ok(),
                "{resource:?} must answer with JSON"
            );
        }

        // Index settings need a real target. Take the first non-system index from discovery and
        // skip this branch when there is none, instead of claiming it was verified.
        let bytes = fetch(crate::resources::Resource::Indices, Some(target("*"))).await;
        let catalog: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let Some(name) = first_non_system_index(&catalog) else {
            return;
        };
        let Some(target) = crate::operation::IndexTarget::parse(name).ok() else {
            return;
        };
        let bytes = fetch(crate::resources::Resource::IndexSettings, Some(target)).await;
        assert!(serde_json::from_slice::<serde_json::Value>(&bytes).is_ok());
        // Never print index names, node names, addresses or response bodies.
    }

    /// First open, non-system index name from a `_resolve/index` response, if the cluster has one.
    /// The name is used as a target only; it is never printed or stored.
    fn first_non_system_index(catalog: &serde_json::Value) -> Option<&str> {
        catalog
            .get("indices")?
            .as_array()?
            .iter()
            .filter_map(|entry| entry.get("name")?.as_str())
            .find(|name| !name.starts_with('.'))
    }
    #[tokio::test]
    #[ignore = "Explicit local ES 7.17.25 authorization and running service required"]
    async fn local_elasticsearch_71725_pit_pagination_round_trip() {
        assert_eq!(std::env::var("ESCOPE_TEST_ES_71725").as_deref(), Ok("1"));
        let profile = profile("http://127.0.0.1:9200".into());
        let client = ReadOnlyClient::new().unwrap();
        // Open a snapshot over the authorized indices.
        let opened = crate::query::PitOpenRequest {
            request_id: Uuid::new_v4().to_string(),
            connection_id: profile.id.clone(),
            index: "*".into(),
        };
        let target = opened.target().unwrap();
        let raw = client
            .execute(
                crate::query::pit_open_plan(&profile, &target).unwrap(),
                &mut Cancellation::never(),
            )
            .await
            .unwrap();
        let pit = crate::query::PitOpenResponse::new(&opened, &profile, raw).unwrap();
        assert!(!pit.pit_id.is_empty());
        // Read only hit metadata, never _source. Page one must already belong to this PIT.
        let first = crate::query::QueryExecuteRequest {
            request_id: Uuid::new_v4().to_string(),
            connection_id: profile.id.clone(),
            index: "*".into(),
            raw_dsl: r#"{"size":1,"_source":false,"sort":["_shard_doc"],"track_total_hits":true}"#
                .into(),
            pit_id: Some(pit.pit_id.clone()),
            search_after: None,
        };
        let prepared = first.prepare().unwrap();
        assert!(prepared.continuation);
        let raw = client
            .execute(
                crate::query::paginated_search_plan(&profile, prepared.body).unwrap(),
                &mut Cancellation::never(),
            )
            .await
            .unwrap();
        let first_response =
            crate::query::QueryExecuteResponse::new(&first, &profile, raw, first.pit_id.as_deref())
                .unwrap();
        let body: serde_json::Value = serde_json::from_str(&first_response.raw_response).unwrap();
        let hits = body["hits"]["hits"].as_array().unwrap();
        assert!(
            !hits.is_empty(),
            "The authorized PIT test needs at least one existing hit"
        );
        assert!(hits.iter().all(|hit| hit.get("_source").is_none()));
        let cursor = serde_json::to_string(hits[0].get("sort").unwrap()).unwrap();
        let continued = crate::query::QueryExecuteRequest {
            request_id: Uuid::new_v4().to_string(),
            connection_id: profile.id.clone(),
            index: "*".into(),
            raw_dsl: first.raw_dsl.clone(),
            pit_id: first_response.pit_id,
            search_after: Some(cursor),
        };
        let prepared = continued.prepare().unwrap();
        let raw = client
            .execute(
                crate::query::paginated_search_plan(&profile, prepared.body).unwrap(),
                &mut Cancellation::never(),
            )
            .await
            .unwrap();
        let response = crate::query::QueryExecuteResponse::new(
            &continued,
            &profile,
            raw,
            continued.pit_id.as_deref(),
        )
        .unwrap();
        assert!(response.pit_id.is_some());
        let next: serde_json::Value = serde_json::from_str(&response.raw_response).unwrap();
        assert!(next["hits"]["hits"]
            .as_array()
            .unwrap()
            .iter()
            .all(|hit| hit.get("_source").is_none()));
        // Close the snapshot so the cluster does not have to expire it.
        client
            .execute(
                crate::query::pit_close_plan(
                    &profile,
                    response.pit_id.as_deref().unwrap_or(&pit.pit_id),
                )
                .unwrap(),
                &mut Cancellation::never(),
            )
            .await
            .unwrap();
        // Never print index names, documents, addresses or response bodies.
    }
}
