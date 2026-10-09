//! Explicit, bounded diagnostics. Their result is never an authorization gate for search.

mod cache;
mod capabilities;

use crate::connection::ReadOnlyClient;
use crate::connection_auth::ResolvedAuth;
use crate::credentials::SystemCredentialStore;
use crate::error::AppError;
use crate::operation::{
    identity_request, privileges_request, resource_request, IndexTarget, ReadOnlyOperation,
    RequestPlan,
};
use crate::read_only::Cancellation;
use crate::storage::TransportSnapshot;
use crate::{with_database, NetworkState, RequestState, StorageState};
pub(crate) use cache::AccessCache;
use cache::{Reports, Ticket, REPORT_TTL};
use capabilities::{Capabilities, FeatureInfo, LicenseInfo, ServerInfo};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::State;
use uuid::Uuid;

const INSPECTION_BUDGET: Duration = Duration::from_secs(30);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccessRequest {
    request_id: String,
    connection_id: String,
    index: Option<String>,
    #[serde(default)]
    refresh: bool,
}

impl AccessRequest {
    fn validate(&self) -> Result<Option<IndexTarget>, AppError> {
        Uuid::parse_str(&self.request_id).map_err(|_| AppError::new("invalidInput"))?;
        Uuid::parse_str(&self.connection_id).map_err(|_| AppError::new("invalidInput"))?;
        self.index.as_deref().map(IndexTarget::parse).transpose()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum AccessStatus {
    Available,
    Denied,
    Unknown,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Feedback {
    status: AccessStatus,
    code: Option<&'static str>,
}

impl Feedback {
    fn status(status: AccessStatus) -> Self {
        Self { status, code: None }
    }

    fn failure(error: AppError) -> Result<Self, AppError> {
        if error.code == "cancelled" {
            return Err(error);
        }
        let status = match error.code {
            "authenticationFailed" | "serverForbidden" => AccessStatus::Denied,
            "unsupported" => AccessStatus::Unsupported,
            // In particular, GET /_license can return a transient 404 during cluster startup.
            _ => AccessStatus::Unknown,
        };
        Ok(Self {
            status,
            code: Some(error.code),
        })
    }

    fn permission(value: Option<bool>) -> Self {
        Self::status(match value {
            Some(true) => AccessStatus::Available,
            Some(false) => AccessStatus::Denied,
            None => AccessStatus::Unknown,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CallerIdentity {
    #[serde(flatten)]
    feedback: Feedback,
    username: Option<String>,
    roles: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Privileges {
    monitor: Feedback,
    read: Feedback,
    view_index_metadata: Feedback,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportFreshness {
    source: &'static str,
    checked_at_ms: u64,
    age_ms: u64,
    ttl_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessResponse {
    request_id: String,
    connection_id: String,
    endpoint: String,
    index: Option<String>,
    identity: CallerIdentity,
    privileges: Privileges,
    server: ServerInfo,
    license: LicenseInfo,
    feature_report: FeatureInfo,
    capabilities: Capabilities,
    checked_at_ms: u64,
    reports: ReportFreshness,
    operation_verification: &'static str,
}

#[derive(Deserialize)]
struct IdentityBody {
    username: String,
    roles: Vec<String>,
    enabled: bool,
}

#[derive(Deserialize)]
struct PrivilegesBody {
    username: String,
    cluster: BTreeMap<String, bool>,
    index: BTreeMap<String, BTreeMap<String, bool>>,
}

fn display_text(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}

fn caller(bytes: &[u8]) -> Result<CallerIdentity, AppError> {
    let body: IdentityBody =
        serde_json::from_slice(bytes).map_err(|_| AppError::new("invalidResponse"))?;
    if !display_text(&body.username, 256)
        || body.roles.len() > 128
        || body.roles.iter().any(|role| !display_text(role, 256))
    {
        return Err(AppError::new("invalidResponse"));
    }
    Ok(CallerIdentity {
        feedback: Feedback::permission(Some(body.enabled)),
        username: Some(body.username),
        roles: body.roles,
    })
}

fn index_privilege(
    index: &BTreeMap<String, BTreeMap<String, bool>>,
    target: Option<&IndexTarget>,
    privilege: &str,
) -> Feedback {
    let Some(target) = target else {
        return Feedback::permission(None);
    };
    let mut unknown = false;
    for name in target.as_str().split(',') {
        match index.get(name).and_then(|entry| entry.get(privilege)) {
            Some(false) => return Feedback::permission(Some(false)),
            None => unknown = true,
            Some(true) => {}
        }
    }
    Feedback::permission(if unknown { None } else { Some(true) })
}

fn privileges(
    bytes: &[u8],
    target: Option<&IndexTarget>,
    identity: &CallerIdentity,
) -> Result<Privileges, AppError> {
    let body: PrivilegesBody =
        serde_json::from_slice(bytes).map_err(|_| AppError::new("invalidResponse"))?;
    if !display_text(&body.username, 256)
        || identity
            .username
            .as_ref()
            .is_some_and(|name| name != &body.username)
        || body.index.len() > 64
    {
        return Err(AppError::new("invalidResponse"));
    }
    Ok(Privileges {
        monitor: Feedback::permission(body.cluster.get("monitor").copied()),
        read: index_privilege(&body.index, target, "read"),
        view_index_metadata: index_privilege(&body.index, target, "view_index_metadata"),
    })
}

fn timestamp_ms() -> Result<u64, AppError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .ok_or_else(|| AppError::new("invalidResponse"))
}

async fn read(
    client: &ReadOnlyClient,
    plan: RequestPlan,
    cancel: &mut Cancellation,
    deadline: tokio::time::Instant,
) -> Result<Vec<u8>, AppError> {
    if cancel.is_cancelled() {
        return Err(AppError::new("cancelled"));
    }
    if tokio::time::Instant::now() >= deadline {
        return Err(AppError::new("timeout"));
    }
    let result = tokio::time::timeout_at(deadline, client.execute(plan, cancel))
        .await
        .unwrap_or_else(|_| Err(AppError::new("timeout")));
    if cancel.is_cancelled() {
        return Err(AppError::new("cancelled"));
    }
    result
}

struct Inspection {
    response: AccessResponse,
    reports: Reports,
    cacheable: bool,
}

impl Inspection {
    fn complete(self, cache: &AccessCache, ticket: &Ticket) -> Result<AccessResponse, AppError> {
        let entry = self
            .response
            .server
            .fingerprint
            .as_ref()
            .filter(|_| self.cacheable)
            .map(|fingerprint| (fingerprint.clone(), self.reports));
        cache.complete(ticket, entry)?;
        Ok(self.response)
    }
}

async fn inspect(
    request: &AccessRequest,
    snapshot: &TransportSnapshot,
    auth: &ResolvedAuth,
    client: &ReadOnlyClient,
    cancel: &mut Cancellation,
    cache: &AccessCache,
    ticket: &Ticket,
) -> Result<Inspection, AppError> {
    let profile = snapshot.profile();
    let target = request.validate()?;
    let deadline = tokio::time::Instant::now() + INSPECTION_BUDGET;
    let identity_plan =
        resource_request(profile, ReadOnlyOperation::Authenticate, None)?.authenticate(auth)?;
    let identity = match read(client, identity_plan, cancel, deadline)
        .await
        .and_then(|body| caller(&body))
    {
        Ok(identity) => identity,
        Err(error) => CallerIdentity {
            feedback: Feedback::failure(error)?,
            username: None,
            roles: Vec::new(),
        },
    };
    let privilege_plan = privileges_request(profile, target.as_ref())?.authenticate(auth)?;
    let privileges = match read(client, privilege_plan, cancel, deadline)
        .await
        .and_then(|body| privileges(&body, target.as_ref(), &identity))
    {
        Ok(privileges) => privileges,
        Err(error) => {
            let feedback = Feedback::failure(error)?;
            Privileges {
                monitor: feedback,
                read: if target.is_some() {
                    feedback
                } else {
                    Feedback::permission(None)
                },
                view_index_metadata: if target.is_some() {
                    feedback
                } else {
                    Feedback::permission(None)
                },
            }
        }
    };
    // Root requires monitor on some deployments. Its failure never erases granted index access.
    let server = match read(
        client,
        identity_request(profile)?.authenticate(auth)?,
        cancel,
        deadline,
    )
    .await
    .and_then(|body| ServerInfo::parse(&body))
    {
        Ok(server) => server,
        Err(error) => ServerInfo::failed(error)?,
    };
    let cache_allowed = identity.feedback.status == AccessStatus::Available
        && privileges.monitor.status == AccessStatus::Available;
    let cached = cache.load(
        ticket,
        server.fingerprint.as_ref(),
        cache_allowed,
        Instant::now(),
    );
    let source = if cached.is_some() { "cache" } else { "live" };
    let reports = match cached {
        Some(reports) => reports,
        None => {
            let observed_at = Instant::now();
            let checked_at_ms = timestamp_ms()?;
            let license = match read(
                client,
                resource_request(
                    profile,
                    if server.requires_enterprise_parameter() {
                        ReadOnlyOperation::LicenseLegacy
                    } else {
                        ReadOnlyOperation::License
                    },
                    None,
                )?
                .authenticate(auth)?,
                cancel,
                deadline,
            )
            .await
            .and_then(|body| LicenseInfo::parse(&body))
            {
                Ok(license) => license,
                Err(error) => LicenseInfo::failed(error)?,
            };
            let features = match read(
                client,
                resource_request(profile, ReadOnlyOperation::FeatureInfo, None)?
                    .authenticate(auth)?,
                cancel,
                deadline,
            )
            .await
            .and_then(|body| FeatureInfo::parse(&body))
            {
                Ok(features) => features,
                Err(error) => FeatureInfo::failed(error)?,
            };
            Reports {
                license,
                features,
                observed_at,
                checked_at_ms,
            }
        }
    };
    if cancel.is_cancelled() {
        return Err(AppError::new("cancelled"));
    }
    let cacheable = cache_allowed
        && reports.license.feedback.status == AccessStatus::Available
        && reports.features.feedback.status == AccessStatus::Available;
    let response = AccessResponse {
        request_id: request.request_id.clone(),
        connection_id: request.connection_id.clone(),
        endpoint: profile.endpoint.clone(),
        index: target.as_ref().map(|target| target.as_str().to_owned()),
        identity,
        privileges,
        capabilities: Capabilities::from_reports(&server, &reports.features),
        server,
        license: reports.license.clone(),
        feature_report: reports.features.clone(),
        checked_at_ms: timestamp_ms()?,
        reports: ReportFreshness {
            source,
            checked_at_ms: reports.checked_at_ms,
            age_ms: reports
                .observed_at
                .elapsed()
                .as_millis()
                .min(u64::MAX as u128) as u64,
            ttl_ms: REPORT_TTL.as_millis() as u64,
        },
        operation_verification: "notRun",
    };
    Ok(Inspection {
        response,
        reports,
        cacheable,
    })
}

#[tauri::command]
pub async fn connection_access(
    state: State<'_, StorageState>,
    network: State<'_, NetworkState>,
    requests: State<'_, RequestState>,
    cache: State<'_, AccessCache>,
    request: AccessRequest,
) -> Result<AccessResponse, AppError> {
    request.validate()?;
    let result = async {
        let mut guard = requests
            .0
            .register(&request.request_id, &request.connection_id)?;
        let snapshot = with_database(&state, |db| db.transport_snapshot(&request.connection_id))?;
        let ticket = cache.begin(&snapshot, request.refresh)?;
        let result = async {
            // Even a cache hit must resolve the current credential and recheck identity/permissions.
            let auth = crate::connection_auth::resolve(&snapshot, &SystemCredentialStore::new())?;
            let client = network
                .0
                .as_ref()
                .map_err(Clone::clone)?
                .for_snapshot(&snapshot)?;
            let inspection = inspect(
                &request,
                &snapshot,
                &auth,
                &client,
                guard.cancellation(),
                &cache,
                &ticket,
            )
            .await?;
            with_database(&state, |db| {
                let current = db.transport_snapshot(&request.connection_id)?;
                if !ticket.matches(&current)? {
                    return Err(AppError::new("diagnosticsStale"));
                }
                if guard.cancellation().is_cancelled() {
                    return Err(AppError::new("cancelled"));
                }
                inspection.complete(&cache, &ticket)
            })
        }
        .await;
        if result.is_err() {
            cache.discard(&ticket);
        }
        result
    }
    .await;
    result.map_err(|mut error: AppError| {
        error.request_id = Some(request.request_id);
        error
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::{CredentialError, CredentialRef, CredentialStore, Secret};
    use crate::storage::{ConnectionInput, Database};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    struct EmptyStore;
    impl CredentialStore for EmptyStore {
        fn get(&self, _: &CredentialRef) -> Result<Secret, CredentialError> {
            panic!("no credential expected")
        }
        fn set(&self, _: &CredentialRef, _: &Secret) -> Result<(), CredentialError> {
            panic!("no credential expected")
        }
        fn delete(&self, _: &CredentialRef) -> Result<(), CredentialError> {
            panic!("no credential expected")
        }
    }

    fn fixture(
        replies: Vec<(&'static str, &'static str)>,
    ) -> (String, mpsc::Receiver<String>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}/base", listener.local_addr().unwrap());
        let (send, recv) = mpsc::channel();
        let server = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(3);
            for (status, body) in replies {
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error)
                            if error.kind() == std::io::ErrorKind::WouldBlock
                                && Instant::now() < deadline =>
                        {
                            thread::sleep(Duration::from_millis(2));
                        }
                        Err(error) => panic!("fixture accept did not complete: {:?}", error.kind()),
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0u8; 4096];
                loop {
                    let count = stream.read(&mut buffer).unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&buffer[..count]);
                    assert!(bytes.len() <= 32768);
                    if let Some(position) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..position]);
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|s| s.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= position + 4 + length {
                            break;
                        }
                    }
                }
                send.send(String::from_utf8(bytes).unwrap()).unwrap();
                write!(stream, "HTTP/1.1 {status}\r\nx-elastic-product: Elasticsearch\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        (endpoint, recv, server)
    }

    #[test]
    fn request_contract_rejects_proxy_fields_and_invalid_targets() {
        let id = Uuid::new_v4().to_string();
        let base =
            serde_json::json!({ "requestId": id, "connectionId": id, "index": "orders-*,orders" });
        assert!(serde_json::from_value::<AccessRequest>(base.clone())
            .unwrap()
            .validate()
            .is_ok());
        for field in ["url", "method", "headers", "body", "credentialRef"] {
            let mut input = base.clone();
            input[field] = serde_json::json!("not-allowed");
            assert!(serde_json::from_value::<AccessRequest>(input).is_err());
        }
        for target in [
            "../_security/user",
            "orders?x=1",
            "_all",
            "",
            "https://other.test",
        ] {
            let mut input = base.clone();
            input["index"] = serde_json::json!(target);
            assert!(serde_json::from_value::<AccessRequest>(input)
                .unwrap()
                .validate()
                .is_err());
        }
    }

    #[test]
    fn unavailable_denied_unknown_and_missing_privileges_stay_distinct() {
        assert_eq!(
            Feedback::failure(AppError::new("serverForbidden"))
                .unwrap()
                .status,
            AccessStatus::Denied
        );
        assert_eq!(
            Feedback::failure(AppError::new("notFound")).unwrap().status,
            AccessStatus::Unknown
        );
        assert_eq!(
            Feedback::failure(AppError::new("unsupported"))
                .unwrap()
                .status,
            AccessStatus::Unsupported
        );
        assert_eq!(
            Feedback::failure(AppError::new("timeout")).unwrap().status,
            AccessStatus::Unknown
        );
        assert_eq!(
            Feedback::failure(AppError::new("cancelled"))
                .unwrap_err()
                .code,
            "cancelled"
        );
        let identity =
            caller(br#"{"username":"reader","roles":["read_orders"],"enabled":true}"#).unwrap();
        let target = IndexTarget::parse("orders,archive").unwrap();
        let p = privileges(
            br#"{"username":"reader","cluster":{"monitor":false},"index":{"orders":{"read":true,"view_index_metadata":false}}}"#,
            Some(&target), &identity,
        ).unwrap();
        assert_eq!(p.monitor.status, AccessStatus::Denied);
        assert_eq!(p.read.status, AccessStatus::Unknown);
        assert_eq!(p.view_index_metadata.status, AccessStatus::Denied);
        assert!(privileges(
            br#"{"username":"other","cluster":{},"index":{}}"#,
            None,
            &identity
        )
        .is_err());
        assert!(caller(br#"{"username":"","roles":[],"enabled":true}"#).is_err());
    }

    #[test]
    fn refresh_is_a_boolean_and_does_not_accept_a_frontend_cache_key() {
        let id = Uuid::new_v4().to_string();
        for (field, value) in [
            ("refresh", serde_json::json!("true")),
            ("cacheKey", serde_json::json!("forged")),
            ("capabilities", serde_json::json!({"search":"available"})),
            ("expectedVersion", serde_json::json!("8.16.0")),
        ] {
            let mut input = serde_json::json!({"requestId":id,"connectionId":id});
            input[field] = value;
            assert!(serde_json::from_value::<AccessRequest>(input).is_err());
        }
    }

    #[tokio::test]
    async fn cancelled_diagnostics_send_neither_identity_nor_followup_reads() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let mut database = Database::open(&temp.path().join("cancelled.sqlite")).unwrap();
        let profile = database
            .save_connection(
                ConnectionInput {
                    display_name: "Cancelled fixture".into(),
                    endpoint: format!("http://{}", listener.local_addr().unwrap()),
                    environment: "development".into(),
                },
                None,
            )
            .unwrap()
            .profile;
        let snapshot = database.transport_snapshot(&profile.id).unwrap();
        let auth = crate::connection_auth::resolve(&snapshot, &EmptyStore).unwrap();
        let request = AccessRequest {
            request_id: Uuid::new_v4().to_string(),
            connection_id: profile.id.clone(),
            index: None,
            refresh: false,
        };
        let registry = crate::read_only::RequestRegistry::default();
        let mut guard = registry
            .register(&request.request_id, &request.connection_id)
            .unwrap();
        registry.cancel(&request.request_id, &request.connection_id);
        let cache = AccessCache::default();
        let ticket = cache.begin(&snapshot, false).unwrap();
        let result = inspect(
            &request,
            &snapshot,
            &auth,
            &ReadOnlyClient::new().unwrap(),
            guard.cancellation(),
            &cache,
            &ticket,
        )
        .await;
        assert!(matches!(result, Err(error) if error.code == "cancelled"));
        assert!(
            matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
        );
    }

    #[tokio::test]
    async fn no_monitor_does_not_hide_granted_index_access_and_wire_is_fixed() {
        let (endpoint, recv, server) = fixture(vec![
            (
                "200 OK",
                r#"{"username":"reader","roles":["orders_reader"],"enabled":true}"#,
            ),
            (
                "200 OK",
                r#"{"username":"reader","cluster":{"monitor":false},"index":{"orders-*":{"read":true,"view_index_metadata":true}}}"#,
            ),
            ("403 Forbidden", "{}"),
            ("403 Forbidden", "{}"),
            ("404 Not Found", "{}"),
        ]);
        let temp = tempfile::tempdir().unwrap();
        let mut database = Database::open(&temp.path().join("access.sqlite")).unwrap();
        let profile = database
            .save_connection(
                ConnectionInput {
                    display_name: "Access fixture".into(),
                    endpoint,
                    environment: "development".into(),
                },
                None,
            )
            .unwrap()
            .profile;
        let snapshot = database.transport_snapshot(&profile.id).unwrap();
        let auth = crate::connection_auth::resolve(&snapshot, &EmptyStore).unwrap();
        let request = AccessRequest {
            request_id: Uuid::new_v4().to_string(),
            connection_id: profile.id.clone(),
            index: Some("orders-*".into()),
            refresh: false,
        };
        let cache = AccessCache::default();
        let ticket = cache.begin(&snapshot, false).unwrap();
        let response = inspect(
            &request,
            &snapshot,
            &auth,
            &ReadOnlyClient::new().unwrap(),
            &mut Cancellation::never(),
            &cache,
            &ticket,
        )
        .await
        .unwrap()
        .complete(&cache, &ticket)
        .unwrap();
        assert_eq!(response.identity.username.as_deref(), Some("reader"));
        assert_eq!(response.privileges.monitor.status, AccessStatus::Denied);
        assert_eq!(response.privileges.read.status, AccessStatus::Available);
        assert_eq!(response.server.feedback.status, AccessStatus::Denied);
        assert_eq!(response.license.feedback.status, AccessStatus::Denied);
        assert_eq!(
            response.feature_report.feedback.status,
            AccessStatus::Unknown
        );
        assert_eq!(
            response.capabilities.search.status,
            capabilities::CapabilityStatus::Unknown
        );
        server.join().unwrap();
        let wire: Vec<_> = recv.try_iter().collect();
        assert!(wire[0].starts_with("GET /base/_security/_authenticate "));
        assert!(wire[1].starts_with("POST /base/_security/user/_has_privileges "));
        assert!(wire[2].starts_with("GET /base/ "));
        assert!(wire[3].starts_with("GET /base/_license?local=true "));
        assert!(wire[4].starts_with("GET /base/_xpack?categories=features&human=false "));
        let body = wire[1].split("\r\n\r\n").nth(1).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(body).unwrap(),
            serde_json::json!({
                "cluster":["monitor"],"index":[{"names":["orders-*"],"privileges":["read","view_index_metadata"]}]
            })
        );
    }

    #[tokio::test]
    async fn only_reports_are_cached_and_forced_failures_do_not_restore_old_success() {
        const CALLER: &str = r#"{"username":"reader","roles":["orders_reader"],"enabled":true}"#;
        const PRIVILEGES: &str = r#"{"username":"reader","cluster":{"monitor":true},"index":{"orders-*":{"read":true,"view_index_metadata":true}}}"#;
        const OTHER_TARGET: &str = r#"{"username":"reader","cluster":{"monitor":true},"index":{"archive-*":{"read":false,"view_index_metadata":false}}}"#;
        const ROOT: &str = r#"{"cluster_uuid":"fixture-cluster","version":{"number":"7.17.25","build_flavor":"default"}}"#;
        const LICENSE: &str = r#"{"license":{"type":"basic","status":"active"}}"#;
        const FEATURES: &str = r#"{"features":{"graph":{"available":false,"enabled":true}}}"#;
        let (endpoint, recv, server) = fixture(vec![
            ("200 OK", CALLER),
            ("200 OK", PRIVILEGES),
            ("200 OK", ROOT),
            ("200 OK", LICENSE),
            ("200 OK", FEATURES),
            ("200 OK", CALLER),
            ("200 OK", OTHER_TARGET),
            ("200 OK", ROOT),
            ("200 OK", CALLER),
            ("200 OK", PRIVILEGES),
            ("200 OK", ROOT),
            ("403 Forbidden", "{}"),
            ("404 Not Found", "{}"),
        ]);
        let mut database = Database::open(std::path::Path::new(":memory:")).unwrap();
        let id = database
            .save_connection(
                ConnectionInput {
                    display_name: "Cache fixture".into(),
                    endpoint,
                    environment: "development".into(),
                },
                None,
            )
            .unwrap()
            .profile
            .id;
        let snapshot = database.transport_snapshot(&id).unwrap();
        let auth = crate::connection_auth::resolve(&snapshot, &EmptyStore).unwrap();
        let cache = AccessCache::default();
        let client = ReadOnlyClient::new().unwrap();
        let mut observed = None;
        for (index, refresh, expected_source) in [
            ("orders-*", false, "live"),
            ("archive-*", false, "cache"),
            ("orders-*", true, "live"),
        ] {
            let request = AccessRequest {
                request_id: Uuid::new_v4().to_string(),
                connection_id: id.clone(),
                index: Some(index.into()),
                refresh,
            };
            let ticket = cache.begin(&snapshot, refresh).unwrap();
            let response = inspect(
                &request,
                &snapshot,
                &auth,
                &client,
                &mut Cancellation::never(),
                &cache,
                &ticket,
            )
            .await
            .unwrap()
            .complete(&cache, &ticket)
            .unwrap();
            assert_eq!(response.reports.source, expected_source);
            if expected_source == "cache" {
                assert_eq!(Some(response.reports.checked_at_ms), observed);
                assert_eq!(response.privileges.read.status, AccessStatus::Denied);
            } else if !refresh {
                observed = Some(response.reports.checked_at_ms);
            } else {
                assert_eq!(response.license.feedback.status, AccessStatus::Denied);
                assert_eq!(response.privileges.read.status, AccessStatus::Available);
                assert!(cache
                    .load(
                        &ticket,
                        response.server.fingerprint.as_ref(),
                        true,
                        Instant::now()
                    )
                    .is_none());
            }
        }
        server.join().unwrap();
        let wire: Vec<_> = recv.try_iter().collect();
        assert_eq!(wire.len(), 13);
        assert!(wire[5].starts_with("GET /base/_security/_authenticate "));
        assert!(wire[6].starts_with("POST /base/_security/user/_has_privileges "));
        assert!(wire[6].contains("archive-*"));
        assert!(wire[7].starts_with("GET /base/ "));
        assert!(wire[3].starts_with("GET /base/_license?local=true&accept_enterprise=true "));
        assert_eq!(
            wire.iter()
                .filter(|request| request.starts_with("GET /base/_license?"))
                .count(),
            2
        );
        assert_eq!(
            wire.iter()
                .filter(|request| request.starts_with("GET /base/_xpack?"))
                .count(),
            2
        );
        assert!(!wire
            .iter()
            .any(|request| request.contains("Authorization:")));
    }

    #[tokio::test]
    async fn exhausted_inspection_budget_starts_no_more_network_requests() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut database = Database::open(std::path::Path::new(":memory:")).unwrap();
        let profile = database
            .save_connection(
                ConnectionInput {
                    display_name: "Budget fixture".into(),
                    endpoint: format!("http://{}", listener.local_addr().unwrap()),
                    environment: "development".into(),
                },
                None,
            )
            .unwrap()
            .profile;
        let plan = identity_request(&profile).unwrap();
        let error = read(
            &ReadOnlyClient::new().unwrap(),
            plan,
            &mut Cancellation::never(),
            tokio::time::Instant::now(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "timeout");
        assert!(
            matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
        );
    }

    #[test]
    fn canonical_ipc_fixture_matches_the_frontend_without_raw_response_fields() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/connection-access-v1.json"
        ))
        .unwrap();
        let identity =
            caller(br#"{"username":"reader","roles":["orders_reader"],"enabled":true}"#).unwrap();
        let target = IndexTarget::parse("orders-*").unwrap();
        let privileges = privileges(br#"{"username":"reader","cluster":{"monitor":false},"index":{"orders-*":{"read":true,"view_index_metadata":true}}}"#,
            Some(&target), &identity).unwrap();
        let server = ServerInfo::parse(br#"{"cluster_uuid":"fixture-cluster","version":{"number":"7.17.25","build_flavor":"default"}}"#).unwrap();
        let license = LicenseInfo::parse(br#"{"license":{"type":"basic","status":"active","uid":"excluded","issued_to":"excluded"}} "#).unwrap();
        let features = FeatureInfo::parse(br#"{"features":{"sql":{"available":true,"enabled":true},"eql":{"available":true,"enabled":false},"graph":{"available":false,"enabled":true}}}"#).unwrap();
        let response = AccessResponse {
            request_id: "f3228da9-8e0a-4ab8-9c3b-d633c60ea8d2".into(),
            connection_id: "1ed43afe-c318-4fe6-8cce-aa2a82be27be".into(),
            endpoint: "https://es.test".into(),
            index: Some("orders-*".into()),
            identity,
            privileges,
            capabilities: Capabilities::from_reports(&server, &features),
            server,
            license,
            feature_report: features,
            checked_at_ms: 1_700_000_000_003,
            reports: ReportFreshness {
                source: "live",
                checked_at_ms: 1_700_000_000_000,
                age_ms: 3,
                ttl_ms: 60_000,
            },
            operation_verification: "notRun",
        };
        assert_eq!(serde_json::to_value(response).unwrap(), fixture);
    }
}
