import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  MAX_MODEL_PROFILES, normalizeModelEndpoint, requireModelsState, resolveDefaultModel, sortModels,
  validateModelInput, type ModelInput, type ModelProfile, type ModelsState,
} from '../domain/models';
import {
  MAX_DISCOVERED_MODELS,
  type ModelCredentialChange, type ModelDiscoveryCredential, type ModelDiscoveryRequest, type ModelDiscoveryResponse,
} from '../domain/model-access';
import type { ErrorCode, IpcError } from './ipc';
import { isPrintableApiKey } from './ai-chat';

/**
 * Model profile persistence and model discovery.
 *
 * The desktop implementation uses the typed commands `models_load`, `models_save`, `models_delete`,
 * `models_select`, `models_cleanup`, `models_discover` and `models_discover_cancel`. Metadata and
 * the optional credential are separate arguments: a secret never travels inside the profile input,
 * which stays exactly `displayName`/`protocol`/`endpoint`/`modelId`. The browser preview keeps
 * metadata only (`hasApiKey` is always false, there is never a credential to clean up) and refuses
 * any secret or discovery call instead of falling back to memory.
 */

export interface ModelService {
  readonly kind: 'desktop' | 'session';
  load(): Promise<ModelsState>;
  /** Omitted `credential` means keep; the default is serialized explicitly as `{ kind: 'keep' }`. */
  save(input: ModelInput, id?: string, credential?: ModelCredentialChange): Promise<ModelProfile>;
  delete(id: string): Promise<void>;
  select(id: string | null): Promise<void>;
  /** Lists model IDs from the configured endpoint; works before a profile exists. */
  discover(request: ModelDiscoveryRequest): Promise<ModelDiscoveryResponse>;
  cancelDiscovery(requestId: string): Promise<boolean>;
  /** True when no credential is left to clean up (there was never anything pending in session). */
  cleanupCredentials(): Promise<boolean>;
}

/** Failure codes this feature renders; unknown shapes collapse to a storage failure, never a raw message. */
const knownCodes: ReadonlySet<string> = new Set<string>([
  'invalidInput', 'invalidName', 'invalidEndpoint', 'invalidEnvironment', 'invalidIndex', 'invalidQuery',
  'duplicateRequest', 'storageUnavailable', 'notFound', 'unsupported', 'permissionDenied', 'serverForbidden',
  'cancelled', 'busy', 'networkError', 'timeout', 'authenticationFailed', 'rateLimited', 'redirectBlocked',
  'httpError', 'notElasticsearch', 'responseTooLarge', 'invalidResponse',
  'credentialUnavailable', 'credentialFailure', 'credentialNotFound',
  'aiTargetChanged',
]);

/** Safe code for anything thrown here or by the backend: domain errors carry the code as their message. */
export function modelErrorCode(failure: unknown): string {
  const record = typeof failure === 'object' && failure !== null
    ? failure as { code?: unknown; message?: unknown } : null;
  const code = typeof record?.code === 'string' ? record.code
    : typeof record?.message === 'string' ? record.message : null;
  return code !== null && knownCodes.has(code) ? code : 'storageUnavailable';
}

function unsupported(): never {
  throw { code: 'unsupported', requestId: null, retryable: false } satisfies IpcError;
}

function invalid(code: string): never {
  throw new Error(code);
}

