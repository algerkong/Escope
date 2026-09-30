export const settingsGroups = [
  { id: 'personal', routes: ['general', 'appearance', 'typography', 'shortcuts'] },
  { id: 'integrations', routes: ['connections', 'models'] },
  { id: 'resources', routes: ['cluster', 'nodes', 'shards', 'indices'] },
] as const;

export type SettingsRoute = typeof settingsGroups[number]['routes'][number];
export const settingsRoutes = settingsGroups.flatMap((group) => [...group.routes]) as SettingsRoute[];
