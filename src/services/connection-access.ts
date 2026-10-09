import { invoke, isTauri } from '@tauri-apps/api/core';
import type { ErrorCode } from './ipc';

export type AccessStatus = 'available' | 'denied' | 'unknown' | 'unsupported';
export interface AccessFeedback { status: AccessStatus; code: ErrorCode | null }
export type CapabilityStatus = 'unknown' | 'unsupported' | 'reported' | 'unlicensed' | 'disabled';
export type EvidenceSource = 'none' | 'version' | 'deployment' | 'featureReport';
export type EvidenceReason = 'notProbed' | 'versionTooOld' | 'serverless' | 'featureReported'
  | 'featureMissing' | 'diagnosticFailed' | 'conflictingEvidence';
export interface CapabilityFeedback {
  status: CapabilityStatus;
  source: EvidenceSource;
  reason: EvidenceReason;
  code: ErrorCode | null;
}
export const capabilityNames = ['search', 'pit', 'sql', 'eql', 'esql', 'graph'] as const;
export type CapabilityName = typeof capabilityNames[number];
export interface FeatureFlags { available: boolean; enabled: boolean }
export interface ServerInfo extends AccessFeedback {
  version: string | null;
  versionKind: 'release' | 'serverless' | 'unrecognized';
  buildFlavor: 'default' | 'oss' | 'serverless' | 'unknown';
  deployment: 'serverless' | 'unknown';
  clusterUuid: string | null;
}
export interface LicenseInfo extends AccessFeedback {
  kind: 'basic' | 'trial' | 'standard' | 'gold' | 'platinum' | 'enterprise' | 'missing' | null;
  state: 'active' | 'expired' | 'invalid' | null;
  expiryTimeMs: string | null;
}
export interface FeatureInfo extends AccessFeedback {
  sql: FeatureFlags | null;
  eql: FeatureFlags | null;
  esql: FeatureFlags | null;
  graph: FeatureFlags | null;
}
export interface ConnectionAccessRequest {
  requestId: string;
  connectionId: string;
  index?: string;
  refresh?: boolean;
}
export interface ConnectionAccessResponse {
  requestId: string;
  connectionId: string;
  endpoint: string;
  index: string | null;
  identity: AccessFeedback & { username: string | null; roles: string[] };
  privileges: { monitor: AccessFeedback; read: AccessFeedback; viewIndexMetadata: AccessFeedback };
  server: ServerInfo;
  license: LicenseInfo;
  featureReport: FeatureInfo;
  capabilities: Record<CapabilityName, CapabilityFeedback>;
  checkedAtMs: number;
  reports: { source: 'live' | 'cache'; checkedAtMs: number; ageMs: number; ttlMs: number };
  operationVerification: 'notRun';
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
  if (item.code !== null) {
    const expected = item.code === 'unsupported' ? 'unsupported'
      : item.code === 'authenticationFailed' || item.code === 'serverForbidden' ? 'denied' : 'unknown';
    if (item.status !== expected) return fail('invalidResponse', requestId);
  }
  return { status: item.status as AccessStatus, code: item.code as ErrorCode | null };
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function serverInfo(value: unknown, requestId: string): ServerInfo {
  const item = record(value, requestId);
  const state = feedback(item, requestId);
  if ((item.version !== null && !text(item.version, 64)) || (item.clusterUuid !== null && !text(item.clusterUuid, 128))
    || !['release', 'serverless', 'unrecognized'].includes(item.versionKind as string)
    || !['default', 'oss', 'serverless', 'unknown'].includes(item.buildFlavor as string)
    || !['serverless', 'unknown'].includes(item.deployment as string)
    || (item.buildFlavor === 'serverless') !== (item.deployment === 'serverless')
    || (item.versionKind === 'serverless') !== (item.deployment === 'serverless')) return fail('invalidResponse', requestId);
  if (state.status === 'available' ? item.version === null
    : item.version !== null || item.clusterUuid !== null || item.buildFlavor !== 'unknown'
      || item.versionKind !== 'unrecognized' || item.deployment !== 'unknown') return fail('invalidResponse', requestId);
  if (item.versionKind === 'release' && (typeof item.version !== 'string'
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(item.version)
    || !item.version.split('.').every((part) => Number(part) <= 0xffffffff))) return fail('invalidResponse', requestId);
  return {
    ...state, version: item.version as string | null, clusterUuid: item.clusterUuid as string | null,
    versionKind: item.versionKind as ServerInfo['versionKind'], buildFlavor: item.buildFlavor as ServerInfo['buildFlavor'],
    deployment: item.deployment as ServerInfo['deployment'],
  };
}

function licenseInfo(value: unknown, requestId: string): LicenseInfo {
  const item = record(value, requestId);
  const state = feedback(item, requestId);
  if ((item.kind !== null && !['basic', 'trial', 'standard', 'gold', 'platinum', 'enterprise', 'missing'].includes(item.kind as string))
    || (item.state !== null && !['active', 'expired', 'invalid'].includes(item.state as string))
    || (item.expiryTimeMs !== null && (typeof item.expiryTimeMs !== 'string'
      || !/^(0|[1-9]\d{0,19})$/.test(item.expiryTimeMs) || BigInt(item.expiryTimeMs) > 18446744073709551615n))
    || (state.status === 'available' ? item.kind === null || item.state === null
      : item.kind !== null || item.state !== null || item.expiryTimeMs !== null)) return fail('invalidResponse', requestId);
  return { ...state, kind: item.kind as LicenseInfo['kind'], state: item.state as LicenseInfo['state'], expiryTimeMs: item.expiryTimeMs as string | null };
}

function flags(value: unknown, requestId: string): FeatureFlags | null {
  if (value === null) return null;
  const item = record(value, requestId);
  if (typeof item.available !== 'boolean' || typeof item.enabled !== 'boolean') return fail('invalidResponse', requestId);
  return { available: item.available, enabled: item.enabled };
}

function featureInfo(value: unknown, requestId: string): FeatureInfo {
  const item = record(value, requestId);
  const state = feedback(item, requestId);
  const result = { ...state, sql: flags(item.sql, requestId), eql: flags(item.eql, requestId),
    esql: flags(item.esql, requestId), graph: flags(item.graph, requestId) };
  if (state.status !== 'available' && [result.sql, result.eql, result.esql, result.graph].some((value) => value !== null)) {
    return fail('invalidResponse', requestId);
  }
  return result;
}

function capability(
  value: unknown, name: CapabilityName, server: ServerInfo, features: FeatureInfo, requestId: string,
): CapabilityFeedback {
  const item = record(value, requestId);
  let status: CapabilityStatus = 'unknown';
  let source: EvidenceSource = 'none';
  let reason: EvidenceReason = 'notProbed';
  let code: ErrorCode | null = null;
  if (name === 'pit' && server.versionKind === 'release' && ['default', 'oss'].includes(server.buildFlavor)
    && server.version?.split('.')[0] === '7' && Number(server.version.split('.')[1]) < 10) {
    status = 'unsupported'; source = 'version'; reason = 'versionTooOld';
  } else if (name === 'graph' && server.deployment === 'serverless') {
    const conflict = features.graph?.available === true && features.graph.enabled;
    status = conflict ? 'unknown' : 'unsupported'; source = 'deployment';
    reason = conflict ? 'conflictingEvidence' : 'serverless';
  } else if (name !== 'search' && name !== 'pit') {
    const flags = features[name];
    source = 'featureReport';
    if (flags) {
      status = !flags.enabled ? 'disabled' : !flags.available ? 'unlicensed' : 'reported';
      reason = 'featureReported';
    } else {
      reason = features.status === 'available' ? 'featureMissing' : 'diagnosticFailed';
      code = features.code;
    }
  }
  // Never accept a positive capability synthesized from version, license tier or a mismatched report.
  if (item.status !== status || item.source !== source || item.reason !== reason || item.code !== code) {
    return fail('invalidResponse', requestId);
  }
  return { status, source, reason, code };
}

/** The request names a stored connection and an optional index, never an API or privilege list. */
export async function readConnectionAccess(request: ConnectionAccessRequest): Promise<ConnectionAccessResponse> {
  const { requestId, connectionId } = request;
  if (!isTauri()) return fail('unsupported', requestId);
  if ((request.index !== undefined && typeof request.index !== 'string')
    || (request.refresh !== undefined && typeof request.refresh !== 'boolean')) return fail('invalidInput', requestId);
  const index = request.index === undefined ? undefined : request.index.trim();
  const payload = { requestId, connectionId, ...(index === undefined ? {} : { index }),
    ...(request.refresh === undefined ? {} : { refresh: request.refresh }) };
  const result = record(await invoke('connection_access', { request: payload }), requestId);
  if (result.requestId !== requestId || result.connectionId !== connectionId || result.index !== (index ?? null)
    || !text(result.endpoint, 2048) || !integer(result.checkedAtMs)
    || result.operationVerification !== 'notRun') return fail('invalidResponse', requestId);
  const identity = record(result.identity, requestId);
  if ((identity.username !== null && !text(identity.username, 256)) || !Array.isArray(identity.roles)
    || identity.roles.length > 128 || !identity.roles.every((role) => text(role, 256))) return fail('invalidResponse', requestId);
  const identityFeedback = feedback(identity, requestId);
  if (identity.username === null && (identityFeedback.status === 'available' || identity.roles.length !== 0)) return fail('invalidResponse', requestId);
  const privileges = record(result.privileges, requestId);
  const capabilities = record(result.capabilities, requestId);
  const server = serverInfo(result.server, requestId);
  const license = licenseInfo(result.license, requestId);
  const featureReport = featureInfo(result.featureReport, requestId);
  const reports = record(result.reports, requestId);
  if (!['live', 'cache'].includes(reports.source as string) || !integer(reports.checkedAtMs)
    || !integer(reports.ageMs) || reports.ttlMs !== 60_000) return fail('invalidResponse', requestId);
  return {
    requestId, connectionId, endpoint: result.endpoint, index: index ?? null,
    identity: { ...identityFeedback, username: identity.username as string | null, roles: identity.roles as string[] },
    privileges: {
      monitor: feedback(privileges.monitor, requestId), read: feedback(privileges.read, requestId),
      viewIndexMetadata: feedback(privileges.viewIndexMetadata, requestId),
    },
    server, license, featureReport,
    capabilities: {
      search: capability(capabilities.search, 'search', server, featureReport, requestId),
      pit: capability(capabilities.pit, 'pit', server, featureReport, requestId),
      sql: capability(capabilities.sql, 'sql', server, featureReport, requestId),
      eql: capability(capabilities.eql, 'eql', server, featureReport, requestId),
      esql: capability(capabilities.esql, 'esql', server, featureReport, requestId),
      graph: capability(capabilities.graph, 'graph', server, featureReport, requestId),
    },
    checkedAtMs: result.checkedAtMs, operationVerification: 'notRun',
    reports: { source: reports.source as 'live' | 'cache', checkedAtMs: reports.checkedAtMs, ageMs: reports.ageMs, ttlMs: reports.ttlMs },
  };
}
