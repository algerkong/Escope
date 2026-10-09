//! A02.1/A04.1: direct AI chat with bounded, target-specific conversation history.
//!
//! Scope: the request's prompt — preceded by its validated history when the caller sends one — is
//! sent to the saved model profile the request names, and a streamed text answer is returned.
//! Everything else is out of scope and refused: no system prompt, no tools, no provider-specific
//! parameters, no credentials in the body, no fallback to another endpoint or protocol. History is
//! only ever the closed `user`/`assistant` transcript the frontend submitted for this exact target.
//!
//! Security boundaries:
//! - The send snapshot is checked against the exact saved target (`protocol`/`endpoint`/`modelId`) and
//!   its scope must cover the payload: `conversation`, or the legacy `userTextOnly` for requests
//!   without history. Routing is resolved only from the saved profile; the approval fields are
//!   never a target, so a stale send snapshot is refused before any socket is opened.
//! - Requests deny unknown fields, so a payload cannot smuggle headers, URLs, roles or extra
//!   parameters through the wire; the prompt and every history message are bounded before the
//!   request is registered or sent.
//! - The transport never follows a redirect, never uses an environment proxy, never retries and
//!   maps everything to static codes: provider error bodies, prompts, history and URLs never reach
//!   IPC.
//! - The saved credential is resolved from the system store for this exact target. An optional
//!   [`OneShotApiKey`] overrides it for one request only. Neither enters a request body, delta,
//!   response or error; production code never reads credentials from the environment.
//! - Cancellation is a real backend action on a registry of its own, scoped to
//!   `(requestId, modelProfileId)`, independent from the Elasticsearch request registry.

use crate::credentials::{CredentialStore, SystemCredentialStore};
use crate::error::AppError;
use crate::model_api_key::OneShotApiKey;
use crate::model_credentials::stored_bearer_header;
use crate::read_only::{validate_uuid, RequestRegistry};
use crate::storage::{ModelProfile, ModelProtocol};
use crate::{with_database, StorageState};
use serde::{Deserialize, Serialize};
use std::fmt;
use tauri::ipc::Channel;
use tauri::State;

#[path = "ai_protocol.rs"]
mod ai_protocol;
#[path = "ai_transport.rs"]
pub(crate) mod ai_transport;
#[cfg(test)]
#[path = "ai_tests.rs"]
mod tests;

use ai_transport::{AiNetwork, AiTarget};

/// Prompt bound in UTF-8 bytes, mirroring `MAX_AI_PROMPT_BYTES` in `src/domain/ai-chat.ts`.
pub(crate) const MAX_PROMPT_BYTES: usize = 64 * 1024;
/// History bounds mirroring `src/domain/ai-chat.ts`: at most [`MAX_HISTORY_MESSAGES`] alternating
/// messages, each at most [`MAX_HISTORY_MESSAGE_BYTES`], and history plus prompt at most
/// [`MAX_CONTEXT_BYTES`].
pub(crate) const MAX_HISTORY_MESSAGES: usize = 20;
pub(crate) const MAX_HISTORY_MESSAGE_BYTES: usize = 256 * 1024;
pub(crate) const MAX_CONTEXT_BYTES: usize = 512 * 1024;

/// The closed role list of a history message. A transcript can never become a system prompt, a
/// tool result or another provider role.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AiChatRole {
    User,
    Assistant,
}

impl AiChatRole {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
        }
    }
}

/// One validated history message. `deny_unknown_fields` keeps a payload from smuggling extra
/// provider fields into a history entry.
#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AiChatMessage {
    pub(crate) role: AiChatRole,
    pub(crate) content: String,
}

impl fmt::Debug for AiChatMessage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AiChatMessage")
            .field("role", &self.role)
            .field("content_bytes", &self.content.len())
            .finish()
    }
}

fn deserialize_history<'de, D>(deserializer: D) -> Result<Option<Vec<AiChatMessage>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Vec::<AiChatMessage>::deserialize(deserializer).map(Some)
}

