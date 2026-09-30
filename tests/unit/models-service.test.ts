import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import canonicalInput from '../fixtures/models-input-canonical.json';
import canonicalState from '../fixtures/models-state-canonical.json';
import { MAX_MODEL_PROFILES, type ModelInput } from '../../src/domain/models';
import { createSessionModelService, desktopModelService } from '../../src/services/models';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }));

const ID = '3f2f2c9a-5b1e-4c6d-9a70-1b2c3d4e5f60';
const input = canonicalInput as ModelInput;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isTauri).mockReturnValue(true);
});

describe('desktop model profile IPC', () => {
  it('reads through models_load and refuses a payload this build cannot explain', async () => {
    vi.mocked(invoke).mockResolvedValue(canonicalState);
    await expect(desktopModelService.load()).resolves.toEqual(canonicalState);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('models_load');

    vi.mocked(invoke).mockResolvedValue({ profiles: [{ id: 'not-a-uuid' }], defaultModelId: null });
    await expect(desktopModelService.load()).rejects.toThrow('invalidModelProfile');
    vi.mocked(invoke).mockResolvedValue({ profiles: canonicalState.profiles, defaultModelId: 'missing' });
    await expect(desktopModelService.load()).rejects.toThrow('invalidModelsState');
  });

  it('sends the validated payload with the stable id and never a credential field', async () => {
    vi.mocked(invoke).mockResolvedValue({ ...canonicalInput, id: ID, sortOrder: 0 });
    await desktopModelService.save(input, ID);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('models_save', { input: canonicalInput, id: ID });
    const [, args] = vi.mocked(invoke).mock.calls[0]!;
    expect(Object.keys((args as { input: object }).input).sort())
      .toEqual(['displayName', 'endpoint', 'modelId', 'protocol']);

    await desktopModelService.save(input);
    expect(invoke).toHaveBeenLastCalledWith('models_save', { input: canonicalInput, id: null });

    // An invalid draft is refused before IPC, so no request is sent for it.
    vi.mocked(invoke).mockClear();
    await expect(desktopModelService.save({ ...input, endpoint: 'https://user:secret@example.test' }))
      .rejects.toThrow('invalidEndpoint');
    await expect(desktopModelService.save({ ...input, modelId: '  ' })).rejects.toThrow('invalidInput');
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

  it('stays unsupported in the browser instead of answering from session memory', async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    const unsupported = { code: 'unsupported', requestId: null, retryable: false };
    await expect(desktopModelService.load()).rejects.toEqual(unsupported);
    await expect(desktopModelService.save(input)).rejects.toEqual(unsupported);
    await expect(desktopModelService.delete(ID)).rejects.toEqual(unsupported);
    await expect(desktopModelService.select(null)).rejects.toEqual(unsupported);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('session model profile adapter', () => {
  it('applies the backend rules: order, default fallback and profile limit', async () => {
    const service = createSessionModelService();
    expect(service.kind).toBe('session');
    expect(await service.load()).toEqual({ profiles: [], defaultModelId: null });

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
    expect(await service.load()).toEqual({ profiles: [], defaultModelId: null });
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
