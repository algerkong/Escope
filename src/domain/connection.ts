export interface ConnectionProfile {
  readonly id: string;
  displayName: string;
  endpoint: string;
  environment: 'development' | 'staging' | 'production';
  sortOrder: number;
  auth: 'none';
}

export type ConnectionInput = Pick<ConnectionProfile, 'displayName' | 'endpoint' | 'environment'>;

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
