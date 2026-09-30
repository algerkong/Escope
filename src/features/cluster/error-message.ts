/**
 * Map structured backend error codes to translation keys for the cluster resource pages.
 * A denied read is explained as a permission problem on that read, not as a broken connection;
 * unknown codes fall back to the generic error copy instead of leaking raw text.
 */
export function clusterErrorKey(code: string, exists: (key: string) => boolean): string {
  if (code === 'unsupported') return 'cluster:desktopOnly';
  if (code === 'serverForbidden') return 'cluster:denied';
  if (code === 'invalidIndex' || code === 'invalidInput') return 'cluster:invalidTarget';
  // The shared `invalidResponse` copy talks about connection identity, which does not describe a
  // metadata body that could not be read.
  if (code === 'invalidResponse') return 'cluster:invalidResponse';
  return exists(`errors:${code}`) ? `errors:${code}` : 'errors:unexpected';
}
