//! `resource_read` IPC: authorized read-only discovery of indices, mappings and field caps.
//!
//! Discovery never depends on `_cat/indices` and never probes a monitoring endpoint: index
//! discovery uses `_resolve/index`, which reports only what the configured credentials may see.
//! A target the caller names explicitly is accepted even when discovery is not authorized, so a
//! user who knows the index name can still work.

use crate::connection::decode_response;
use crate::error::AppError;
use crate::operation::{self, IndexTarget, ReadOnlyOperation, RequestPlan};
use crate::read_only::validate_uuid;
use crate::storage::ConnectionProfile;
use serde::{Deserialize, Serialize};

/// The resource kinds exposed through IPC.
///
/// Every variant maps to one fixed operation; the cluster-wide ones (`clusterHealth`,
/// `nodesStats`, `shards`) are read with no target at all, and `indexSettings` always needs an
/// explicit target so it can never read the settings of every index by accident.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Resource {
    Indices,
    Mapping,
    FieldCaps,
    ClusterHealth,
    NodesStats,
    Shards,
    IndexSettings,
}

impl Resource {
    fn operation(self) -> Result<ReadOnlyOperation, AppError> {
        match self {
            Self::Indices => operation::authorize("resource.indices"),
            Self::Mapping => operation::authorize("resource.mapping"),
            Self::FieldCaps => operation::authorize("resource.fieldCaps"),
            Self::ClusterHealth => operation::authorize("resource.clusterHealth"),
            Self::NodesStats => operation::authorize("resource.nodesStats"),
            Self::Shards => operation::authorize("resource.shards"),
            Self::IndexSettings => operation::authorize("resource.indexSettings"),
        }
    }

    /// Whether this resource reads an index target at all.
    pub const fn takes_target(self) -> bool {
        matches!(
            self,
            Self::Indices | Self::Mapping | Self::FieldCaps | Self::IndexSettings
        )
    }

