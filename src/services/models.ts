import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  MAX_MODEL_PROFILES, requireModelsState, resolveDefaultModel, sortModels,
  validateModelInput, type ModelInput, type ModelProfile, type ModelsState,
} from '../domain/models';
import type { IpcError } from './ipc';

/**
 * Model profile persistence for the settings page.
 *
 * The desktop implementation uses the four typed commands `models_load`, `models_save`,
 * `models_delete` and `models_select`; the payload is a profile with no credential field, so this
 * service cannot send a secret to the backend. The browser preview keeps its own explicit
 * session-memory implementation and says so: a failed desktop call is never answered from memory.
 */
export interface ModelService {
  readonly kind: 'desktop' | 'session';
  load(): Promise<ModelsState>;
  save(input: ModelInput, id?: string): Promise<ModelProfile>;
  delete(id: string): Promise<void>;
  select(id: string | null): Promise<void>;
}

function unsupported(): never {
  throw { code: 'unsupported', requestId: null, retryable: false } satisfies IpcError;
}

/** Desktop IPC. The stored read is strict: a payload this build cannot explain fails the load. */
export const desktopModelService: ModelService = {
  kind: 'desktop',
  load: async () => {
    if (!isTauri()) return unsupported();
    return requireModelsState(await invoke<unknown>('models_load'));
  },
  save: async (input, id) => {
    if (!isTauri()) return unsupported();
    // The payload is validated here; the response is not re-parsed, because the settings page reads
    // the list back through `load` and a write that succeeded must never be reported as failed.
    return await invoke<ModelProfile>('models_save', { input: validateModelInput(input), id: id ?? null });
  },
  delete: async (id) => {
    if (!isTauri()) return unsupported();
    await invoke('models_delete', { id });
  },
  select: async (id) => {
    if (!isTauri()) return unsupported();
    await invoke('models_select', { id });
  },
};

/**
 * Browser preview adapter: model profiles live in session memory and are lost on reload. It applies
 * the same validation, ordering, profile limit and default-selection fallback as the backend, so
 * the preview exercises the real rules — but it is a separate mode, never a fallback for a failed
 * desktop write.
 */
export function createSessionModelService(): ModelService {
  let state: ModelsState = { profiles: [], defaultModelId: null };
  return {
    kind: 'session',
    load: async () => structuredClone(state),
    save: async (input, id) => {
      const clean = validateModelInput(input);
      const existing = state.profiles.find((profile) => profile.id === id);
      if (id !== undefined && !existing) throw new Error('notFound');
      if (!existing && state.profiles.length >= MAX_MODEL_PROFILES) throw new Error('invalidInput');
      const profile: ModelProfile = {
        ...clean,
        id: existing?.id ?? crypto.randomUUID(),
        sortOrder: existing?.sortOrder ?? Math.max(-1, ...state.profiles.map((item) => item.sortOrder)) + 1,
      };
      const profiles = existing
        ? state.profiles.map((item) => item.id === profile.id ? profile : item)
        : [...state.profiles, profile];
      state = { profiles: sortModels(profiles), defaultModelId: resolveDefaultModel(profiles, state.defaultModelId) };
      return structuredClone(profile);
    },
    delete: async (id) => {
      if (!state.profiles.some((profile) => profile.id === id)) throw new Error('notFound');
      const profiles = state.profiles.filter((profile) => profile.id !== id);
      state = { profiles, defaultModelId: resolveDefaultModel(profiles, state.defaultModelId === id ? null : state.defaultModelId) };
    },
    select: async (id) => {
      if (id !== null && !state.profiles.some((profile) => profile.id === id)) throw new Error('notFound');
      state = { ...state, defaultModelId: resolveDefaultModel(state.profiles, id) };
    },
  };
}

/** Desktop in the app, session memory in the browser preview — chosen once, not per call. */
export function createModelService(): ModelService {
  return isTauri() ? desktopModelService : createSessionModelService();
}
