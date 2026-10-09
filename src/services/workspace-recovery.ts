import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  emptyRecoveryDocument, parseRecoveryDocument, parseRecoveryRecord,
  type WorkspaceRecoveryDocument, type WorkspaceRecoveryRecord,
} from '../domain/workspace-recovery';

export interface WorkspaceRecoveryService {
  readonly kind: 'desktop' | 'session';
  load(): Promise<WorkspaceRecoveryRecord>;
  save(expectedRevision: number, document: WorkspaceRecoveryDocument): Promise<number>;
}

function fail(code: 'invalidInput' | 'invalidResponse' | 'unsupported' | 'workspaceConflict'): never {
  throw { code, requestId: null, retryable: false };
}

function validateWrite(revision: number, document: WorkspaceRecoveryDocument) {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER
    || parseRecoveryDocument(document) === null) fail('invalidInput');
}

export const desktopWorkspaceRecoveryService: WorkspaceRecoveryService = {
  kind: 'desktop',
  load: async () => {
    if (!isTauri()) fail('unsupported');
    const record = parseRecoveryRecord(await invoke<unknown>('workspace_recovery_load'));
    if (record === null) fail('invalidResponse');
    return record;
  },
  save: async (expectedRevision, document) => {
    if (!isTauri()) fail('unsupported');
    validateWrite(expectedRevision, document);
    const result = await invoke<unknown>('workspace_recovery_save', { expectedRevision, document });
    if (typeof result !== 'object' || result === null || Object.keys(result).length !== 1
      || !('revision' in result) || result.revision !== expectedRevision + 1) fail('invalidResponse');
    return result.revision;
  },
};

/** Explicit preview storage, never a fallback for a failed SQLite write. */
export function createSessionWorkspaceRecoveryService(): WorkspaceRecoveryService {
  let stored: WorkspaceRecoveryRecord = { revision: 0, document: emptyRecoveryDocument() };
  return {
    kind: 'session',
    load: async () => structuredClone(stored),
    save: async (expectedRevision, document) => {
      validateWrite(expectedRevision, document);
      if (expectedRevision !== stored.revision) fail('workspaceConflict');
      stored = { revision: stored.revision + 1, document: structuredClone(document) };
      return stored.revision;
    },
  };
}

export function createWorkspaceRecoveryService(): WorkspaceRecoveryService {
  return isTauri() ? desktopWorkspaceRecoveryService : createSessionWorkspaceRecoveryService();
}