/// One chat request. `deny_unknown_fields` is the smuggling barrier: a payload that carries
/// headers, a URL, extra roles or extra provider parameters is refused at the IPC edge instead of
/// being silently stripped.
///
/// `Debug` is manual because the prompt and the history are user text and the optional credential
/// is a secret: none of them may reach a log line through a derived formatter.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AiChatRequest {
    pub(crate) request_id: String,
    pub(crate) model_profile_id: String,
    pub(crate) prompt: String,
    pub(crate) authorization: AiChatAuthorization,
    /// Complete earlier exchanges for this target, oldest first. `None` and `[]` both mean a
    /// single-turn request; when present, the approval must be scoped to `conversation`.
    #[serde(default, deserialize_with = "deserialize_history")]
    pub(crate) history: Option<Vec<AiChatMessage>>,
    /// Single-use bearer credential for the one approved call. `None` for unauthenticated
    /// endpoints; never persisted, never reused across invocations.
    #[serde(default)]
    pub(crate) api_key: Option<OneShotApiKey>,
}

impl fmt::Debug for AiChatRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let history = self.history.as_deref().unwrap_or_default();
        let history_bytes: usize = history.iter().map(|message| message.content.len()).sum();
        f.debug_struct("AiChatRequest")
            .field("request_id", &self.request_id)
            .field("model_profile_id", &self.model_profile_id)
            .field("prompt_bytes", &self.prompt.len())
            .field("history_messages", &history.len())
            .field("history_bytes", &history_bytes)
            .field("api_key", &self.api_key.is_some())
            .finish()
    }
}

/// The exact target selected when the user sends. It never overrides the saved profile.
/// This contract does not require a confirmation dialog; `scope` must cover the payload:
/// `conversation` always, the legacy `userTextOnly` only for a request without history.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AiChatAuthorization {
    pub(crate) scope: String,
    pub(crate) protocol: ModelProtocol,
    pub(crate) endpoint: String,
    pub(crate) model_id: String,
}

/// `ai_chat_cancel` payload: the same pair the chat registered with.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AiChatCancelRequest {
    pub(crate) request_id: String,
    pub(crate) model_profile_id: String,
}

/// One streamed text piece. `sequence` counts from 1 across the invocation.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiChatDelta {
    pub(crate) request_id: String,
    pub(crate) model_profile_id: String,
    pub(crate) sequence: u32,
    pub(crate) text: String,
}

/// How the provider reported the end of the answer.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AiChatOutcome {
    Complete,
    Length,
    Filtered,
}

/// The accumulated result of one chat invocation. Field names and order match
/// `tests/fixtures/ai-chat-response.json`; `Deserialize` exists so the fixture can be pinned from
/// the Rust side too.
#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AiChatResponse {
    pub(crate) request_id: String,
    pub(crate) model_profile_id: String,
    pub(crate) protocol: ModelProtocol,
    pub(crate) endpoint: String,
    pub(crate) model_id: String,
    pub(crate) actual_model_id: Option<String>,
    pub(crate) sequence: u32,
    pub(crate) text: String,
    pub(crate) outcome: AiChatOutcome,
}

impl AiChatRequest {
    /// Refuse a malformed request before any lookup, registration or socket. Prompts and history
    /// are measured but never altered: the exact approved bytes are what gets sent.
    fn validate(&self) -> Result<(), AppError> {
        validate_uuid(&self.request_id)?;
        validate_uuid(&self.model_profile_id)?;
        if self.prompt.trim().is_empty() || self.prompt.len() > MAX_PROMPT_BYTES {
            return Err(AppError::new("invalidInput"));
        }
        if self.authorization.scope != "conversation"
            && (self.authorization.scope != "userTextOnly" || self.has_history())
        {
            return Err(AppError::new("aiApprovalRequired"));
        }
        self.validate_history()
    }

