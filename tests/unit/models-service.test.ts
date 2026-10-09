import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import canonicalInput from '../fixtures/models-input-canonical.json';
import canonicalState from '../fixtures/models-state-canonical.json';
import discoveryRequestFixture from '../fixtures/model-discovery-request.json';
import discoveryResponseFixture from '../fixtures/model-discovery-response.json';
import type { ModelCredentialChange, ModelDiscoveryRequest, ModelDiscoveryResponse } from '../../src/domain/model-access';
import { MAX_DISCOVERED_MODELS } from '../../src/domain/model-access';
import { MAX_MODEL_PROFILES, type ModelInput } from '../../src/domain/models';
import { createSessionModelService, desktopModelService } from '../../src/services/models';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }));

const ID = '3f2f2c9a-5b1e-4c6d-9a70-1b2c3d4e5f60';
const input = canonicalInput as ModelInput;
const discoveryRequest = discoveryRequestFixture as ModelDiscoveryRequest;
const discoveryResponse = discoveryResponseFixture as ModelDiscoveryResponse;
const UNSUPPORTED = { code: 'unsupported', requestId: null, retryable: false };
/** Clearly fictitious tokens; never real credentials. */
const REPLACE_KEY = 'fixture-replace-token';

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isTauri).mockReturnValue(true);
});

