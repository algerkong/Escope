//! Observed metadata is not an operation probe, permission grant, or compatibility certification.

use super::{display_text, AccessStatus, Feedback};
use crate::error::AppError;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum BuildFlavor {
    Default,
    Oss,
    Serverless,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Deployment {
    Serverless,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum VersionKind {
    Release,
    Serverless,
    Unrecognized,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ServerFingerprint {
    cluster_uuid: String,
    version: String,
    flavor: BuildFlavor,
    build_hash: Option<String>,
    build_type: Option<String>,
    build_snapshot: Option<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ServerInfo {
    #[serde(flatten)]
    pub feedback: Feedback,
    pub version: Option<String>,
    pub version_kind: VersionKind,
    pub build_flavor: BuildFlavor,
    pub deployment: Deployment,
    pub cluster_uuid: Option<String>,
    #[serde(skip)]
    pub fingerprint: Option<ServerFingerprint>,
}

#[derive(Deserialize)]
struct RootBody {
    cluster_uuid: Option<String>,
    version: VersionBody,
}

#[derive(Deserialize)]
struct VersionBody {
    number: String,
    build_flavor: Option<String>,
    build_hash: Option<String>,
    build_type: Option<String>,
    build_snapshot: Option<bool>,
}

fn exact_release(value: &str) -> Option<(u32, u32, u32)> {
    let parts: Vec<_> = value.split('.').collect();
    if parts.len() != 3
        || parts.iter().any(|part| {
            part.is_empty()
                || !part.bytes().all(|byte| byte.is_ascii_digit())
                || (part.len() > 1 && part.starts_with('0'))
        })
    {
        return None;
    }
    Some((
        parts[0].parse().ok()?,
        parts[1].parse().ok()?,
        parts[2].parse().ok()?,
    ))
}

impl ServerInfo {
    pub fn requires_enterprise_parameter(&self) -> bool {
        self.version_kind == VersionKind::Release
            && matches!(self.build_flavor, BuildFlavor::Default | BuildFlavor::Oss)
            && self
                .version
                .as_deref()
                .and_then(exact_release)
                .is_some_and(|version| ((7, 6, 0)..(8, 0, 0)).contains(&version))
    }

    pub fn parse(bytes: &[u8]) -> Result<Self, AppError> {
        let root: RootBody =
            serde_json::from_slice(bytes).map_err(|_| AppError::new("invalidResponse"))?;
        let version = root.version;
        if !display_text(&version.number, 64)
            || [
                version.build_flavor.as_deref(),
                version.build_hash.as_deref(),
                version.build_type.as_deref(),
            ]
            .into_iter()
            .flatten()
            .any(|value| !display_text(value, 128))
            || root
                .cluster_uuid
                .as_ref()
                .is_some_and(|value| !display_text(value, 128))
        {
            return Err(AppError::new("invalidResponse"));
        }
        let build_flavor = match version.build_flavor.as_deref() {
            Some("default") => BuildFlavor::Default,
            Some("oss") => BuildFlavor::Oss,
            Some("serverless") => BuildFlavor::Serverless,
            _ => BuildFlavor::Unknown,
        };
        let serverless = build_flavor == BuildFlavor::Serverless;
        let version_kind = if serverless {
            VersionKind::Serverless
        } else if exact_release(&version.number).is_some() && version.build_snapshot != Some(true) {
            VersionKind::Release
        } else {
            VersionKind::Unrecognized
        };
        let cluster_uuid = root.cluster_uuid.filter(|value| value != "_na_");
        // Unknown builds and prereleases have no reusable compatibility identity.
        let fingerprint = cluster_uuid.as_ref().and_then(|cluster_uuid| {
            (build_flavor != BuildFlavor::Unknown && version_kind != VersionKind::Unrecognized)
                .then(|| ServerFingerprint {
                    cluster_uuid: cluster_uuid.clone(),
                    version: version.number.clone(),
                    flavor: build_flavor,
                    build_hash: version.build_hash,
                    build_type: version.build_type,
                    build_snapshot: version.build_snapshot,
                })
        });
        Ok(Self {
            feedback: Feedback::status(AccessStatus::Available),
            version: Some(version.number),
            version_kind,
            build_flavor,
            // A default/OSS build or a hostname cannot distinguish Hosted, ECE, ECK and self-managed.
            deployment: if serverless {
                Deployment::Serverless
            } else {
                Deployment::Unknown
            },
            cluster_uuid,
            fingerprint,
        })
    }

    pub fn failed(error: AppError) -> Result<Self, AppError> {
        Ok(Self {
            feedback: Feedback::failure(error)?,
            version: None,
            version_kind: VersionKind::Unrecognized,
            build_flavor: BuildFlavor::Unknown,
            deployment: Deployment::Unknown,
            cluster_uuid: None,
            fingerprint: None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum LicenseKind {
    Basic,
    Trial,
    Standard,
    Gold,
    Platinum,
    Enterprise,
    Missing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum LicenseState {
    Active,
    Expired,
    Invalid,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LicenseInfo {
    #[serde(flatten)]
    pub feedback: Feedback,
    pub kind: Option<LicenseKind>,
    pub state: Option<LicenseState>,
    /// Decimal text retains even a server timestamp outside JavaScript's safe integer range.
    pub expiry_time_ms: Option<String>,
}

#[derive(Deserialize)]
struct LicenseBody {
    license: LicenseFields,
}

#[derive(Deserialize)]
struct LicenseFields {
    #[serde(rename = "type")]
    kind: LicenseKind,
    status: LicenseState,
    expiry_date_in_millis: Option<u64>,
}

impl LicenseInfo {
    pub fn parse(bytes: &[u8]) -> Result<Self, AppError> {
        let body: LicenseBody =
            serde_json::from_slice(bytes).map_err(|_| AppError::new("invalidResponse"))?;
        Ok(Self {
            feedback: Feedback::status(AccessStatus::Available),
            kind: Some(body.license.kind),
            state: Some(body.license.status),
            expiry_time_ms: body
                .license
                .expiry_date_in_millis
                .map(|value| value.to_string()),
        })
    }

    pub fn failed(error: AppError) -> Result<Self, AppError> {
        Ok(Self {
            feedback: Feedback::failure(error)?,
            kind: None,
            state: None,
            expiry_time_ms: None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct FeatureFlags {
    pub available: bool,
    pub enabled: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FeatureInfo {
    #[serde(flatten)]
    pub feedback: Feedback,
    pub sql: Option<FeatureFlags>,
    pub eql: Option<FeatureFlags>,
    pub esql: Option<FeatureFlags>,
    pub graph: Option<FeatureFlags>,
}

#[derive(Deserialize)]
struct FeatureBody {
    features: FeatureFields,
}

#[derive(Deserialize)]
struct FeatureFields {
    sql: Option<FeatureFlags>,
    eql: Option<FeatureFlags>,
    esql: Option<FeatureFlags>,
    graph: Option<FeatureFlags>,
}

impl FeatureInfo {
    pub fn parse(bytes: &[u8]) -> Result<Self, AppError> {
        let body: FeatureBody =
            serde_json::from_slice(bytes).map_err(|_| AppError::new("invalidResponse"))?;
        Ok(Self {
            feedback: Feedback::status(AccessStatus::Available),
            sql: body.features.sql,
            eql: body.features.eql,
            esql: body.features.esql,
            graph: body.features.graph,
        })
    }

    pub fn failed(error: AppError) -> Result<Self, AppError> {
        Ok(Self {
            feedback: Feedback::failure(error)?,
            sql: None,
            eql: None,
            esql: None,
            graph: None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum CapabilityStatus {
    Unknown,
    Unsupported,
    Reported,
    Unlicensed,
    Disabled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum EvidenceSource {
    None,
    Version,
    Deployment,
    FeatureReport,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum EvidenceReason {
    NotProbed,
    VersionTooOld,
    Serverless,
    FeatureReported,
    FeatureMissing,
    DiagnosticFailed,
    ConflictingEvidence,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Capability {
    pub status: CapabilityStatus,
    pub source: EvidenceSource,
    pub reason: EvidenceReason,
    pub code: Option<&'static str>,
}

impl Capability {
    fn unprobed() -> Self {
        Self {
            status: CapabilityStatus::Unknown,
            source: EvidenceSource::None,
            reason: EvidenceReason::NotProbed,
            code: None,
        }
    }

    fn reported(flags: Option<FeatureFlags>, feedback: Feedback) -> Self {
        match flags {
            Some(flags) => Self {
                status: if !flags.enabled {
                    CapabilityStatus::Disabled
                } else if !flags.available {
                    CapabilityStatus::Unlicensed
                } else {
                    CapabilityStatus::Reported
                },
                source: EvidenceSource::FeatureReport,
                reason: EvidenceReason::FeatureReported,
                code: None,
            },
            None => Self {
                status: CapabilityStatus::Unknown,
                source: EvidenceSource::FeatureReport,
                reason: if feedback.status == AccessStatus::Available {
                    EvidenceReason::FeatureMissing
                } else {
                    EvidenceReason::DiagnosticFailed
                },
                code: feedback.code,
            },
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Capabilities {
    pub search: Capability,
    pub pit: Capability,
    pub sql: Capability,
    pub eql: Capability,
    pub esql: Capability,
    pub graph: Capability,
}

impl Capabilities {
    pub fn from_reports(server: &ServerInfo, features: &FeatureInfo) -> Self {
        let mut pit = Capability::unprobed();
        // PIT first appeared in 7.10. A later release is not proof that a target/API is usable.
        if server.version_kind == VersionKind::Release
            && matches!(server.build_flavor, BuildFlavor::Default | BuildFlavor::Oss)
            && server
                .version
                .as_deref()
                .and_then(exact_release)
                .is_some_and(|version| version.0 == 7 && version < (7, 10, 0))
        {
            pit = Capability {
                status: CapabilityStatus::Unsupported,
                source: EvidenceSource::Version,
                reason: EvidenceReason::VersionTooOld,
                code: None,
            };
        }
        let mut graph = Capability::reported(features.graph, features.feedback);
        if server.deployment == Deployment::Serverless {
            let conflict = features
                .graph
                .is_some_and(|flags| flags.available && flags.enabled);
            graph = Capability {
                status: if conflict {
                    CapabilityStatus::Unknown
                } else {
                    CapabilityStatus::Unsupported
                },
                source: EvidenceSource::Deployment,
                reason: if conflict {
                    EvidenceReason::ConflictingEvidence
                } else {
                    EvidenceReason::Serverless
                },
                code: None,
            };
        }
        Self {
            search: Capability::unprobed(),
            pit,
            sql: Capability::reported(features.sql, features.feedback),
            eql: Capability::reported(features.eql, features.feedback),
            esql: Capability::reported(features.esql, features.feedback),
            graph,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn server(version: &str, flavor: &str) -> ServerInfo {
        ServerInfo::parse(
            &serde_json::to_vec(&json!({
                "cluster_uuid":"fixture-cluster",
                "version":{"number":version,"build_flavor":flavor},
            }))
            .unwrap(),
        )
        .unwrap()
    }

    fn no_features() -> FeatureInfo {
        FeatureInfo::parse(br#"{"features":{}}"#).unwrap()
    }

    #[test]
    fn exact_release_is_not_a_major_version_support_claim() {
        for (version, status) in [
            ("7.9.3", CapabilityStatus::Unsupported),
            ("7.10.0", CapabilityStatus::Unknown),
            ("7.17.25", CapabilityStatus::Unknown),
            ("8.16.0", CapabilityStatus::Unknown),
            ("9.1.0", CapabilityStatus::Unknown),
            ("10.0.0", CapabilityStatus::Unknown),
            ("7.9.3-SNAPSHOT", CapabilityStatus::Unknown),
            ("7.09.3", CapabilityStatus::Unknown),
            ("+7.9.3", CapabilityStatus::Unknown),
            ("7.9", CapabilityStatus::Unknown),
            ("7.9.invalid", CapabilityStatus::Unknown),
            ("garbled", CapabilityStatus::Unknown),
        ] {
            let server = server(version, "default");
            let capabilities = Capabilities::from_reports(&server, &no_features());
            assert_eq!(capabilities.pit.status, status, "{version}");
            assert_eq!(capabilities.search.status, CapabilityStatus::Unknown);
            assert_eq!(server.version.as_deref(), Some(version));
            assert_eq!(server.deployment, Deployment::Unknown);
        }
        assert_eq!(
            Capabilities::from_reports(&server("7.9.3", "future"), &no_features())
                .pit
                .status,
            CapabilityStatus::Unknown
        );
        let snapshot = ServerInfo::parse(
            br#"{"version":{"number":"7.9.3","build_flavor":"default","build_snapshot":true}}"#,
        )
        .unwrap();
        assert_eq!(snapshot.version_kind, VersionKind::Unrecognized);
        assert!(snapshot.fingerprint.is_none());
    }

    #[test]
    fn serverless_is_explicit_and_its_version_never_drives_release_rules() {
        let server = server("7.9.3", "serverless");
        assert_eq!(server.deployment, Deployment::Serverless);
        assert_eq!(server.version_kind, VersionKind::Serverless);
        assert!(!server.requires_enterprise_parameter());
        let capabilities = Capabilities::from_reports(&server, &no_features());
        assert_eq!(capabilities.pit.status, CapabilityStatus::Unknown);
        assert_eq!(capabilities.graph.status, CapabilityStatus::Unsupported);
        assert_eq!(capabilities.graph.source, EvidenceSource::Deployment);
        let conflicting =
            FeatureInfo::parse(br#"{"features":{"graph":{"available":true,"enabled":true}}}"#)
                .unwrap();
        assert_eq!(
            Capabilities::from_reports(&server, &conflicting)
                .graph
                .reason,
            EvidenceReason::ConflictingEvidence
        );
    }

    #[test]
    fn legacy_enterprise_parameter_uses_an_exact_release_not_a_major_guess() {
        for (version, flavor, expected) in [
            ("7.5.2", "default", false),
            ("7.6.0", "default", true),
            ("7.17.25", "default", true),
            ("7.17.25-SNAPSHOT", "default", false),
            ("7.17.25", "unknown", false),
            ("7.17.25", "serverless", false),
            ("8.16.0", "default", false),
            ("9.1.0", "default", false),
        ] {
            assert_eq!(
                server(version, flavor).requires_enterprise_parameter(),
                expected
            );
        }
    }

    #[test]
    fn missing_metadata_has_no_reusable_identity_and_raw_extras_are_not_returned() {
        let info = ServerInfo::parse(
            br#"{"cluster_uuid":"_na_","secret":"fixture-secret","version":{"number":"8.16.0"}}"#,
        )
        .unwrap();
        assert!(info.cluster_uuid.is_none());
        assert!(info.fingerprint.is_none());
        assert_eq!(info.deployment, Deployment::Unknown);
        assert!(!serde_json::to_string(&info)
            .unwrap()
            .contains("fixture-secret"));
        for raw in [
            r#"{"version":{"number":""}}"#,
            r#"{"version":{"number":"8.16.0\n"}}"#,
            r#"{"version":{"number":"8.16.0","build_snapshot":"false"}}"#,
            r#"{"version":{"number":"8.16.0","number":"9.1.0"}}"#,
        ] {
            assert!(ServerInfo::parse(raw.as_bytes()).is_err());
        }
    }

    #[test]
    fn flags_are_reported_not_probed_and_do_not_use_license_tier_guesses() {
        let info = FeatureInfo::parse(
            br#"{"features":{
            "sql":{"available":true,"enabled":true},
            "eql":{"available":true,"enabled":false},
            "graph":{"available":false,"enabled":true},
            "ignored":{"secret":"fixture-secret"}
        }}"#,
        )
        .unwrap();
        let capabilities = Capabilities::from_reports(&server("8.16.0", "default"), &info);
        assert_eq!(capabilities.sql.status, CapabilityStatus::Reported);
        assert_eq!(capabilities.eql.status, CapabilityStatus::Disabled);
        assert_eq!(capabilities.graph.status, CapabilityStatus::Unlicensed);
        assert_eq!(capabilities.esql.status, CapabilityStatus::Unknown);
        assert_eq!(capabilities.esql.reason, EvidenceReason::FeatureMissing);
        assert!(!serde_json::to_string(&info)
            .unwrap()
            .contains("fixture-secret"));
        for raw in [
            r#"{}"#,
            r#"{"features":{"sql":{"available":"true","enabled":true}}}"#,
            r#"{"features":{"sql":{"available":true}}}"#,
            r#"{"features":{"sql":{"available":true,"available":false,"enabled":true}}}"#,
        ] {
            assert!(FeatureInfo::parse(raw.as_bytes()).is_err());
        }
    }

    #[test]
    fn expired_and_missing_license_facts_are_not_permission_denials() {
        for status in ["active", "expired", "invalid"] {
            let license = LicenseInfo::parse(
                &serde_json::to_vec(&json!({
                    "license":{"type":"trial","status":status,"expiry_date_in_millis":u64::MAX,
                        "uid":"excluded-uid","issued_to":"fixture-secret"},
                }))
                .unwrap(),
            )
            .unwrap();
            assert_eq!(license.feedback.status, AccessStatus::Available);
            assert_eq!(
                license.expiry_time_ms.as_deref(),
                Some("18446744073709551615")
            );
            let output = serde_json::to_string(&license).unwrap();
            assert!(!output.contains("fixture-secret"));
            assert!(!output.contains("excluded-uid"));
        }
        let permanent =
            LicenseInfo::parse(br#"{"license":{"type":"basic","status":"active"}}"#).unwrap();
        assert!(permanent.expiry_time_ms.is_none());
        for raw in [
            r#"{"license":null}"#,
            r#"{"license":{"type":"future","status":"active"}}"#,
            r#"{"license":{"type":"basic","status":"future"}}"#,
            r#"{"license":{"type":"trial","status":"active","expiry_date_in_millis":-1}}"#,
            r#"{"license":{"type":"trial","status":"active","expiry_date_in_millis":1.5}}"#,
        ] {
            assert!(LicenseInfo::parse(raw.as_bytes()).is_err());
        }
        let missing = LicenseInfo::failed(AppError::new("notFound")).unwrap();
        assert_eq!(missing.feedback.status, AccessStatus::Unknown);
        assert_eq!(missing.feedback.code, Some("notFound"));
    }

    #[test]
    fn probe_errors_remain_diagnostic_evidence_not_feature_denials() {
        for (code, status) in [
            ("serverForbidden", AccessStatus::Denied),
            ("authenticationFailed", AccessStatus::Denied),
            ("notFound", AccessStatus::Unknown),
            ("httpError", AccessStatus::Unknown),
            ("timeout", AccessStatus::Unknown),
            ("rateLimited", AccessStatus::Unknown),
            ("notElasticsearch", AccessStatus::Unknown),
            ("invalidResponse", AccessStatus::Unknown),
        ] {
            let features = FeatureInfo::failed(AppError::new(code)).unwrap();
            assert_eq!(features.feedback.status, status);
            let graph = Capabilities::from_reports(&server("8.16.0", "default"), &features).graph;
            assert_eq!(graph.status, CapabilityStatus::Unknown);
            assert_eq!(graph.reason, EvidenceReason::DiagnosticFailed);
            assert_eq!(graph.code, Some(code));
        }
        assert!(FeatureInfo::failed(AppError::new("cancelled")).is_err());
        assert!(LicenseInfo::failed(AppError::new("cancelled")).is_err());
        assert!(ServerInfo::failed(AppError::new("cancelled")).is_err());
    }
}