function fail(code: ErrorCode, requestId: string | null): never {
  throw { code, requestId, retryable: false } satisfies IpcError;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Closed credential change; a secret is accepted only through `replace`. */
function requireCredentialChange(value: ModelCredentialChange | undefined): ModelCredentialChange {
  if (value === undefined) return { kind: 'keep' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('invalidInput');
  const record = value as Record<string, unknown>;
  if (record.kind === 'keep' || record.kind === 'clear') {
    if (Object.keys(record).length !== 1) return invalid('invalidInput');
    return { kind: record.kind };
  }
  if (record.kind === 'replace') {
    if (Object.keys(record).length !== 2 || !('apiKey' in record)) return invalid('invalidInput');
    if (typeof record.apiKey !== 'string' || !isPrintableApiKey(record.apiKey)) return invalid('invalidInput');
    return { kind: 'replace', apiKey: record.apiKey };
  }
  return invalid('invalidInput');
}

function requireDiscoveryCredential(value: unknown): ModelDiscoveryCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('invalidInput');
  const record = value as Record<string, unknown>;
  if (record.kind === 'none') {
    if (Object.keys(record).length !== 1) return invalid('invalidInput');
    return { kind: 'none' };
  }
  if (record.kind === 'stored') {
    if (Object.keys(record).length !== 2 || typeof record.modelProfileId !== 'string'
      || !uuid.test(record.modelProfileId)) return invalid('invalidInput');
    return { kind: 'stored', modelProfileId: record.modelProfileId };
  }
  if (record.kind === 'provided') {
    if (Object.keys(record).length !== 2 || typeof record.apiKey !== 'string'
      || !isPrintableApiKey(record.apiKey)) return invalid('invalidInput');
    return { kind: 'provided', apiKey: record.apiKey };
  }
  return invalid('invalidInput');
}

/** Closed discovery request; the endpoint is normalized here so both sides compare one spelling. */
function requireDiscoveryRequest(value: unknown): ModelDiscoveryRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('invalidInput');
  const record = value as Record<string, unknown>;
  const keys = ['requestId', 'protocol', 'endpoint', 'credential'];
  if (Object.keys(record).length !== keys.length || keys.some((key) => !(key in record))) {
    return invalid('invalidInput');
  }
  if (typeof record.requestId !== 'string' || !uuid.test(record.requestId)) return invalid('invalidInput');
  if (record.protocol !== 'openaiCompatible' && record.protocol !== 'ollama') return invalid('invalidInput');
  if (typeof record.endpoint !== 'string') return invalid('invalidEndpoint');
  return {
    requestId: record.requestId,
    protocol: record.protocol,
    endpoint: normalizeModelEndpoint(record.endpoint),
    credential: requireDiscoveryCredential(record.credential),
  };
}

/** The answer must echo the exact sent target and carry a bounded, unique ID list. */
function requireDiscoveryResponse(value: unknown, sent: ModelDiscoveryRequest): ModelDiscoveryResponse {
  const code = 'invalidResponse';
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(code, sent.requestId);
  const record = value as Record<string, unknown>;
  const keys = ['requestId', 'protocol', 'endpoint', 'modelIds', 'truncated'];
  if (Object.keys(record).length !== keys.length || keys.some((key) => !(key in record))) {
    return fail(code, sent.requestId);
  }
  if (record.requestId !== sent.requestId || record.protocol !== sent.protocol
    || record.endpoint !== sent.endpoint) return fail(code, sent.requestId);
  if (!Array.isArray(record.modelIds) || record.modelIds.length > MAX_DISCOVERED_MODELS) {
    return fail(code, sent.requestId);
  }
  const modelIds: string[] = [];
  const seen = new Set<string>();
  for (const id of record.modelIds) {
    if (typeof id !== 'string' || id.trim() === '' || [...id].length > 200 || seen.has(id)) {
      return fail(code, sent.requestId);
    }
    seen.add(id);
    modelIds.push(id);
  }
  if (typeof record.truncated !== 'boolean') return fail(code, sent.requestId);
  return {
    requestId: sent.requestId,
    protocol: sent.protocol,
    endpoint: sent.endpoint,
    modelIds,
    truncated: record.truncated,
  };
}

