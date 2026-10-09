//! Read-only operation registry.
//!
//! Every endpoint the desktop backend may reach is declared here, together with its fixed HTTP
//! method. There is no generic proxy command: a request can never carry a URL, a method or a
//! header from the frontend, and a plan is only ever built from a stored connection.

use crate::error::AppError;
use crate::storage::ConnectionProfile;
use reqwest::{Client, Method, RequestBuilder};
use url::Url;

/// The complete read-only API surface. Anything that is not a variant here — every write,
/// management or diagnostics endpoint — fails closed with `permissionDenied`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadOnlyOperation {
    /// `GET {base}/` — cluster identity and version.
    ClusterIdentity,
    /// `GET {base}/_cluster/health` — cluster health. Cluster-wide, never carries a target.
    ClusterHealth,
    /// `GET {base}/_resolve/index/{target}` — authorized index and alias discovery.
    IndexDiscovery,
    /// `GET {base}/{target}/_settings` — settings of one explicitly named target.
    IndexSettings,
    /// `GET {base}/{target}/_mapping` — mappings of the resolved targets.
    Mapping,
    /// `GET {base}/{target}/_field_caps?fields=*` — field types and searchability.
    FieldCaps,
    /// `GET {base}/_nodes/stats/jvm,fs,os,process,thread_pool` — per-node runtime stats.
    /// Cluster-wide, never carries a target.
    NodesStats,
    /// `GET {base}/_cat/shards?format=json&h=...` — shard allocation as JSON. Cluster-wide,
    /// never carries a target.
    Shards,
    /// `POST {base}/{target}/_search` — one strictly validated search body.
    Search,
    /// `POST {base}/{target}/_pit?keep_alive=1m` — open one search snapshot for pagination.
    PitOpen,
    /// `POST {base}/_search` — continuation inside an open snapshot. The snapshot already fixes
    /// the index list, so this form never carries a target.
    PitSearch,
    /// `DELETE {base}/_pit` — close a snapshot. The body is composed here from an already
    /// validated id; it is never caller input.
    PitClose,
}

impl ReadOnlyOperation {
    /// Map an IPC-visible name to an operation. Unknown names are refused.
    pub fn parse(name: &str) -> Result<Self, AppError> {
        match name {
            "connection.test" => Ok(Self::ClusterIdentity),
            "resource.clusterHealth" => Ok(Self::ClusterHealth),
            "resource.indices" => Ok(Self::IndexDiscovery),
            "resource.indexSettings" => Ok(Self::IndexSettings),
            "resource.mapping" => Ok(Self::Mapping),
            "resource.fieldCaps" => Ok(Self::FieldCaps),
            "resource.nodesStats" => Ok(Self::NodesStats),
            "resource.shards" => Ok(Self::Shards),
            "query.execute" => Ok(Self::Search),
            "resource.pitOpen" => Ok(Self::PitOpen),
            "resource.pitClose" => Ok(Self::PitClose),
            _ => Err(AppError::new("permissionDenied")),
        }
    }

    /// The method is a property of the operation; a caller can never choose it.
    pub const fn method(self) -> Method {
        match self {
            Self::Search | Self::PitOpen | Self::PitSearch => Method::POST,
            Self::PitClose => Method::DELETE,
            Self::ClusterIdentity
            | Self::ClusterHealth
            | Self::IndexDiscovery
            | Self::IndexSettings
            | Self::Mapping
            | Self::FieldCaps
            | Self::NodesStats
            | Self::Shards => Method::GET,
        }
    }

    /// Whether this operation reads one explicit target. A cluster-wide operation must not carry
    /// one: silently ignoring it would misreport what was actually read.
    pub const fn takes_target(self) -> bool {
        matches!(
            self,
            Self::IndexDiscovery
                | Self::IndexSettings
                | Self::Mapping
                | Self::FieldCaps
                | Self::Search
                | Self::PitOpen
        )
    }

    /// Whether this operation carries a JSON body. Only the search family and the snapshot
    /// close — whose body is composed here from an already validated id — ever do.
    pub const fn carries_body(self) -> bool {
        matches!(self, Self::Search | Self::PitSearch | Self::PitClose)
    }
}

/// Resolve an operation name, refusing anything that is not registered.
pub fn authorize(operation: &str) -> Result<ReadOnlyOperation, AppError> {
    ReadOnlyOperation::parse(operation)
}

