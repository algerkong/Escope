//! In-flight read-only request lifecycle: registration, cancellation and release.
//!
//! Cancelling is a real backend action, not a frontend flag: the running HTTP future is dropped
//! and its concurrency permit and registration are released. It never claims that the
//! Elasticsearch-side task was terminated — a search that already reached the cluster may still
//! be running there — and the TCP connection itself is owned by the HTTP client, which may close
//! it asynchronously.

use crate::error::AppError;
use serde::Deserialize;
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use tokio::sync::watch;
use uuid::Uuid;

/// Finished IDs stay reserved for a bounded number of later requests, so a duplicate reuse is
/// refused without the registry growing with the session.
pub(crate) const MAX_COMPLETED: usize = 64;
/// Early cancels are remembered for a bounded number of pairs. A cancel only has to outlive the
/// IPC hop between `request_cancel` and the `query_execute` it belongs to.
pub(crate) const MAX_PENDING_CANCELS: usize = 64;

/// Cancellation is bound to the exact `(requestId, connectionId)` pair the request registered
/// with, so an early, late or cross-connection cancel can never touch a different request.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct RequestKey {
    request_id: String,
    connection_id: String,
}

impl RequestKey {
    fn new(request_id: &str, connection_id: &str) -> Self {
        Self {
            request_id: request_id.to_owned(),
            connection_id: connection_id.to_owned(),
        }
    }
}

/// Registry of the requests that can currently be cancelled through IPC.
///
/// The state is bounded in both directions: at most [`MAX_COMPLETED`] finished IDs and
/// [`MAX_PENDING_CANCELS`] early cancels are remembered, and the oldest entry is evicted first.
#[derive(Debug, Default)]
pub struct RequestRegistry {
    state: Mutex<RegistryState>,
}

#[derive(Debug, Default)]
struct RegistryState {
    slots: HashMap<RequestKey, Slot>,
    completed: VecDeque<RequestKey>,
    pending_cancels: VecDeque<RequestKey>,
}

/// What is known about one `(requestId, connectionId)` pair.
#[derive(Debug)]
enum Slot {
    /// In flight: cancelling signals this channel.
    Running(watch::Sender<bool>),
    /// A cancel arrived before the request registered. The next registration for this pair is
    /// refused with `cancelled` instead of sending anything to the cluster.
    Cancelled,
    /// Finished recently: the ID stays reserved so it cannot be reused for a second request.
    Completed,
}

impl RequestRegistry {
    /// Register one in-flight request.
    ///
    /// The handshake is what makes an early cancel real: a cancel that won the IPC race leaves a
    /// tombstone, and the registration it belongs to fails with `cancelled` before any plan is
    /// built. A duplicate of a running or recently finished ID fails with `duplicateRequest`
    /// instead of silently rebinding the cancel to the new request.
    pub fn register(
        &self,
        request_id: &str,
        connection_id: &str,
    ) -> Result<RequestGuard<'_>, AppError> {
        let key = RequestKey::new(request_id, connection_id);
        let (sender, receiver) = watch::channel(false);
        let mut state = self.state.lock().map_err(|_| AppError::new("busy"))?;
        match state.slots.get(&key) {
            Some(Slot::Cancelled) => {
                // Consume the tombstone: it applies to exactly this one start.
                state.slots.remove(&key);
                state.pending_cancels.retain(|pending| pending != &key);
                return Err(AppError::new("cancelled"));
            }
            Some(Slot::Running(_) | Slot::Completed) => {
                return Err(AppError::new("duplicateRequest"));
            }
            None => {}
        }
        state.slots.insert(key.clone(), Slot::Running(sender));
        Ok(RequestGuard {
            registry: self,
            key,
            cancellation: Cancellation { receiver },
        })
    }

    /// Cancel the request registered under this exact pair.
    ///
    /// `true` means the cancellation took effect: an in-flight request was signalled, or a
    /// not-yet-registered request for this pair was marked so it can never be sent. `false` means
    /// the request had already finished, so there was nothing left to cancel. A cancel never
    /// affects another request ID or another connection, and it is never remembered for one.
    pub fn cancel(&self, request_id: &str, connection_id: &str) -> bool {
        let key = RequestKey::new(request_id, connection_id);
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        match state.slots.get(&key) {
            Some(Slot::Running(sender)) => return sender.send(true).is_ok(),
            Some(Slot::Cancelled) => return true,
            Some(Slot::Completed) => return false,
            None => {}
        }
        state.slots.insert(key.clone(), Slot::Cancelled);
        state.pending_cancels.push_back(key);
        while state.pending_cancels.len() > MAX_PENDING_CANCELS {
            if let Some(evicted) = state.pending_cancels.pop_front() {
                if matches!(state.slots.get(&evicted), Some(Slot::Cancelled)) {
                    state.slots.remove(&evicted);
                }
            }
        }
        true
    }
}

