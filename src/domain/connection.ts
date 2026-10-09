export interface ConnectionProfile {
  readonly id: string;
  displayName: string;
  endpoint: string;
  environment: 'development' | 'staging' | 'production';
  sortOrder: number;
  auth: 'none' | 'basic' | 'apiKey' | 'bearer';
  hasCredential?: boolean;
  hasCustomCa?: boolean;
}

export type ConnectionInput = Pick<ConnectionProfile, 'displayName' | 'endpoint' | 'environment'>;

export type ConnectionCredentialChange =
  | { kind: 'keep' | 'clear' }
  | { kind: 'basic'; username: string; password: string }
  | { kind: 'apiKey'; id: string; key: string }
  | { kind: 'bearer'; token: string };

export type ConnectionCaChange = { kind: 'keep' | 'clear' } | { kind: 'replace'; pem: string };

export interface ConnectionSecurityChange {
  credential: ConnectionCredentialChange;
  ca: ConnectionCaChange;
}

export interface CredentialCleanupState {
  status: 'complete' | 'pending' | 'incomplete';
  remaining: number | null;
  abandoned: number;
}

export interface ConnectionWriteResult {
  profile: ConnectionProfile;
  credentialDetached: boolean;
  cleanup: CredentialCleanupState;
}

export interface ConnectionDeleteResult {
  cleanup: CredentialCleanupState;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

function invalid(): never { throw { code: 'invalidInput', requestId: null, retryable: false }; }

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && encoder.encode(value).length <= bytes && !value.includes('\0');
}

/** The only secret-bearing frontend value. It is submitted, never merged into a profile. */
export function requireConnectionSecurity(value?: ConnectionSecurityChange): ConnectionSecurityChange {
  if (value === undefined) return { credential: { kind: 'keep' }, ca: { kind: 'keep' } };
  const security = record(value);
  if (!exactKeys(security, ['credential', 'ca'])) return invalid();
  const input = record(security.credential);
  let credential: ConnectionCredentialChange;
  if ((input.kind === 'keep' || input.kind === 'clear') && exactKeys(input, ['kind'])) {
    credential = { kind: input.kind };
  } else if (input.kind === 'basic' && exactKeys(input, ['kind', 'username', 'password'])
    && boundedText(input.username, 256) && !input.username.includes(':') && boundedText(input.password, 1536)) {
    credential = { kind: 'basic', username: input.username, password: input.password };
  } else if (input.kind === 'apiKey' && exactKeys(input, ['kind', 'id', 'key'])
    && boundedText(input.id, 256) && !input.id.includes(':') && boundedText(input.key, 1536)) {
    credential = { kind: 'apiKey', id: input.id, key: input.key };
  } else if (input.kind === 'bearer' && exactKeys(input, ['kind', 'token'])
    && boundedText(input.token, 1536) && /^[\x21-\x7e]+$/.test(input.token)) {
    credential = { kind: 'bearer', token: input.token };
  } else return invalid();
  const tls = record(security.ca);
  let ca: ConnectionCaChange;
  if ((tls.kind === 'keep' || tls.kind === 'clear') && exactKeys(tls, ['kind'])) ca = { kind: tls.kind };
  else if (tls.kind === 'replace' && exactKeys(tls, ['kind', 'pem']) && boundedText(tls.pem, 65536)) {
    ca = { kind: 'replace', pem: tls.pem };
  } else return invalid();
  return { credential, ca };
}

/** Public metadata has no place for vault references or secret payloads. */
export function requireConnectionProfile(value: unknown): ConnectionProfile {
  const profile = record(value);
  if (!exactKeys(profile, ['id', 'displayName', 'endpoint', 'environment', 'sortOrder', 'auth', 'hasCredential', 'hasCustomCa'])
    || typeof profile.id !== 'string' || !uuid.test(profile.id)
    || typeof profile.displayName !== 'string' || typeof profile.endpoint !== 'string'
    || typeof profile.environment !== 'string' || !['development', 'staging', 'production'].includes(profile.environment)
    || typeof profile.sortOrder !== 'number' || !Number.isSafeInteger(profile.sortOrder) || profile.sortOrder < 0
    || typeof profile.auth !== 'string' || !['none', 'basic', 'apiKey', 'bearer'].includes(profile.auth)
    || typeof profile.hasCredential !== 'boolean' || profile.hasCredential !== (profile.auth !== 'none')
    || typeof profile.hasCustomCa !== 'boolean') return invalid();
  const input = validateConnection(profile as unknown as ConnectionInput);
  return {
    ...input, id: profile.id, sortOrder: profile.sortOrder, auth: profile.auth as ConnectionProfile['auth'],
    hasCredential: profile.hasCredential, hasCustomCa: profile.hasCustomCa,
  };
}

export function selectConnection(profiles: readonly ConnectionProfile[], requested: string | null): string | null {
  if (profiles.some((profile) => profile.id === requested)) return requested;
  return [...profiles].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))[0]?.id ?? null;
}

export function validateConnection(input: ConnectionInput): ConnectionInput {
  const displayName = input.displayName.trim();
  if (!displayName || displayName.length > 80) throw new Error('invalidName');
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
  if (!['development', 'staging', 'production'].includes(input.environment)) throw new Error('invalidEnvironment');
  return { displayName, endpoint: endpoint.href.replace(/\/$/, ''), environment: input.environment };
}
