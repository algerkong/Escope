//! Protocol adapters for the two supported wire formats.
//!
//! OpenAI-compatible Chat Completions is parsed as SSE (`choices[].delta.content`,
//! `finish_reason`, terminal `[DONE]`) with the maintained `eventsource-stream` parser; Ollama
//! `/api/chat` is parsed as NDJSON, framed on `\n` (which can never split a multibyte character)
//! with the raw cap bounding each line. Both adapters share the same request body (the validated
//! history followed by the current user prompt) and the same accumulation rules: text is preserved
//! exactly, sequence numbers count from 1, and nothing is reported as a successful answer unless
//! the provider's own termination marker and reason agree.
//!
//! Compatibility note: gateways in front of compatible providers send `"finish_reason": ""` on
//! every intermediate chunk. An empty string means "not finished yet", exactly like `null` and an
//! absent field; only a non-empty, supported reason terminates a stream, and a stream that never
//! reports one still fails as incomplete.

use super::ai_transport::{
    chat_body, chat_url, status_error, AiNetwork, AiTarget, GuardedBody, MAX_MODEL_CHARS,
};
use crate::ai::{AiChatDelta, AiChatMessage, AiChatOutcome, AiDeltaSink};
use crate::error::AppError;
use crate::read_only::Cancellation;
use crate::storage::ModelProtocol;
use bytes::Bytes;
use eventsource_stream::{EventStreamError, Eventsource};
use futures_util::Stream;
use futures_util::StreamExt;
use reqwest::header::HeaderValue;
use serde_json::Value;

/// The accumulated answer plus what the provider said about it.
#[derive(Debug)]
pub(crate) struct Completion {
    pub(crate) text: String,
    pub(crate) sequence: u32,
    pub(crate) actual_model_id: Option<String>,
    pub(crate) outcome: AiChatOutcome,
}

/// Everything one chat call sends: the identifiers the deltas carry, the prompt and its validated
/// history, and the sensitive header built from the approved credential. Grouped so the call site
/// cannot mix up two adjacent string parameters.
pub(crate) struct ChatPayload<'a> {
    pub(crate) request_id: &'a str,
    pub(crate) prompt: &'a str,
    pub(crate) history: &'a [AiChatMessage],
    pub(crate) bearer: Option<HeaderValue>,
}

/// Send the single approved prompt — preceded by the validated history when the request carries
/// one — and collect the streamed answer.
///
/// Everything the request will do is fixed before the socket opens: the target snapshot, the one
/// URL, the exact body, one permit and the overall deadline. The permit is released, the HTTP
/// future is dropped and the caller's registration guard is dropped on every exit path, including
/// cancellation, timeout and a dead delta channel.
///
/// The optional bearer header was built by the caller from the approved credential (the request
/// override or the saved reference for this exact target); it never enters the URL, the JSON body,
/// a delta, a response or an error.
pub(crate) async fn complete(
    network: &AiNetwork,
    target: &AiTarget,
    payload: ChatPayload<'_>,
    sink: &dyn AiDeltaSink,
    cancellation: &mut Cancellation,
) -> Result<Completion, AppError> {
    let ChatPayload {
        request_id,
        prompt,
        history,
        bearer,
    } = payload;
    let _permit = network.acquire()?;
    let url = chat_url(target)?;
    let body = chat_body(&target.model_id, prompt, history);
    let limits = *network.limits();
    let deadline = tokio::time::Instant::now() + limits.overall;
    let run = async {
        let response = tokio::select! {
            biased;
            // A cancel that races with a completed response is reported as cancelled: the user
            // asked to stop, and the answer is dropped rather than presented as fresh.
            () = cancellation.cancelled() => return Err(AppError::new("cancelled")),
            response = network.send(url, body, bearer) => response?,
        };
        let status = response.status();
        if !status.is_success() {
            // The provider's error body is never read, logged or returned.
            return Err(status_error(status));
        }
        let guarded = GuardedBody::new(
            Box::pin(response.bytes_stream()),
            limits.max_raw,
            limits.idle,
        );
        let mut state = Accumulator::new(sink, request_id, &target.profile_id, limits.max_text);
        let outcome = match target.protocol {
            ModelProtocol::OpenaiCompatible => {
                openai_sse(guarded, &mut state, cancellation).await?
            }
            ModelProtocol::Ollama => ollama_ndjson(guarded, &mut state, cancellation).await?,
        };
        Ok(state.into_completion(outcome))
    };
    // The overall deadline bounds connect, headers and the whole read in one window.
    match tokio::time::timeout_at(deadline, run).await {
        Ok(result) => result,
        Err(_) => Err(AppError::new("timeout")),
    }
}

