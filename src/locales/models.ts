/**
 * `models` namespace: model profile configuration, credentials, model discovery and the explicit
 * generation test in the settings container. Kept in its own file so the models feature owns its
 * copy; `locales/index.ts` registers the bundle under the `models` key.
 *
 * The wording never claims a model works before the user runs the explicit test: a saved profile,
 * a saved key and a fetched model list are configuration, not proof of generation. Key material is
 * never part of this bundle.
 */
export const enModels = {
  add: 'Add model', edit: 'Edit model', filter: 'Filter models', refresh: 'Refresh',
  profileCount_one: '{{count}} model profile', profileCount_other: '{{count}} model profiles',
  empty: 'No model profile',
  emptyDetail: 'Add a profile with an endpoint and a model id.',
  loading: 'Loading model profiles…',
  loadFailed: 'The model profiles could not be read.',
  refreshFailed: 'The list could not be re-read after the last change. The stored values were not modified.',

  name: 'Name', protocol: 'Protocol', endpoint: 'Endpoint', modelId: 'Model ID',
  protocolOpenaiCompatible: 'OpenAI-compatible', protocolOllama: 'Ollama',
  endpointHintOllama: 'Base URL of the Ollama service, for example http://127.0.0.1:11434 (without /v1).',
  endpointHintCompatible: 'Base URL including the API path, for example http://127.0.0.1:8000/v1.',

  fetchModels: 'Fetch models', fetching: 'Fetching model list…',
  fetchFailed: 'The model list could not be fetched.',
  fetchEmpty: 'The endpoint returned no model id. Enter one manually.',
  fetchTruncated: 'Showing the first {{count}} model ids; the list may be truncated.',
  discoveredModels: 'Fetched models', manualModelId: 'Manual entry',

  apiKey: 'API key',
  apiKeyNew: 'Optional. Stored on this device for this endpoint and protocol, and sent only as the request credential.',
  apiKeyKeep: 'A key is saved for this target. Leave blank to keep it; type a new value to replace it.',
  apiKeyReenter: 'The endpoint or protocol changed: the saved key will not be reused. Type a new key, or confirm the removal below.',
  apiKeySession: 'Browser preview: keys are not stored here; leave this blank.',
  apiKeyInvalid: 'The key may only contain printable ASCII characters without spaces, up to 2048 bytes.',
  clearKey: 'Remove the saved key when saving',
  showKey: 'Show key', hideKey: 'Hide key',
  httpWarning: 'HTTP is unencrypted: the key and messages are sent without transport encryption. You can continue.',

  keyConfigured: 'Key saved', keyNone: 'No key',

  test: 'Test model', testRunning: 'Waiting for the model…', testStreaming: 'Receiving the reply…',
  testCancel: 'Cancel test', testRetry: 'Retry test', testCancelled: 'Test cancelled',
  testPassed: 'Generation OK', testFailed: 'Test failed',
  testLatency: '{{value}} ms', testActualModel: 'Actual model: {{id}}', testActualUnknown: 'Actual model: not reported',
  testAt: 'at {{time}}',
  testDesktopOnly: 'Model tests require the desktop app.',
  testIncomplete: 'The model reply did not finish normally, so no success was recorded.',
  testEmptyReply: 'The model returned no text, so no success was recorded.',

  default: 'Default', setDefault: 'Use as default',
  notVerified: 'Not verified',
  sessionNotice: 'Browser preview: model profiles are kept in session memory and are lost when the page reloads.',

  cleanupPending: 'A removed key is still waiting for secure cleanup; the profile change was saved.',
  cleanupRetry: 'Retry cleanup',
  cleanupFailed: 'The credential cleanup could not be completed.',

  credentialUnavailable: 'The saved key is unavailable: the system credential store could not be read. Save the key again or remove it.',
  credentialFailure: 'The credential store rejected the last key operation. Try again or remove the saved key.',
  credentialNotFound: 'No saved key was found for this target. Save one, or send without authentication.',

  aiTargetChanged: 'The response did not match the requested target and was discarded.',

  saveTitle: 'Model was not saved',
  saveFailed: 'The profile was not saved. The values you entered are kept.',
  deleteTitle: 'Delete model',
  deleteDetail: 'Deletes “{{name}}”. Its saved key is removed from this device; if it is the default, the first remaining profile becomes the default.',
  deleteFailed: 'The model was not deleted.',
  selectFailed: 'The default model could not be changed.',
  notFound: 'This model profile no longer exists.',
} as const;

