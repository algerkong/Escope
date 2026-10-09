import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  MAX_AI_API_KEY_BYTES, MAX_AI_CONTEXT_BYTES, MAX_AI_HISTORY_MESSAGES, MAX_AI_OUTPUT_BYTES, MAX_AI_PROMPT_BYTES,
} from '../../src/domain/ai-chat';
import type {
  AiChatCancelRequest, AiChatDelta, AiChatRequest, AiChatResponse,
} from '../../src/domain/ai-chat';
import { aiErrorCode, desktopAiChatBackend, isPrintableApiKey, utf8ByteLength } from '../../src/services/ai-chat';
import fixtureRequest from '../fixtures/ai-chat-request.json';
import fixtureResponse from '../fixtures/ai-chat-response.json';
import conversationRequest from '../fixtures/ai-conversation-request.json';

interface FakeChannel {
  onmessage: (value: unknown) => void;
}

// The Channel double is pushed here instead of being returned, so tests can drive the stream that
// the service handed to `invoke` exactly the way the Tauri bridge would.
const { channels } = vi.hoisted(() => ({ channels: [] as FakeChannel[] }));

vi.mock('@tauri-apps/api/core', () => {
  class MockChannel<T> {
    id = 1;
    onmessage: (value: T) => void;
    constructor(onmessage: (value: T) => void) {
      this.onmessage = onmessage;
      channels.push(this as unknown as FakeChannel);
    }
  }
  return { invoke: vi.fn(), isTauri: vi.fn(), Channel: MockChannel };
});