/// The streamed answer under construction. It enforces the output cap and emits each piece once,
/// in order, with a sequence number counting from 1.
struct Accumulator<'a> {
    sink: &'a dyn AiDeltaSink,
    request_id: &'a str,
    model_profile_id: &'a str,
    max_text: usize,
    text: String,
    sequence: u32,
    actual_model: Option<String>,
}

impl<'a> Accumulator<'a> {
    fn new(
        sink: &'a dyn AiDeltaSink,
        request_id: &'a str,
        model_profile_id: &'a str,
        max_text: usize,
    ) -> Self {
        Self {
            sink,
            request_id,
            model_profile_id,
            max_text,
            text: String::new(),
            sequence: 0,
            actual_model: None,
        }
    }

    /// Record one text piece. The cap is checked before the piece is appended or emitted, and the
    /// text is preserved exactly: no trimming, no replacement. A channel delivery failure aborts
    /// the invocation as `cancelled`.
    fn push(&mut self, piece: &str) -> Result<(), AppError> {
        if piece.is_empty() {
            return Ok(());
        }
        if self.text.len() + piece.len() > self.max_text {
            return Err(AppError::new("responseTooLarge"));
        }
        self.sequence += 1;
        self.text.push_str(piece);
        self.sink.send(AiChatDelta {
            request_id: self.request_id.to_owned(),
            model_profile_id: self.model_profile_id.to_owned(),
            sequence: self.sequence,
            text: piece.to_owned(),
        })
    }

    /// Remember the model the provider reports. The first bounded name wins; a different name
    /// later in the same stream is a provider-side target change this client refuses, and an
    /// oversized name is ignored instead of being echoed.
    fn observe_model(&mut self, value: Option<&Value>) -> Result<(), AppError> {
        let Some(Value::String(model)) = value else {
            return Ok(());
        };
        if model.is_empty() || model.chars().count() > MAX_MODEL_CHARS {
            return Ok(());
        }
        match &self.actual_model {
            None => {
                self.actual_model = Some(model.clone());
                Ok(())
            }
            Some(known) if known == model => Ok(()),
            Some(_) => Err(AppError::new("aiUnsupportedResponse")),
        }
    }

    fn into_completion(self, outcome: AiChatOutcome) -> Completion {
        Completion {
            text: self.text,
            sequence: self.sequence,
            actual_model_id: self.actual_model,
            outcome,
        }
    }
}

