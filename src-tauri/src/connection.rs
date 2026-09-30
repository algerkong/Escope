use crate::error::AppError;
use crate::operation::identity_request;
use crate::storage::ConnectionProfile;
use reqwest::{redirect::Policy, Client, StatusCode};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;
use uuid::Uuid;

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

    fn with_timeout(timeout: Duration) -> Result<Self, AppError> {
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
        let _permit = self
            .permits
            .try_acquire()
            .map_err(|_| AppError::new("busy"))?;
        let plan = identity_request(profile)?;
        let started = Instant::now();
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
        StatusCode::TOO_MANY_REQUESTS => "rateLimited",
        status if status.is_redirection() => "redirectBlocked",
        _ => "httpError",
    };
    AppError::new(code)
}

#[cfg(test)]
mod tests {
    use super::*;
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
            while !request.ends_with(b"\r\n\r\n") {
                let mut chunk = [0; 1024];
                let length = stream.read(&mut chunk).unwrap();
                assert!(length > 0, "Request closed before headers completed");
                request.extend_from_slice(&chunk[..length]);
                assert!(request.len() <= 8192);
            }
            sender.send(String::from_utf8(request).unwrap()).unwrap();
            thread::sleep(delay);
            let _ = stream.write_all(response.as_bytes());
        });
        (endpoint, receiver, handle)
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
}