    /// Whether the target is mandatory. Only index settings: without a target it would read the
    /// settings of every index instead of the one the user chose.
    pub const fn requires_target(self) -> bool {
        matches!(self, Self::IndexSettings)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceReadRequest {
    pub request_id: String,
    pub connection_id: String,
    pub resource: Resource,
    /// Index expression. For discovery, mapping and field caps, omitting it means `*`, which
    /// resolves open indices only; hidden, closed and system indices are never selected
    /// implicitly. Cluster-wide resources must not carry one, and index settings must.
    #[serde(default)]
    pub index: Option<String>,
}

impl ResourceReadRequest {
    /// Validate the identifiers. The command calls this before its error mapper can attach a
    /// request ID, so an invalid ID is never echoed back through IPC.
    pub fn validate_ids(&self) -> Result<(), AppError> {
        validate_uuid(&self.request_id)?;
        validate_uuid(&self.connection_id)
    }

    /// Validate the index expression and return the checked target, if this resource reads one.
    pub fn target(&self) -> Result<Option<IndexTarget>, AppError> {
        self.validate_ids()?;
        match self.index.as_deref() {
            Some(raw) => {
                // A cluster-wide resource with an index would silently ignore it, so the request
                // is refused instead of answering a different question than the caller asked.
                if !self.resource.takes_target() {
                    return Err(AppError::new("invalidIndex"));
                }
                Ok(Some(IndexTarget::parse(raw)?))
            }
            None if self.resource.requires_target() => Err(AppError::new("invalidIndex")),
            None if self.resource.takes_target() => Ok(Some(IndexTarget::all())),
            None => Ok(None),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceReadResponse {
    pub request_id: String,
    pub connection_id: String,
    pub endpoint: String,
    pub raw_response: String,
}

impl ResourceReadResponse {
    /// Keep the cluster's own bytes: the response is never re-serialized, so number literals,
    /// key order and formatting survive exactly as Elasticsearch sent them.
    ///
    /// Only one shape rule is enforced: every one of these endpoints answers with JSON
    /// (`_cat/shards?format=json` with an array). Anything else is a proxy page, an error page or
    /// a truncated body, and is reported as `invalidResponse` instead of being handed to the UI
    /// as data. Nothing is defaulted, filled in or dropped — in particular a partially failed
    /// `_nodes` response keeps its raw `_nodes.failed` for the UI to mark as partial.
    pub fn new(
        request: &ResourceReadRequest,
        profile: &ConnectionProfile,
        raw: Vec<u8>,
    ) -> Result<Self, AppError> {
        let raw_response = decode_response(raw)?;
        serde_json::from_str::<serde_json::Value>(&raw_response)
            .map_err(|_| AppError::new("invalidResponse"))?;
        Ok(Self {
            request_id: request.request_id.clone(),
            connection_id: request.connection_id.clone(),
            endpoint: profile.endpoint.clone(),
            raw_response,
        })
    }
}

/// Build the plan for one resource read from an already validated target.
pub fn resource_plan(
    profile: &ConnectionProfile,
    resource: Resource,
    target: Option<&IndexTarget>,
) -> Result<RequestPlan, AppError> {
    operation::resource_request(profile, resource.operation()?, target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{AuthKind, ConnectionAuth};

    const REQUEST: &str = "6f3b2f1c-4f3e-4a5b-8c9d-0e1f2a3b4c5d";
    const CONNECTION: &str = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e";

    fn profile() -> ConnectionProfile {
        ConnectionProfile {
            id: CONNECTION.into(),
            display_name: "Fixture".into(),
            endpoint: "https://example.test/proxy/es".into(),
            environment: "development".into(),
            sort_order: 0,
            auth: "none",
            auth_state: ConnectionAuth::none(),
        }
    }

    fn request(resource: Resource, index: Option<&str>) -> ResourceReadRequest {
        ResourceReadRequest {
            request_id: REQUEST.into(),
            connection_id: CONNECTION.into(),
            resource,
            index: index.map(str::to_owned),
        }
    }

    #[test]
    fn a_missing_target_defaults_to_open_indices_only() {
        let request = request(Resource::Indices, None);
        let target = request.target().unwrap().unwrap();
        assert_eq!(target.as_str(), "*");
        assert_eq!(
            resource_plan(&profile(), Resource::Indices, Some(&target))
                .unwrap()
                .build(&reqwest::Client::new())
                .unwrap()
                .build()
                .unwrap()
                .url()
                .as_str(),
            "https://example.test/proxy/es/_resolve/index/*"
        );
    }

    #[test]
    fn every_resource_keeps_the_base_prefix_and_uses_a_get() {
        for (resource, index, expected) in [
            (
                Resource::Indices,
                Some("logs-*"),
                "https://example.test/proxy/es/_resolve/index/logs-*",
            ),
            (
                Resource::Mapping,
                Some("logs-*"),
                "https://example.test/proxy/es/logs-*/_mapping",
            ),
            (
                Resource::FieldCaps,
                Some("logs-*"),
                "https://example.test/proxy/es/logs-*/_field_caps?fields=*",
            ),
            (
                Resource::IndexSettings,
                Some("logs-*"),
                "https://example.test/proxy/es/logs-*/_settings",
            ),
            (
                Resource::ClusterHealth,
                None,
                "https://example.test/proxy/es/_cluster/health",
            ),
            (
                Resource::NodesStats,
                None,
                "https://example.test/proxy/es/_nodes/stats/jvm,fs,os,process,thread_pool",
            ),
            (
                Resource::Shards,
                None,
                "https://example.test/proxy/es/_cat/shards?format=json&h=index,shard,prirep,state,docs,store,ip,node,unassigned.reason",
            ),
        ] {
            let request = request(resource, index);
            let target = request.target().unwrap();
            let plan = resource_plan(&profile(), resource, target.as_ref()).unwrap();
            let built = plan
                .build(&reqwest::Client::new())
                .unwrap()
                .build()
                .unwrap();
            assert_eq!(built.method(), reqwest::Method::GET, "{resource:?}");
            assert_eq!(built.url().as_str(), expected, "{resource:?}");
            assert!(built.body().is_none(), "{resource:?}");
        }
    }

    #[test]
    fn cluster_wide_resources_refuse_an_index_instead_of_ignoring_it() {
        for resource in [
            Resource::ClusterHealth,
            Resource::NodesStats,
            Resource::Shards,
        ] {
            assert!(request(resource, None).target().unwrap().is_none());
            for index in ["logs-*", "*", "logs"] {
                assert_eq!(
                    request(resource, Some(index)).target().unwrap_err().code,
                    "invalidIndex",
                    "{resource:?} must not accept {index}"
                );
            }
        }
    }

    #[test]
    fn index_settings_requires_an_explicit_target() {
        assert!(request(Resource::IndexSettings, Some("logs-*"))
            .target()
            .unwrap()
            .is_some());
        // Without a target this would read every index's settings, so it is refused.
        assert_eq!(
            request(Resource::IndexSettings, None)
                .target()
                .unwrap_err()
                .code,
            "invalidIndex"
        );
        assert_eq!(
            request(Resource::IndexSettings, Some("  "))
                .target()
                .unwrap_err()
                .code,
            "invalidIndex"
        );
        assert_eq!(
            request(Resource::IndexSettings, Some("../_cluster/settings"))
                .target()
                .unwrap_err()
                .code,
            "invalidIndex"
        );
    }

    #[test]
    fn an_invalid_target_is_refused_before_a_plan_exists() {
        for index in [
            "../_delete",
            "logs-*,../_delete",
            "logs/../x",
            "_all",
            "logs?x=1",
        ] {
            assert_eq!(
                request(Resource::Mapping, Some(index))
                    .target()
                    .unwrap_err()
                    .code,
                "invalidIndex",
                "{index} should be refused"
            );
        }
    }

    #[test]
    fn a_bound_resource_plan_cannot_be_sent_without_its_resolved_auth() {
        let mut profile = profile();
        profile.auth_state = ConnectionAuth {
            kind: AuthKind::Basic,
            credential_ref: Some(crate::credentials::CredentialRef::generate()),
        };
        let target = IndexTarget::parse("logs-*").unwrap();
        // The plan itself is built, but it refuses to become a request: the header can only be
        // attached by the resolver for this exact connection.
        for (resource, target) in [
            (Resource::Indices, Some(&target)),
            (Resource::ClusterHealth, None),
        ] {
            let plan = resource_plan(&profile, resource, target).unwrap();
            assert_eq!(
                plan.build(&reqwest::Client::new()).err().unwrap().code,
                "unsupported",
                "{resource:?}"
            );
        }
    }

    #[test]
    fn a_resource_response_must_be_json_and_is_never_rewritten() {
        let profile = profile();
        let request = request(Resource::Shards, None);
        // `_cat/shards?format=json` answers with an array; `_nodes/stats` with an object whose
        // failed-node list must survive untouched.
        let nodes = r#"{"_nodes":{"total":2,"successful":1,"failed":1},"nodes":{"n1":{"thread_pool":{"search":{"rejected":123456789012345678901234567890}}}}}"#;
        for raw in ["[]", "{}", nodes] {
            let response =
                ResourceReadResponse::new(&request, &profile, raw.as_bytes().to_vec()).unwrap();
            assert_eq!(response.raw_response, raw);
        }
        for raw in ["", "<html>not json</html>", "{", "null null"] {
            assert_eq!(
                ResourceReadResponse::new(&request, &profile, raw.as_bytes().to_vec())
                    .unwrap_err()
                    .code,
                "invalidResponse",
                "{raw} must not be handed to the UI as data"
            );
        }
    }

    #[test]
    fn the_response_contract_uses_the_exact_camel_case_keys() {
        let value = serde_json::to_value(ResourceReadResponse {
            request_id: REQUEST.into(),
            connection_id: CONNECTION.into(),
            endpoint: "https://example.test/proxy/es".into(),
            raw_response: "{}".into(),
        })
        .unwrap();
        let object = value.as_object().unwrap();
        assert_eq!(object.len(), 4);
        for key in ["requestId", "connectionId", "endpoint", "rawResponse"] {
            assert!(object.contains_key(key), "{key} is missing");
        }
    }

    #[test]
    fn ipc_payloads_reject_unknown_fields_resources_and_invalid_ids() {
        // Every exposed resource kind is accepted by name, and each one resolves to its own
        // operation instead of a caller-supplied path.
        for (name, index, target_expected) in [
            ("indices", "", true),
            ("mapping", "", true),
            ("fieldCaps", "", true),
            ("indexSettings", r#","index":"logs-*""#, true),
            ("clusterHealth", "", false),
            ("nodesStats", "", false),
            ("shards", "", false),
        ] {
            let payload = format!(
                r#"{{"requestId":"{REQUEST}","connectionId":"{CONNECTION}","resource":"{name}"{index}}}"#
            );
            let request: ResourceReadRequest = serde_json::from_str(&payload).unwrap();
            assert_eq!(
                request.target().unwrap().is_some(),
                target_expected,
                "{name} should resolve a target: {target_expected}"
            );
        }
        let valid = format!(
            r#"{{"requestId":"{REQUEST}","connectionId":"{CONNECTION}","resource":"indices"}}"#
        );
        let request: ResourceReadRequest = serde_json::from_str(&valid).unwrap();
        assert_eq!(request.target().unwrap().unwrap().as_str(), "*");
        for payload in [
            format!(
                r#"{{"requestId":"{REQUEST}","connectionId":"{CONNECTION}","resource":"indices","url":"https://example.test"}}"#
            ),
            format!(
                r#"{{"requestId":"{REQUEST}","connectionId":"{CONNECTION}","resource":"indices","method":"DELETE"}}"#
            ),
            format!(
                r#"{{"requestId":"{REQUEST}","connectionId":"{CONNECTION}","resource":"indices","headers":{{"authorization":"secret"}}}}"#
            ),
            format!(
                r#"{{"requestId":"{REQUEST}","connectionId":"{CONNECTION}","resource":"indices","credentialRef":"{CONNECTION}"}}"#
            ),
            format!(
                r#"{{"requestId":"{REQUEST}","connectionId":"{CONNECTION}","resource":"indices","secret":"fixture"}}"#
            ),
            format!(
                r#"{{"requestId":"{REQUEST}","connectionId":"{CONNECTION}","resource":"indices","authorization":"Basic fixture"}}"#
            ),
            format!(
                r#"{{"requestId":"{REQUEST}","connectionId":"{CONNECTION}","resource":"clusterState"}}"#
            ),
            format!(
                r#"{{"requestId":"{REQUEST}","connectionId":"{CONNECTION}","resource":"_search"}}"#
            ),
            format!(
                r#"{{"requestId":"{REQUEST}","connectionId":"{CONNECTION}","resource":"field_caps"}}"#
            ),
            format!(
                r#"{{"requestId":"{REQUEST}","connectionId":"{CONNECTION}","resource":"cluster_health"}}"#
            ),
            format!(
                r#"{{"requestId":"{REQUEST}","connectionId":"{CONNECTION}","resource":"nodes"}}"#
            ),
            format!(
                r#"{{"requestId":"{REQUEST}","connectionId":"{CONNECTION}","resource":"_cat/shards"}}"#
            ),
            format!(
                r#"{{"requestId":"{REQUEST}","connectionId":"{CONNECTION}","resource":"index_settings"}}"#
            ),
            format!(
                r#"{{"requestId":"secret","connectionId":"{CONNECTION}","resource":"indices"}}"#
            ),
            format!(r#"{{"requestId":"{REQUEST}","connectionId":"secret","resource":"indices"}}"#),
        ] {
            let parsed: Result<ResourceReadRequest, _> = serde_json::from_str(&payload);
            if let Ok(request) = parsed {
                assert_eq!(request.validate_ids().unwrap_err().code, "invalidInput");
            }
        }
    }

    #[test]
    fn an_invalid_identifier_is_reported_without_a_request_id() {
        // The command validates the identifiers before its error mapper runs, so this error is
        // the one that reaches IPC, and it carries no request ID to reflect back.
        let mut request = request(Resource::Indices, None);
        request.request_id = "secret".into();
        let error = request.validate_ids().unwrap_err();
        assert_eq!(error.code, "invalidInput");
        assert_eq!(error.request_id, None);
        request.request_id = REQUEST.into();
        request.connection_id = "secret".into();
        let error = request.validate_ids().unwrap_err();
        assert_eq!(error.code, "invalidInput");
        assert_eq!(error.request_id, None);
    }
}
