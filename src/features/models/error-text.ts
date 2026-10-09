import { aiFailureText } from '../ai/error-text';

/**
 * Failure text for the model settings page.
 *
 * Model-specific codes (credentials, the key shape and generation-test outcomes) have a single
 * copy in the `models` namespace; AI codes reuse the AI bundle through `aiFailureText`, except
 * `aiTargetChanged` whose AI copy talks about the chat review and is replaced by a short
 * target-mismatch line here. Shared codes reuse the `errors` texts, and an unknown code falls back
 * to the storage-failure copy, so a raw backend message is never rendered.
 */
export const modelSpecificCodes = [
  'apiKeyInvalid', 'credentialUnavailable', 'credentialFailure', 'credentialNotFound',
  'testIncomplete', 'testEmptyReply',
] as const;

export type ModelSpecificCode = typeof modelSpecificCodes[number];

const specificCodes: ReadonlySet<string> = new Set<string>(modelSpecificCodes);

/** AI transport codes whose failures the model page can explain, beyond the two model overrides. */
const aiCodes: ReadonlySet<string> = new Set<string>([
  'aiApprovalRequired', 'aiIncompleteStream', 'aiUnsupportedResponse', 'aiProviderError',
]);

const sharedCodes: ReadonlySet<string> = new Set<string>([
  'invalidInput', 'invalidName', 'invalidEndpoint', 'storageUnavailable', 'notFound', 'unsupported',
  'permissionDenied', 'serverForbidden', 'cancelled', 'busy', 'networkError', 'timeout',
  'authenticationFailed', 'rateLimited', 'redirectBlocked', 'httpError', 'notElasticsearch',
  'responseTooLarge', 'invalidResponse',
]);

export function modelFailureText(t: (key: string) => string, code: string): string {
  if (specificCodes.has(code)) return t(`models:${code}`);
  if (code === 'aiTargetChanged') return t('models:aiTargetChanged');
  if (aiCodes.has(code)) return aiFailureText(t, code);
  if (sharedCodes.has(code)) return t(`errors:${code}`);
  return t('errors:storageUnavailable');
}
