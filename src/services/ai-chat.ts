import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import {
  MAX_AI_API_KEY_BYTES, MAX_AI_CONTEXT_BYTES, MAX_AI_HISTORY_MESSAGES, MAX_AI_OUTPUT_BYTES, MAX_AI_PROMPT_BYTES,
  type AiChatAuthorization, type AiChatBackend, type AiChatCancelRequest, type AiChatDelta, type AiChatMessage,
  type AiChatOutcome, type AiChatRequest, type AiChatResponse,
} from '../domain/ai-chat';
import { modelProtocols, type ModelProtocol } from '../domain/models';
import type { ErrorCode } from './ipc';

/**
 * AI chat transport: a new message plus complete earlier exchanges for the selected target.
 *
 * The desktop implementation calls `ai_chat` with the frozen request and a per-invocation
 * `Channel<AiChatDelta>`, and `ai_chat_cancel` with the same request identity. Nothing here
 * reads a global event bus, a browser `fetch` or a fixture: the browser preview stays
 * `unsupported` and a failed desktop call is never answered from memory.
 *
 * A request may carry one optional single-use `apiKey` (the normal path omits it and lets the
 * backend use the profile's saved credential). It is forwarded only inside the `ai_chat` payload,
 * never to cancel, deltas or the result, it is dropped from the local payload as soon as the
 * invocation settles, and the caller's request object is never modified. Only printable ASCII
 * (0x21–0x7e, at most 2048 bytes) is accepted; user-configured HTTP or HTTPS endpoints are allowed
 * as configured, and transport risk is surfaced in the UI instead of being blocked here.
 *
 * The final response is the authoritative full result: its sequence must be at least the number
 * of deltas already observed and its text must start with the observed prefix, while a stream that
 * contradicts the final (a lower sequence or a different prefix) is rejected. Late channel events
 * after settlement are ignored, and failures are reduced to a whitelisted code bound to the
 * request id — raw errors or bad inputs are never echoed.
 */

export type AiChatErrorCode = ErrorCode
  | 'aiApprovalRequired' | 'aiTargetChanged' | 'credentialUnavailable' | 'credentialFailure' | 'credentialNotFound'
  | 'aiIncompleteStream' | 'aiUnsupportedResponse' | 'aiProviderError';

/** Structured failure: a whitelisted code, the request it is bound to, and nothing else. */
export interface AiChatError {
  code: AiChatErrorCode;
  requestId: string | null;
  retryable: boolean;
}

const knownCodes: ReadonlySet<string> = new Set<string>([
  'invalidInput', 'invalidName', 'invalidEndpoint', 'invalidEnvironment', 'invalidIndex', 'invalidQuery',
  'duplicateRequest', 'storageUnavailable', 'notFound', 'unsupported', 'permissionDenied', 'serverForbidden',
  'cancelled', 'busy', 'networkError', 'timeout', 'authenticationFailed', 'rateLimited', 'redirectBlocked',
  'httpError', 'notElasticsearch', 'responseTooLarge', 'invalidResponse',
  'credentialUnavailable', 'credentialFailure', 'credentialNotFound',
  'aiApprovalRequired', 'aiTargetChanged',
  'aiIncompleteStream', 'aiUnsupportedResponse', 'aiProviderError',
]);

/** UTF-8 size used by the prompt and output limits; kept here so both sides of the contract share it. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Safe code for anything thrown at this boundary: unknown shapes collapse, raw messages never leak. */
export function aiErrorCode(error: unknown): AiChatErrorCode {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && knownCodes.has(code) ? code as AiChatErrorCode : 'aiProviderError';
}

function fail(code: AiChatErrorCode, requestId: string | null): never {
  throw { code, requestId, retryable: false } satisfies AiChatError;
}

/** A rejected call keeps only the code, the request it answers and the retry hint. */
function safeFailure(failure: unknown, fallbackRequestId: string | null): AiChatError {
  const record = typeof failure === 'object' && failure !== null
    ? failure as { requestId?: unknown; retryable?: unknown } : null;
  const requestId = fallbackRequestId
    ?? (typeof record?.requestId === 'string' ? record.requestId : null);
  return {
    code: aiErrorCode(failure),
    requestId,
    retryable: typeof record?.retryable === 'boolean' ? record.retryable : false,
  };
}

/**
 * The only key shape this build accepts anywhere: printable ASCII 0x21–0x7e, nonempty,
 * at most 2048 bytes. Transport choice belongs to the user's configured endpoint, not here.
 */
