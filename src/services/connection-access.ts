import { invoke, isTauri } from '@tauri-apps/api/core';
import type { ErrorCode } from './ipc';

export type AccessStatus = 'available' | 'denied' | 'unknown' | 'unsupported';
export interface AccessFeedback { status: AccessStatus; code: ErrorCode | null }
export interface ConnectionAccessRequest { requestId: string; connectionId: string; index?: string }
export interface ConnectionAccessResponse {
  requestId: string;
  connectionId: string;
  endpoint: string;
  index: string | null;
  identity: AccessFeedback & { username: string | null; roles: string[] };
  privileges: { monitor: AccessFeedback; read: AccessFeedback; viewIndexMetadata: AccessFeedback };
  capabilities: { search: AccessFeedback; pit: AccessFeedback };
  version: string | null;
}

const codes = new Set<ErrorCode>([
  'authenticationFailed', 'serverForbidden', 'notFound', 'unsupported', 'networkError', 'timeout',
  'busy', 'rateLimited', 'invalidResponse', 'responseTooLarge', 'notElasticsearch', 'redirectBlocked', 'httpError',
  'tlsError', 'invalidCertificate', 'credentialNotFound', 'credentialUnavailable', 'credentialFailure',
]);
function fail(code: ErrorCode, requestId: string): never { throw { code, requestId, retryable: false }; }
function record(value: unknown, requestId: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('invalidResponse', requestId);
  return value as Record<string, unknown>;
}
function feedback(value: unknown, requestId: string): AccessFeedback {
  const item = record(value, requestId);
  if (!['available', 'denied', 'unknown', 'unsupported'].includes(item.status as string)
    || (item.code !== null && !codes.has(item.code as ErrorCode))) return fail('invalidResponse', requestId);
  return { status: item.status as AccessStatus, code: item.code as ErrorCode | null };
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
}

/** The request names a stored connection and an optional index, never an API or privilege list. */
export async function readConnectionAccess(request: ConnectionAccessRequest): Promise<ConnectionAccessResponse> {
  const { requestId, connectionId } = request;
  if (!isTauri()) return fail('unsupported', requestId);
  const index = request.index === undefined ? undefined : request.index.trim();
  const payload = index === undefined ? { requestId, connectionId } : { requestId, connectionId, index };
  const result = record(await invoke('connection_access', { request: payload }), requestId);
  if (result.requestId !== requestId || result.connectionId !== connectionId || result.index !== (index ?? null)
    || !text(result.endpoint, 2048) || (result.version !== null && !text(result.version, 64))) return fail('invalidResponse', requestId);
  const identity = record(result.identity, requestId);
  if ((identity.username !== null && !text(identity.username, 256)) || !Array.isArray(identity.roles)
    || identity.roles.length > 128 || !identity.roles.every((role) => text(role, 256))) return fail('invalidResponse', requestId);
  const privileges = record(result.privileges, requestId);
  const capabilities = record(result.capabilities, requestId);
  return {
    requestId, connectionId, endpoint: result.endpoint, index: index ?? null, version: result.version as string | null,
    identity: { ...feedback(identity, requestId), username: identity.username as string | null, roles: identity.roles as string[] },
    privileges: {
      monitor: feedback(privileges.monitor, requestId), read: feedback(privileges.read, requestId),
      viewIndexMetadata: feedback(privileges.viewIndexMetadata, requestId),
    },
    capabilities: { search: feedback(capabilities.search, requestId), pit: feedback(capabilities.pit, requestId) },
  };
}
