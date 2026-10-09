//! HTTP transport for AI chat: the fixed POST, the bounded response stream and static errors.
//!
//! The client is built with the product's transport rules baked in: no redirects, no environment
//! proxy, normal TLS verification, a bounded connect timeout, at most two in-flight requests and
//! no retry logic. Everything the request may do is decided here from the saved target snapshot,
//! never from an approval payload.

use crate::ai::AiChatMessage;
use crate::credentials::CredentialRef;
use crate::error::AppError;
use crate::storage::ModelProtocol;
use bytes::Bytes;
use futures_util::Stream;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::sync::{Semaphore, SemaphorePermit};
use tokio::time::Sleep;
use url::Url;

/// Raw response bytes per stream, enforced on the stream that feeds the protocol parser so the
/// parser can never buffer past the cap.
pub(crate) const MAX_RAW_BYTES: usize = 1024 * 1024;
/// Accumulated answer text per stream.
pub(crate) const MAX_TEXT_BYTES: usize = 256 * 1024;
/// The streamed model name is display data and is bounded like the saved model id.
pub(crate) const MAX_MODEL_CHARS: usize = 200;

/// Transport limits. The production values are the product contract; tests override them to
/// exercise the expiry paths without waiting for real minutes.
#[derive(Clone, Copy, Debug)]
pub(crate) struct AiLimits {
    pub(crate) connect: Duration,
    pub(crate) overall: Duration,
    pub(crate) idle: Duration,
    pub(crate) max_raw: usize,
    pub(crate) max_text: usize,
    pub(crate) max_inflight: usize,
}

impl Default for AiLimits {
    fn default() -> Self {
        Self {
            connect: Duration::from_secs(10),
            overall: Duration::from_secs(120),
            idle: Duration::from_secs(30),
            max_raw: MAX_RAW_BYTES,
            max_text: MAX_TEXT_BYTES,
            max_inflight: 2,
        }
    }
}

/// The immutable routing snapshot of one approved chat target, taken from the saved profile.
#[derive(Clone, Debug)]
pub(crate) struct AiTarget {
    pub(crate) profile_id: String,
    pub(crate) protocol: ModelProtocol,
    pub(crate) endpoint: String,
    pub(crate) model_id: String,
    /// The trusted credential reference persisted for this profile, if any. Captured with the rest
    /// of the target, so a saved key is resolved for exactly this endpoint/protocol/model
    /// snapshot and a later edit can never redirect an in-flight request to another target.
    pub(crate) credential_ref: Option<CredentialRef>,
}

/// The shared defensive HTTP client: no redirects, no environment proxy, normal TLS certificate
/// verification, a bounded connect timeout and no protocol-NACK retries. Used by the chat
/// transport and by model discovery, so both cannot drift apart.
pub(crate) fn transport_client(connect_timeout: Duration) -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .no_proxy()
        // The client's default policy retries protocol NACKs; a prompt must never be resent by the
        // transport, not even when the failure looked retryable.
        .retry(reqwest::retry::never())
        .connect_timeout(connect_timeout)
        .user_agent("EScope/0.1.0")
        .build()
        .map_err(|_| AppError::new("networkError"))
}

/// One HTTP client with the transport rules applied, plus the shared in-flight permit pool.
pub(crate) struct AiNetwork {
    client: reqwest::Client,
    permits: Semaphore,
    limits: AiLimits,
}

impl AiNetwork {
    pub(crate) fn new() -> Result<Self, AppError> {
        Self::with_limits(AiLimits::default())
    }

    pub(crate) fn with_limits(limits: AiLimits) -> Result<Self, AppError> {
        Ok(Self {
            client: transport_client(limits.connect)?,
            permits: Semaphore::new(limits.max_inflight),
            limits,
        })
    }

    pub(crate) fn limits(&self) -> &AiLimits {
        &self.limits
    }

    /// Take one in-flight permit without waiting: a third concurrent chat is refused with `busy`
    /// instead of queueing behind the other two while holding its cancellation channel.
    pub(crate) fn acquire(&self) -> Result<SemaphorePermit<'_>, AppError> {
        self.permits
            .try_acquire()
            .map_err(|_| AppError::new("busy"))
    }

    /// Send the fixed JSON POST. The only caller-supplied header is the single-use bearer value
    /// built from the request's one-shot credential; nothing here retries, so one call is one
    /// request.
    pub(crate) async fn send(
        &self,
        url: Url,
        body: Vec<u8>,
        bearer: Option<reqwest::header::HeaderValue>,
    ) -> Result<reqwest::Response, AppError> {
        let mut request = self
            .client
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body);
        if let Some(bearer) = bearer {
            request = request.header(reqwest::header::AUTHORIZATION, bearer);
        }
        request
            .send()
            .await
            .map_err(|error| transport_error(&error))
    }
}

