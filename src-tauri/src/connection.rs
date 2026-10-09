use crate::connection_auth::ResolvedAuth;
use crate::error::AppError;
use crate::operation::{identity_request, RequestPlan};
use crate::read_only::Cancellation;
use crate::storage::{ConnectionProfile, TransportSnapshot};
use reqwest::{Client, StatusCode};
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
    /// The overall request timeout this client was built with. Kept so a per-snapshot client
    /// (custom CA) is built with exactly the same transport budget.
    timeout: Duration,
}

impl ReadOnlyClient {
    pub fn new() -> Result<Self, AppError> {
        Self::with_timeout(Duration::from_secs(10))
    }

    pub(crate) fn with_timeout(timeout: Duration) -> Result<Self, AppError> {
        Ok(Self {
            client: crate::connection_tls::build_client(timeout, None)?,
            permits: Arc::new(Semaphore::new(4)),
            timeout,
        })
    }

    /// The client to use for one validated connection snapshot.
    ///
    /// A snapshot without a custom CA shares this client unchanged — same connection pool, same
    /// timeout, same concurrency permits. A snapshot with a custom CA gets its own client whose
    /// trust roots are that snapshot's chain only *added to* the default roots, while the permit
    /// semaphore is shared, so the global in-flight limit still counts every request family
    /// together. Nothing is cached: another connection never reuses these roots, and the client
    /// is dropped with the request.
    pub fn for_snapshot(&self, snapshot: &TransportSnapshot) -> Result<Self, AppError> {
        match snapshot.ca() {
            None => Ok(self.clone()),
            Some(ca) => Ok(Self {
                client: crate::connection_tls::build_client(self.timeout, Some(ca))?,
                permits: Arc::clone(&self.permits),
                timeout: self.timeout,
            }),
        }
    }

    pub async fn test(
        &self,
        profile: &ConnectionProfile,
        probe: ConnectionProbe,
        auth: &ResolvedAuth,
    ) -> Result<ConnectionIdentity, AppError> {
        probe.validate()?;
        let request_id = probe.request_id.clone();
        let result = self.test_inner(profile, probe, auth).await;
        result.map_err(|mut error| {
            error.request_id = Some(request_id);
            error
        })
    }