/// Upper bounds for one target expression. The limits are generous for real clusters and small
/// enough that a malformed payload cannot turn into an unbounded URL.
const MAX_TARGET_BYTES: usize = 2048;
const MAX_TARGETS: usize = 64;
const MAX_INDEX_BYTES: usize = 255;
/// Used when the caller does not name a target: every open index, never hidden or closed ones.
const ALL_INDICES: &str = "*";

/// A validated Elasticsearch index expression.
///
/// [`IndexTarget::parse`] is the only constructor, so a plan cannot be built from an unchecked
/// string and no caller has to be trusted to have validated one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexTarget(String);

impl IndexTarget {
    /// Reject anything that is not a plain Elasticsearch index expression.
    ///
    /// The character set is closed: no path separator, percent escape, query or fragment
    /// character, so a target can never escape the configured base path or inject a URL part.
    /// Multiple targets and wildcards are supported, but every comma-separated item is validated
    /// on its own, so a valid item cannot carry an invalid one.
    pub fn parse(raw: &str) -> Result<Self, AppError> {
        let target = raw.trim();
        if target.is_empty() || target.len() > MAX_TARGET_BYTES {
            return Err(AppError::new("invalidIndex"));
        }
        let items: Vec<&str> = target.split(',').collect();
        if items.len() > MAX_TARGETS || !items.iter().all(|item| valid_index_item(item)) {
            return Err(AppError::new("invalidIndex"));
        }
        Ok(Self(target.to_owned()))
    }