    /// History is a complete alternating transcript: none at all, or 1..=[`MAX_HISTORY_MESSAGES`]
    /// messages in `user`/`assistant` pairs that start with `user` and end with `assistant`. Every
    /// message is non-blank and bounded, and history plus prompt stays within [`MAX_CONTEXT_BYTES`],
    /// so a request can never grow the outbound body past the pinned contract.
    fn validate_history(&self) -> Result<(), AppError> {
        let Some(history) = self.history.as_deref() else {
            return Ok(());
        };
        if history.is_empty() {
            return Ok(());
        }
        if history.len() > MAX_HISTORY_MESSAGES || history.len() % 2 != 0 {
            return Err(AppError::new("invalidInput"));
        }
        let mut total = self.prompt.len();
        for (index, message) in history.iter().enumerate() {
            let expected = if index % 2 == 0 {
                AiChatRole::User
            } else {
                AiChatRole::Assistant
            };
            if message.role != expected
                || message.content.trim().is_empty()
                || message.content.len() > MAX_HISTORY_MESSAGE_BYTES
            {
                return Err(AppError::new("invalidInput"));
            }
            total += message.content.len();
        }
        if total > MAX_CONTEXT_BYTES {
            return Err(AppError::new("invalidInput"));
        }
        Ok(())
    }

    /// Whether the payload carries a real transcript, which decides which scopes cover it.
    fn has_history(&self) -> bool {
        self.history
            .as_ref()
            .is_some_and(|history| !history.is_empty())
    }

    /// The validated history to send ahead of the prompt.
    fn history(&self) -> &[AiChatMessage] {
        self.history.as_deref().unwrap_or_default()
    }
}

impl AiChatCancelRequest {
    fn validate(&self) -> Result<(), AppError> {
        validate_uuid(&self.request_id)?;
        validate_uuid(&self.model_profile_id)
    }
}

/// Where deltas go while the answer streams. The production implementation is the per-invocation
/// IPC channel; a delivery failure means the UI is gone, so it is reported as `cancelled` and the
/// local HTTP request is dropped instead of running on or being claimed as complete.
pub(crate) trait AiDeltaSink: Send + Sync {
    fn send(&self, delta: AiChatDelta) -> Result<(), AppError>;
}

impl AiDeltaSink for Channel<AiChatDelta> {
    fn send(&self, delta: AiChatDelta) -> Result<(), AppError> {
        Channel::send(self, delta).map_err(|_| AppError::new("cancelled"))
    }
}

/// Backend state for AI chat: one HTTP client with its own pool, concurrency limit and timeouts,
/// one cancellation registry scoped by `(requestId, modelProfileId)`, and the credential backend
/// used to resolve saved model keys.
///
/// The registry is deliberately independent from the Elasticsearch `RequestState`: cancelling an
/// AI chat can never touch a query and vice versa, even when the two identifiers collide. The
/// credential backend is the real OS store in production and an injected store in tests, so the
/// saved-key path never falls back to plaintext or a session value.
pub struct AiState {
    pub(crate) network: Result<AiNetwork, AppError>,
    pub(crate) requests: RequestRegistry,
    pub(crate) credentials: Box<dyn CredentialStore>,
}

impl AiState {
    pub fn new() -> Self {
        Self {
            network: AiNetwork::new(),
            requests: RequestRegistry::default(),
            credentials: Box::new(SystemCredentialStore::new()),
        }
    }
}

/// Stream one approved chat completion over the per-invocation channel. The request carries the
/// single user prompt and, when the caller has one, the bounded conversation history that
/// precedes it.
#[tauri::command]
pub(crate) async fn ai_chat(
    state: State<'_, StorageState>,
    ai: State<'_, AiState>,
    request: AiChatRequest,
    on_event: Channel<AiChatDelta>,
) -> Result<AiChatResponse, AppError> {
    // Identifiers are validated before the error mapper exists: an invalid ID must never be
    // reflected back through IPC.
    request.validate()?;
    let request_id = request.request_id.clone();
    let result = chat(&state, &ai, request, &on_event).await;
    result.map_err(|mut error: AppError| {
        error.request_id = Some(request_id);
        error
    })
}

