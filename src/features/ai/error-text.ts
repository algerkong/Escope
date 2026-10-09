/**
 * Failure text for the AI panel.
 *
 * Only whitelisted codes are rendered: AI-specific codes come from the `aiChat` namespace, the
 * credential codes shared with model settings come from `models`, codes shared with the rest of
 * the app come from `errors`, and anything else falls back to the provider-failure copy. An
 * unknown code can therefore never leak a raw message or produce a missing translation.
 */
export const aiSpecificCodes = [
  'aiTargetChanged', 'aiEmptyReply',
  'aiIncompleteStream', 'aiUnsupportedResponse', 'aiProviderError',
] as const;

export type AiSpecificCode = typeof aiSpecificCodes[number];

const aiCodes: ReadonlySet<string> = new Set<string>(aiSpecificCodes);

/** Codes whose single copy lives in the `models` bundle because model settings show them too. */
const modelCredentialCodes: ReadonlySet<string> = new Set<string>([
  'credentialUnavailable', 'credentialFailure', 'credentialNotFound',
]);

const commonCodes: ReadonlySet<string> = new Set<string>([
  'invalidInput', 'invalidName', 'invalidEndpoint', 'invalidEnvironment', 'invalidIndex', 'invalidQuery',
  'duplicateRequest', 'storageUnavailable', 'notFound', 'unsupported', 'permissionDenied', 'serverForbidden',
  'cancelled', 'busy', 'networkError', 'timeout', 'authenticationFailed', 'rateLimited', 'redirectBlocked',
  'httpError', 'notElasticsearch', 'responseTooLarge', 'invalidResponse',
]);

export function aiFailureText(t: (key: string) => string, code: string): string {
  if (aiCodes.has(code)) return t(`aiChat:${code}`);
  if (modelCredentialCodes.has(code)) return t(`models:${code}`);
  if (commonCodes.has(code)) return t(`errors:${code}`);
  return t('aiChat:aiProviderError');
}