/// Parse an OpenAI-compatible Chat Completions SSE stream.
///
/// The adapter is deliberately strict: choice index 0 (and only one choice), a string
/// `delta.content`, an assistant role, at most one supported `finish_reason` and the `[DONE]`
/// marker are all required for a complete answer. Provider error frames and `error` events,
/// malformed frames, repeated or conflicting terminations, text after a termination and
/// unsupported output all fail the invocation instead of pretending the partial text is the
/// answer; `[DONE]` is the only normal termination.
///
/// Gateways commonly send `"finish_reason": ""` on every intermediate chunk, so an empty string
/// is tolerated as nonterminal; a malformed or conflicting termination is still refused, and a
/// stream without a supported reason plus `[DONE]` still fails as incomplete.
async fn openai_sse<S>(
    body: GuardedBody<S>,
    state: &mut Accumulator<'_>,
    cancellation: &mut Cancellation,
) -> Result<AiChatOutcome, AppError>
where
    S: Stream<Item = Result<Bytes, reqwest::Error>> + Unpin,
{
    let mut events = body.eventsource();
    let mut finish: Option<AiChatOutcome> = None;
    loop {
        let next = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(AppError::new("cancelled")),
            next = events.next() => next,
        };
        let Some(event) = next else {
            // EOF without the terminal marker: the provider cut the stream.
            return Err(AppError::new("aiIncompleteStream"));
        };
        let event = match event {
            Ok(event) => event,
            Err(EventStreamError::Utf8(_) | EventStreamError::Parser(_)) => {
                return Err(AppError::new("invalidResponse"))
            }
            Err(EventStreamError::Transport(failure)) => return Err(failure.into_app_error()),
        };
        // Comments and keep-alives carry no data and are skipped by the parser. A typed event
        // other than `message` is a provider extension this client does not support, and an
        // `error` event is a provider failure that must never be silently ignored.
        if event.event == "error" {
            return Err(AppError::new("aiProviderError"));
        }
        if event.event != "message" {
            return Err(AppError::new("aiUnsupportedResponse"));
        }
        if event.data.is_empty() {
            continue;
        }
        if event.data == "[DONE]" {
            // Normal termination: only a stream that also reported a supported finish reason is
            // a complete answer.
            return finish.ok_or_else(|| AppError::new("aiIncompleteStream"));
        }
        let frame: Value =
            serde_json::from_str(&event.data).map_err(|_| AppError::new("invalidResponse"))?;
        if is_provider_error(&frame) {
            return Err(AppError::new("aiProviderError"));
        }
        let frame = frame
            .as_object()
            .ok_or_else(|| AppError::new("aiUnsupportedResponse"))?;
        state.observe_model(frame.get("model"))?;
        let Some(choices) = frame.get("choices") else {
            continue;
        };
        let Some(choices) = choices.as_array() else {
            return Err(AppError::new("aiUnsupportedResponse"));
        };
        // A usage-only frame has no choices; more than one choice is a shape this client does
        // not support (it only ever asks for one).
        if choices.len() > 1 {
            return Err(AppError::new("aiUnsupportedResponse"));
        }
        for choice in choices {
            if choice.get("index").and_then(Value::as_u64) != Some(0) {
                return Err(AppError::new("aiUnsupportedResponse"));
            }
            if let Some(delta) = choice.get("delta").filter(|delta| !delta.is_null()) {
                let Some(delta) = delta.as_object() else {
                    return Err(AppError::new("aiUnsupportedResponse"));
                };
                for unsupported in ["tool_calls", "function_call", "audio"] {
                    if content_present(delta.get(unsupported)) {
                        return Err(AppError::new("aiUnsupportedResponse"));
                    }
                }
                if let Some(role) = delta.get("role").filter(|role| !role.is_null()) {
                    if role.as_str() != Some("assistant") {
                        return Err(AppError::new("aiUnsupportedResponse"));
                    }
                }
                if let Some(content) = delta.get("content") {
                    match content {
                        Value::String(piece) if !piece.is_empty() => {
                            // No text delta may follow a reported termination.
                            if finish.is_some() {
                                return Err(AppError::new("aiUnsupportedResponse"));
                            }
                            state.push(piece)?;
                        }
                        Value::String(_) | Value::Null => {}
                        _ => return Err(AppError::new("aiUnsupportedResponse")),
                    }
                }
            }
            if let Some(reason) = choice.get("finish_reason").and_then(terminal_finish_reason) {
                // A repeated or conflicting termination is refused, never merged: a later
                // `stop` must not overwrite an earlier `length` or `content_filter`.
                if finish.is_some() {
                    return Err(AppError::new("aiUnsupportedResponse"));
                }
                let reason = reason
                    .as_str()
                    .ok_or_else(|| AppError::new("aiUnsupportedResponse"))?;
                finish = Some(match reason {
                    "stop" => AiChatOutcome::Complete,
                    "length" => AiChatOutcome::Length,
                    "content_filter" => AiChatOutcome::Filtered,
                    _ => return Err(AppError::new("aiUnsupportedResponse")),
                });
            }
        }
    }
}

/// Parse an Ollama `/api/chat` NDJSON stream.
///
/// Records are framed on `\n` with a trailing `\r` trimmed; a record is only decoded once
/// complete, so a chunk boundary inside a multibyte character is harmless. Completion requires
/// `done: true`; `done_reason` maps `stop`/`length`, an absent `done_reason` is accepted as a
/// normal stop for older servers, EOF without `done:true` is an incomplete stream, and an error
/// or unsupported record fails the invocation.
///
/// A final record may legally arrive at EOF without its trailing newline; it is decoded with the
/// same strict UTF-8 and JSON rules, so a truncated or malformed record still fails closed.
/// Cancellation is honoured between records of the same network chunk, so a stop that arrives
/// while earlier records are being handled can never become a success.
async fn ollama_ndjson<S>(
    mut body: GuardedBody<S>,
    state: &mut Accumulator<'_>,
    cancellation: &mut Cancellation,
) -> Result<AiChatOutcome, AppError>
where
    S: Stream<Item = Result<Bytes, reqwest::Error>> + Unpin,
{
    let mut buffer: Vec<u8> = Vec::new();
    loop {
        let next = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(AppError::new("cancelled")),
            next = body.next() => next,
        };
        let Some(chunk) = next else {
            // EOF: a last record may arrive without its trailing newline.
            let line = trim_line(std::mem::take(&mut buffer));
            if line.is_empty() {
                return Err(AppError::new("aiIncompleteStream"));
            }
            if let Some(outcome) = process_line(&line, state)? {
                if cancelled_now(cancellation).await {
                    return Err(AppError::new("cancelled"));
                }
                return Ok(outcome);
            }
            // A valid non-terminal record keeps its text, but the provider never said `done`.
            return Err(AppError::new("aiIncompleteStream"));
        };
        let chunk = chunk.map_err(|failure| failure.into_app_error())?;
        buffer.extend_from_slice(&chunk);
        while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = buffer.drain(..=newline).collect();
            let line = trim_line(line);
            if line.is_empty() {
                continue;
            }
            if cancelled_now(cancellation).await {
                return Err(AppError::new("cancelled"));
            }
            if let Some(outcome) = process_line(&line, state)? {
                // The terminal record itself may have emitted a last delta; a stop that arrived
                // meanwhile still wins over the completion.
                if cancelled_now(cancellation).await {
                    return Err(AppError::new("cancelled"));
                }
                return Ok(outcome);
            }
        }
    }
}

