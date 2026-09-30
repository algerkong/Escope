/**
 * `models` namespace: model profile configuration in the settings container.
 * Kept in its own file so the models feature owns its copy; `locales/index.ts` registers the
 * bundle under the `models` key.
 *
 * The wording never claims a model works: this page stores configuration and states that no
 * endpoint was contacted, so no "online", "available" or test result is shown here.
 */
export const enModels = {
  add: 'Add model', edit: 'Edit model', filter: 'Filter models', refresh: 'Refresh',
  profileCount_one: '{{count}} model profile', profileCount_other: '{{count}} model profiles',
  empty: 'No model profile',
  emptyDetail: 'Enter an endpoint and type the model id. Saving writes local configuration only; no request is sent to that address.',
  loading: 'Loading model profiles…',
  loadFailed: 'The model profiles could not be read.',
  refreshFailed: 'The list could not be re-read after the last change. The stored values were not modified.',

  name: 'Name', protocol: 'Protocol', endpoint: 'Endpoint', modelId: 'Model ID',
  protocolOpenaiCompatible: 'OpenAI-compatible', protocolOllama: 'Ollama',
  nameHint: 'A label for this profile. The name is not the identity: renaming keeps the same id.',
  endpointHint: 'Base URL of the model service. No credentials, query string or fragment.',
  modelIdHint: 'Type the exact model id the service expects. Listing models is not implemented yet.',

  default: 'Default', setDefault: 'Use as default',
  defaultHint: 'The default model is the one the AI panel preselects. Choosing it here does not call the model.',
  configOnly: 'Configuration only: nothing is sent to this endpoint, so no connection state has been verified.',
  notVerified: 'Not verified',
  callsDisabled: 'Protocol calls are not implemented yet. This page stores the configuration only.',
  sessionNotice: 'Browser preview: model profiles are kept in session memory and are lost when the page reloads.',

  saveTitle: 'Model was not saved',
  saveFailed: 'The profile was not saved. The values you entered are kept.',
  deleteTitle: 'Delete model',
  deleteDetail: 'Deletes “{{name}}”. If it is the default, the first remaining profile becomes the default.',
  deleteFailed: 'The model was not deleted.',
  selectFailed: 'The default model could not be changed.',
  notFound: 'This model profile no longer exists.',
} as const;

export const zhModels: Record<keyof typeof enModels, string> = {
  add: '添加模型', edit: '编辑模型', filter: '筛选模型', refresh: '刷新',
  profileCount_one: '{{count}} 个模型配置', profileCount_other: '{{count}} 个模型配置',
  empty: '尚未配置模型',
  emptyDetail: '填写端点并手动输入模型 ID。保存只写入本地配置，不会向该地址发送任何请求。',
  loading: '正在加载模型配置…',
  loadFailed: '模型配置读取失败。',
  refreshFailed: '上次修改后列表未能重新读取，已保存的值未被修改。',

  name: '名称', protocol: '协议', endpoint: '端点', modelId: '模型 ID',
  protocolOpenaiCompatible: 'OpenAI 兼容', protocolOllama: 'Ollama',
  nameHint: '仅用于显示的标签；名称不是身份标识，重命名后仍保留原 ID。',
  endpointHint: '模型服务的基础地址，不含凭据、查询参数或片段。',
  modelIdHint: '手动输入服务期望的模型 ID；本版不提供模型列表拉取。',

  default: '默认', setDefault: '设为默认',
  defaultHint: '默认模型是 AI 面板的预选模型；在这里选择不会调用模型。',
  configOnly: '仅配置：不会向该端点发送请求，因此没有验证任何连接状态。',
  notVerified: '尚未验证',
  callsDisabled: '协议调用尚未实现，本页只保存配置。',
  sessionNotice: '浏览器预览：模型配置仅保存在会话内存，刷新页面后丢失。',

  saveTitle: '模型未能保存',
  saveFailed: '配置未能保存，当前填写的值仍然保留。',
  deleteTitle: '删除模型',
  deleteDetail: '删除“{{name}}”。若它正是默认模型，将自动回退到首个剩余配置。',
  deleteFailed: '模型未能删除。',
  selectFailed: '默认模型未能修改。',
  notFound: '该模型配置已不存在。',
};