export const zhModels: Record<keyof typeof enModels, string> = {
  add: '添加模型', edit: '编辑模型', filter: '筛选模型', refresh: '刷新',
  profileCount_one: '{{count}} 个模型配置', profileCount_other: '{{count}} 个模型配置',
  empty: '尚未配置模型',
  emptyDetail: '添加包含端点与模型 ID 的配置。',
  loading: '正在加载模型配置…',
  loadFailed: '模型配置读取失败。',
  refreshFailed: '上次修改后列表未能重新读取，已保存的值未被修改。',

  name: '名称', protocol: '协议', endpoint: '端点', modelId: '模型 ID',
  protocolOpenaiCompatible: 'OpenAI 兼容', protocolOllama: 'Ollama',
  endpointHintOllama: 'Ollama 服务的基础地址，例如 http://127.0.0.1:11434（不要加 /v1）。',
  endpointHintCompatible: '包含 API 路径的基础地址，例如 http://127.0.0.1:8000/v1。',

  fetchModels: '获取模型', fetching: '正在获取模型列表…',
  fetchFailed: '模型列表获取失败。',
  fetchEmpty: '端点未返回任何模型 ID，可手动填写。',
  fetchTruncated: '仅显示前 {{count}} 个模型 ID，列表可能已被截断。',
  discoveredModels: '已获取的模型', manualModelId: '手动输入',

  apiKey: 'API 密钥',
  apiKeyNew: '可选。按当前端点与协议保存在本机，只作为请求凭据发送。',
  apiKeyKeep: '该目标已保存密钥：留空保持不变，输入新值即替换。',
  apiKeyReenter: '端点或协议已更改：不会沿用已保存的密钥。请输入新密钥，或在下方确认清除。',
  apiKeySession: '浏览器预览不会保存密钥，请留空。',
  apiKeyInvalid: '密钥只能包含可打印 ASCII 字符（不含空格），最多 2048 字节。',
  clearKey: '保存时移除已保存的密钥',
  showKey: '显示密钥', hideKey: '隐藏密钥',
  httpWarning: 'HTTP 未加密：密钥与消息都不会经过传输加密，仍可继续。',

  keyConfigured: '已保存密钥', keyNone: '未保存密钥',

  test: '测试模型', testRunning: '正在等待模型响应…', testStreaming: '正在接收回复…',
  testCancel: '取消测试', testRetry: '重试测试', testCancelled: '测试已取消',
  testPassed: '生成测试通过', testFailed: '测试失败',
  testLatency: '{{value}} 毫秒', testActualModel: '实际模型：{{id}}', testActualUnknown: '实际模型：未上报',
  testAt: '时间 {{time}}',
  testDesktopOnly: '模型测试需要桌面应用。',
  testIncomplete: '模型回复未正常完成，不计为通过。',
  testEmptyReply: '模型未返回文本，不计为通过。',

  default: '默认', setDefault: '设为默认',
  notVerified: '尚未验证',
  sessionNotice: '浏览器预览：模型配置仅保存在会话内存，刷新页面后丢失。',

  cleanupPending: '有已移除的密钥等待安全清理；配置修改已保存。',
  cleanupRetry: '重试清理',
  cleanupFailed: '凭据清理未能完成。',

  credentialUnavailable: '已保存的密钥不可用：系统凭据存储读取失败。请重新保存密钥或将其移除。',
  credentialFailure: '凭据存储拒绝了上次密钥操作。请重试或移除已保存的密钥。',
  credentialNotFound: '该目标没有已保存的密钥。请保存密钥，或不带认证发送。',

  aiTargetChanged: '响应与请求的模型目标不一致，已丢弃。',

  saveTitle: '模型未能保存',
  saveFailed: '配置未能保存，当前填写的值仍然保留。',
  deleteTitle: '删除模型',
  deleteDetail: '删除“{{name}}”。其保存的密钥会从本机移除；若它正是默认模型，将自动回退到首个剩余配置。',
  deleteFailed: '模型未能删除。',
  selectFailed: '默认模型未能修改。',
  notFound: '该模型配置已不存在。',
};