/// A non-blocking cancellation check, used between records that arrive in the same network
/// chunk. The watch channel keeps its value, so a cancel that arrived before the check is seen
/// even though nothing was polled in between.
async fn cancelled_now(cancellation: &mut Cancellation) -> bool {
    tokio::select! {
        biased;
        () = cancellation.cancelled() => true,
        () = std::future::ready(()) => false,
    }
}

/// Handle one NDJSON frame; `Some(outcome)` when the frame terminates the stream normally.
fn process_line(
    line: &[u8],
    state: &mut Accumulator<'_>,
) -> Result<Option<AiChatOutcome>, AppError> {
    let text = std::str::from_utf8(line).map_err(|_| AppError::new("invalidResponse"))?;
    let frame: Value = serde_json::from_str(text).map_err(|_| AppError::new("invalidResponse"))?;
    if is_provider_error(&frame) {
        return Err(AppError::new("aiProviderError"));
    }
    let frame = frame
        .as_object()
        .ok_or_else(|| AppError::new("aiUnsupportedResponse"))?;
    state.observe_model(frame.get("model"))?;
    if let Some(message) = frame.get("message").filter(|message| !message.is_null()) {
        let message = message
            .as_object()
            .ok_or_else(|| AppError::new("aiUnsupportedResponse"))?;
        if content_present(message.get("tool_calls")) || content_present(message.get("images")) {
            return Err(AppError::new("aiUnsupportedResponse"));
        }
        if let Some(role) = message.get("role").filter(|role| !role.is_null()) {
            if role.as_str() != Some("assistant") {
                return Err(AppError::new("aiUnsupportedResponse"));
            }
        }
        if let Some(content) = message.get("content") {
            match content {
                Value::String(piece) => state.push(piece)?,
                Value::Null => {}
                _ => return Err(AppError::new("aiUnsupportedResponse")),
            }
        }
    }
    // An absent `done` is not a terminal record (only EOF decides that it was incomplete); a
    // present but non-boolean value is a malformed frame.
    match frame.get("done") {
        None => {}
        Some(Value::Bool(true)) => {
            let outcome = match frame.get("done_reason") {
                None | Some(Value::Null) => AiChatOutcome::Complete,
                Some(Value::String(reason)) if reason == "stop" => AiChatOutcome::Complete,
                Some(Value::String(reason)) if reason == "length" => AiChatOutcome::Length,
                _ => return Err(AppError::new("aiUnsupportedResponse")),
            };
            return Ok(Some(outcome));
        }
        Some(Value::Bool(false)) => {}
        Some(_) => return Err(AppError::new("aiUnsupportedResponse")),
    }
    Ok(None)
}

/// A provider error frame: valid JSON with a non-null `error` member. The member is never read
/// into the error, only its presence is.
fn is_provider_error(frame: &Value) -> bool {
    frame.get("error").is_some_and(|error| !error.is_null())
}

/// Whether a `finish_reason` value is terminal. `null`, an absent field and the empty string that
/// gateways send on intermediate chunks all mean "not finished yet"; anything else — including a
/// number or an object — is handed on and then refused unless it is a supported reason string.
fn terminal_finish_reason(reason: &Value) -> Option<&Value> {
    match reason {
        Value::Null => None,
        Value::String(text) if text.is_empty() => None,
        _ => Some(reason),
    }
}

/// Whether an optional member carries content this client cannot render (tool output, images,
/// audio). An absent member, an explicit `null`, an empty array/object and an empty string are
/// placeholders that carry nothing; anything else — an actual tool call, image or audio payload —
/// is refused instead of being rendered or silently dropped.
fn content_present(value: Option<&Value>) -> bool {
    value.is_some_and(|value| match value {
        Value::Null => false,
        Value::Array(items) => !items.is_empty(),
        Value::Object(fields) => !fields.is_empty(),
        Value::String(text) => !text.is_empty(),
        _ => true,
    })
}

/// Drop the trailing `\n` of a drained line and a `\r` from CRLF separators.
fn trim_line(mut line: Vec<u8>) -> Vec<u8> {
    if line.last() == Some(&b'\n') {
        line.pop();
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    line
}
