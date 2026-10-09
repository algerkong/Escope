import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiChatDelta, AiChatRequest, AiChatResponse } from '../../src/domain/ai-chat';
import { desktopAiChatBackend } from '../../src/services/ai-chat';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
  Channel: class<T> {
    onmessage: (value: T) => void;
    constructor(handler: (value: T) => void) { this.onmessage = handler; }
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isTauri).mockReturnValue(true);
});

describe('user-configured AI endpoint policy', () => {
  it.each([
    'http://model.internal:8788/team/v1',
    'http://192.0.2.44:8788/custom/v1',
    'http://[2001:db8::1]:8788/v1',
    'https://models.example.test:9443/team/v1',
  ])('permits the approved custom endpoint with a one-use key: %s', async (endpoint) => {
    const request: AiChatRequest = {
      requestId: crypto.randomUUID(),
      modelProfileId: crypto.randomUUID(),
      prompt: 'Hello.',
      authorization: {
        scope: 'userTextOnly', protocol: 'openaiCompatible', endpoint, modelId: 'custom-model-id',
      },
      apiKey: 'fixture-only-one-use-key',
    };
    let sent: AiChatRequest | undefined;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      expect(command).toBe('ai_chat');
      const payload = args as { request: AiChatRequest; onEvent: Channel<AiChatDelta> };
      sent = structuredClone(payload.request);
      payload.onEvent.onmessage({
        requestId: request.requestId, modelProfileId: request.modelProfileId, sequence: 1, text: 'Hello.',
      });
      return {
        requestId: request.requestId,
        modelProfileId: request.modelProfileId,
        protocol: request.authorization.protocol,
        endpoint,
        modelId: request.authorization.modelId,
        actualModelId: 'custom-model-revision',
        sequence: 1,
        text: 'Hello.',
        outcome: 'complete',
      } satisfies AiChatResponse;
    });
    const result = await desktopAiChatBackend.chat(request, () => {});
    expect(sent).toEqual(request);
    expect(result.endpoint).toBe(endpoint);
    expect(JSON.stringify(result)).not.toContain('fixture-only-one-use-key');
    expect(invoke).toHaveBeenCalledTimes(1);
    // Boundary validation does not mutate a request owned by the caller.
    expect(request.apiKey).toBe('fixture-only-one-use-key');
  });
});
