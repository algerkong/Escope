import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { parsePreferences } from '../../src/domain/preferences';
import { createStorage } from '../../src/services/storage';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isTauri).mockReturnValue(true);
});

describe('desktop preference IPC', () => {
  it('sends the canonical camelCase payload to save_preferences', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const preferences = parsePreferences({ mode: 'dark', startAI: true, uiSize: 16 });
    await createStorage().savePreferences(preferences);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('save_preferences', { preferences });
    const [, args] = vi.mocked(invoke).mock.calls[0]!;
    const payload = JSON.stringify(args);
    expect(payload).toContain('"startAI":true');
    expect(payload).not.toContain('"startAi"');
  });

  it('keeps the desktop read strict and still accepts a legacy startAi payload', async () => {
    vi.mocked(invoke).mockResolvedValue({
      preferences: { ...parsePreferences(null), startAI: true, uiSize: 18 },
      connections: [],
      activeConnectionId: null,
    });
    const state = await createStorage().load();
    expect(state.preferences.startAI).toBe(true);
    expect(state.preferences.uiSize).toBe(18);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('connections_load');

    const legacy: Record<string, unknown> = { ...parsePreferences(null), startAi: true };
    delete legacy.startAI;
    vi.mocked(invoke).mockResolvedValue({
      preferences: legacy,
      connections: [],
      activeConnectionId: null,
    });
    expect((await createStorage().load()).preferences.startAI).toBe(true);
  });

  it('fails the load instead of silently defaulting an incomplete stored payload', async () => {
    vi.mocked(invoke).mockResolvedValue({
      preferences: { mode: 'dark' },
      connections: [],
      activeConnectionId: null,
    });
    await expect(createStorage().load()).rejects.toThrow('invalidPreferences');
  });
});