const request = fixtureRequest as unknown as AiChatRequest;
const response = fixtureResponse as unknown as AiChatResponse;
/** Clearly fictitious token; never a real credential. */
const FIXTURE_KEY = 'fixture-one-shot-token';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (failure: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/** Answers `ai_chat` with a promise the test settles, and records cancel calls. */
function answerChat() {
  const chat = deferred<unknown>();
  const cancels: unknown[] = [];
  vi.mocked(invoke).mockImplementation((async (command: string, args?: unknown) => {
    if (command === 'ai_chat') return chat.promise;
    if (command === 'ai_chat_cancel') {
      cancels.push(args);
      return true;
    }
    throw new Error(`unexpected command ${command}`);
  }));
  return { chat, cancels };
}

/** The channel of the most recent `chat` call. */
function lastChannel(): FakeChannel {
  return channels[channels.length - 1]!;
}

/** The request payload of the most recent `chat` call. */
function sentRequest(): AiChatRequest {
  const call = vi.mocked(invoke).mock.calls.filter((entry) => entry[0] === 'ai_chat').pop();
  return (call?.[1] as { request: AiChatRequest }).request;
}

const delta = (sequence: number, text: string, identity: Partial<AiChatDelta> = {}): AiChatDelta => ({
  requestId: request.requestId, modelProfileId: request.modelProfileId, sequence, text, ...identity,
});

const responseWith = (patch: Partial<AiChatResponse>): AiChatResponse => ({ ...response, ...patch });

beforeEach(() => {
  vi.resetAllMocks();
  channels.length = 0;
  vi.mocked(isTauri).mockReturnValue(true);
});

describe('ai chat IPC', () => {
  it('sends the frozen request with a per-request channel and returns the validated response', async () => {
    const { chat } = answerChat();
    const received: AiChatDelta[] = [];
    const pending = desktopAiChatBackend.chat(request, (value) => received.push(value));
    const channel = lastChannel();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('ai_chat', { request, onEvent: channel });

    const handler = channel.onmessage;
    handler(delta(1, response.text));
    expect(received).toEqual([delta(1, response.text)]);
    chat.resolve(response);
    await expect(pending).resolves.toEqual(response);
    // The handler is released on settlement, and replaying the old handler stays ignored.
    expect(channel.onmessage).not.toBe(handler);
    handler(delta(2, 'late'));
    expect(received).toHaveLength(1);
  });

  it('treats the final as the authoritative result when it arrives before the last chunk', async () => {
    const { chat } = answerChat();
    const received: AiChatDelta[] = [];
    const pending = desktopAiChatBackend.chat(request, (value) => received.push(value));
    const handler = lastChannel().onmessage;
    handler(delta(1, 'A term '));
    handler(delta(2, 'query matches '));
    const final = responseWith({ sequence: 3, text: response.text });
    chat.resolve(final);
    await expect(pending).resolves.toEqual(final);
    expect(received.map((event) => event.sequence)).toEqual([1, 2]);

    // The third chunk may still be delivered by the bridge; it is late and ignored.
    handler(delta(3, 'an exact value.'));
    expect(received).toHaveLength(2);
  });

  it('accepts a final that arrives without any channel event', async () => {
    const { chat } = answerChat();
    const received: AiChatDelta[] = [];
    const pending = desktopAiChatBackend.chat(request, (value) => received.push(value));
    chat.resolve(response);
    await expect(pending).resolves.toEqual(response);
    expect(received).toHaveLength(0);
  });

  it('never invokes a malformed or oversized request', async () => {
    const cases: unknown[] = [
      { ...request, prompt: '' },
      { ...request, prompt: '   ' },
      { ...request, prompt: 'é'.repeat(MAX_AI_PROMPT_BYTES / 2 + 1) },
      { ...request, requestId: 'not-a-uuid' },
      { ...request, extra: 'field' },
      { ...request, authorization: { ...request.authorization, scope: 'everything' } },
      { ...request, authorization: { ...request.authorization, protocol: 'grpc' } },
      { ...request, authorization: { ...request.authorization, endpoint: 'http://a.test/?key=1' } },
      { ...request, authorization: { ...request.authorization, modelId: '   ' } },
    ];
    for (const value of cases) {
      const pending = desktopAiChatBackend.chat(value as AiChatRequest, () => {});
      await expect(pending).rejects.toMatchObject({ code: 'invalidInput', retryable: false });
    }
    expect(utf8ByteLength('é'.repeat(MAX_AI_PROMPT_BYTES / 2 + 1))).toBeGreaterThan(MAX_AI_PROMPT_BYTES);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('forwards a bounded conversation as a frozen copy with the shared contract', async () => {
    const caller = structuredClone(conversationRequest) as AiChatRequest;
    const snapshot = structuredClone(caller);
    const { chat } = answerChat();
    const pending = desktopAiChatBackend.chat(caller, () => {});
    expect(sentRequest()).toEqual(snapshot);
    expect(sentRequest().history).not.toBe(caller.history);
    caller.history![0]!.content = 'changed after sending';
    expect(sentRequest()).toEqual(snapshot);
    chat.resolve(response);
    await expect(pending).resolves.toEqual(response);
  });

  it('rejects invalid history without sending or exposing its contents', async () => {
    const conversation = conversationRequest as AiChatRequest;
    const user = { role: 'user', content: 'private-user-text' };
    const assistant = { role: 'assistant', content: 'private-assistant-text' };
    const cases: unknown[] = [
      null, undefined, {}, [user], [assistant, user], [user, user],
      [{ ...user, role: 'system' }, assistant],
      [{ ...user, content: '' }, assistant],
      [user, { ...assistant, content: ' \n ' }],
      [{ ...user, headers: { authorization: 'fixture-secret' } }, assistant],
      [{ ...user, content: 123 }, assistant],
      [user, { ...assistant, content: 'x'.repeat(MAX_AI_OUTPUT_BYTES + 1) }],
      Array.from({ length: MAX_AI_HISTORY_MESSAGES + 2 }, (_, index) => index % 2 === 0 ? user : assistant),
      [
        { ...user, content: 'a'.repeat(MAX_AI_CONTEXT_BYTES / 2) },
        { ...assistant, content: 'b'.repeat(MAX_AI_CONTEXT_BYTES / 2) },
      ],
    ];
    for (const history of cases) {
      const failure: unknown = await desktopAiChatBackend.chat(
        { ...conversation, history } as AiChatRequest, () => {},
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'invalidInput' });
      expect(JSON.stringify(failure)).not.toContain('private-');
    }
    await expect(desktopAiChatBackend.chat({
      ...conversation, authorization: { ...conversation.authorization, scope: 'userTextOnly' },
    }, () => {})).rejects.toMatchObject({ code: 'invalidInput' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('accepts the exact UTF-8 conversation boundary without truncating content', async () => {
    const prompt = 'é'.repeat(MAX_AI_PROMPT_BYTES / 2);
    const caller: AiChatRequest = {
      ...request,
      prompt,
      authorization: { ...request.authorization, scope: 'conversation' },
      history: [
        { role: 'user', content: 'a'.repeat(MAX_AI_CONTEXT_BYTES - MAX_AI_PROMPT_BYTES - MAX_AI_OUTPUT_BYTES) },
        { role: 'assistant', content: 'b'.repeat(MAX_AI_OUTPUT_BYTES) },
      ],
    };
    const { chat } = answerChat();
    const pending = desktopAiChatBackend.chat(caller, () => {});
    expect(sentRequest()).toEqual(caller);
    chat.resolve(response);
    await expect(pending).resolves.toEqual(response);
  });

  it('rejects a malformed key before invoking and never echoes the rejected value', async () => {
    const keys: unknown[] = [
      '', 'has space', 'line\nbreak', '中文密钥', 'del\x7f', 'a'.repeat(MAX_AI_API_KEY_BYTES + 1), 42,
    ];
    for (const apiKey of keys) {
      const failure = await desktopAiChatBackend
        .chat({ ...request, apiKey } as AiChatRequest, () => {})
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'invalidInput', requestId: request.requestId, retryable: false });
      if (typeof apiKey === 'string' && apiKey !== '') {
        expect(JSON.stringify(failure)).not.toContain(apiKey);
      }
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it('forwards a single-use key only to ai_chat and drops it once the invocation settles', async () => {
    const caller: AiChatRequest = { ...request, apiKey: FIXTURE_KEY };
    const snapshot = structuredClone(caller);
    const { chat } = answerChat();
    const received: AiChatDelta[] = [];
    const pending = desktopAiChatBackend.chat(caller, (value) => received.push(value));
    expect(sentRequest().apiKey).toBe(FIXTURE_KEY);

    lastChannel().onmessage(delta(1, response.text));
    expect(received).toEqual([delta(1, response.text)]);
    expect(Object.keys(received[0]!)).toEqual(['requestId', 'modelProfileId', 'sequence', 'text']);

    chat.resolve(response);
    await expect(pending).resolves.toEqual(response);
    expect('apiKey' in (sentRequest() as object)).toBe(false);
    expect(Object.keys(response)).not.toContain('apiKey');
    // The caller-owned request is never mutated.
    expect(caller).toEqual(snapshot);
  });

  it('carries a key over any user-configured HTTP or HTTPS endpoint', async () => {
    for (const endpoint of [
      // Main's service policy pins these shapes: custom hosts, ports, paths and plain HTTP are allowed.
      'http://model.internal:8788/team/v1', 'http://192.0.2.44:8788/custom/v1', 'http://[2001:db8::1]:8788/v1',
      'https://models.example.test:9443/team/v1', 'http://127.0.0.1:11434', 'http://localhost:11434', 'http://[::1]:11434',
    ]) {
      const { chat } = answerChat();
      const pending = desktopAiChatBackend.chat({
        ...request, apiKey: FIXTURE_KEY, authorization: { ...request.authorization, endpoint },
      }, () => {});
      expect(sentRequest().apiKey).toBe(FIXTURE_KEY);
      chat.resolve(responseWith({ endpoint }));
      await expect(pending).resolves.toMatchObject({ endpoint });
    }
    // The same custom HTTP endpoint without a key stays accepted as well.
    const { chat } = answerChat();
    const plain = desktopAiChatBackend.chat({
      ...request, authorization: { ...request.authorization, endpoint: 'http://192.168.1.10:11434' },
    }, () => {});
    chat.resolve(responseWith({ endpoint: 'http://192.168.1.10:11434' }));
    await expect(plain).resolves.toMatchObject({ endpoint: 'http://192.168.1.10:11434' });
  });

  it('never forwards the key to cancel, deltas or failures', async () => {
    const { cancels } = answerChat();
    const received: AiChatDelta[] = [];
    const pending = desktopAiChatBackend.chat({ ...request, apiKey: FIXTURE_KEY }, (value) => received.push(value));
    lastChannel().onmessage(delta(1, 'A', { requestId: crypto.randomUUID() }));
    const failure = await pending.catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'aiIncompleteStream', requestId: request.requestId });
    expect(JSON.stringify(failure)).not.toContain(FIXTURE_KEY);
    expect(cancels).toEqual([{ request: { requestId: request.requestId, modelProfileId: request.modelProfileId } }]);
    expect(JSON.stringify(cancels)).not.toContain(FIXTURE_KEY);
    expect(received).toHaveLength(0);
    // The aborted invocation also forgot the key locally.
    expect('apiKey' in (sentRequest() as object)).toBe(false);
  });

  it('accepts only the printable key shape and leaves transport to the configured endpoint', () => {
    expect(isPrintableApiKey('abc-123')).toBe(true);
    expect(isPrintableApiKey('a'.repeat(MAX_AI_API_KEY_BYTES))).toBe(true);
    expect(isPrintableApiKey('a'.repeat(MAX_AI_API_KEY_BYTES + 1))).toBe(false);
    expect(isPrintableApiKey('')).toBe(false);
    expect(isPrintableApiKey('has space')).toBe(false);
    expect(isPrintableApiKey('line\nbreak')).toBe(false);
    expect(isPrintableApiKey('中')).toBe(false);
    expect(isPrintableApiKey('del\x7f')).toBe(false);
  });

  it('stays unsupported in the browser preview without any fallback', async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    await expect(desktopAiChatBackend.chat(request, () => {}))
      .rejects.toEqual({ code: 'unsupported', requestId: request.requestId, retryable: false });
    await expect(desktopAiChatBackend.cancel({ requestId: request.requestId, modelProfileId: request.modelProfileId }))
      .rejects.toEqual({ code: 'unsupported', requestId: request.requestId, retryable: false });
    expect(desktopAiChatBackend.available).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects a foreign or replayed delta, cancels the backend and never resolves success', async () => {
    const { chat, cancels } = answerChat();
    const received: AiChatDelta[] = [];
    const pending = desktopAiChatBackend.chat(request, (value) => received.push(value));
    const handler = lastChannel().onmessage;

    handler(delta(1, 'A', { requestId: crypto.randomUUID() }));
    await expect(pending).rejects.toMatchObject({ code: 'aiIncompleteStream', requestId: request.requestId });
    expect(cancels).toEqual([{ request: { requestId: request.requestId, modelProfileId: request.modelProfileId } }]);
    expect(received).toHaveLength(0);

    // Late frames after the rejection are ignored even when replayed through the old handler.
    handler(delta(1, 'late'));
    expect(received).toHaveLength(0);
    chat.resolve(response);
    await Promise.resolve();
    expect(received).toHaveLength(0);
  });

  it.each<[string, AiChatDelta[]]>([
    ['a zero index', [delta(0, 'A')]],
    ['a gap', [delta(1, 'A'), delta(3, 'B')]],
    ['a replayed index', [delta(1, 'A'), delta(1, 'B')]],
    ['an empty chunk', [delta(1, '')]],
  ])('rejects %s in the delta sequence', async (_label, deltas) => {
    const { chat, cancels } = answerChat();
    const pending = desktopAiChatBackend.chat(request, () => {});
    const channel = lastChannel();
    for (const value of deltas) channel.onmessage(value);
    await expect(pending).rejects.toMatchObject({ code: 'aiIncompleteStream' });
    expect(cancels).toHaveLength(1);
    chat.resolve(response);
    await Promise.resolve();
  });

  it.each<[string, AiChatDelta[], Partial<AiChatResponse>]>([
    ['a sequence below the observed count', [delta(1, 'A'), delta(2, 'B')], { sequence: 1, text: 'AB' }],
    ['a text that does not cover the observed prefix', [delta(1, 'AB')], { sequence: 3, text: 'AX-more' }],
    ['a longer text at the observed count', [delta(1, 'AB')], { sequence: 1, text: 'ABC' }],
    ['a nonempty zero-sequence text', [], { sequence: 0, text: 'x' }],
  ])('rejects a final with %s', async (_label, deltas, patch) => {
    const { chat } = answerChat();
    const pending = desktopAiChatBackend.chat(request, () => {});
    const channel = lastChannel();
    for (const value of deltas) channel.onmessage(value);
    chat.resolve(responseWith(patch));
    await expect(pending).rejects.toMatchObject({ code: 'aiIncompleteStream' });
  });

  it('rejects a response bound to another target or identity and never cancels a finished request', async () => {
    const cases: [unknown, string][] = [
      [responseWith({ requestId: crypto.randomUUID() }), 'aiUnsupportedResponse'],
      [responseWith({ endpoint: 'http://other.test:11434' }), 'aiTargetChanged'],
      [responseWith({ modelId: 'other-model' }), 'aiTargetChanged'],
      [responseWith({ protocol: 'openaiCompatible' }), 'aiTargetChanged'],
    ];
    for (const [final, code] of cases) {
      const { chat } = answerChat();
      const pending = desktopAiChatBackend.chat(request, () => {});
      lastChannel().onmessage(delta(1, response.text));
      chat.resolve(final);
      await expect(pending).rejects.toMatchObject({ code });
    }
    expect(vi.mocked(invoke).mock.calls.filter((call) => call[0] === 'ai_chat_cancel')).toHaveLength(0);
  });

  it('rejects unknown fields, outcomes, model ids and sequence types in the response', async () => {
    const missing: Record<string, unknown> = { ...response };
    delete missing.actualModelId;
    const cases: unknown[] = [
      { ...response, extra: 1 },
      missing,
      responseWith({ outcome: 'partial' as AiChatResponse['outcome'] }),
      responseWith({ actualModelId: 7 as unknown as string }),
      responseWith({ actualModelId: '' }),
      responseWith({ sequence: -1 }),
      responseWith({ sequence: 1.5 }),
      responseWith({ sequence: '1' as unknown as number }),
    ];
    for (const final of cases) {
      const { chat } = answerChat();
      const pending = desktopAiChatBackend.chat(request, () => {});
      lastChannel().onmessage(delta(1, response.text));
      chat.resolve(final);
      await expect(pending).rejects.toMatchObject({ code: 'aiUnsupportedResponse' });
    }
  });

  it('rejects a delta or a final that would exceed the output limit and cancels the request', async () => {
    const { chat, cancels } = answerChat();
    const pending = desktopAiChatBackend.chat(request, () => {});
    lastChannel().onmessage(delta(1, 'x'.repeat(MAX_AI_OUTPUT_BYTES + 1)));
    await expect(pending).rejects.toMatchObject({ code: 'aiIncompleteStream' });
    expect(cancels).toHaveLength(1);
    chat.resolve(response);
    await Promise.resolve();

    const second = answerChat();
    const oversized = 'y'.repeat(MAX_AI_OUTPUT_BYTES + 1);
    const finalPending = desktopAiChatBackend.chat(request, () => {});
    second.chat.resolve(responseWith({ sequence: 1, text: oversized }));
    await expect(finalPending).rejects.toMatchObject({ code: 'aiIncompleteStream' });
  });

  it('cancel stops the local stream, asks the backend and ignores the late answer', async () => {
    const { chat, cancels } = answerChat();
    const received: AiChatDelta[] = [];
    const pending = desktopAiChatBackend.chat(request, (value) => received.push(value));
    lastChannel().onmessage(delta(1, 'partial'));
    expect(received).toHaveLength(1);

    await expect(desktopAiChatBackend.cancel({
      requestId: request.requestId, modelProfileId: request.modelProfileId,
    })).resolves.toBe(true);
    await expect(pending).rejects.toEqual({ code: 'cancelled', requestId: request.requestId, retryable: false });
    expect(cancels).toEqual([{ request: { requestId: request.requestId, modelProfileId: request.modelProfileId } }]);
    chat.resolve(response);
    await Promise.resolve();
    expect(received).toHaveLength(1);
  });

  it('cancel validates identity and answers', async () => {
    const { cancels } = answerChat();
    await expect(desktopAiChatBackend.cancel({ requestId: request.requestId, modelProfileId: 'x' }))
      .rejects.toMatchObject({ code: 'invalidInput' });
    await expect(desktopAiChatBackend.cancel({
      requestId: request.requestId, modelProfileId: request.modelProfileId, extra: 1,
    } as unknown as AiChatCancelRequest)).rejects.toMatchObject({ code: 'invalidInput' });
    expect(cancels).toHaveLength(0);

    vi.mocked(invoke).mockImplementation((async (command: string) => {
      if (command === 'ai_chat_cancel') return 'yes';
      throw new Error('unexpected');
    }));
    await expect(desktopAiChatBackend.cancel({ requestId: request.requestId, modelProfileId: request.modelProfileId }))
      .rejects.toMatchObject({ code: 'invalidResponse' });
  });

  it('rejects two in-flight requests with the same id without a second invoke', async () => {
    const { chat } = answerChat();
    const first = desktopAiChatBackend.chat(request, () => {});
    await expect(desktopAiChatBackend.chat(request, () => {}))
      .rejects.toEqual({ code: 'duplicateRequest', requestId: request.requestId, retryable: false });
    expect(invoke).toHaveBeenCalledTimes(1);
    lastChannel().onmessage(delta(1, response.text));
    chat.resolve(response);
    await expect(first).resolves.toEqual(response);
  });

  it('reduces backend failures and raw errors to structured codes', async () => {
    vi.mocked(invoke).mockImplementation((async () => {
      throw { code: 'timeout', requestId: 'elsewhere', retryable: true, payload: 'secret' };
    }));
    await expect(desktopAiChatBackend.chat(request, () => {})).rejects.toEqual({
      code: 'timeout', requestId: request.requestId, retryable: true,
    });

    vi.mocked(invoke).mockImplementation((async () => { throw new Error('raw backend text'); }));
    await expect(desktopAiChatBackend.chat(request, () => {})).rejects.toEqual({
      code: 'aiProviderError', requestId: request.requestId, retryable: false,
    });

    // A failing invocation with a key drops it from the local payload as well.
    vi.mocked(invoke).mockImplementation((async () => {
      throw { code: 'timeout', requestId: request.requestId, retryable: false };
    }));
    await expect(desktopAiChatBackend.chat({ ...request, apiKey: FIXTURE_KEY }, () => {}))
      .rejects.toMatchObject({ code: 'timeout' });
    expect('apiKey' in (sentRequest() as object)).toBe(false);
  });

  it('maps unknown thrown values to a provider failure without leaking them', () => {
    expect(aiErrorCode({ code: 'aiApprovalRequired' })).toBe('aiApprovalRequired');
    expect(aiErrorCode({ code: 'credentialUnavailable' })).toBe('credentialUnavailable');
    expect(aiErrorCode({ code: 'credentialFailure' })).toBe('credentialFailure');
    expect(aiErrorCode({ code: 'credentialNotFound' })).toBe('credentialNotFound');
    expect(aiErrorCode({ code: 'networkError', detail: 'secret' })).toBe('networkError');
    expect(aiErrorCode(new Error('boom'))).toBe('aiProviderError');
    expect(aiErrorCode('boom')).toBe('aiProviderError');
    expect(aiErrorCode(undefined)).toBe('aiProviderError');
  });

  it('releases the channel, key and request identity after a synchronous bridge failure', async () => {
    vi.mocked(invoke).mockImplementation(() => { throw new Error('private bridge failure'); });
    await expect(desktopAiChatBackend.chat({ ...request, apiKey: FIXTURE_KEY }, () => {}))
      .rejects.toEqual({ code: 'aiProviderError', requestId: request.requestId, retryable: false });
    expect(sentRequest().apiKey).toBeUndefined();

    const { chat } = answerChat();
    const pending = desktopAiChatBackend.chat(request, () => {});
    chat.resolve(response);
    await expect(pending).resolves.toEqual(response);
  });
});
