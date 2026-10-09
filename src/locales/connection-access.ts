export const enConnectionAccess = {
  inspect: 'Inspect identity and permissions: {{name}}', title: 'Identity and Permissions', run: 'Inspect',
  index: 'Index or pattern', optional: 'Optional', identity: 'Current identity', username: 'Username', roles: 'Roles',
  permissions: 'Permissions', monitor: 'Cluster monitoring', read: 'Index read', viewIndexMetadata: 'Index metadata',
  capabilities: 'API support', search: 'Search', pit: 'Point in time', version: 'Server version',
  available: 'Available', denied: 'Permission denied', unknown: 'Unknown', unsupported: 'Not supported',
  pending: 'Inspecting', stale: 'Connection changed. Previous diagnostics are out of date.',
  desktopOnly: 'Identity and permissions require the desktop app.', none: 'None',
  apiScope: 'API support is based on the reported version, not a permission or license grant.',
  noIndex: 'No index checked', failed: 'Diagnostics could not be completed.',
};

export const zhConnectionAccess: typeof enConnectionAccess = {
  inspect: '检查身份与权限：{{name}}', title: '身份与权限', run: '检查',
  index: '索引或匹配模式', optional: '可选', identity: '当前身份', username: '用户名', roles: '角色',
  permissions: '权限', monitor: '集群监控', read: '索引读取', viewIndexMetadata: '索引元数据',
  capabilities: 'API 支持', search: '搜索', pit: '时间点快照', version: '服务版本',
  available: '可用', denied: '权限不足', unknown: '未知', unsupported: '不支持',
  pending: '正在检查', stale: '连接已修改，之前的诊断已过期。',
  desktopOnly: '身份与权限检查仅在桌面应用中可用。', none: '无',
  apiScope: 'API 支持按服务返回的版本判断，不代表已取得权限或许可。',
  noIndex: '未检查索引', failed: '诊断未能完成。',
};