export function isPrintableApiKey(apiKey: string): boolean {
  // Printable ASCII only, so the byte limit equals the code-unit limit.
  if (apiKey.length === 0 || apiKey.length > MAX_AI_API_KEY_BYTES) return false;
  for (let index = 0; index < apiKey.length; index += 1) {
    const code = apiKey.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const outcomes: readonly AiChatOutcome[] = ['complete', 'length', 'filtered'];
const requestKeys = ['requestId', 'modelProfileId', 'prompt', 'authorization'] as const;
const optionalRequestKeys = ['apiKey', 'history'] as const;
const allowedRequestKeys: readonly string[] = [...requestKeys, ...optionalRequestKeys];
const authorizationKeys = ['scope', 'protocol', 'endpoint', 'modelId'] as const;
const cancelKeys = ['requestId', 'modelProfileId'] as const;
const deltaKeys = ['requestId', 'modelProfileId', 'sequence', 'text'] as const;
const responseKeys = [
  'requestId', 'modelProfileId', 'protocol', 'endpoint', 'modelId', 'actualModelId', 'sequence', 'text', 'outcome',
] as const;

function closedRecord(value: unknown, keys: readonly string[], requestId: string | null): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalidInput', requestId);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !(key in record))) {
    fail('invalidInput', requestId);
  }
  return record;
}

function requireUuid(value: unknown, requestId: string | null): string {
  if (typeof value !== 'string' || !uuid.test(value)) fail('invalidInput', requestId);
  return value;
}

/** Non-blank text with a code-point limit; the stored string itself is returned unchanged. */
function requireTargetText(value: unknown, max: number, requestId: string | null): string {
  if (typeof value !== 'string' || value.trim() === '' || [...value].length > max) fail('invalidInput', requestId);
  return value;
}

function requireEndpoint(value: unknown, requestId: string | null): string {
  if (typeof value !== 'string' || value.length > 2048) fail('invalidInput', requestId);
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    fail('invalidInput', requestId);
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) || !endpoint.hostname
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    fail('invalidInput', requestId);
  }
  return value;
}

function requireAuthorization(value: unknown, requestId: string): AiChatAuthorization {
  const record = closedRecord(value, authorizationKeys, requestId);
  if (record.scope !== 'userTextOnly' && record.scope !== 'conversation') fail('invalidInput', requestId);
  if (!modelProtocols.includes(record.protocol as ModelProtocol)) fail('invalidInput', requestId);
  return {
    scope: record.scope,
    protocol: record.protocol as ModelProtocol,
    endpoint: requireEndpoint(record.endpoint, requestId),
    modelId: requireTargetText(record.modelId, 200, requestId),
  };
}

/** The validated request plus the key kept out of the shared request type while it is in use. */
interface CleanChatRequest {
  requestId: string;
  modelProfileId: string;
  prompt: string;
  authorization: AiChatAuthorization;
  history?: AiChatMessage[];
  apiKey: string | null;
}

function requireHistory(value: unknown, requestId: string, promptBytes: number): AiChatMessage[] {
  if (!Array.isArray(value) || value.length > MAX_AI_HISTORY_MESSAGES || value.length % 2 !== 0) {
    fail('invalidInput', requestId);
  }
  let bytes = promptBytes;
  const history: AiChatMessage[] = [];
  for (const [index, item] of value.entries()) {
    const message = closedRecord(item, ['role', 'content'], requestId);
    const role = index % 2 === 0 ? 'user' : 'assistant';
    if (message.role !== role || typeof message.content !== 'string' || message.content.trim() === '') {
      fail('invalidInput', requestId);
    }
    const size = utf8ByteLength(message.content);
    bytes += size;
    if (size > MAX_AI_OUTPUT_BYTES || bytes > MAX_AI_CONTEXT_BYTES) fail('invalidInput', requestId);
    history.push({ role, content: message.content });
  }
  return history;
}

/**
 * Closed request check: mandatory fields, optional history and key, nothing else. A rejected
 * request never reaches `invoke`, and no rejected value — the key included — is echoed back.
 */
function requireChatRequest(value: unknown): CleanChatRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalidInput', null);
  const record = value as Record<string, unknown>;
  if (requestKeys.some((key) => !(key in record))
    || Object.keys(record).some((key) => !allowedRequestKeys.includes(key))) {
    fail('invalidInput', null);
  }
  const requestId = requireUuid(record.requestId, null);
  const modelProfileId = requireUuid(record.modelProfileId, requestId);
  const prompt = record.prompt;
  if (typeof prompt !== 'string' || prompt.trim() === '' || utf8ByteLength(prompt) > MAX_AI_PROMPT_BYTES) {
    fail('invalidInput', requestId);
  }
  const authorization = requireAuthorization(record.authorization, requestId);
  const history = 'history' in record
    ? requireHistory(record.history, requestId, utf8ByteLength(prompt)) : undefined;
  if (history?.length && authorization.scope !== 'conversation') fail('invalidInput', requestId);
  let apiKey: string | null = null;
  if ('apiKey' in record) {
    if (typeof record.apiKey !== 'string' || !isPrintableApiKey(record.apiKey)) fail('invalidInput', requestId);
    apiKey = record.apiKey;
  }
  return { requestId, modelProfileId, prompt, authorization, history, apiKey };
}