describe('desktop model profile IPC', () => {
  it('reads through models_load and refuses a payload this build cannot explain', async () => {
    vi.mocked(invoke).mockResolvedValue(canonicalState);
    await expect(desktopModelService.load()).resolves.toEqual(canonicalState);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('models_load');
    expect(canonicalState.credentialCleanupPending).toBe(false);

    vi.mocked(invoke).mockResolvedValue({ profiles: [{ id: 'not-a-uuid' }], defaultModelId: null, credentialCleanupPending: false });
    await expect(desktopModelService.load()).rejects.toThrow('invalidModelProfile');
    vi.mocked(invoke).mockResolvedValue({ profiles: canonicalState.profiles, defaultModelId: 'missing' });
    await expect(desktopModelService.load()).rejects.toThrow('invalidModelsState');
    const withoutPending: Record<string, unknown> = { ...canonicalState };
    delete withoutPending.credentialCleanupPending;
    vi.mocked(invoke).mockResolvedValue(withoutPending);
    await expect(desktopModelService.load()).rejects.toThrow('invalidModelsState');
  });

  it('serializes the credential separately and never puts a secret in the metadata input', async () => {
    vi.mocked(invoke).mockResolvedValue({ ...canonicalInput, id: ID, sortOrder: 0, hasApiKey: true });
    await desktopModelService.save(input, ID, { kind: 'replace', apiKey: REPLACE_KEY });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('models_save', {
      input: canonicalInput, id: ID, credential: { kind: 'replace', apiKey: REPLACE_KEY },
    });
    const [, args] = vi.mocked(invoke).mock.calls[0]!;
    expect(Object.keys((args as { input: object }).input).sort())
      .toEqual(['displayName', 'endpoint', 'modelId', 'protocol']);
    expect(JSON.stringify((args as { input: object }).input)).not.toContain(REPLACE_KEY);

    await desktopModelService.save(input, undefined, { kind: 'clear' });
    expect(invoke).toHaveBeenLastCalledWith('models_save', {
      input: canonicalInput, id: null, credential: { kind: 'clear' },
    });
    // An omitted credential means keep, serialized explicitly for the backend.
    await desktopModelService.save(input);
    expect(invoke).toHaveBeenLastCalledWith('models_save', {
      input: canonicalInput, id: null, credential: { kind: 'keep' },
    });

    // Invalid drafts and invalid credential changes are refused before IPC.
    vi.mocked(invoke).mockClear();
    await expect(desktopModelService.save({ ...input, endpoint: 'https://user:secret@example.test' }))
      .rejects.toThrow('invalidEndpoint');
    await expect(desktopModelService.save({ ...input, modelId: '  ' })).rejects.toThrow('invalidInput');
    await expect(desktopModelService.save({ ...input, apiKey: 'placeholder' } as ModelInput)).rejects.toThrow('invalidInput');
    await expect(desktopModelService.save(input, undefined, { kind: 'replace', apiKey: 'has space' }))
      .rejects.toThrow('invalidInput');
    await expect(desktopModelService.save(input, undefined, { kind: 'replace', apiKey: 'x'.repeat(2049) }))
      .rejects.toThrow('invalidInput');
    await expect(desktopModelService.save(input, undefined, { kind: 'replace' } as ModelCredentialChange))
      .rejects.toThrow('invalidInput');
    await expect(desktopModelService.save(input, undefined, { kind: 'clear', apiKey: REPLACE_KEY } as unknown as ModelCredentialChange))
      .rejects.toThrow('invalidInput');
    await expect(desktopModelService.save(input, undefined, { kind: 'other' } as unknown as ModelCredentialChange))
      .rejects.toThrow('invalidInput');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('deletes and selects through the typed commands, including clearing the default', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await desktopModelService.delete(ID);
    expect(invoke).toHaveBeenLastCalledWith('models_delete', { id: ID });
    await desktopModelService.select(ID);
    expect(invoke).toHaveBeenLastCalledWith('models_select', { id: ID });
    await desktopModelService.select(null);
    expect(invoke).toHaveBeenLastCalledWith('models_select', { id: null });
  });

  it('sends the normalized discovery request and returns only a bound, bounded answer', async () => {
    vi.mocked(invoke).mockResolvedValue(discoveryResponse);
    await expect(desktopModelService.discover({ ...discoveryRequest, endpoint: `${discoveryRequest.endpoint}/` }))
      .resolves.toEqual(discoveryResponse);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('models_discover', { request: discoveryRequest });

    const cases: unknown[] = [
      { ...discoveryResponse, requestId: crypto.randomUUID() },
      { ...discoveryResponse, protocol: 'ollama' },
      { ...discoveryResponse, endpoint: `${discoveryResponse.endpoint}/other` },
      { ...discoveryResponse, truncated: 'yes' },
      { ...discoveryResponse, modelIds: ['a', 'a'] },
      { ...discoveryResponse, modelIds: [''] },
      { ...discoveryResponse, modelIds: ['x'.repeat(201)] },
      { ...discoveryResponse, modelIds: 'none' },
      { ...discoveryResponse, modelIds: [1] },
      { ...discoveryResponse, extra: 1 },
      { ...discoveryResponse, modelIds: Array.from({ length: MAX_DISCOVERED_MODELS + 1 }, (_, index) => `m-${index}`) },
    ];
    for (const value of cases) {
      vi.mocked(invoke).mockResolvedValue(value);
      await expect(desktopModelService.discover(discoveryRequest))
        .rejects.toMatchObject({ code: 'invalidResponse', requestId: discoveryRequest.requestId });
    }
  });

  it('validates the discovery request and its credential union before IPC', async () => {
    vi.mocked(invoke).mockClear();
    const bad: unknown[] = [
      { ...discoveryRequest, requestId: 'nope' },
      { ...discoveryRequest, protocol: 'anthropic' },
      { ...discoveryRequest, endpoint: 'https://user:secret@example.test' },
      { ...discoveryRequest, endpoint: 7 },
      { ...discoveryRequest, credential: { kind: 'provided', apiKey: 'has space' } },
      { ...discoveryRequest, credential: { kind: 'provided', apiKey: '' } },
      { ...discoveryRequest, credential: { kind: 'stored', modelProfileId: 'nope' } },
      { ...discoveryRequest, credential: { kind: 'stored', modelProfileId: discoveryRequest.requestId, extra: 1 } },
      { ...discoveryRequest, credential: { kind: 'other' } },
      { ...discoveryRequest, credential: 7 },
      { ...discoveryRequest, extra: 1 },
    ];
    for (const value of bad) {
      await expect(desktopModelService.discover(value as ModelDiscoveryRequest)).rejects.toThrow();
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it('cancels a discovery and retries credential cleanup with boolean answers', async () => {
    vi.mocked(invoke).mockResolvedValue(false);
    await expect(desktopModelService.cancelDiscovery(discoveryRequest.requestId)).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('models_discover_cancel', {
      request: { requestId: discoveryRequest.requestId },
    });
    await expect(desktopModelService.cancelDiscovery('nope')).rejects.toThrow('invalidInput');

    vi.mocked(invoke).mockResolvedValue(true);
    await expect(desktopModelService.cleanupCredentials()).resolves.toBe(true);
    expect(invoke).toHaveBeenLastCalledWith('models_cleanup');

    vi.mocked(invoke).mockResolvedValue('yes');
    await expect(desktopModelService.cleanupCredentials())
      .rejects.toMatchObject({ code: 'invalidResponse' });
    vi.mocked(invoke).mockResolvedValue(1);
    await expect(desktopModelService.cancelDiscovery(discoveryRequest.requestId))
      .rejects.toMatchObject({ code: 'invalidResponse', requestId: discoveryRequest.requestId });
  });

  it('stays unsupported in the browser instead of answering from session memory', async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    await expect(desktopModelService.load()).rejects.toEqual(UNSUPPORTED);
    await expect(desktopModelService.save(input)).rejects.toEqual(UNSUPPORTED);
    await expect(desktopModelService.delete(ID)).rejects.toEqual(UNSUPPORTED);
    await expect(desktopModelService.select(null)).rejects.toEqual(UNSUPPORTED);
    await expect(desktopModelService.discover(discoveryRequest)).rejects.toEqual(UNSUPPORTED);
    await expect(desktopModelService.cancelDiscovery(discoveryRequest.requestId)).rejects.toEqual(UNSUPPORTED);
    await expect(desktopModelService.cleanupCredentials()).rejects.toEqual(UNSUPPORTED);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('session model profile adapter', () => {
  it('keeps metadata only: no key flag, no cleanup pending and no discovery fallback', async () => {
    const service = createSessionModelService();
    expect(service.kind).toBe('session');
    expect(await service.load()).toEqual({ profiles: [], defaultModelId: null, credentialCleanupPending: false });

    const saved = await service.save(input);
    expect(saved.hasApiKey).toBe(false);
    expect((await service.load()).profiles[0]!.hasApiKey).toBe(false);
    // A replacement secret is refused outright; keep and clear stay metadata-only.
    await expect(service.save(input, undefined, { kind: 'replace', apiKey: REPLACE_KEY })).rejects.toEqual({ code: 'unsupported', requestId: null, retryable: false });
    await expect(service.save(input, saved.id, { kind: 'clear' })).resolves.toMatchObject({ hasApiKey: false });
    await expect(service.save(input, saved.id)).resolves.toMatchObject({ hasApiKey: false });

    // There is never a credential to clean up, and discovery is not answered from memory.
    expect(await service.cleanupCredentials()).toBe(true);
    await expect(service.discover(discoveryRequest)).rejects.toEqual({ code: 'unsupported', requestId: null, retryable: false });
    await expect(service.cancelDiscovery(discoveryRequest.requestId)).rejects.toEqual({ code: 'unsupported', requestId: null, retryable: false });
  });

  it('applies the backend rules: order, default fallback and profile limit', async () => {
    const service = createSessionModelService();
    expect(await service.load()).toEqual({ profiles: [], defaultModelId: null, credentialCleanupPending: false });

    const first = await service.save(input);
    const second = await service.save({ ...input, displayName: 'Gateway', protocol: 'openaiCompatible' });
    expect(first.sortOrder).toBe(0);
    expect(second.sortOrder).toBe(1);
    expect((await service.load()).defaultModelId).toBe(first.id);

    await service.select(second.id);
    expect((await service.load()).defaultModelId).toBe(second.id);

    // Deleting the selected profile falls back to the first remaining one, like the backend.
    await service.delete(second.id);
    const remaining = await service.load();
    expect(remaining.profiles.map((profile) => profile.id)).toEqual([first.id]);
    expect(remaining.defaultModelId).toBe(first.id);
    await service.delete(first.id);
    expect(await service.load()).toEqual({ profiles: [], defaultModelId: null, credentialCleanupPending: false });
    await expect(service.delete(first.id)).rejects.toThrow('notFound');
    await expect(service.select('missing')).rejects.toThrow('notFound');
    await expect(service.save(input, 'missing')).rejects.toThrow('notFound');
  });

  it('refuses an unknown protocol, a secret in the endpoint and the 129th profile', async () => {
    const service = createSessionModelService();
    await expect(service.save({ ...input, protocol: 'anthropic' as ModelInput['protocol'] })).rejects.toThrow('invalidInput');
    await expect(service.save({ ...input, endpoint: 'http://user:pw@example.test' })).rejects.toThrow('invalidEndpoint');
    for (let index = 0; index < MAX_MODEL_PROFILES; index += 1) {
      await service.save({ ...input, displayName: `Model ${index}` });
    }
    await expect(service.save(input)).rejects.toThrow('invalidInput');
    // Editing an existing profile still works at the limit and keeps its identity.
    const loaded = await service.load();
    const existing = loaded.profiles[0]!;
    await expect(service.save({ ...input, displayName: 'Renamed' }, existing.id))
      .resolves.toMatchObject({ id: existing.id, displayName: 'Renamed', sortOrder: existing.sortOrder });
    expect((await service.load()).profiles).toHaveLength(MAX_MODEL_PROFILES);
  });

  it('keeps everything in session memory, so a new adapter starts empty', async () => {
    const first = createSessionModelService();
    await first.save(input);
    expect((await first.load()).profiles).toHaveLength(1);
    expect((await createSessionModelService().load()).profiles).toHaveLength(0);
  });
});