/// Build the one POST URL this profile may be sent to: the saved base URL including its path
/// prefix, plus the adapter's fixed append path. Scheme, host, userinfo, query and fragment are
/// all checked again here, so a corrupted profile can never turn into a request.
pub(crate) fn chat_url(target: &AiTarget) -> Result<Url, AppError> {
    let mut url = Url::parse(&target.endpoint).map_err(|_| AppError::new("invalidInput"))?;
    if !["http", "https"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::new("invalidInput"));
    }
    // Only the configured base path is preserved: the appended path is closed per protocol.
    let path = format!("{}/", url.path().trim_end_matches('/'));
    url.set_path(&path);
    let relative = match target.protocol {
        ModelProtocol::OpenaiCompatible => "chat/completions",
        ModelProtocol::Ollama => "api/chat",
    };
    url.join(relative)
        .map_err(|_| AppError::new("invalidInput"))
}

/// The exact request body: the validated history followed by the current user prompt, streamed,
/// and nothing else. No system prompt, tools, temperature or provider parameters, and every
/// message's bytes are sent unaltered.
pub(crate) fn chat_body(model_id: &str, prompt: &str, history: &[AiChatMessage]) -> Vec<u8> {
    let mut messages: Vec<serde_json::Value> = Vec::with_capacity(history.len() + 1);
    for message in history {
        messages.push(serde_json::json!({
            "role": message.role.as_str(),
            "content": message.content.as_str(),
        }));
    }
    messages.push(serde_json::json!({ "role": "user", "content": prompt }));
    serde_json::json!({
        "model": model_id,
        "messages": messages,
        "stream": true,
    })
    .to_string()
    .into_bytes()
}

/// Map a transport failure to a static code. reqwest's text and source chain can contain the full
/// URL, so they are never copied into the error.
pub(crate) fn transport_error(error: &reqwest::Error) -> AppError {
    AppError::new(if error.is_timeout() {
        "timeout"
    } else {
        "networkError"
    })
}

/// Map the response status to a static code without reading the provider's body. Redirects are
/// surfaced as such because the client never follows one.
pub(crate) fn status_error(status: reqwest::StatusCode) -> AppError {
    let code = match status {
        reqwest::StatusCode::UNAUTHORIZED => "authenticationFailed",
        reqwest::StatusCode::FORBIDDEN => "serverForbidden",
        reqwest::StatusCode::NOT_FOUND => "notFound",
        reqwest::StatusCode::TOO_MANY_REQUESTS => "rateLimited",
        status if status.is_redirection() => "redirectBlocked",
        _ => "httpError",
    };
    AppError::new(code)
}

/// A failure observed while reading the response body, before any protocol parsing.
#[derive(Debug)]
pub(crate) enum BodyFailure {
    /// The underlying HTTP read failed.
    Transport(reqwest::Error),
    /// The raw stream exceeded the byte cap.
    TooLarge,
    /// No chunk arrived for the idle window.
    Idle,
}

impl BodyFailure {
    pub(crate) fn into_app_error(self) -> AppError {
        match self {
            Self::Transport(error) => transport_error(&error),
            Self::TooLarge => AppError::new("responseTooLarge"),
            Self::Idle => AppError::new("timeout"),
        }
    }
}

/// Bounds the raw response stream. The byte cap and the idle window are enforced on the stream
/// that feeds the protocol parser, so neither the HTTP buffer nor the SSE/NDJSON framer can grow
/// past the cap, and a stalled provider fails after the idle window instead of hanging until the
/// overall deadline.
///
/// A chunk that does not fit in the remaining budget is rejected whole: handing the parser a
/// prefix of it could let a `[DONE]` or `done:true` inside that prefix complete the call and skip
/// the known size error. Only deltas from earlier, fully allowed chunks survive such a failure.
pub(crate) struct GuardedBody<S> {
    inner: S,
    seen: usize,
    max: usize,
    finished: bool,
    idle: Duration,
    timer: Option<Pin<Box<Sleep>>>,
}

impl<S> GuardedBody<S> {
    pub(crate) fn new(inner: S, max: usize, idle: Duration) -> Self {
        Self {
            inner,
            seen: 0,
            max,
            finished: false,
            idle,
            timer: None,
        }
    }
}

impl<S> Stream for GuardedBody<S>
where
    S: Stream<Item = Result<Bytes, reqwest::Error>> + Unpin,
{
    type Item = Result<Bytes, BodyFailure>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        if this.finished {
            return Poll::Ready(None);
        }
        if this.timer.is_none() {
            this.timer = Some(Box::pin(tokio::time::sleep(this.idle)));
        }
        if let Some(timer) = this.timer.as_mut() {
            if timer.as_mut().poll(cx).is_ready() {
                this.finished = true;
                return Poll::Ready(Some(Err(BodyFailure::Idle)));
            }
        }
        match Pin::new(&mut this.inner).poll_next(cx) {
            Poll::Ready(Some(Ok(chunk))) => {
                this.timer = None;
                if this.seen + chunk.len() > this.max {
                    this.seen = this.max;
                    this.finished = true;
                    return Poll::Ready(Some(Err(BodyFailure::TooLarge)));
                }
                this.seen += chunk.len();
                Poll::Ready(Some(Ok(chunk)))
            }
            Poll::Ready(Some(Err(error))) => {
                this.timer = None;
                this.finished = true;
                Poll::Ready(Some(Err(BodyFailure::Transport(error))))
            }
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}
