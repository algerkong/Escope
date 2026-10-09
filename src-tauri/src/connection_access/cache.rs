//! Session-only report cache. Caller identities, privileges, secrets and authorization are never cached.

use super::capabilities::{FeatureInfo, LicenseInfo, ServerFingerprint};
use crate::error::AppError;
use crate::operation;
use crate::storage::{ConnectionAuth, TransportSnapshot};
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use uuid::Uuid;

pub(super) const REPORT_TTL: Duration = Duration::from_secs(60);
const MAX_ENTRIES: usize = 16;

#[derive(Clone, PartialEq, Eq)]
struct Binding {
    connection_id: String,
    endpoint: String,
    auth: ConnectionAuth,
    ca: Option<String>,
}

impl Binding {
    fn new(snapshot: &TransportSnapshot) -> Result<Self, AppError> {
        Ok(Self {
            connection_id: snapshot.profile().id.clone(),
            endpoint: operation::base_url(snapshot.profile())?.to_string(),
            auth: snapshot.profile().auth_state.clone(),
            ca: snapshot.ca().map(|ca| ca.as_pem().to_owned()),
        })
    }
}

pub(super) struct Ticket {
    binding: Binding,
    token: Uuid,
}

impl Ticket {
    pub fn matches(&self, snapshot: &TransportSnapshot) -> Result<bool, AppError> {
        Ok(self.binding == Binding::new(snapshot)?)
    }
}

#[derive(Clone)]
pub(super) struct Reports {
    pub license: LicenseInfo,
    pub features: FeatureInfo,
    pub observed_at: Instant,
    pub checked_at_ms: u64,
}

#[derive(Clone)]
struct Entry {
    fingerprint: ServerFingerprint,
    reports: Reports,
}

struct Slot {
    binding: Binding,
    token: Uuid,
    entry: Option<Entry>,
}

#[derive(Default)]
pub(crate) struct AccessCache(Mutex<VecDeque<Slot>>);

impl AccessCache {
    pub(super) fn begin(
        &self,
        snapshot: &TransportSnapshot,
        refresh: bool,
    ) -> Result<Ticket, AppError> {
        let binding = Binding::new(snapshot)?;
        let mut slots = self.0.lock().map_err(|_| AppError::new("busy"))?;
        let old = slots
            .iter()
            .position(|slot| slot.binding.connection_id == binding.connection_id)
            .and_then(|position| slots.remove(position));
        let entry = old
            .filter(|slot| slot.binding == binding && !refresh)
            .and_then(|slot| slot.entry);
        let token = Uuid::new_v4();
        slots.push_back(Slot {
            binding: binding.clone(),
            token,
            entry,
        });
        while slots.len() > MAX_ENTRIES {
            slots.pop_front();
        }
        Ok(Ticket { binding, token })
    }

    pub(super) fn load(
        &self,
        ticket: &Ticket,
        fingerprint: Option<&ServerFingerprint>,
        allowed: bool,
        now: Instant,
    ) -> Option<Reports> {
        let mut slots = self.0.lock().ok()?;
        let slot = slots.iter_mut().find(|slot| slot.token == ticket.token)?;
        let valid = allowed
            && slot.entry.as_ref().is_some_and(|entry| {
                Some(&entry.fingerprint) == fingerprint
                    && now.saturating_duration_since(entry.reports.observed_at) < REPORT_TTL
            });
        if !valid {
            slot.entry = None;
        }
        slot.entry.as_ref().map(|entry| entry.reports.clone())
    }

    pub(super) fn complete(
        &self,
        ticket: &Ticket,
        entry: Option<(ServerFingerprint, Reports)>,
    ) -> Result<(), AppError> {
        let mut slots = self.0.lock().map_err(|_| AppError::new("busy"))?;
        let slot = slots
            .iter_mut()
            .find(|slot| slot.token == ticket.token)
            .ok_or_else(|| AppError::new("diagnosticsStale"))?;
        slot.entry = entry.map(|(fingerprint, reports)| Entry {
            fingerprint,
            reports,
        });
        Ok(())
    }