/// Keeps one request cancellable for exactly as long as it is in flight.
#[derive(Debug)]
pub struct RequestGuard<'a> {
    registry: &'a RequestRegistry,
    key: RequestKey,
    cancellation: Cancellation,
}

impl RequestGuard<'_> {
    pub fn cancellation(&mut self) -> &mut Cancellation {
        &mut self.cancellation
    }
}

/// Dropping the guard marks the request finished: the entry stops being cancellable and the ID
/// stays reserved for a bounded window, so a late cancel cannot reach a later request and a
/// duplicate reuse is refused.
impl Drop for RequestGuard<'_> {
    fn drop(&mut self) {
        let Ok(mut state) = self.registry.state.lock() else {
            return;
        };
        if !matches!(state.slots.get(&self.key), Some(Slot::Running(_))) {
            return;
        }
        state.slots.insert(self.key.clone(), Slot::Completed);
        state.completed.push_back(self.key.clone());
        while state.completed.len() > MAX_COMPLETED {
            if let Some(evicted) = state.completed.pop_front() {
                if matches!(state.slots.get(&evicted), Some(Slot::Completed)) {
                    state.slots.remove(&evicted);
                }
            }
        }
    }
}

/// The cancellation channel of a single request.
#[derive(Debug)]
pub struct Cancellation {
    receiver: watch::Receiver<bool>,
}

impl Cancellation {
    /// A channel that can never fire, for requests that are not cancellable through IPC.
    pub fn never() -> Self {
        static NEVER: OnceLock<watch::Sender<bool>> = OnceLock::new();
        // The sender is a process-wide static, so the receiver can never be woken by a dropped
        // sender and `cancelled()` simply never resolves.
        let sender = NEVER.get_or_init(|| watch::channel(false).0);
        Self {
            receiver: sender.subscribe(),
        }
    }

    /// Resolves once this request is cancelled, or once its sender is gone (guard dropped).
    pub async fn cancelled(&mut self) {
        let _ = self.receiver.changed().await;
    }
}

/// `request_cancel` payload. Both identifiers are validated before they are looked up.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelRequest {
    pub request_id: String,
    pub connection_id: String,
}

impl CancelRequest {
    pub fn validate(&self) -> Result<(), AppError> {
        validate_uuid(&self.request_id)?;
        validate_uuid(&self.connection_id)
    }
}

