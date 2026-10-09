//! Explicit, bounded diagnostics. Their result is never an authorization gate for search.

use crate::connection::ReadOnlyClient;
use crate::connection_auth::ResolvedAuth;
use crate::error::AppError;
use crate::operation::{
    identity_request, privileges_request, resource_request, IndexTarget, ReadOnlyOperation,
};
use crate::read_only::Cancellation;
use crate::storage::ConnectionProfile;
use crate::{connection_for_request, NetworkState, RequestState, StorageState};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::State;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccessRequest {
    request_id: String,
    connection_id: String,
    index: Option<String>,
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
            "notFound" | "unsupported" => AccessStatus::Unsupported,
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
struct Capabilities {
    search: Feedback,
    pit: Feedback,
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
    capabilities: Capabilities,
    version: Option<String>,
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

#[derive(Deserialize)]
struct RootBody {
    version: VersionBody,
}

#[derive(Deserialize)]
struct VersionBody {
    number: String,
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

fn capabilities(bytes: &[u8]) -> Result<(Capabilities, String), AppError> {
    let body: RootBody =
        serde_json::from_slice(bytes).map_err(|_| AppError::new("invalidResponse"))?;
    if !display_text(&body.version.number, 64) {
        return Err(AppError::new("invalidResponse"));
    }
    let parts: Vec<_> = body.version.number.split('.').collect();
    let parsed = if parts.len() == 3 {
        parts[0]
            .parse::<u32>()
            .ok()
            .zip(parts[1].parse::<u32>().ok())
            .filter(|_| parts[2].parse::<u32>().is_ok())
    } else {
        None
    };
    let (search, pit) = match parsed {
        Some((7..=9, _)) => (
            AccessStatus::Available,
            if parsed.is_some_and(|(major, minor)| major == 7 && minor < 10) {
                AccessStatus::Unsupported
            } else {
                AccessStatus::Available
            },
        ),
        _ => (AccessStatus::Unknown, AccessStatus::Unknown),
    };
    Ok((
        Capabilities {
            search: Feedback::status(search),
            pit: Feedback::status(pit),
        },
        body.version.number,
    ))
}

async fn inspect(
    request: &AccessRequest,
    profile: &ConnectionProfile,
    auth: &ResolvedAuth,
    client: &ReadOnlyClient,
    target: Option<&IndexTarget>,
    cancel: &mut Cancellation,
) -> Result<AccessResponse, AppError> {
    let identity_plan =
        resource_request(profile, ReadOnlyOperation::Authenticate, None)?.authenticate(auth)?;
    let identity = match client
        .execute(identity_plan, cancel)
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
    let privilege_plan = privileges_request(profile, target)?.authenticate(auth)?;
    let privileges = match client
        .execute(privilege_plan, cancel)
        .await
        .and_then(|body| privileges(&body, target, &identity))
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
    let (capabilities, version) = match client
        .execute(identity_request(profile)?.authenticate(auth)?, cancel)
        .await
        .and_then(|body| capabilities(&body))
    {
        Ok((capabilities, version)) => (capabilities, Some(version)),
        Err(error) => {
            let mut feedback = Feedback::failure(error)?;
            if feedback.status == AccessStatus::Denied {
                feedback.status = AccessStatus::Unknown;
            }
            (
                Capabilities {
                    search: feedback,
                    pit: feedback,
                },
                None,
            )
        }
    };
    Ok(AccessResponse {
        request_id: request.request_id.clone(),
        connection_id: request.connection_id.clone(),
        endpoint: profile.endpoint.clone(),
        index: target.map(|target| target.as_str().to_owned()),
        identity,
        privileges,
        capabilities,
        version,
    })
}

#[tauri::command]
pub async fn connection_access(
    state: State<'_, StorageState>,
    network: State<'_, NetworkState>,
    requests: State<'_, RequestState>,
    request: AccessRequest,
) -> Result<AccessResponse, AppError> {
    let target = request.validate()?;
    let result = async {
        let mut guard = requests
            .0
            .register(&request.request_id, &request.connection_id)?;
        let (snapshot, auth) = connection_for_request(&state, &request.connection_id)?;
        let client = network
            .0
            .as_ref()
            .map_err(Clone::clone)?
            .for_snapshot(&snapshot)?;
        inspect(
            &request,
            snapshot.profile(),
            &auth,
            &client,
            target.as_ref(),
            guard.cancellation(),
        )
        .await
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
    fn pit_version_feedback_is_not_a_license_or_permission_claim() {
        for (version, status) in [
            ("7.9.3", AccessStatus::Unsupported),
            ("7.17.25", AccessStatus::Available),
            ("8.16.0", AccessStatus::Available),
            ("9.1.0", AccessStatus::Available),
            ("10.0.0", AccessStatus::Unknown),
            ("invalid", AccessStatus::Unknown),
            ("7.10.invalid", AccessStatus::Unknown),
        ] {
            let body =
                serde_json::to_vec(&serde_json::json!({"version":{"number":version}})).unwrap();
            assert_eq!(capabilities(&body).unwrap().0.pit.status, status);
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
        };
        let registry = crate::read_only::RequestRegistry::default();
        let mut guard = registry
            .register(&request.request_id, &request.connection_id)
            .unwrap();
        registry.cancel(&request.request_id, &request.connection_id);
        let result = inspect(
            &request,
            &profile,
            &auth,
            &ReadOnlyClient::new().unwrap(),
            None,
            guard.cancellation(),
        )
        .await;
        assert!(matches!(result, Err(error) if error.code == "cancelled"));
        assert!(
            matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
        );
    }

    #[tokio::test]
    async fn no_monitor_does_not_hide_granted_index_access_and_wire_is_fixed() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/base", listener.local_addr().unwrap());
        let (send, recv) = mpsc::channel();
        let server = thread::spawn(move || {
            for (status, body) in [
                (
                    "200 OK",
                    r#"{"username":"reader","roles":["orders_reader"],"enabled":true}"#,
                ),
                (
                    "200 OK",
                    r#"{"username":"reader","cluster":{"monitor":false},"index":{"orders-*":{"read":true,"view_index_metadata":true}}}"#,
                ),
                ("403 Forbidden", "{}"),
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0u8; 4096];
                loop {
                    let count = stream.read(&mut buffer).unwrap();
                    if count == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buffer[..count]);
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
        };
        let target = request.validate().unwrap();
        let response = inspect(
            &request,
            &profile,
            &auth,
            &ReadOnlyClient::new().unwrap(),
            target.as_ref(),
            &mut Cancellation::never(),
        )
        .await
        .unwrap();
        assert_eq!(response.identity.username.as_deref(), Some("reader"));
        assert_eq!(response.privileges.monitor.status, AccessStatus::Denied);
        assert_eq!(response.privileges.read.status, AccessStatus::Available);
        assert_eq!(response.capabilities.search.status, AccessStatus::Unknown);
        server.join().unwrap();
        let wire: Vec<_> = recv.try_iter().collect();
        assert!(wire[0].starts_with("GET /base/_security/_authenticate "));
        assert!(wire[1].starts_with("POST /base/_security/user/_has_privileges "));
        assert!(wire[2].starts_with("GET /base/ "));
        let body = wire[1].split("\r\n\r\n").nth(1).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(body).unwrap(),
            serde_json::json!({
                "cluster":["monitor"],"index":[{"names":["orders-*"],"privileges":["read","view_index_metadata"]}]
            })
        );
    }
}