function requireCancelRequest(value: unknown): AiChatCancelRequest {
  const record = closedRecord(value, cancelKeys, null);
  const requestId = requireUuid(record.requestId, null);
  const modelProfileId = requireUuid(record.modelProfileId, requestId);
  return { requestId, modelProfileId };
}

/**
 * One delta as a closed, identity-bound chunk: the sequence starts at 1 and continues by exactly
 * one, and empty chunks are not part of the contract.
 */
function readDelta(
  value: unknown, requestId: string, modelProfileId: string, lastSequence: number | null,
): AiChatDelta | AiChatErrorCode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'aiIncompleteStream';
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== deltaKeys.length || deltaKeys.some((key) => !(key in record))) {
    return 'aiIncompleteStream';
  }
  if (record.requestId !== requestId || record.modelProfileId !== modelProfileId) return 'aiIncompleteStream';
  const sequence = record.sequence;
  if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 1 || sequence > 1_000_000) {
    return 'aiIncompleteStream';
  }
  if (lastSequence === null ? sequence !== 1 : sequence !== lastSequence + 1) return 'aiIncompleteStream';
  if (typeof record.text !== 'string' || record.text === '' || record.text.length > MAX_AI_OUTPUT_BYTES) {
    return 'aiIncompleteStream';
  }
  return { requestId, modelProfileId, sequence, text: record.text };
}

/**
 * The final answer is authoritative: it must echo the exact approved target, cover every delta
 * already observed (sequence >= count, text starts with the observed prefix) and agree exactly
 * with the stream once it claims all chunks. Contradictions are refused; a larger sequence or a
 * longer matching text is the genuine completion arriving before the last channel delivery.
 */
function readResponse(
  value: unknown, requestId: string, modelProfileId: string,
  target: { protocol: ModelProtocol; endpoint: string; modelId: string },
  seenCount: number, seenText: string,
): AiChatResponse | AiChatErrorCode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'aiUnsupportedResponse';
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== responseKeys.length || responseKeys.some((key) => !(key in record))) {
    return 'aiUnsupportedResponse';
  }
  if (record.requestId !== requestId || record.modelProfileId !== modelProfileId) return 'aiUnsupportedResponse';
  if (record.protocol !== target.protocol || record.endpoint !== target.endpoint || record.modelId !== target.modelId) {
    return 'aiTargetChanged';
  }
  const actualModelId = record.actualModelId;
  if (actualModelId !== null
    && (typeof actualModelId !== 'string' || actualModelId.trim() === '' || [...actualModelId].length > 200)) {
    return 'aiUnsupportedResponse';
  }
  if (!outcomes.includes(record.outcome as AiChatOutcome)) return 'aiUnsupportedResponse';
  const sequence = record.sequence;
  if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 0 || sequence > 1_000_000) {
    return 'aiUnsupportedResponse';
  }
  const text = record.text;
  if (typeof text !== 'string' || utf8ByteLength(text) > MAX_AI_OUTPUT_BYTES) return 'aiIncompleteStream';
  if (sequence < seenCount) return 'aiIncompleteStream';
  if (!text.startsWith(seenText)) return 'aiIncompleteStream';
  // Claiming every chunk while the text differs means one of the two is not the real result.
  if (sequence === seenCount && text !== seenText) return 'aiIncompleteStream';
  return {
    requestId,
    modelProfileId,
    protocol: target.protocol,
    endpoint: target.endpoint,
    modelId: target.modelId,
    actualModelId: actualModelId as string | null,
    sequence,
    text,
    outcome: record.outcome as AiChatOutcome,
  };
}

/**
 * In-flight streams by request id. `cancel` stops the local stream (detaching the channel) before
 * asking the backend, so a settled or cancelled request can never be answered later.
 */
const activeStreams = new Map<string, { modelProfileId: string; abort: (code: AiChatErrorCode) => void }>();

