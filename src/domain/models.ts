/**
 * Model profile configuration: what the settings page stores, and nothing else.
 *
 * A profile is a display name, a wire protocol, an endpoint and the model id the user typed. There
 * is no field for an API key, token, header or credential reference, and no field describing a
 * connection state: this module can say what was configured, never that a model works.
 *
 * The stored-data rules mirror `storage.rs` and are pinned by the shared fixtures in
 * `tests/fixtures/models-*.json`, so both languages agree on the field names, the protocol
 * spellings and the default-selection fallback.
 */

/** Hard upper bound for stored profiles; the backend refuses the next one. */
export const MAX_MODEL_PROFILES = 128;

export type ModelProtocol = 'openaiCompatible' | 'ollama';

export interface ModelProfile {
  readonly id: string;
  displayName: string;
  protocol: ModelProtocol;
  endpoint: string;
  modelId: string;
  sortOrder: number;
}

/** What the settings form submits. */
export type ModelInput = Pick<ModelProfile, 'displayName' | 'protocol' | 'endpoint' | 'modelId'>;

/** One load answer: the stored profiles plus the resolved default selection. */
export interface ModelsState {
  profiles: ModelProfile[];
  defaultModelId: string | null;
}

export const modelProtocols: readonly ModelProtocol[] = ['openaiCompatible', 'ollama'];

const inputKeys = ['displayName', 'protocol', 'endpoint', 'modelId'] as const;
const profileKeys = [...inputKeys, 'id', 'sortOrder'] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Storage order: explicit sort order first, then the stable id. Both adapters order the same way. */
export function sortModels(profiles: readonly ModelProfile[]): ModelProfile[] {
  return [...profiles].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

/**
 * Effective default selection, mirroring the Rust rule: the stored id while it still names a
 * profile, otherwise the first profile, otherwise `null`. A stored id that was deleted therefore
 * falls back to the first remaining profile instead of leaving the page without a default.
 */
export function resolveDefaultModel(profiles: readonly ModelProfile[], stored: string | null): string | null {
  if (profiles.some((profile) => profile.id === stored)) return stored;
  return sortModels(profiles)[0]?.id ?? null;
}

/**
 * Normalize one submitted profile. Same closed checks as the backend: a name of 1–80 characters, a
 * model id of 1–200 characters, a known protocol and an HTTP(S) endpoint without credentials,
 * query string or fragment. Throws the error code the UI shows instead of silently repairing input.
 */
export function validateModelInput(input: ModelInput): ModelInput {
  const displayName = input.displayName.trim();
  if (!displayName || displayName.length > 80) throw new Error('invalidName');
  if (!modelProtocols.includes(input.protocol)) throw new Error('invalidInput');
  const modelId = input.modelId.trim();
  if (!modelId || modelId.length > 200) throw new Error('invalidInput');
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint.trim());
  } catch {
    throw new Error('invalidEndpoint');
  }
  if (input.endpoint.length > 2048 || !['http:', 'https:'].includes(endpoint.protocol) || !endpoint.hostname ||
    endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('invalidEndpoint');
  }
  return { displayName, protocol: input.protocol, endpoint: endpoint.href.replace(/\/+$/, ''), modelId };
}

function requireKeys(source: Record<string, unknown>, keys: readonly string[], code: string): void {
  if (Object.keys(source).length !== keys.length || keys.some((key) => !(key in source))) throw new Error(code);
}

function requireText(value: unknown, code: string): string {
  if (typeof value !== 'string') throw new Error(code);
  return value;
}

/**
 * Contract boundary for one profile this build did not produce itself (the desktop database
 * through IPC). An unknown, missing or invalid field fails loudly instead of becoming a default
 * the user never chose.
 */
export function requireModelProfile(value: unknown): ModelProfile {
  const code = 'invalidModelProfile';
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  const source = value as Record<string, unknown>;
  requireKeys(source, profileKeys, code);
  const id = requireText(source.id, code);
  if (!uuid.test(id)) throw new Error(code);
  const sortOrder = source.sortOrder;
  if (typeof sortOrder !== 'number' || !Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 1_000_000) {
    throw new Error(code);
  }
  let clean: ModelInput;
  try {
    clean = validateModelInput({
      displayName: requireText(source.displayName, code),
      protocol: source.protocol as ModelProtocol,
      endpoint: requireText(source.endpoint, code),
      modelId: requireText(source.modelId, code),
    });
  } catch {
    throw new Error(code);
  }
  return { ...clean, id, sortOrder };
}

/**
 * Contract boundary for a whole load answer. The default must name a stored profile whenever one
 * exists, because both adapters resolve the fallback before answering: a `null` default with a
 * non-empty list means the payload did not come from this build.
 */
export function requireModelsState(value: unknown): ModelsState {
  const code = 'invalidModelsState';
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  const source = value as Record<string, unknown>;
  requireKeys(source, ['profiles', 'defaultModelId'], code);
  if (!Array.isArray(source.profiles) || source.profiles.length > MAX_MODEL_PROFILES) throw new Error(code);
  const profiles = source.profiles.map(requireModelProfile);
  const ids = new Set(profiles.map((profile) => profile.id));
  if (ids.size !== profiles.length) throw new Error(code);
  const stored = source.defaultModelId;
  if (stored !== null && (typeof stored !== 'string' || !ids.has(stored))) throw new Error(code);
  if (profiles.length > 0 && stored === null) throw new Error(code);
  return { profiles, defaultModelId: stored };
}