/// Cancel the chat registered under this exact `(requestId, modelProfileId)` pair.
///
/// `true` means the cancellation took effect: an in-flight stream is signalled, or a chat that has
/// not registered yet is marked so it can never be sent. `false` means the chat had already
/// finished. A cancel never affects another pair, and an AI cancel never reaches an Elasticsearch
/// request.
#[tauri::command]
pub(crate) fn ai_chat_cancel(
    ai: State<'_, AiState>,
    request: AiChatCancelRequest,
) -> Result<bool, AppError> {
    request.validate()?;
    Ok(ai
        .requests
        .cancel(&request.request_id, &request.model_profile_id))
}

/// The command body without the IPC wrapper, so tests can drive the exact same flow.
async fn chat(
    storage: &StorageState,
    ai: &AiState,
    request: AiChatRequest,
    sink: &dyn AiDeltaSink,
) -> Result<AiChatResponse, AppError> {
    // Validated here as well as in the IPC wrapper: the shared path is the one tests exercise,
    // and a direct caller must never skip the identifier, prompt or scope checks.
    request.validate()?;
    // Registered before any lookup or I/O: an early cancel blocks this start, and a duplicate ID
    // can never hijack the running request's cancellation or its result.
    let mut guard = ai
        .requests
        .register(&request.request_id, &request.model_profile_id)?;
    let target = resolve_target(storage, &request)?;
    // The credential is decided for exactly this snapshot: the request's single-use override wins,
    // otherwise the reference persisted for this profile is resolved from the trusted store. No
    // other profile's reference, no environment value and no other target can be used here.
    let bearer = match request.api_key.as_ref() {
        Some(key) => Some(key.bearer_header()?),
        None => match target.credential_ref.as_ref() {
            Some(reference) => Some(stored_bearer_header(ai.credentials.as_ref(), reference)?),
            None => None,
        },
    };
    let network = ai.network.as_ref().map_err(Clone::clone)?;
    let completion = ai_protocol::complete(
        network,
        &target,
        ai_protocol::ChatPayload {
            request_id: &request.request_id,
            prompt: &request.prompt,
            history: request.history(),
            bearer,
        },
        sink,
        guard.cancellation(),
    )
    .await?;
    Ok(AiChatResponse {
        request_id: request.request_id,
        model_profile_id: target.profile_id,
        protocol: target.protocol,
        endpoint: target.endpoint,
        model_id: target.model_id,
        actual_model_id: completion.actual_model_id,
        sequence: completion.sequence,
        text: completion.text,
        outcome: completion.outcome,
    })
}

/// Read the saved profile by stable ID and check the approval against it. The routing snapshot is
/// taken from the saved profile only; the approval fields are never used as a target.
fn resolve_target(storage: &StorageState, request: &AiChatRequest) -> Result<AiTarget, AppError> {
    let profiles = with_database(storage, |db| db.models())?.profiles;
    let profile = profiles
        .into_iter()
        .find(|profile| profile.id == request.model_profile_id)
        .ok_or_else(|| AppError::new("notFound"))?;
    check_approval(&request.authorization, request.has_history(), &profile)?;
    Ok(AiTarget {
        profile_id: profile.id,
        protocol: profile.protocol,
        endpoint: profile.endpoint,
        model_id: profile.model_id,
        credential_ref: profile.credential_ref,
    })
}

/// The approval is valid exactly when its scope covers the payload — `conversation` always, the
/// legacy `userTextOnly` only for a request without history — and it names the same protocol,
/// endpoint and model id as the saved profile, and nothing else. Editing the profile invalidates
/// earlier send snapshots; the caller must reload the current configuration.
fn check_approval(
    authorization: &AiChatAuthorization,
    has_history: bool,
    profile: &ModelProfile,
) -> Result<(), AppError> {
    let scope_covers_payload = match authorization.scope.as_str() {
        "conversation" => true,
        "userTextOnly" => !has_history,
        _ => false,
    };
    if !scope_covers_payload {
        return Err(AppError::new("aiApprovalRequired"));
    }
    if authorization.protocol != profile.protocol
        || authorization.endpoint != profile.endpoint
        || authorization.model_id != profile.model_id
    {
        return Err(AppError::new("aiTargetChanged"));
    }
    Ok(())
}
