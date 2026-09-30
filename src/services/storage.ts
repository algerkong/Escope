import { invoke, isTauri } from '@tauri-apps/api/core';
import type { ConnectionInput, ConnectionProfile } from '../domain/connection';
import { selectConnection, validateConnection } from '../domain/connection';
import { parsePreferences, type Preferences } from '../domain/preferences';

export interface StoredState {
  preferences: Preferences;
  connections: ConnectionProfile[];
  activeConnectionId: string | null;
}

export interface StorageService {
  readonly kind: 'desktop' | 'session';
  load(): Promise<StoredState>;
  savePreferences(preferences: Preferences): Promise<void>;
  saveConnection(input: ConnectionInput, id?: string): Promise<ConnectionProfile>;
  deleteConnection(id: string): Promise<void>;
  selectConnection(id: string | null): Promise<void>;
}

export function createSessionStorage(): StorageService {
  let state: StoredState = { preferences: parsePreferences(null), connections: [], activeConnectionId: null };
  return {
    kind: 'session',
    load: async () => structuredClone(state),
    savePreferences: async (preferences) => { state.preferences = parsePreferences(preferences); },
    saveConnection: async (input, id) => {
      const clean = validateConnection(input);
      const existing = state.connections.find((profile) => profile.id === id);
      if (id && !existing) throw new Error('notFound');
      const profile: ConnectionProfile = {
        ...clean, id: existing?.id ?? crypto.randomUUID(),
        sortOrder: existing?.sortOrder ?? Math.max(-1, ...state.connections.map((item) => item.sortOrder)) + 1,
        auth: 'none',
      };
      state = {
        ...state, connections: existing
          ? state.connections.map((item) => item.id === profile.id ? profile : item)
          : [...state.connections, profile],
      };
      return structuredClone(profile);
    },
    deleteConnection: async (id) => {
      state.connections = state.connections.filter((profile) => profile.id !== id);
      state.activeConnectionId = selectConnection(state.connections, state.activeConnectionId);
    },
    selectConnection: async (id) => {
      if (id !== null && !state.connections.some((profile) => profile.id === id)) throw new Error('notFound');
      state.activeConnectionId = id;
    },
  };
}

export function createStorage(): StorageService {
  if (!isTauri()) return createSessionStorage();
  return {
    kind: 'desktop',
    load: async () => {
      const state = await invoke<StoredState>('load_state');
      return { ...state, preferences: parsePreferences(state.preferences) };
    },
    savePreferences: (preferences) => invoke('save_preferences', { preferences }),
    saveConnection: (input, id) => invoke('save_connection', { input, id: id ?? null }),
    deleteConnection: (id) => invoke('delete_connection', { id }),
    selectConnection: (id) => invoke('select_connection', { id }),
  };
}
