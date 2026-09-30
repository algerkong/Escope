/**
 * Map structured backend error codes to translation keys.
 * A dedicated `queryLive` entry wins, then the shared `errors` namespace; an unknown code
 * falls back to the generic error copy instead of leaking a raw key or message.
 */
function knownKey(code: string, exists: (key: string) => boolean): string {
  if (exists(`queryLive:${code}`)) return `queryLive:${code}`;
  return exists(`errors:${code}`) ? `errors:${code}` : 'errors:unexpected';
}

/** Resource reads: a denied index listing must not read as a denied query. */
export function resourceErrorKey(code: string, exists: (key: string) => boolean): string {
  if (code === 'unsupported') return 'queryLive:desktopOnly';
  if (code === 'permissionDenied' || code === 'serverForbidden') return 'queryLive:indexDenied';
  return knownKey(code, exists);
}

export function executionErrorKey(code: string, exists: (key: string) => boolean): string {
  if (code === 'unsupported') return 'queryLive:desktopOnly';
  if (code === 'invalidResponse') return 'queryLive:invalidResponse';
  return knownKey(code, exists);
}