    /// Every open index. Hidden and closed indices are never selected implicitly.
    pub fn all() -> Self {
        Self(ALL_INDICES.to_owned())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn valid_index_item(item: &str) -> bool {
    if item.is_empty() || item.len() > MAX_INDEX_BYTES || item == "." || item == ".." {
        return false;
    }
    // `_` and `-` are reserved at the start of an index name; a leading `-` would also mean
    // "exclude" in a multi-target expression, which this backend does not accept.
    if item.starts_with('_') || item.starts_with('-') {
        return false;
    }
    item.bytes().all(
        |byte| matches!(byte, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'.' | b'_' | b'-' | b'*'),
    )
}

/// A fully determined request: fixed method, absolute URL derived from the stored connection and
/// an optional JSON body. The connection's own base path is preserved.
#[derive(Debug)]
pub struct RequestPlan {
    method: Method,
    url: Url,
    body: Option<Vec<u8>>,
}

impl RequestPlan {
    pub fn build(self, client: &Client) -> RequestBuilder {
        let mut request = client.request(self.method, self.url);
        if let Some(body) = self.body {
            request = request
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body);
        }
        request
    }
}

/// Plan a resource read. Search is not reachable here: it needs a validated body.
///
/// `target` is `None` for the cluster-wide resources and `Some` for the ones that read one
/// explicit target; [`plan`] refuses a mismatch. Nothing here reads cluster state or triggers a
/// second request.
pub(crate) fn resource_request(
    profile: &ConnectionProfile,
    operation: ReadOnlyOperation,
    target: Option<&IndexTarget>,
) -> Result<RequestPlan, AppError> {
    // The resource planner serves metadata reads only: the search family and the snapshot
    // lifecycle are planned by the query and PIT paths, never here.
    if operation.carries_body() || operation == ReadOnlyOperation::PitOpen {
        return Err(AppError::new("permissionDenied"));
    }
    plan(profile, operation, target, None)
}

/// Plan the single search execution: the only operation that carries a body.
pub(crate) fn search_request(
    profile: &ConnectionProfile,
    target: &IndexTarget,
    body: Vec<u8>,
) -> Result<RequestPlan, AppError> {
    plan(
        profile,
        authorize("query.execute")?,
        Some(target),
        Some(body),
    )
}
/// Open one snapshot for pagination. The keep-alive is fixed here; the caller supplies only the
/// already validated target.
pub(crate) fn pit_open_request(
    profile: &ConnectionProfile,
    target: &IndexTarget,
) -> Result<RequestPlan, AppError> {
    plan(profile, ReadOnlyOperation::PitOpen, Some(target), None)
}

/// Plan one continuation search inside an open snapshot. The body was composed and validated by
/// the query layer; this only fixes the endpoint.
pub(crate) fn pit_search_request(
    profile: &ConnectionProfile,
    body: Vec<u8>,
) -> Result<RequestPlan, AppError> {
    plan(profile, ReadOnlyOperation::PitSearch, None, Some(body))
}

/// Plan the snapshot close. The body is `{"id": …}` built here from an id that was already
/// checked to be a bounded printable token, so it cannot inject anything into the JSON.
pub(crate) fn pit_close_request(
    profile: &ConnectionProfile,
    pit_id: &str,
) -> Result<RequestPlan, AppError> {
    let body = serde_json::to_vec(&serde_json::json!({ "id": pit_id }))
        .map_err(|_| AppError::new("invalidInput"))?;
    plan(profile, ReadOnlyOperation::PitClose, None, Some(body))
}

/// The only place a relative API path is produced. It is a closed match on the registered
/// operations, so no caller can supply a path, an extra query parameter or a body for another
/// endpoint.
fn relative(
    operation: ReadOnlyOperation,
    target: Option<&IndexTarget>,
) -> Result<String, AppError> {
    let target = || {
        target
            .map(IndexTarget::as_str)
            .ok_or_else(|| AppError::new("permissionDenied"))
    };
    match operation {
        ReadOnlyOperation::ClusterIdentity => Ok(String::new()),
        ReadOnlyOperation::ClusterHealth => Ok("_cluster/health".to_owned()),
        ReadOnlyOperation::IndexDiscovery => Ok(format!("_resolve/index/{}", target()?)),
        ReadOnlyOperation::IndexSettings => Ok(format!("{}/_settings", target()?)),
        ReadOnlyOperation::Mapping => Ok(format!("{}/_mapping", target()?)),
        // The field list is part of this operation, never caller input.
        ReadOnlyOperation::FieldCaps => Ok(format!("{}/_field_caps?fields=*", target()?)),
        ReadOnlyOperation::NodesStats => {
            Ok("_nodes/stats/jvm,fs,os,process,thread_pool".to_owned())
        }
        // `format=json` and the metric list are part of this operation, never caller input.
        ReadOnlyOperation::Shards => Ok(
            "_cat/shards?format=json&h=index,shard,prirep,state,docs,store,ip,node,unassigned.reason"
                .to_owned(),
        ),
        ReadOnlyOperation::Search => Ok(format!("{}/_search", target()?)),
        // The keep-alive is part of this operation, never caller input.
        ReadOnlyOperation::PitOpen => Ok(format!("{}/_pit?keep_alive=1m", target()?)),
        // A continuation names no target: the snapshot already fixes the index list.
        ReadOnlyOperation::PitSearch => Ok("_search".to_owned()),
        ReadOnlyOperation::PitClose => Ok("_pit".to_owned()),
    }
}

/// Build a plan for one registered operation against the connection's own base URL.
fn plan(
    profile: &ConnectionProfile,
    operation: ReadOnlyOperation,
    target: Option<&IndexTarget>,
    body: Option<Vec<u8>>,
) -> Result<RequestPlan, AppError> {
    // Only the body-carrying operations may have one: a plain read can never smuggle a body in,
    // and an operation whose body is part of its contract must not be planned without it.
    if body.is_some() != operation.carries_body() {
        return Err(AppError::new("permissionDenied"));
    }
    // A target is present exactly when the operation reads one.
    if target.is_some() != operation.takes_target() {
        return Err(AppError::new("permissionDenied"));
    }
    let url = base_url(profile)?
        .join(&relative(operation, target)?)
        .map_err(|_| AppError::new("invalidEndpoint"))?;
    Ok(RequestPlan {
        method: operation.method(),
        url,
        body,
    })
}

/// The connection's own base URL: scheme, host, port and the configured path prefix, nothing
/// else. A connection with a bound credential is refused until an authenticated request path
/// exists, so a stored secret can never be sent by an unauthenticated plan.
pub(crate) fn base_url(profile: &ConnectionProfile) -> Result<Url, AppError> {
    // The IPC-facing `auth` label stays "none"; the real state is the internal metadata. Both are
    // checked so a stored credential can never reach the network before the authenticated request
    // path exists.
    if profile.auth != "none" || !profile.auth_state.unauthenticated() {
        return Err(AppError::new("unsupported"));
    }
    let mut url = Url::parse(&profile.endpoint).map_err(|_| AppError::new("invalidEndpoint"))?;
    if !["http", "https"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::new("invalidEndpoint"));
    }
    // Only the configured base path is permitted; callers cannot supply an API path or method.
    let path = format!("{}/", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(url)
}

/// The cluster identity plan: a single GET against the configured base path.
pub fn identity_request(profile: &ConnectionProfile) -> Result<RequestPlan, AppError> {
    plan(profile, authorize("connection.test")?, None, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::CredentialRef;
    use crate::storage::{AuthKind, ConnectionAuth};

    fn profile(endpoint: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: uuid::Uuid::new_v4().to_string(),
            display_name: "Fixture".into(),
            endpoint: endpoint.into(),
            environment: "development".into(),
            sort_order: 0,
            auth: "none",
            auth_state: ConnectionAuth::none(),
        }
    }

    #[test]
    fn unknown_write_and_management_operations_are_denied() {
        for operation in [
            "",
            "GET",
            "index.delete",
            "document.update",
            "query.execute/../delete",
            "query.execute ",
            "resource.read",
            "resource.indices.all",
            "resource.clusterState",
            "resource.clusterSettings",
            "resource.nodesStats.all",
            "resource.nodes",
            "resource.tasks",
            "resource.shards/../delete",
            "resource.indexSettings.all",
            "_cat/indices",
            "_cluster/state",
            "capability.read",
            "cluster.health",
            "resource.pitSearch",
            "query.executePage",
            "pit.open",
            "resource.pitCloseAll",
        ] {
            assert_eq!(authorize(operation).unwrap_err().code, "permissionDenied");
        }
    }

    #[test]
    fn the_registry_only_exposes_the_fixed_read_only_surface() {
        for (name, method) in [
            ("connection.test", Method::GET),
            ("resource.indices", Method::GET),
            ("resource.mapping", Method::GET),
            ("resource.fieldCaps", Method::GET),
            ("resource.indexSettings", Method::GET),
            ("resource.clusterHealth", Method::GET),
            ("resource.nodesStats", Method::GET),
            ("resource.shards", Method::GET),
            ("query.execute", Method::POST),
            ("resource.pitOpen", Method::POST),
            ("resource.pitClose", Method::DELETE),
        ] {
            assert_eq!(authorize(name).unwrap().method(), method, "{name}");
        }
    }

    #[test]
    fn cluster_wide_operations_take_no_target_and_the_others_require_one() {
        let profile = profile("https://example.test/proxy/es");
        let target = IndexTarget::parse("logs-*").unwrap();
        for operation in [
            ReadOnlyOperation::ClusterIdentity,
            ReadOnlyOperation::ClusterHealth,
            ReadOnlyOperation::NodesStats,
            ReadOnlyOperation::Shards,
        ] {
            assert!(!operation.takes_target(), "{operation:?}");
            // A target would be silently ignored, so the plan refuses it.
            assert_eq!(
                resource_request(&profile, operation, Some(&target))
                    .err()
                    .unwrap()
                    .code,
                "permissionDenied",
                "{operation:?}"
            );
            assert!(resource_request(&profile, operation, None).is_ok());
        }
        for operation in [
            ReadOnlyOperation::IndexDiscovery,
            ReadOnlyOperation::IndexSettings,
            ReadOnlyOperation::Mapping,
            ReadOnlyOperation::FieldCaps,
        ] {
            assert!(operation.takes_target(), "{operation:?}");
            assert_eq!(
                resource_request(&profile, operation, None)
                    .err()
                    .unwrap()
                    .code,
                "permissionDenied",
                "{operation:?}"
            );
        }
        // Search takes a target too, but it is never planned through `resource_request`.
        assert!(ReadOnlyOperation::Search.takes_target());
    }

    #[test]
    fn the_new_cluster_paths_are_fixed_and_keep_the_base_prefix() {
        let profile = profile("https://example.test/proxy/es");
        for (operation, expected) in [
            (
                ReadOnlyOperation::ClusterHealth,
                "https://example.test/proxy/es/_cluster/health",
            ),
            (
                ReadOnlyOperation::NodesStats,
                "https://example.test/proxy/es/_nodes/stats/jvm,fs,os,process,thread_pool",
            ),
            (
                ReadOnlyOperation::Shards,
                "https://example.test/proxy/es/_cat/shards?format=json&h=index,shard,prirep,state,docs,store,ip,node,unassigned.reason",
            ),
        ] {
            let request = resource_request(&profile, operation, None)
                .unwrap()
                .build(&Client::new())
                .build()
                .unwrap();
            assert_eq!(request.method(), Method::GET);
            assert_eq!(request.url().as_str(), expected);
            assert!(request.body().is_none());
        }
        let settings = IndexTarget::parse("logs-*").unwrap();
        let request = resource_request(&profile, ReadOnlyOperation::IndexSettings, Some(&settings))
            .unwrap()
            .build(&Client::new())
            .build()
            .unwrap();
        assert_eq!(request.method(), Method::GET);
        assert_eq!(
            request.url().as_str(),
            "https://example.test/proxy/es/logs-*/_settings"
        );
    }

    #[test]
    fn identity_plan_preserves_prefix_and_never_accepts_method_path_or_secrets() {
        let mut profile = profile("https://example.test/proxy/es");
        let request = identity_request(&profile)
            .unwrap()
            .build(&Client::new())
            .build()
            .unwrap();
        assert_eq!(request.method(), Method::GET);
        assert_eq!(request.url().as_str(), "https://example.test/proxy/es/");
        assert!(request.body().is_none());
        for endpoint in [
            "file:///tmp/secret",
            "https://user:secret@example.test",
            "https://example.test/?token=secret",
            "https://example.test/#secret",
        ] {
            profile.endpoint = endpoint.into();
            assert_eq!(
                identity_request(&profile).unwrap_err().code,
                "invalidEndpoint"
            );
        }
        // A stored credential is refused through the internal metadata as well, so the plan cannot
        // send it before the authenticated request path exists.
        profile.endpoint = "https://example.test/proxy/es".into();
        profile.auth_state = ConnectionAuth {
            kind: AuthKind::ApiKey,
            credential_ref: Some(CredentialRef::generate()),
        };
        assert_eq!(
            identity_request(&profile).err().unwrap().code,
            "unsupported"
        );
        // The IPC-facing label alone is enough to refuse as well.
        profile.auth_state = ConnectionAuth::none();
        profile.auth = "basic";
        assert_eq!(
            identity_request(&profile).err().unwrap().code,
            "unsupported"
        );
    }

    #[test]
    fn registered_plans_keep_the_base_prefix_and_never_add_a_body() {
        let profile = profile("https://example.test/proxy/es");
        let target = IndexTarget::parse("logs-*").unwrap();
        for (operation, expected) in [
            (
                ReadOnlyOperation::IndexDiscovery,
                "https://example.test/proxy/es/_resolve/index/logs-*",
            ),
            (
                ReadOnlyOperation::Mapping,
                "https://example.test/proxy/es/logs-*/_mapping",
            ),
            (
                ReadOnlyOperation::FieldCaps,
                "https://example.test/proxy/es/logs-*/_field_caps?fields=*",
            ),
        ] {
            let request = resource_request(&profile, operation, Some(&target))
                .unwrap()
                .build(&Client::new())
                .build()
                .unwrap();
            assert_eq!(request.method(), Method::GET);
            assert_eq!(request.url().as_str(), expected);
            assert!(request.body().is_none());
        }
    }

    #[test]
    fn only_the_search_operation_can_carry_a_body_or_accept_one() {
        let profile = profile("https://example.test/proxy/es");
        let target = IndexTarget::parse("logs-*").unwrap();
        assert_eq!(
            resource_request(&profile, ReadOnlyOperation::Search, Some(&target))
                .err()
                .unwrap()
                .code,
            "permissionDenied"
        );
        let request = search_request(&profile, &target, b"{}".to_vec())
            .unwrap()
            .build(&Client::new())
            .build()
            .unwrap();
        assert_eq!(request.method(), Method::POST);
        assert_eq!(
            request.url().as_str(),
            "https://example.test/proxy/es/logs-*/_search"
        );
        assert_eq!(request.body().unwrap().as_bytes().unwrap(), b"{}");
        // The identity plan carries no body and no target.
        assert!(identity_request(&profile).unwrap().body.is_none());
    }

    #[test]
    fn valid_targets_are_accepted_including_wildcards_and_multiple_targets() {
        for raw in [
            "logs",
            "logs-*",
            "*",
            ".kibana",
            "a.b_c-d",
            "logs-*,metrics-*",
            "A1",
        ] {
            assert_eq!(IndexTarget::parse(raw).unwrap().as_str(), raw);
        }
        assert_eq!(IndexTarget::parse("  logs-*  ").unwrap().as_str(), "logs-*");
        assert!(IndexTarget::parse(&"x".repeat(MAX_INDEX_BYTES)).is_ok());
        let many = (0..MAX_TARGETS)
            .map(|index| format!("i{index}"))
            .collect::<Vec<_>>()
            .join(",");
        assert!(IndexTarget::parse(&many).is_ok());
        assert_eq!(IndexTarget::all().as_str(), "*");
    }

    #[test]
    fn targets_that_could_escape_the_path_or_inject_url_parts_are_refused() {
        for raw in [
            "",
            "   ",
            "a/b",
            "/absolute",
            "../../etc/passwd",
            "..",
            ".",
            "a/../b",
            "logs%2F*",
            "logs%",
            "logs?pretty",
            "logs#fragment",
            "logs&x=1",
            "logs+1",
            "logs 1",
            "logs\t1",
            "logs\n1",
            "logs|cat",
            "logs\"1",
            "logs\\1",
            "logs;1",
            "logs(1)",
            "logs[1]",
            "logs{1}",
            "logs<1>",
            "logs`1`",
            "logs@1",
            "logs:1",
            "logs=1",
            "_all",
            "_cat/indices",
            "-logs",
            "logs,-old",
            ",logs",
            "logs,",
            "logs,,metrics",
            "ünïcode",
            "logs*,",
        ] {
            assert_eq!(
                IndexTarget::parse(raw).unwrap_err().code,
                "invalidIndex",
                "{raw} should be refused"
            );
        }
        let too_long = "x".repeat(MAX_TARGET_BYTES + 1);
        assert_eq!(
            IndexTarget::parse(&too_long).unwrap_err().code,
            "invalidIndex"
        );
        let too_many = (0..=MAX_TARGETS)
            .map(|index| format!("i{index}"))
            .collect::<Vec<_>>()
            .join(",");
        assert_eq!(
            IndexTarget::parse(&too_many).unwrap_err().code,
            "invalidIndex"
        );
    }

    #[test]
    fn the_snapshot_lifecycle_keeps_its_fixed_shape_and_own_body() {
        let profile = profile("https://example.test/proxy/es");
        let target = IndexTarget::parse("logs-*").unwrap();
        // Opening a snapshot is a POST against the validated target with a fixed keep-alive and
        // no body at all.
        let request = pit_open_request(&profile, &target)
            .unwrap()
            .build(&Client::new())
            .build()
            .unwrap();
        assert_eq!(request.method(), Method::POST);
        assert_eq!(
            request.url().as_str(),
            "https://example.test/proxy/es/logs-*/_pit?keep_alive=1m"
        );
        assert!(request.body().is_none());
        // The continuation search names no target: the snapshot already fixes the index list.
        let request = pit_search_request(&profile, b"{\"size\":1}".to_vec())
            .unwrap()
            .build(&Client::new())
            .build()
            .unwrap();
        assert_eq!(request.method(), Method::POST);
        assert_eq!(
            request.url().as_str(),
            "https://example.test/proxy/es/_search"
        );
        assert_eq!(request.body().unwrap().as_bytes().unwrap(), b"{\"size\":1}");
        // Closing composes our own body and can never be planned without one.
        let request = pit_close_request(&profile, "pit-abc123")
            .unwrap()
            .build(&Client::new())
            .build()
            .unwrap();
        assert_eq!(request.method(), Method::DELETE);
        assert_eq!(request.url().as_str(), "https://example.test/proxy/es/_pit");
        assert_eq!(
            request.body().unwrap().as_bytes().unwrap(),
            b"{\"id\":\"pit-abc123\"}"
        );
        assert_eq!(
            plan(&profile, ReadOnlyOperation::PitClose, None, None)
                .err()
                .unwrap()
                .code,
            "permissionDenied"
        );
        // The snapshot lifecycle is not reachable through the metadata-read planner.
        assert_eq!(
            resource_request(&profile, ReadOnlyOperation::PitOpen, Some(&target))
                .err()
                .unwrap()
                .code,
            "permissionDenied"
        );
        assert!(resource_request(&profile, ReadOnlyOperation::PitSearch, None).is_err());
        assert!(resource_request(&profile, ReadOnlyOperation::PitClose, None).is_err());
        // A stored credential still refuses every snapshot plan.
        let mut secured = profile;
        secured.auth_state = ConnectionAuth {
            kind: AuthKind::ApiKey,
            credential_ref: Some(CredentialRef::generate()),
        };
        assert_eq!(
            pit_open_request(&secured, &target).err().unwrap().code,
            "unsupported"
        );
    }
}
