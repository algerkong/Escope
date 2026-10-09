import { invoke, isTauri } from '@tauri-apps/api/core';
import type {
  ConnectionDeleteResult, ConnectionInput, ConnectionProfile, ConnectionSecurityChange, ConnectionWriteResult, CredentialCleanupState,
} from '../domain/connection';
import { requireConnectionProfile, requireConnectionSecurity, selectConnection, validateConnection } from '../domain/connection';
import { parsePreferences, requirePreferences, type Preferences } from '../domain/preferences';

export interface StoredState {
  preferences: Preferences;
  connections: ConnectionProfile[];
  activeConnectionId: string | null;
  credentialCleanupPending?: boolean;
}

export interface StorageService {
  readonly kind: 'desktop' | 'session';
  load(): Promise<StoredState>;
  savePreferences(preferences: Preferences): Promise<void>;
  saveConnection(input: ConnectionInput, id?: string): Promise<ConnectionProfile>;
  deleteConnection(id: string): Promise<void>;
  selectConnection(id: string | null): Promise<void>;
  saveConnectionSecure?(input: ConnectionInput, id?: string, security?: ConnectionSecurityChange): Promise<ConnectionWriteResult>;
  deleteConnectionSecure?(id: string): Promise<ConnectionDeleteResult>;
  cleanupCredentials?(): Promise<CredentialCleanupState>;
}

export function createSessionStorage(): StorageService {
  let state: StoredState = { preferences: parsePreferences(null), connections: [], activeConnectionId: null };
  const service: StorageService = {
    kind: 'session',
    load: async () => structuredClone(state),
    savePreferences: async (preferences) => { state.preferences = requirePreferences(preferences); },
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
    saveConnectionSecure: async (input, id, security) => {
      const change = requireConnectionSecurity(security);
      if (!['keep', 'clear'].includes(change.credential.kind) || change.ca.kind === 'replace') {
        throw { code: 'unsupported', requestId: null, retryable: false };
      }
      const profile = await service.saveConnection(input, id);
      return { profile, credentialDetached: false, cleanup: cleanCleanup() };
    },
    deleteConnectionSecure: async (id) => {
      await service.deleteConnection(id);
      return { cleanup: cleanCleanup() };
    },
    cleanupCredentials: async () => cleanCleanup(),
  };
  return service;
}

function cleanCleanup(): CredentialCleanupState { return { status: 'complete', remaining: 0, abandoned: 0 }; }

export function createStorage(): StorageService {
  if (!isTauri()) return createSessionStorage();
  return {
    kind: 'desktop',
    load: async () => {
      const state = await invoke<StoredState>('connections_load');
      // Rust already validates the stored row; this is the frontend side of the same contract, so
      // an unexpected payload fails the startup instead of quietly becoming default settings.
      const preferences = requirePreferences(state.preferences);
      if (!Array.isArray(state.connections)
        || (state.activeConnectionId !== null && typeof state.activeConnectionId !== 'string')
        || (state.credentialCleanupPending !== undefined && typeof state.credentialCleanupPending !== 'boolean')) {
        throw { code: 'invalidResponse' };
      }
      const connections = state.connections.map(requireConnectionProfile);
      if (new Set(connections.map((profile) => profile.id)).size !== connections.length) throw { code: 'invalidResponse' };
      return { preferences, connections, activeConnectionId: state.activeConnectionId,
        credentialCleanupPending: state.credentialCleanupPending ?? false };
    },
    savePreferences: (preferences) => invoke('save_preferences', { preferences }),
    saveConnection: (input, id) => invoke('save_connection', { input, id: id ?? null }),
    deleteConnection: (id) => invoke('delete_connection', { id }),
    selectConnection: (id) => invoke('select_connection', { id }),
    saveConnectionSecure: (input, id, security) => {
      const { credential, ca } = requireConnectionSecurity(security);
      return invoke('connections_save', { input: validateConnection(input), id: id ?? null, credential, ca });
    },
    deleteConnectionSecure: (id) => invoke('connections_delete', { id }),
    cleanupCredentials: () => invoke('connections_cleanup'),
  };
}