    async fn test_inner(
        &self,
        profile: &ConnectionProfile,
        probe: ConnectionProbe,
        auth: &ResolvedAuth,
    ) -> Result<ConnectionIdentity, AppError> {
        if profile.id != probe.connection_id {
            return Err(AppError::new("invalidInput"));
        }
        let plan = identity_request(profile)?.authenticate(auth)?;
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
                .build(&self.client)?
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

/// Whether one transport failure came from the TLS layer, decided by error *type* only.
///
/// TLS failures surface as a `rustls::Error`, either directly in the source chain or nested inside
/// the `io::Error` layer(s) the async plumbing wraps them in. The walk follows `source()` and, at
/// every `io::Error`, the `get_ref()` chain as well. It never inspects an error message, URL or
/// body, so the classification cannot be spoofed by text and cannot leak anything; anything
/// unrecognized stays a generic network failure.
fn tls_layer_error(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut current = Some(error);
    while let Some(source) = current {
        if source.downcast_ref::<rustls::Error>().is_some() {
            return true;
        }
        if let Some(io) = source.downcast_ref::<std::io::Error>() {
            let mut layer = Some(io);
            while let Some(inner) = layer {
                match inner.get_ref() {
                    Some(wrapped) if wrapped.downcast_ref::<rustls::Error>().is_some() => {
                        return true;
                    }
                    Some(wrapped) => layer = wrapped.downcast_ref::<std::io::Error>(),
                    None => layer = None,
                }
            }
        }
        current = source.source();
    }
    false
}

fn network_error(error: reqwest::Error) -> AppError {
    // reqwest errors can contain URLs and key material in their source chain. Only a stable code
    // is ever returned; the chain is not printed, logged or sent.
    AppError::new(if error.is_timeout() {
        // A request that ran out of time is reported as a timeout even if the timeout happened
        // inside a handshake: that is the more specific fact for the user.
        "timeout"
    } else if tls_layer_error(&error) {
        // Certificate validation and other handshake failures are TLS-layer results, not generic
        // network failures. No detail beyond the code is exposed.
        "tlsError"
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
    use crate::connection_auth::EsAuthMaterial;
    use crate::connection_credentials::ConnectionCredentials;
    use crate::credentials::{CredentialRef, Secret};
    use crate::storage::{AuthKind, ConnectionAuth, ConnectionInput, Database, TransportSnapshot};
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

    /// A cloned client and a per-snapshot client keep one concurrency budget and the exact
    /// configured timeout; a snapshot carrying a custom CA gets its own client that still shares
    /// the permits, so the global in-flight limit counts every request family together.
    #[test]
    fn snapshot_clients_share_permits_and_preserve_timeout() {
        let client = ReadOnlyClient::with_timeout(Duration::from_millis(123)).unwrap();
        let clone = client.clone();
        assert!(Arc::ptr_eq(&client.permits, &clone.permits));
        assert_eq!(client.timeout, Duration::from_millis(123));

        let plain = TransportSnapshot::for_test(profile("https://example.test/es".into()));
        let plain_client = client.for_snapshot(&plain).unwrap();
        assert!(Arc::ptr_eq(&client.permits, &plain_client.permits));
        assert_eq!(plain_client.timeout, Duration::from_millis(123));

        let ca = crate::connection_tls::CaCertificate::parse(
            crate::connection_tls::test_certificates::ROOT_CA_3,
        )
        .unwrap();
        let secured =
            TransportSnapshot::for_test_with_ca(profile("https://example.test/es".into()), ca);
        let ca_client = client.for_snapshot(&secured).unwrap();
        assert!(Arc::ptr_eq(&client.permits, &ca_client.permits));
        assert_eq!(ca_client.timeout, Duration::from_millis(123));
    }

    /// One self-signed certificate generated in memory for `san`: PEM for a client trust store,
    /// DER certificate and PKCS#8 key for the loopback server.
    fn self_signed(san: &str) -> (String, Vec<u8>, Vec<u8>) {
        let generated = rcgen::generate_simple_self_signed(vec![san.to_owned()]).unwrap();
        (
            generated.cert.pem(),
            generated.cert.der().to_vec(),
            generated.key_pair.serialize_der(),
        )
    }

    /// A loopback HTTPS server that answers a fixed number of connections with the identity
    /// fixture and then exits. Every loop is bounded (non-blocking accept with a deadline, read
    /// timeout, bounded request), so a refused handshake or an aborted client still terminates the
    /// thread. The certificate and key live in memory only; nothing touches the system trust store
    /// or a real service.
    struct TlsFixture {
        endpoint: String,
        certificate_pem: String,
        server: thread::JoinHandle<()>,
    }

    impl TlsFixture {
        /// `connections` is the exact number of TCP connections the test will open against this
        /// server; the internal deadline only guards against a bug leaving the thread alive.
        fn start(san: &str, connections: usize) -> Self {
            let (certificate_pem, certificate_der, key_der) = self_signed(san);
            let config = rustls::ServerConfig::builder_with_provider(Arc::new(
                rustls::crypto::ring::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![certificate_der.into()],
                rustls::pki_types::PrivateKeyDer::Pkcs8(key_der.into()),
            )
            .unwrap();
            let config = Arc::new(config);
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let endpoint = format!(
                "https://localhost:{}",
                listener.local_addr().unwrap().port()
            );
            let server = thread::spawn(move || {
                listener.set_nonblocking(true).unwrap();
                let deadline = Instant::now() + Duration::from_secs(5);
                let mut served = 0usize;
                while served < connections && Instant::now() < deadline {
                    let stream = match listener.accept() {
                        Ok((stream, _)) => stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(5));
                            continue;
                        }
                        Err(_) => return,
                    };
                    served += 1;
                    // On Windows an accepted socket can inherit the listener's non-blocking mode,
                    // which would turn every read into `WouldBlock`; the connection handler must be
                    // blocking with its own read timeout.
                    let _ = stream.set_nonblocking(false);
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
                    let Ok(connection) = rustls::ServerConnection::new(config.clone()) else {
                        continue;
                    };
                    let mut tls = rustls::StreamOwned::new(connection, stream);
                    let mut request = Vec::new();
                    let mut chunk = [0u8; 1024];
                    while header_boundary(&request).is_none() {
                        match tls.read(&mut chunk) {
                            Ok(0) | Err(_) => break,
                            Ok(length) => request.extend_from_slice(&chunk[..length]),
                        }
                    }
                    if header_boundary(&request).is_some() {
                        let _ = tls.write_all(
                            response("200 OK", BODY, "X-Elastic-Product: Elasticsearch\r\n")
                                .as_bytes(),
                        );
                        let _ = tls.flush();
                    }
                }
            });
            Self {
                endpoint,
                certificate_pem,
                server,
            }
        }

        /// The same server's address as an IP, for the hostname-mismatch case.
        fn ip_endpoint(&self) -> String {
            self.endpoint.replace("localhost", "127.0.0.1")
        }

        fn ca(&self) -> crate::connection_tls::CaCertificate {
            crate::connection_tls::CaCertificate::parse(&self.certificate_pem).unwrap()
        }

        fn join(self) {
            let _ = self.server.join();
        }
    }

    fn tls_input(endpoint: &str) -> ConnectionInput {
        ConnectionInput {
            display_name: "Tls fixture".into(),
            endpoint: endpoint.into(),
            environment: "development".into(),
        }
    }

    /// Store one connection with an optional custom CA chain and return its id.
    fn store_tls_connection(
        database: &mut Database,
        store: &FakeStore,
        input: ConnectionInput,
        ca: Option<crate::connection_tls::CaCertificate>,
    ) -> String {
        let mut credentials = ConnectionCredentials::new(database, store);
        let id = credentials.save(input.clone(), None).unwrap().profile.id;
        credentials
            .save_combined(
                input,
                Some(id.clone()),
                crate::connection_credentials::ConnectionCredentialPlan::Keep,
                match ca {
                    Some(ca) => crate::connection_credentials::ConnectionCaPlan::Replace(ca),
                    None => crate::connection_credentials::ConnectionCaPlan::Keep,
                },
            )
            .unwrap();
        id
    }

    /// Run one identity request through the client a snapshot builds. `snapshot` is the trusted
    /// read of a saved row, exactly like the IPC commands use.
    async fn identity_via_snapshot(
        base: &ReadOnlyClient,
        snapshot: &TransportSnapshot,
    ) -> Result<ConnectionIdentity, AppError> {
        base.for_snapshot(snapshot)
            .unwrap()
            .test(
                snapshot.profile(),
                probe(snapshot.profile()),
                &no_auth(snapshot.profile()),
            )
            .await
    }

    /// C04.1 regression over a real (loopback, in-memory) TLS handshake: default verification
    /// rejects a self-signed server, and the same server is accepted once its chain is the
    /// connection's saved CA, with normal hostname verification.
    #[tokio::test]
    async fn tls_handshake_rejects_self_signed_and_trusts_only_a_saved_chain() {
        let fixture = TlsFixture::start("localhost", 2);
        let base = ReadOnlyClient::new().unwrap();

        // No custom chain: the self-signed server fails normal verification.
        let plain = TransportSnapshot::for_test(profile(fixture.endpoint.clone()));
        let error = identity_via_snapshot(&base, &plain).await.unwrap_err();
        assert_eq!(error.code, "tlsError");
        // A failed handshake never echoes the target, the certificate or a response body.
        let rendered = format!("{error:?}");
        assert!(!rendered.contains("localhost"));
        assert!(!rendered.contains(&fixture.endpoint));
        assert!(!rendered.contains("Fixture"));

        // The same server is trusted once the saved row carries its chain.
        let temp = tempfile::tempdir().unwrap();
        let mut database = Database::open(&temp.path().join("escope.sqlite")).unwrap();
        let store = FakeStore::default();
        let id = store_tls_connection(
            &mut database,
            &store,
            tls_input(&fixture.endpoint),
            Some(fixture.ca()),
        );
        let snapshot = database.transport_snapshot(&id).unwrap();
        assert!(snapshot.ca().is_some());
        let identity = identity_via_snapshot(&base, &snapshot).await.unwrap();
        assert_eq!(identity.cluster_name, "Fixture");
        assert_eq!(identity.endpoint, fixture.endpoint);
        fixture.join();
    }

    /// C04.1: a failure that is not TLS stays a generic network failure, and a timeout keeps its
    /// own code; the classification never turns an unrelated transport error into a TLS claim.
    #[tokio::test]
    async fn non_tls_failures_keep_generic_network_codes() {
        // Bind and release a port, so the address is almost certainly unused afterwards.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let endpoint = format!("http://{address}/es");
        let base = ReadOnlyClient::new().unwrap();
        let snapshot = TransportSnapshot::for_test(profile(endpoint.clone()));

        let error = base
            .for_snapshot(&snapshot)
            .unwrap()
            .test(
                snapshot.profile(),
                probe(snapshot.profile()),
                &no_auth(snapshot.profile()),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "networkError");
        assert!(!format!("{error:?}").contains(&endpoint));

        // A request that outlives its own timeout is still `timeout`, even though the clock runs
        // inside the transport: the two codes stay independent. The local server accepts and stays
        // silent, so the overall request timeout is the only outcome.
        let silent = TcpListener::bind("127.0.0.1:0").unwrap();
        let silent_address = silent.local_addr().unwrap();
        let silent_server = thread::spawn(move || {
            if let Ok((stream, _)) = silent.accept() {
                thread::sleep(Duration::from_millis(500));
                drop(stream);
            }
        });
        let slow = ReadOnlyClient::with_timeout(Duration::from_millis(30)).unwrap();
        let slow_snapshot =
            TransportSnapshot::for_test(profile(format!("http://{silent_address}/es")));
        let error = slow
            .for_snapshot(&slow_snapshot)
            .unwrap()
            .test(
                slow_snapshot.profile(),
                probe(slow_snapshot.profile()),
                &no_auth(slow_snapshot.profile()),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "timeout");
        let _ = silent_server.join();
    }

    /// C04.1 regression: trust is never shared. Another connection to the same server, a
    /// connection without a chain and a connection whose chain is a different self-signed
    /// certificate all fail, and the correct chain still fails on a hostname mismatch.
    #[tokio::test]
    async fn tls_handshake_trust_does_not_leak_to_other_connections_or_hostnames() {
        let fixture = TlsFixture::start("localhost", 4);
        let unrelated = TransportSnapshot::for_test(profile(fixture.endpoint.clone()));
        let base = ReadOnlyClient::new().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let mut database = Database::open(&temp.path().join("escope.sqlite")).unwrap();
        let store = FakeStore::default();
        // A different in-memory chain, never stored on another row that points at this server.
        let (other_pem, _, _) = self_signed("localhost");
        let other_ca = crate::connection_tls::CaCertificate::parse(&other_pem).unwrap();

        // A saved row without a chain must not inherit the trust of any other row.
        let no_ca = store_tls_connection(&mut database, &store, tls_input(&fixture.endpoint), None);
        let no_ca_snapshot = database.transport_snapshot(&no_ca).unwrap();
        assert!(no_ca_snapshot.ca().is_none());
        assert_eq!(
            identity_via_snapshot(&base, &no_ca_snapshot)
                .await
                .unwrap_err()
                .code,
            "tlsError"
        );

        // A wrong chain fails too, even though another connection trusts this server.
        let wrong_ca = store_tls_connection(
            &mut database,
            &store,
            tls_input(&fixture.endpoint),
            Some(other_ca),
        );
        let wrong_snapshot = database.transport_snapshot(&wrong_ca).unwrap();
        assert_eq!(
            identity_via_snapshot(&base, &wrong_snapshot)
                .await
                .unwrap_err()
                .code,
            "tlsError"
        );
        // The corresponding hand-built snapshot proves the same client is not polluted by any
        // globally cached root: nothing was trusted before, and nothing is trusted now.
        let error = identity_via_snapshot(&base, &unrelated).await.unwrap_err();
        assert_eq!(error.code, "tlsError");

        // The correct chain still fails when the hostname does not match the certificate.
        let mismatch = store_tls_connection(
            &mut database,
            &store,
            tls_input(&fixture.ip_endpoint()),
            Some(fixture.ca()),
        );
        let mismatch_snapshot = database.transport_snapshot(&mismatch).unwrap();
        let error = identity_via_snapshot(&base, &mismatch_snapshot)
            .await
            .unwrap_err();
        assert_eq!(error.code, "tlsError");
        assert!(!format!("{error:?}").contains("127.0.0.1"));
        fixture.join();
    }

    /// Test-only credential store: in-memory entries, never a real keyring and never a
    /// production fallback.
    #[derive(Default)]
    struct FakeStore {
        entries: std::sync::Mutex<std::collections::HashMap<String, Vec<u8>>>,
    }

    impl FakeStore {
        fn put(&self, reference: &CredentialRef, secret: &Secret) {
            self.entries.lock().unwrap().insert(
                reference.as_str().to_owned(),
                secret.expose_secret().to_vec(),
            );
        }
    }

    impl crate::credentials::CredentialStore for FakeStore {
        fn set(
            &self,
            reference: &CredentialRef,
            secret: &Secret,
        ) -> Result<(), crate::credentials::CredentialError> {
            self.put(reference, secret);
            Ok(())
        }

        fn get(
            &self,
            reference: &CredentialRef,
        ) -> Result<Secret, crate::credentials::CredentialError> {
            let entries = self.entries.lock().unwrap();
            Secret::new(
                entries
                    .get(reference.as_str())
                    .ok_or(crate::credentials::CredentialError::NotFound)?
                    .clone(),
            )
        }

        fn delete(
            &self,
            _reference: &CredentialRef,
        ) -> Result<(), crate::credentials::CredentialError> {
            Ok(())
        }
    }

    /// The resolution of an unauthenticated profile. The snapshot comes from the crate-visible
    /// test constructor; production code can only obtain one from `Database::transport_snapshot`,
    /// and the empty store proves the store is not consulted for a connection without a
    /// credential.
    fn no_auth(profile: &ConnectionProfile) -> ResolvedAuth {
        let snapshot = TransportSnapshot::for_test(profile.clone());
        crate::connection_auth::resolve(&snapshot, &FakeStore::default()).unwrap()
    }

    /// A connection stored in a temporary database, bound through the production credential
    /// orchestration, plus its trusted transport snapshot and the injected vault. Wire tests
    /// that need authentication resolve exclusively through this path — the same one the IPC
    /// commands use — never from a hand-built profile.
    struct TrustedConnection {
        snapshot: TransportSnapshot,
        store: FakeStore,
    }

    impl TrustedConnection {
        fn new(endpoint: String, material: EsAuthMaterial) -> Self {
            Self::store_connection(endpoint, Some(material))
        }

        /// The same trusted path for a connection that has no credential.
        fn plain(endpoint: String) -> Self {
            Self::store_connection(endpoint, None)
        }

        fn store_connection(endpoint: String, material: Option<EsAuthMaterial>) -> Self {
            let temp = tempfile::tempdir().unwrap();
            let mut database = Database::open(&temp.path().join("escope.sqlite")).unwrap();
            let store = FakeStore::default();
            let id = ConnectionCredentials::new(&mut database, &store)
                .save(
                    ConnectionInput {
                        display_name: "Fixture".into(),
                        endpoint,
                        environment: "development".into(),
                    },
                    None,
                )
                .unwrap()
                .profile
                .id;
            if let Some(material) = material {
                ConnectionCredentials::new(&mut database, &store)
                    .bind_auth(&id, material)
                    .unwrap();
            }
            Self {
                snapshot: database.transport_snapshot(&id).unwrap(),
                store,
            }
        }

        fn profile(&self) -> &ConnectionProfile {
            self.snapshot.profile()
        }

        fn auth(&self) -> ResolvedAuth {
            crate::connection_auth::resolve(&self.snapshot, &self.store).unwrap()
        }
    }

    /// Read one complete HTTP request: headers plus exactly the announced body, so a captured
    /// request is whole even when segments split it.
    fn read_request(stream: &mut std::net::TcpStream) -> Vec<u8> {
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
        request
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
            let request = read_request(&mut stream);
            sender.send(String::from_utf8(request).unwrap()).unwrap();
            thread::sleep(delay);
            let _ = stream.write_all(response.as_bytes());
        });
        (endpoint, receiver, handle)
    }

    /// Serve `responses` in order over one loopback listener and capture every request. Each
    /// response closes the connection, so every call opens its own and the captured request list
    /// is complete and ordered.
    fn sequence_fixture(
        responses: Vec<String>,
    ) -> (String, mpsc::Receiver<String>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let (sender, receiver) = mpsc::channel();
        let handle = thread::spawn(move || {
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_request(&mut stream);
                sender.send(String::from_utf8(request).unwrap()).unwrap();
                let _ = stream.write_all(response.as_bytes());
            }
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
            .test(&profile, probe, &no_auth(&profile))
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
                .test(&profile, probe, &no_auth(&profile))
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
            .test(&profile, probe(&profile), &no_auth(&profile))
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
                .test(&profile, probe(&profile), &no_auth(&profile))
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
                .test(&profile, probe(&profile), &no_auth(&profile))
                .await
                .unwrap_err()
                .code,
            "timeout"
        );
        handle.join().unwrap();
        let mut wrong = probe(&profile);
        wrong.connection_id = Uuid::new_v4().to_string();
        assert_eq!(
            client
                .test(&profile, wrong, &no_auth(&profile))
                .await
                .unwrap_err()
                .code,
            "invalidInput"
        );
    }

    #[test]
    fn ipc_probe_rejects_arbitrary_urls_methods_and_invalid_ids() {
        assert!(serde_json::from_str::<ConnectionProbe>(
            r#"{"requestId":"x","connectionId":"y","url":"https://example.test","method":"DELETE"}"#
        )
        .is_err());
        // Credential references, secrets and headers can never ride along on the probe envelope:
        // the subject is the stored connection ID only.
        for extra in ["credentialRef", "secret", "authorization", "headers"] {
            let payload = format!(r#"{{"requestId":"x","connectionId":"y","{extra}":"fixture"}}"#);
            assert!(
                serde_json::from_str::<ConnectionProbe>(&payload).is_err(),
                "{extra}"
            );
        }
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
        let store = FakeStore::default();
        let client = ReadOnlyClient::new().unwrap();
        let mut invalid = probe(&profile);
        invalid.request_id = "fixture-secret".into();
        let error = client
            .test(&profile, invalid, &no_auth(&profile))
            .await
            .unwrap_err();
        assert_eq!(error.code, "invalidInput");
        assert!(error.request_id.is_none());
        let mut mismatched = probe(&profile);
        mismatched.connection_id = Uuid::new_v4().to_string();
        assert_eq!(
            client
                .test(&profile, mismatched, &no_auth(&profile))
                .await
                .unwrap_err()
                .code,
            "invalidInput"
        );
        // An IPC-facing auth label this build does not produce is refused before any socket is
        // opened, even with an unauthenticated resolution in hand.
        profile.auth = "basic";
        let unresolved = no_auth(&ConnectionProfile {
            auth: "none",
            ..profile.clone()
        });
        assert_eq!(
            client
                .test(&profile, probe(&profile), &unresolved)
                .await
                .unwrap_err()
                .code,
            "unsupported"
        );
        // A credential bound through the internal metadata can never be sent without a resolvable
        // secret: with no vault entry the resolution fails, and a plan that skips authentication
        // is refused before `build` can produce a request.
        profile.auth = "none";
        profile.auth_state = ConnectionAuth {
            kind: AuthKind::Basic,
            credential_ref: Some(CredentialRef::generate()),
        };
        let bound_snapshot = TransportSnapshot::for_test(profile.clone());
        assert_eq!(
            crate::connection_auth::resolve(&bound_snapshot, &store)
                .unwrap_err()
                .code,
            "credentialNotFound"
        );
        let plan = crate::operation::identity_request(&profile).unwrap();
        assert_eq!(
            plan.build(&Client::new()).err().unwrap().code,
            "unsupported"
        );
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[tokio::test]
    async fn each_supported_kind_sends_its_exact_wire_encoding() {
        let product = "X-Elastic-Product: Elasticsearch\r\n";
        for (material, expected) in [
            (
                EsAuthMaterial::basic("aladdin", "opensesame").unwrap(),
                "Basic YWxhZGRpbjpvcGVuc2VzYW1l",
            ),
            (
                EsAuthMaterial::api_key(API_KEY_ID, API_KEY_SECRET).unwrap(),
                "ApiKey VnVhQ2ZHY0JDZGJrUW0tZTVhT3g6dWkybHAyYXhUTm1zeWFrdzl0dk5udw==",
            ),
            (
                EsAuthMaterial::bearer("fixture-bearer-token").unwrap(),
                "Bearer fixture-bearer-token",
            ),
        ] {
            let (endpoint, received, handle) =
                fixture(response("200 OK", BODY, product), Duration::ZERO);
            let trusted = TrustedConnection::new(endpoint, material);
            let profile = trusted.profile();
            let auth = trusted.auth();
            let identity = ReadOnlyClient::new()
                .unwrap()
                .test(profile, probe(profile), &auth)
                .await
                .unwrap();
            assert_eq!(identity.cluster_uuid, "fixture-uuid");
            let request = received.recv().unwrap();
            assert!(request.starts_with("GET / HTTP/1.1\r\n"));
            // Exactly one header, with the exact wire value.
            assert!(
                request.contains(&format!("authorization: {expected}\r\n")),
                "{expected}"
            );
            assert_eq!(request.to_lowercase().matches("authorization:").count(), 1);
            handle.join().unwrap();
        }
    }

    #[tokio::test]
    async fn every_authenticated_resource_family_carries_the_bound_header() {
        let product = "X-Elastic-Product: Elasticsearch\r\n";
        let (endpoint, received, handle) = sequence_fixture(vec![
            response("200 OK", BODY, product),
            response("200 OK", RESOURCE_BODY, product),
            response(
                "200 OK",
                r#"{"cluster_name":"Fixture","status":"green"}"#,
                product,
            ),
            response("200 OK", r#"{"logs-000001":{"mappings":{}}}"#, product),
            response("200 OK", r#"{"fields":{}}"#, product),
            response("200 OK", r#"{"logs-000001":{"settings":{}}}"#, product),
            response("200 OK", r#"{"nodes":{}}"#, product),
            response("200 OK", "[]", product),
            response(
                "200 OK",
                r#"{"license":{"type":"basic","status":"active"}}"#,
                product,
            ),
            response("200 OK", r#"{"features":{}}"#, product),
            response(
                "200 OK",
                r#"{"license":{"type":"enterprise","status":"active"}}"#,
                product,
            ),
        ]);
        let material = EsAuthMaterial::api_key(API_KEY_ID, API_KEY_SECRET).unwrap();
        let trusted = TrustedConnection::new(format!("{endpoint}/proxy/es"), material);
        let profile = trusted.profile();
        let auth = trusted.auth();
        let expected =
            "authorization: ApiKey VnVhQ2ZHY0JDZGJrUW0tZTVhT3g6dWkybHAyYXhUTm1zeWFrdzl0dk5udw==\r\n";
        let client = ReadOnlyClient::new().unwrap();
        client.test(profile, probe(profile), &auth).await.unwrap();
        for (resource, index) in [
            (crate::resources::Resource::Indices, Some("logs-*")),
            (crate::resources::Resource::ClusterHealth, None),
            (crate::resources::Resource::Mapping, Some("logs-*")),
            (crate::resources::Resource::FieldCaps, Some("logs-*")),
            (crate::resources::Resource::IndexSettings, Some("logs-*")),
            (crate::resources::Resource::NodesStats, None),
            (crate::resources::Resource::Shards, None),
        ] {
            let target = index.map(target);
            let plan = crate::resources::resource_plan(profile, resource, target.as_ref())
                .unwrap()
                .authenticate(&auth)
                .unwrap();
            client
                .execute(plan, &mut Cancellation::never())
                .await
                .unwrap();
        }
        for operation in [
            crate::operation::ReadOnlyOperation::License,
            crate::operation::ReadOnlyOperation::FeatureInfo,
            crate::operation::ReadOnlyOperation::LicenseLegacy,
        ] {
            let plan = crate::operation::resource_request(profile, operation, None)
                .unwrap()
                .authenticate(&auth)
                .unwrap();
            client
                .execute(plan, &mut Cancellation::never())
                .await
                .unwrap();
        }
        let mut request_lines = Vec::new();
        while let Ok(request) = received.recv_timeout(Duration::from_secs(1)) {
            assert_eq!(request.to_lowercase().matches("authorization:").count(), 1);
            assert!(request.contains(expected), "{request}");
            request_lines.push(request.lines().next().unwrap().to_owned());
        }
        // Every family kept its own fixed path and the configured base prefix.
        assert_eq!(
            request_lines,
            [
                "GET /proxy/es/ HTTP/1.1",
                "GET /proxy/es/_resolve/index/logs-* HTTP/1.1",
                "GET /proxy/es/_cluster/health HTTP/1.1",
                "GET /proxy/es/logs-*/_mapping HTTP/1.1",
                "GET /proxy/es/logs-*/_field_caps?fields=* HTTP/1.1",
                "GET /proxy/es/logs-*/_settings HTTP/1.1",
                "GET /proxy/es/_nodes/stats/jvm,fs,os,process,thread_pool HTTP/1.1",
                "GET /proxy/es/_cat/shards?format=json&h=index,shard,prirep,state,docs,store,ip,node,unassigned.reason HTTP/1.1",
                "GET /proxy/es/_license?local=true HTTP/1.1",
                "GET /proxy/es/_xpack?categories=features&human=false HTTP/1.1",
                "GET /proxy/es/_license?local=true&accept_enterprise=true HTTP/1.1",
            ]
        );
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn authenticated_search_and_pit_round_trip_keep_bytes_paths_and_header() {
        let product = "X-Elastic-Product: Elasticsearch\r\n";
        let search_response = r#"{"took":1,"timed_out":false,"_shards":{"total":1,"successful":1,"skipped":0,"failed":0},"hits":{"total":{"value":0,"relation":"eq"},"hits":[]}}"#;
        let (endpoint, received, handle) = sequence_fixture(vec![
            response("200 OK", search_response, product),
            response("200 OK", r#"{"id":"pit-fixture-1"}"#, product),
            response("200 OK", search_response, product),
            response("200 OK", r#"{"succeeded":true,"num_freed":1}"#, product),
        ]);
        let material = EsAuthMaterial::bearer("fixture-bearer-token").unwrap();
        let trusted = TrustedConnection::new(format!("{endpoint}/proxy/es"), material);
        let profile = trusted.profile();
        let auth = trusted.auth();
        let client = ReadOnlyClient::new().unwrap();

        // Page one: the validated draft body is posted verbatim.
        let plan = crate::query::search_plan(profile, &target("logs-*"), search_body())
            .unwrap()
            .authenticate(&auth)
            .unwrap();
        client
            .execute(plan, &mut Cancellation::never())
            .await
            .unwrap();

        // Snapshot open, continuation and close.
        let opened_request = crate::query::PitOpenRequest {
            request_id: Uuid::new_v4().to_string(),
            connection_id: profile.id.clone(),
            index: "logs-*".into(),
        };
        let plan = crate::query::pit_open_plan(profile, &opened_request.target().unwrap())
            .unwrap()
            .authenticate(&auth)
            .unwrap();
        let raw = client
            .execute(plan, &mut Cancellation::never())
            .await
            .unwrap();
        let opened = crate::query::PitOpenResponse::new(&opened_request, profile, raw).unwrap();
        assert_eq!(opened.pit_id, "pit-fixture-1");

        let continuation = crate::query::QueryExecuteRequest {
            request_id: Uuid::new_v4().to_string(),
            connection_id: profile.id.clone(),
            index: "logs-*".into(),
            raw_dsl: SEARCH_BODY.into(),
            pit_id: Some(opened.pit_id.clone()),
            search_after: None,
        };
        let prepared = continuation.prepare().unwrap();
        assert!(prepared.continuation);
        let body = prepared.body.clone();
        let plan = crate::query::paginated_search_plan(profile, prepared.body)
            .unwrap()
            .authenticate(&auth)
            .unwrap();
        client
            .execute(plan, &mut Cancellation::never())
            .await
            .unwrap();

        let plan = crate::query::pit_close_plan(profile, &opened.pit_id)
            .unwrap()
            .authenticate(&auth)
            .unwrap();
        client
            .execute(plan, &mut Cancellation::never())
            .await
            .unwrap();

        let expected = "authorization: Bearer fixture-bearer-token\r\n";
        let mut requests = Vec::new();
        while let Ok(request) = received.recv_timeout(Duration::from_secs(1)) {
            requests.push(request);
        }
        assert_eq!(requests.len(), 4);
        for request in &requests {
            assert!(request.contains(expected), "{request}");
        }
        assert!(requests[0].starts_with("POST /proxy/es/logs-*/_search HTTP/1.1\r\n"));
        assert!(requests[0].ends_with(SEARCH_BODY));
        assert!(requests[1].starts_with("POST /proxy/es/logs-*/_pit?keep_alive=1m HTTP/1.1\r\n"));
        assert!(requests[2].starts_with("POST /proxy/es/_search HTTP/1.1\r\n"));
        // The continuation body is the composed one, byte for byte.
        assert!(requests[2].ends_with(std::str::from_utf8(&body).unwrap()));
        assert!(requests[3].starts_with("DELETE /proxy/es/_pit HTTP/1.1\r\n"));
        assert!(requests[3].ends_with(r#"{"id":"pit-fixture-1"}"#));
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn a_bound_plan_is_never_sent_without_its_own_resolved_auth() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let trusted = TrustedConnection::new(
            endpoint.clone(),
            EsAuthMaterial::basic("aladdin", "opensesame").unwrap(),
        );
        let profile = trusted.profile();
        let auth = trusted.auth();
        let client = ReadOnlyClient::new().unwrap();

        // Skipping the authentication step: the secured plan refuses to build or send.
        let plan = crate::query::search_plan(profile, &target("logs-*"), search_body()).unwrap();
        assert_eq!(
            client
                .execute(plan, &mut Cancellation::never())
                .await
                .unwrap_err()
                .code,
            "unsupported"
        );

        // Another connection's resolution is refused even though both connections are bound.
        let other = TrustedConnection::new(
            endpoint.clone(),
            EsAuthMaterial::basic("aladdin", "opensesame").unwrap(),
        );
        assert_ne!(other.profile().id, profile.id);
        let plan = crate::query::search_plan(profile, &target("logs-*"), search_body()).unwrap();
        assert_eq!(
            plan.authenticate(&other.auth()).err().unwrap().code,
            "unsupported"
        );

        // The same connection id with a different endpoint is refused: auth captured for the old
        // target never authenticates a plan for the new one.
        let mut moved = profile.clone();
        moved.endpoint = format!("{endpoint}/other");
        let plan = crate::query::search_plan(&moved, &target("logs-*"), search_body()).unwrap();
        assert_eq!(plan.authenticate(&auth).err().unwrap().code, "unsupported");

        // An unauthenticated plan refuses a header as well, even for the same connection.
        let plain = ConnectionProfile {
            auth_state: ConnectionAuth::none(),
            ..profile.clone()
        };
        let plan = crate::query::search_plan(&plain, &target("logs-*"), search_body()).unwrap();
        assert_eq!(plan.authenticate(&auth).err().unwrap().code, "unsupported");

        // Nothing opened a socket on the configured endpoint.
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[tokio::test]
    async fn authenticated_http_errors_stay_structured_and_never_echo_the_server() {
        let product = "X-Elastic-Product: Elasticsearch\r\n";
        for (status, code) in [
            ("401 Unauthorized", "authenticationFailed"),
            ("403 Forbidden", "serverForbidden"),
        ] {
            let (endpoint, received, handle) = fixture(
                response(status, "reason=fixture-secret-token", product),
                Duration::ZERO,
            );
            let trusted = TrustedConnection::new(
                endpoint,
                EsAuthMaterial::bearer("fixture-secret-token").unwrap(),
            );
            let profile = trusted.profile();
            let auth = trusted.auth();
            let plan = crate::query::search_plan(profile, &target("logs-*"), search_body())
                .unwrap()
                .authenticate(&auth)
                .unwrap();
            let error = ReadOnlyClient::new()
                .unwrap()
                .execute(plan, &mut Cancellation::never())
                .await
                .unwrap_err();
            assert_eq!(error.code, code, "{status}");
            let rendered = serde_json::to_string(&error).unwrap();
            assert!(!rendered.contains("fixture-secret-token"));
            assert!(!rendered.contains("authorization"));
            // The request still carried the credential it was configured with.
            let request = received.recv().unwrap();
            assert!(request.contains("authorization: Bearer fixture-secret-token\r\n"));
            handle.join().unwrap();
        }
    }

    #[tokio::test]
    async fn authenticated_redirects_are_blocked_for_same_and_foreign_targets() {
        let destination = TcpListener::bind("127.0.0.1:0").unwrap();
        destination.set_nonblocking(true).unwrap();
        for location in [
            format!("http://{}/moved", destination.local_addr().unwrap()),
            "/moved".to_owned(),
        ] {
            let (endpoint, received, handle) = fixture(
                response("302 Found", "", &format!("Location: {location}\r\n")),
                Duration::ZERO,
            );
            let trusted = TrustedConnection::new(
                endpoint,
                EsAuthMaterial::basic("aladdin", "opensesame").unwrap(),
            );
            let plan = identity_request(trusted.profile())
                .unwrap()
                .authenticate(&trusted.auth())
                .unwrap();
            let error = ReadOnlyClient::new()
                .unwrap()
                .execute(plan, &mut Cancellation::never())
                .await
                .unwrap_err();
            assert_eq!(error.code, "redirectBlocked", "{location}");
            // The only endpoint that saw the credential is the configured one.
            let request = received.recv().unwrap();
            assert!(request.contains("authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l\r\n"));
            handle.join().unwrap();
        }
        assert_eq!(
            destination.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[tokio::test]
    async fn authenticated_requests_keep_the_response_bound_and_cancellation() {
        // The size bound applies with authentication exactly as without it.
        let (endpoint, _received, handle) = fixture(
            response(
                "200 OK",
                &"x".repeat(RESPONSE_LIMIT + 1),
                "X-Elastic-Product: Elasticsearch\r\n",
            ),
            Duration::ZERO,
        );
        let trusted = TrustedConnection::new(
            endpoint,
            EsAuthMaterial::api_key("fixture-id", "fixture-key").unwrap(),
        );
        let plan = crate::query::search_plan(trusted.profile(), &target("logs-*"), search_body())
            .unwrap()
            .authenticate(&trusted.auth())
            .unwrap();
        assert_eq!(
            ReadOnlyClient::new()
                .unwrap()
                .execute(plan, &mut Cancellation::never())
                .await
                .unwrap_err()
                .code,
            "responseTooLarge"
        );
        handle.join().unwrap();

        // Cancelling an authenticated request drops the future, releases the permit and never
        // waits for the late response.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let (started, started_receiver) = tokio::sync::oneshot::channel();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _request = read_request(&mut stream);
            started.send(()).unwrap();
            thread::sleep(Duration::from_secs(2));
            let _ = stream.write_all(
                response("200 OK", "{}", "X-Elastic-Product: Elasticsearch\r\n").as_bytes(),
            );
        });
        let trusted = TrustedConnection::new(
            endpoint,
            EsAuthMaterial::api_key("fixture-id", "fixture-key").unwrap(),
        );
        let profile = trusted.profile();
        let auth = trusted.auth();
        let request_id = Uuid::new_v4().to_string();
        let registry = crate::read_only::RequestRegistry::default();
        let client = ReadOnlyClient::new().unwrap();
        let mut started_receiver = started_receiver;
        let started_at = Instant::now();
        {
            let mut guard = registry.register(&request_id, profile.id.as_str()).unwrap();
            let plan = crate::query::search_plan(profile, &target("logs-*"), search_body())
                .unwrap()
                .authenticate(&auth)
                .unwrap();
            let executing = client.execute(plan, guard.cancellation());
            tokio::pin!(executing);
            tokio::select! {
                result = &mut executing => panic!("the request must still be in flight: {result:?}"),
                _ = &mut started_receiver => {}
            }
            assert!(registry.cancel(&request_id, profile.id.as_str()));
            assert_eq!(executing.await.unwrap_err().code, "cancelled");
        }
        assert!(
            started_at.elapsed() < Duration::from_secs(1),
            "cancellation must not wait for the cluster to answer"
        );
        assert!(client.permits.try_acquire_many(4).is_ok());
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn a_missing_vault_entry_never_becomes_an_unauthenticated_send() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        // A stored row bound to a reference whose vault entry does not exist, resolved through
        // the same trusted path the commands use.
        let temp = tempfile::tempdir().unwrap();
        let mut database = Database::open(&temp.path().join("escope.sqlite")).unwrap();
        let store = FakeStore::default();
        let id = ConnectionCredentials::new(&mut database, &store)
            .save(
                ConnectionInput {
                    display_name: "Fixture".into(),
                    endpoint: format!("http://{}", listener.local_addr().unwrap()),
                    environment: "development".into(),
                },
                None,
            )
            .unwrap()
            .profile
            .id;
        database
            .bind_credential(&id, AuthKind::Basic, &CredentialRef::generate())
            .unwrap();
        let snapshot = database.transport_snapshot(&id).unwrap();
        assert_eq!(
            crate::connection_auth::resolve(&snapshot, &store)
                .unwrap_err()
                .code,
            "credentialNotFound"
        );
        // There is no fallback path: the command fails before a socket is opened.
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[tokio::test]
    async fn authentication_is_isolated_between_connections() {
        let product = "X-Elastic-Product: Elasticsearch\r\n";
        let (endpoint_a, received_a, handle_a) =
            fixture(response("200 OK", BODY, product), Duration::ZERO);
        let (endpoint_b, received_b, handle_b) =
            fixture(response("200 OK", BODY, product), Duration::ZERO);
        let trusted_a = TrustedConnection::new(
            endpoint_a,
            EsAuthMaterial::bearer("fixture-token-a").unwrap(),
        );
        let trusted_b = TrustedConnection::new(
            endpoint_b,
            EsAuthMaterial::api_key("fixture-id-b", "fixture-key-b").unwrap(),
        );
        let client = ReadOnlyClient::new().unwrap();
        client
            .test(
                trusted_a.profile(),
                probe(trusted_a.profile()),
                &trusted_a.auth(),
            )
            .await
            .unwrap();
        client
            .test(
                trusted_b.profile(),
                probe(trusted_b.profile()),
                &trusted_b.auth(),
            )
            .await
            .unwrap();
        let request_a = received_a.recv().unwrap();
        let request_b = received_b.recv().unwrap();
        assert!(request_a.contains("authorization: Bearer fixture-token-a\r\n"));
        assert!(!request_a.contains("fixture-token-b"));
        assert!(!request_a.to_lowercase().contains("apikey"));
        assert!(
            request_b.contains("authorization: ApiKey Zml4dHVyZS1pZC1iOmZpeHR1cmUta2V5LWI=\r\n")
        );
        assert!(!request_b.contains("fixture-token-a"));
        handle_a.join().unwrap();
        handle_b.join().unwrap();
    }

    #[tokio::test]
    async fn the_trusted_resolver_drives_a_loopback_search_request() {
        // The full command path over a temporary database and an injected vault: stored row →
        // trusted snapshot → real resolution → plan binding → loopback request.
        let product = "X-Elastic-Product: Elasticsearch\r\n";
        let search_response = r#"{"took":1,"timed_out":false,"_shards":{"total":1,"successful":1,"skipped":0,"failed":0},"hits":{"total":{"value":0,"relation":"eq"},"hits":[]}}"#;
        let (endpoint, received, handle) =
            fixture(response("200 OK", search_response, product), Duration::ZERO);
        let trusted = TrustedConnection::new(
            format!("{endpoint}/proxy/es"),
            EsAuthMaterial::api_key(API_KEY_ID, API_KEY_SECRET).unwrap(),
        );
        let plan = crate::query::search_plan(trusted.profile(), &target("logs-*"), search_body())
            .unwrap()
            .authenticate(&trusted.auth())
            .unwrap();
        ReadOnlyClient::new()
            .unwrap()
            .execute(plan, &mut Cancellation::never())
            .await
            .unwrap();
        let request = received.recv().unwrap();
        assert!(request.starts_with("POST /proxy/es/logs-*/_search HTTP/1.1\r\n"));
        assert!(request.contains(
            "authorization: ApiKey VnVhQ2ZHY0JDZGJrUW0tZTVhT3g6dWkybHAyYXhUTm1zeWFrdzl0dk5udw==\r\n"
        ));
        assert!(request.ends_with(SEARCH_BODY));
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn a_stored_connection_without_a_credential_sends_no_authorization() {
        let product = "X-Elastic-Product: Elasticsearch\r\n";
        let (endpoint, received, handle) =
            fixture(response("200 OK", BODY, product), Duration::ZERO);
        let trusted = TrustedConnection::plain(endpoint);
        let identity = ReadOnlyClient::new()
            .unwrap()
            .test(trusted.profile(), probe(trusted.profile()), &trusted.auth())
            .await
            .unwrap();
        assert_eq!(identity.cluster_uuid, "fixture-uuid");
        let request = received.recv().unwrap();
        assert!(!request.to_lowercase().contains("authorization:"));
        handle.join().unwrap();
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
                    .test(&profile, probe(&profile), &no_auth(&profile))
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
            .test(&profile, probe(&profile), &no_auth(&profile))
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
                .test(&profile, probe(&profile), &no_auth(&profile))
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
            .test(&profile, probe(&profile), &no_auth(&profile))
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
            .test(&profile, probe(&profile), &no_auth(&profile))
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
    /// Fixture API Key components; `base64("id:secret")` is asserted literally in the wire tests.
    const API_KEY_ID: &str = "VuaCfGcBCdbkQm-e5aOx";
    const API_KEY_SECRET: &str = "ui2lp2axTNmsyakw9tvNnw";

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