/** Desktop IPC. The stored read is strict: a payload this build cannot explain fails the load. */
export const desktopModelService: ModelService = {
  kind: 'desktop',
  load: async () => {
    if (!isTauri()) return unsupported();
    return requireModelsState(await invoke<unknown>('models_load'));
  },
  save: async (input, id, credential) => {
    if (!isTauri()) return unsupported();
    // The payload is validated here; the response is not re-parsed, because the settings page reads
    // the list back through `load` and a write that succeeded must never be reported as failed.
    const change = requireCredentialChange(credential);
    return await invoke<ModelProfile>('models_save', {
      input: validateModelInput(input), id: id ?? null, credential: change,
    });
  },
  delete: async (id) => {
    if (!isTauri()) return unsupported();
    await invoke('models_delete', { id });
  },
  select: async (id) => {
    if (!isTauri()) return unsupported();
    await invoke('models_select', { id });
  },
  discover: async (request) => {
    if (!isTauri()) return unsupported();
    const clean = requireDiscoveryRequest(request);
    return requireDiscoveryResponse(await invoke<unknown>('models_discover', { request: clean }), clean);
  },
  cancelDiscovery: async (requestId) => {
    if (!isTauri()) return unsupported();
    if (typeof requestId !== 'string' || !uuid.test(requestId)) return invalid('invalidInput');
    const cancelled = await invoke<unknown>('models_discover_cancel', { request: { requestId } });
    if (typeof cancelled !== 'boolean') return fail('invalidResponse', requestId);
    return cancelled;
  },
  cleanupCredentials: async () => {
    if (!isTauri()) return unsupported();
    const clean = await invoke<unknown>('models_cleanup');
    if (typeof clean !== 'boolean') return fail('invalidResponse', null);
    return clean;
  },
};

/**
 * Browser preview adapter: model profiles live in session memory and are lost on reload. It applies
 * the same metadata validation, ordering, profile limit and default-selection fallback as the
 * backend, but it never holds a credential: `hasApiKey` stays false, a replacement key is refused
 * and discovery is unsupported — never answered from a fixture or a memory secret.
 */
export function createSessionModelService(): ModelService {
  let state: ModelsState = { profiles: [], defaultModelId: null, credentialCleanupPending: false };
  return {
    kind: 'session',
    load: async () => structuredClone(state),
    save: async (input, id, credential) => {
      const change = requireCredentialChange(credential);
      if (change.kind === 'replace') return unsupported();
      const clean = validateModelInput(input);
      const existing = state.profiles.find((profile) => profile.id === id);
      if (id !== undefined && !existing) throw new Error('notFound');
      if (!existing && state.profiles.length >= MAX_MODEL_PROFILES) throw new Error('invalidInput');
      const profile: ModelProfile = {
        ...clean,
        id: existing?.id ?? crypto.randomUUID(),
        sortOrder: existing?.sortOrder ?? Math.max(-1, ...state.profiles.map((item) => item.sortOrder)) + 1,
        hasApiKey: false,
      };
      const profiles = existing
        ? state.profiles.map((item) => item.id === profile.id ? profile : item)
        : [...state.profiles, profile];
      state = {
        profiles: sortModels(profiles),
        defaultModelId: resolveDefaultModel(profiles, state.defaultModelId),
        credentialCleanupPending: false,
      };
      return structuredClone(profile);
    },
    delete: async (id) => {
      if (!state.profiles.some((profile) => profile.id === id)) throw new Error('notFound');
      const profiles = state.profiles.filter((profile) => profile.id !== id);
      state = {
        ...state,
        profiles,
        defaultModelId: resolveDefaultModel(profiles, state.defaultModelId === id ? null : state.defaultModelId),
      };
    },
    select: async (id) => {
      if (id !== null && !state.profiles.some((profile) => profile.id === id)) throw new Error('notFound');
      state = { ...state, defaultModelId: resolveDefaultModel(state.profiles, id) };
    },
    discover: async () => unsupported(),
    cancelDiscovery: async () => unsupported(),
    // No credential is ever stored in this adapter, so nothing can be pending cleanup.
    cleanupCredentials: async () => true,
  };
}

/** Desktop in the app, session memory in the browser preview — chosen once, not per call. */
export function createModelService(): ModelService {
  return isTauri() ? desktopModelService : createSessionModelService();
}