    pub(super) fn discard(&self, ticket: &Ticket) {
        if let Ok(mut slots) = self.0.lock() {
            if let Some(slot) = slots.iter_mut().find(|slot| slot.token == ticket.token) {
                slot.entry = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection_access::capabilities::ServerInfo;
    use crate::connection_tls::{test_certificates, CaCertificate};
    use crate::credentials::CredentialRef;
    use crate::storage::{AuthKind, ConnectionInput, Database};

    fn snapshot() -> TransportSnapshot {
        let mut db = Database::open(std::path::Path::new(":memory:")).unwrap();
        let id = db
            .save_connection(
                ConnectionInput {
                    display_name: "Fixture".into(),
                    endpoint: "https://fixture.test/base".into(),
                    environment: "development".into(),
                },
                None,
            )
            .unwrap()
            .profile
            .id;
        db.transport_snapshot(&id).unwrap()
    }

    fn fingerprint(version: &str, cluster: &str) -> ServerFingerprint {
        ServerInfo::parse(
            &serde_json::to_vec(&serde_json::json!({
                "cluster_uuid":cluster,"version":{"number":version,"build_flavor":"default"}
            }))
            .unwrap(),
        )
        .unwrap()
        .fingerprint
        .unwrap()
    }

    fn reports(now: Instant) -> Reports {
        Reports {
            license: LicenseInfo::parse(br#"{"license":{"type":"basic","status":"active"}}"#)
                .unwrap(),
            features: FeatureInfo::parse(
                br#"{"features":{"graph":{"available":false,"enabled":true}}}"#,
            )
            .unwrap(),
            observed_at: now,
            checked_at_ms: 1_700_000_000_000,
        }
    }

    #[test]
    fn ttl_is_monotonic_and_cache_hits_do_not_extend_observation_time() {
        let snapshot = snapshot();
        let cache = AccessCache::default();
        let ticket = cache.begin(&snapshot, false).unwrap();
        let identity = fingerprint("8.16.0", "cluster-a");
        let now = Instant::now();
        cache
            .complete(&ticket, Some((identity.clone(), reports(now))))
            .unwrap();
        let hit = cache
            .load(
                &ticket,
                Some(&identity),
                true,
                now + Duration::from_secs(59),
            )
            .unwrap();
        assert_eq!(hit.observed_at, now);
        cache
            .complete(&ticket, Some((identity.clone(), hit)))
            .unwrap();
        assert!(cache
            .load(&ticket, Some(&identity), true, now + REPORT_TTL)
            .is_none());
    }

    #[test]
    fn denied_unknown_root_refresh_cluster_and_exact_version_invalidate_reports() {
        let snapshot = snapshot();
        let cache = AccessCache::default();
        let identity = fingerprint("8.16.0", "cluster-a");
        for (next, allowed) in [
            (Some(identity.clone()), false),
            (None, true),
            (Some(fingerprint("8.16.1", "cluster-a")), true),
            (Some(fingerprint("8.16.0", "cluster-b")), true),
        ] {
            let ticket = cache.begin(&snapshot, false).unwrap();
            cache
                .complete(&ticket, Some((identity.clone(), reports(Instant::now()))))
                .unwrap();
            assert!(cache
                .load(&ticket, next.as_ref(), allowed, Instant::now())
                .is_none());
            assert!(cache
                .load(&ticket, Some(&identity), true, Instant::now())
                .is_none());
        }
        let ticket = cache.begin(&snapshot, false).unwrap();
        cache
            .complete(&ticket, Some((identity.clone(), reports(Instant::now()))))
            .unwrap();
        let refreshed = cache.begin(&snapshot, true).unwrap();
        assert!(cache
            .load(&refreshed, Some(&identity), true, Instant::now())
            .is_none());
    }

    #[test]
    fn transport_binding_covers_id_endpoint_auth_reference_and_ca_but_not_name() {
        let original = snapshot();
        let cache = AccessCache::default();
        let identity = fingerprint("8.16.0", "cluster-a");
        let mut renamed = original.profile().clone();
        renamed.display_name = "Renamed".into();
        let renamed = TransportSnapshot::for_test(renamed);
        let ticket = cache.begin(&original, false).unwrap();
        assert!(ticket.matches(&renamed).unwrap());
        cache
            .complete(&ticket, Some((identity.clone(), reports(Instant::now()))))
            .unwrap();
        let after_rename = cache.begin(&renamed, false).unwrap();
        assert!(cache
            .load(&after_rename, Some(&identity), true, Instant::now())
            .is_some());
        let mut variants = Vec::new();
        let mut profile = original.profile().clone();
        profile.id = Uuid::new_v4().to_string();
        variants.push(TransportSnapshot::for_test(profile));
        let mut profile = original.profile().clone();
        profile.endpoint = "https://other.test/base".into();
        variants.push(TransportSnapshot::for_test(profile));
        for kind in [AuthKind::Basic, AuthKind::ApiKey, AuthKind::Bearer] {
            let mut profile = original.profile().clone();
            profile.auth_state = ConnectionAuth {
                kind,
                credential_ref: Some(CredentialRef::generate()),
            };
            variants.push(TransportSnapshot::for_test(profile));
        }
        variants.push(TransportSnapshot::for_test_with_ca(
            original.profile().clone(),
            CaCertificate::parse(test_certificates::ROOT_CA_3).unwrap(),
        ));
        for changed in variants {
            let ticket = cache.begin(&original, false).unwrap();
            cache
                .complete(&ticket, Some((identity.clone(), reports(Instant::now()))))
                .unwrap();
            assert!(!ticket.matches(&changed).unwrap());
            let next = cache.begin(&changed, false).unwrap();
            assert!(cache
                .load(&next, Some(&identity), true, Instant::now())
                .is_none());
        }
        let mut profile = original.profile().clone();
        profile.auth_state = ConnectionAuth {
            kind: AuthKind::Basic,
            credential_ref: Some(CredentialRef::generate()),
        };
        let authenticated = TransportSnapshot::for_test(profile.clone());
        let ticket = cache.begin(&authenticated, false).unwrap();
        profile.auth_state.credential_ref = Some(CredentialRef::generate());
        assert!(!ticket
            .matches(&TransportSnapshot::for_test(profile))
            .unwrap());
    }

    #[test]
    fn late_completion_and_cancel_cannot_overwrite_newer_intent() {
        let snapshot = snapshot();
        let cache = AccessCache::default();
        let identity = fingerprint("8.16.0", "cluster-a");
        let old = cache.begin(&snapshot, false).unwrap();
        let new = cache.begin(&snapshot, false).unwrap();
        cache
            .complete(&new, Some((identity.clone(), reports(Instant::now()))))
            .unwrap();
        assert_eq!(
            cache.complete(&old, None).unwrap_err().code,
            "diagnosticsStale"
        );
        cache.discard(&old);
        assert!(cache
            .load(&new, Some(&identity), true, Instant::now())
            .is_some());
        cache.discard(&new);
        assert!(cache
            .load(&new, Some(&identity), true, Instant::now())
            .is_none());
    }

    #[test]
    fn cache_has_a_fixed_session_bound() {
        let cache = AccessCache::default();
        for _ in 0..MAX_ENTRIES + 5 {
            cache.begin(&snapshot(), false).unwrap();
        }
        assert_eq!(cache.0.lock().unwrap().len(), MAX_ENTRIES);
    }
}