/// Every request and connection identifier must be a UUID; anything else is refused before a
/// lookup or a network plan is built.
pub(crate) fn validate_uuid(value: &str) -> Result<(), AppError> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| AppError::new("invalidInput"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const REQUEST: &str = "6f3b2f1c-4f3e-4a5b-8c9d-0e1f2a3b4c5d";
    const CONNECTION: &str = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e";
    const OTHER_CONNECTION: &str = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5f";

    #[test]
    fn an_early_cancel_blocks_the_start_it_was_meant_for() {
        let registry = RequestRegistry::default();
        // The cancel arrives before the request registers: it is remembered, not dropped.
        assert!(registry.cancel(REQUEST, CONNECTION));
        assert_eq!(
            registry.register(REQUEST, CONNECTION).unwrap_err().code,
            "cancelled"
        );
        // It applied to exactly one start, so the next attempt is a normal request again.
        assert!(registry.register(REQUEST, CONNECTION).is_ok());
    }

    #[test]
    fn an_early_cancel_only_affects_its_own_pair() {
        let registry = RequestRegistry::default();
        assert!(registry.cancel(REQUEST, CONNECTION));
        assert!(registry.register(REQUEST, OTHER_CONNECTION).is_ok());
        assert!(registry
            .register("6f3b2f1c-4f3e-4a5b-8c9d-0e1f2a3b4c50", CONNECTION)
            .is_ok());
    }

    #[test]
    fn early_cancels_are_bounded_and_never_grow_without_limit() {
        let registry = RequestRegistry::default();
        let oldest = "6f3b2f1c-4f3e-4a5b-8c9d-000000000000".to_string();
        assert!(registry.cancel(&oldest, CONNECTION));
        let mut newest = String::new();
        for index in 1..=MAX_PENDING_CANCELS {
            newest = format!("6f3b2f1c-4f3e-4a5b-8c9d-{index:012}");
            assert!(registry.cancel(&newest, CONNECTION));
        }
        // The oldest tombstone was evicted; the newest still blocks its start.
        assert!(registry.register(&oldest, CONNECTION).is_ok());
        assert_eq!(
            registry.register(&newest, CONNECTION).unwrap_err().code,
            "cancelled"
        );
    }

    #[test]
    fn cancel_reports_accurately_for_running_pending_and_finished_requests() {
        let registry = RequestRegistry::default();
        let mut guard = registry.register(REQUEST, CONNECTION).unwrap();
        assert!(registry.cancel(REQUEST, CONNECTION));
        assert!(*guard.cancellation().receiver.borrow());
        // Still running: the cancel stays in effect and is reported again.
        assert!(registry.cancel(REQUEST, CONNECTION));
        drop(guard);
        // Finished: nothing was in flight, so a late cancel reports false and is not remembered.
        assert!(!registry.cancel(REQUEST, CONNECTION));
        // A request that never registered is reported as cancelled so the caller knows the
        // cancellation took effect, and it does not block an unrelated ID.
        assert!(registry.cancel("6f3b2f1c-4f3e-4a5b-8c9d-0e1f2a3b4c50", CONNECTION));
    }

    #[test]
    fn the_same_id_on_two_connections_never_shares_a_cancellation() {
        let registry = RequestRegistry::default();
        let mut first = registry.register(REQUEST, CONNECTION).unwrap();
        let second = registry.register(REQUEST, OTHER_CONNECTION).unwrap();
        assert!(registry.cancel(REQUEST, OTHER_CONNECTION));
        // The other connection's cancel never reaches this request.
        assert!(!*first.cancellation().receiver.borrow());
        drop(second);
        // Its own cancel still works, so the two entries stayed independent.
        assert!(registry.cancel(REQUEST, CONNECTION));
        assert!(*first.cancellation().receiver.borrow());
    }

    #[test]
    fn duplicate_in_flight_and_finished_ids_are_refused_and_retention_is_bounded() {
        let registry = RequestRegistry::default();
        let guard = registry.register(REQUEST, CONNECTION).unwrap();
        assert_eq!(
            registry.register(REQUEST, CONNECTION).unwrap_err().code,
            "duplicateRequest"
        );
        drop(guard);
        // A just-finished ID stays reserved instead of starting a second request with it.
        assert_eq!(
            registry.register(REQUEST, CONNECTION).unwrap_err().code,
            "duplicateRequest"
        );
        // The reservation window is bounded: enough newer completions release the ID again.
        for index in 0..=MAX_COMPLETED {
            let id = format!("6f3b2f1c-4f3e-4a5b-8c9d-{index:012}");
            drop(registry.register(&id, CONNECTION).unwrap());
        }
        assert!(registry.register(REQUEST, CONNECTION).is_ok());
    }

    #[tokio::test]
    async fn a_registered_cancellation_wakes_the_waiter_even_when_it_is_already_signalled() {
        let registry = RequestRegistry::default();
        let mut guard = registry.register(REQUEST, CONNECTION).unwrap();
        assert!(registry.cancel(REQUEST, CONNECTION));
        // Signalled before the waiter is created: `watch` keeps the value, so this must not hang.
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            guard.cancellation().cancelled(),
        )
        .await
        .expect("a cancel that arrives first must still be observed");
    }

    #[tokio::test]
    async fn a_never_cancellation_never_resolves() {
        let mut cancellation = Cancellation::never();
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(20),
            cancellation.cancelled()
        )
        .await
        .is_err());
    }

    #[test]
    fn cancel_requests_require_uuid_identifiers_and_reject_extra_fields() {
        let request: CancelRequest = serde_json::from_str(
            r#"{"requestId":"6f3b2f1c-4f3e-4a5b-8c9d-0e1f2a3b4c5d","connectionId":"1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e"}"#,
        )
        .unwrap();
        assert!(request.validate().is_ok());
        for payload in [
            r#"{"requestId":"secret","connectionId":"1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e"}"#,
            r#"{"requestId":"6f3b2f1c-4f3e-4a5b-8c9d-0e1f2a3b4c5d","connectionId":"secret"}"#,
        ] {
            let request: CancelRequest = serde_json::from_str(payload).unwrap();
            assert_eq!(request.validate().unwrap_err().code, "invalidInput");
        }
        // A caller cannot smuggle a target, method or header through the payload.
        assert!(serde_json::from_str::<CancelRequest>(
            r#"{"requestId":"6f3b2f1c-4f3e-4a5b-8c9d-0e1f2a3b4c5d","connectionId":"1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e","url":"https://example.test"}"#
        )
        .is_err());
    }
}