function runChat(clean: CleanChatRequest, onDelta: (delta: AiChatDelta) => void): Promise<AiChatResponse> {
  const { requestId, modelProfileId, prompt, authorization } = clean;
  // The caller-owned request is never mutated: the payload is a fresh copy carrying the mandatory
  // fields, and the key is attached only while the invocation is outstanding.
  const payload: AiChatRequest = { requestId, modelProfileId, prompt, authorization: { ...authorization } };
  if (clean.history !== undefined) payload.history = clean.history;
  let apiKey: string | null = clean.apiKey;
  // The validated copy stops holding the key as soon as the payload does.
  clean.apiKey = null;
  if (apiKey !== null) payload.apiKey = apiKey;
  const target = { protocol: authorization.protocol, endpoint: authorization.endpoint, modelId: authorization.modelId };
  return new Promise<AiChatResponse>((resolve, reject) => {
    if (activeStreams.has(requestId)) {
      reject({ code: 'duplicateRequest', requestId, retryable: false } satisfies AiChatError);
      return;
    }
    let settled = false;
    let lastSequence: number | null = null;
    let count = 0;
    let streamed = '';
    let streamedBytes = 0;

    const dropKey = () => {
      apiKey = null;
      if (payload.apiKey !== undefined) delete payload.apiKey;
    };
    const detach = () => { channel.onmessage = () => {}; };
    const release = () => {
      if (activeStreams.get(requestId) === stream) activeStreams.delete(requestId);
    };
    const abort = (code: AiChatErrorCode, cancelBackend: boolean) => {
      if (settled) return;
      settled = true;
      detach();
      release();
      dropKey();
      if (cancelBackend) void cancelOnBackend(requestId, modelProfileId);
      reject({ code, requestId, retryable: false } satisfies AiChatError);
    };
    const channel = new Channel<AiChatDelta>((value) => {
      if (settled) return;
      const delta = readDelta(value, requestId, modelProfileId, lastSequence);
      if (typeof delta === 'string') {
        abort(delta, true);
        return;
      }
      const size = utf8ByteLength(delta.text);
      if (streamedBytes + size > MAX_AI_OUTPUT_BYTES) {
        abort('aiIncompleteStream', true);
        return;
      }
      lastSequence = delta.sequence;
      count += 1;
      streamedBytes += size;
      streamed += delta.text;
      try {
        // The consumer receives a validated copy; the stream itself keeps the raw text.
        onDelta({ requestId, modelProfileId, sequence: delta.sequence, text: delta.text });
      } catch {
        // A consumer callback must not break the transport.
      }
    });
    const stream = { modelProfileId, abort: (code: AiChatErrorCode) => abort(code, false) };
    activeStreams.set(requestId, stream);

    const rejectInvocation = (failure: unknown) => {
      if (settled) return;
      settled = true;
      detach();
      release();
      dropKey();
      reject(safeFailure(failure, requestId));
    };
    let invocation: Promise<unknown>;
    try {
      invocation = invoke<unknown>('ai_chat', { request: payload, onEvent: channel });
    } catch (failure) {
      rejectInvocation(failure);
      return;
    }
    void invocation.then(
      (value) => {
        if (settled) return;
        const response = readResponse(value, requestId, modelProfileId, target, count, streamed);
        if (typeof response === 'string') {
          abort(response, false);
          return;
        }
        settled = true;
        detach();
        release();
        dropKey();
        resolve(response);
      },
      rejectInvocation,
    );
  });
}

function cancelOnBackend(requestId: string, modelProfileId: string): Promise<unknown> {
  return invoke<unknown>('ai_chat_cancel', { request: { requestId, modelProfileId } }).catch(() => undefined);
}

/** Desktop in the app, `unsupported` in the browser preview — chosen once, never a fallback. */
export const desktopAiChatBackend: AiChatBackend = {
  get available() { return isTauri(); },
  chat: (request, onDelta) => {
    try {
      const clean = requireChatRequest(request);
      if (!isTauri()) fail('unsupported', clean.requestId);
      return runChat(clean, onDelta);
    } catch (failure) {
      return Promise.reject(safeFailure(failure, null));
    }
  },
  cancel: async (request) => {
    const clean = requireCancelRequest(request);
    if (!isTauri()) fail('unsupported', clean.requestId);
    // Stop the local stream first: a cancelled request must not keep receiving deltas or resolve.
    const stream = activeStreams.get(clean.requestId);
    if (stream && stream.modelProfileId === clean.modelProfileId) stream.abort('cancelled');
    let answer: unknown;
    try {
      answer = await invoke<unknown>('ai_chat_cancel', { request: clean });
    } catch (failure) {
      throw safeFailure(failure, clean.requestId);
    }
    if (typeof answer !== 'boolean') fail('invalidResponse', clean.requestId);
    return answer;
  },
};
