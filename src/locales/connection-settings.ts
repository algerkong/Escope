/**
 * `connectionSettings` namespace: the connection credential/CA editor, its metadata badges and the
 * secure-cleanup notice. Kept in its own file so the connections feature owns its copy;
 * `locales/index.ts` registers the bundle under the `connectionSettings` key.
 *
 * The wording never claims a removed secret is already erased, never asks to disable certificate
 * validation, and never describes a stored credential as reusable for a changed endpoint.
 */
export const enConnectionSettings = {
  authNone: 'None',
  authBasic: 'Basic (username and password)',
  authApiKey: 'API Key (ID and secret)',
  authBearer: 'Bearer token',
  authCredentialSaved: 'Credential saved',
  authCredentialMissing: 'No saved credential',
  caBadgeCustom: 'Custom CA',
  caBadgeDefault: 'System CA',

  credentialKeepHint: 'A credential is saved for this connection and is never filled into this form. Leave the fields blank to keep it, or type new values to replace it when you save.',
  credentialMissingHint: 'No credential is saved for this connection. Enter one, or switch to None.',
  credentialNewHint: 'The credential is stored in the system credential store on this device and is sent only for this connection.',
  credentialNoneHint: 'Saving leaves this connection without authentication; its saved credential will be removed.',
  credentialIncompleteBasic: 'Replacing the credential requires both the username and the password; leaving both blank keeps the saved credential.',
  credentialRequiredBasic: 'Enter the username and password, or switch to None.',
  credentialIncompleteApiKey: 'Replacing the credential requires both the key ID and the secret; leaving both blank keeps the saved credential.',
  credentialRequiredApiKey: 'Enter the key ID and the secret, or switch to None.',
  credentialRequiredBearer: 'Enter the bearer token, or switch to None.',

  caLabel: 'Custom CA certificate',
  caKeep: 'Keep the saved custom CA',
  caDefault: 'Use the system trust store (default validation)',
  caReplace: 'Replace with a custom CA',
  caConfigured: 'A custom CA certificate is saved for this connection. Its contents are never displayed or exported here.',
  caPemLabel: 'CA certificate (PEM text)',
  caPemPlaceholder: '-----BEGIN CERTIFICATE-----',
  caReplaceHint: 'Paste the PEM certificate text. Private keys and other secrets are rejected by the backend and never stored.',
  caPemRequired: 'Paste the PEM certificate text, or use the system default CA.',

  endpointChangeWarning: 'The endpoint changed: the saved credential and custom CA are not carried over and will be detached when you save. Enter new material to keep using them.',
  httpAuthWarning: 'HTTP is unencrypted: the credential is sent to this endpoint without transport encryption.',
  browserNotice: 'Browser preview cannot save credentials or custom CAs; authenticated changes are rejected and are never kept in memory instead.',
  browserSaveBlocked: 'Credentials and custom CAs can only be saved from the desktop app. This change was rejected and nothing was saved.',
  saveFailed: 'The connection was not saved.',

  cleanupPending: 'Removed credential material is still waiting for secure cleanup on this device; the connection change was saved.',
  cleanupRetry: 'Retry cleanup',
  cleanupFailed: 'The secure cleanup did not complete; the removed material may still be present in the system credential store.',

  editorDescriptionDesktop: 'Metadata is stored on this device; credentials and the custom CA go to secure storage and are never shown again.',
  editorDescriptionBrowser: 'Browser preview keeps connection metadata in session memory only and stores no credentials.',

  fieldUsername: 'Username',
  fieldPassword: 'Password',
  fieldApiId: 'Key ID',
  fieldApiKey: 'Secret',
  fieldToken: 'Bearer token',
  showSecret: 'Show {{field}}',
  hideSecret: 'Hide {{field}}',
} as const;

export const zhConnectionSettings: Record<keyof typeof enConnectionSettings, string> = {
  authNone: '无认证',
  authBasic: 'Basic（用户名与密码）',
  authApiKey: 'API Key（ID 与密钥）',
  authBearer: 'Bearer Token',
  authCredentialSaved: '已保存凭据',
  authCredentialMissing: '未保存凭据',
  caBadgeCustom: '自定义 CA',
  caBadgeDefault: '系统 CA',

  credentialKeepHint: '此连接已保存凭据，字段不会回填。两项留空保存将保留现有凭据；输入新值将在保存时替换。',
  credentialMissingHint: '此连接没有已保存的凭据。请输入凭据，或切换为无认证。',
  credentialNewHint: '凭据保存在本机系统密钥库中，仅用于此连接的请求。',
  credentialNoneHint: '保存后此连接将不再使用认证，其已保存的凭据会被移除。',
  credentialIncompleteBasic: '替换凭据需要同时填写用户名与密码；两项都留空则保留已保存的凭据。',
  credentialRequiredBasic: '请输入用户名与密码，或切换为无认证。',
  credentialIncompleteApiKey: '替换凭据需要同时填写密钥 ID 与密钥；两项都留空则保留已保存的凭据。',
  credentialRequiredApiKey: '请输入密钥 ID 与密钥，或切换为无认证。',
  credentialRequiredBearer: '请输入 Bearer Token，或切换为无认证。',

  caLabel: '自定义 CA 证书',
  caKeep: '保留已保存的自定义 CA',
  caDefault: '使用系统信任的 CA（默认校验）',
  caReplace: '替换为自定义 CA',
  caConfigured: '此连接已保存自定义 CA 证书；内容不会在此显示或导出。',
  caPemLabel: 'CA 证书（PEM 文本）',
  caPemPlaceholder: '-----BEGIN CERTIFICATE-----',
  caReplaceHint: '粘贴 PEM 证书文本；私钥与其他秘密会被后端拒绝，不会保存。',
  caPemRequired: '请粘贴 PEM 证书文本，或改用系统默认 CA。',

  endpointChangeWarning: '地址已更改：已保存的凭据与自定义 CA 不会随之复用，保存时将解绑；如需继续使用，请填写新内容。',
  httpAuthWarning: 'HTTP 未加密：凭据将在没有传输加密的情况下发送。',
  browserNotice: '浏览器预览无法保存凭据或自定义 CA；此类修改会被拒绝，也不会回退为内存保存。',
  browserSaveBlocked: '凭据与自定义 CA 只能在桌面应用中保存，本次修改已被拒绝，未保存任何内容。',
  saveFailed: '连接未保存。',

  cleanupPending: '已移除的凭据材料仍在本机等待安全清理；本次修改已保存。',
  cleanupRetry: '重试清理',
  cleanupFailed: '安全清理未完成，已移除的材料可能仍存在于系统密钥库中。',

  editorDescriptionDesktop: '元数据保存在本机；凭据与自定义 CA 交由桌面端安全存储，保存后不会回显。',
  editorDescriptionBrowser: '浏览器预览仅在会话内保留连接元数据，不保存凭据。',

  fieldUsername: '用户名',
  fieldPassword: '密码',
  fieldApiId: '密钥 ID',
  fieldApiKey: '密钥',
  fieldToken: 'Bearer Token',
  showSecret: '显示{{field}}',
  hideSecret: '隐藏{{field}}',
};
