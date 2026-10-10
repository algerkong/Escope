export type QueryEditorRuntime = typeof import('./monaco-runtime');

let loaded: QueryEditorRuntime | undefined;
let pending: Promise<QueryEditorRuntime> | undefined;

/** The home/index/settings routes do not import Monaco until a query editor is mounted. */
export function loadQueryEditor(): QueryEditorRuntime | Promise<QueryEditorRuntime> {
  if (loaded) return loaded;
  pending ??= import('./monaco-runtime').then((runtime) => {
    loaded = runtime;
    return runtime;
  }).catch(() => {
    pending = undefined;
    throw new Error('queryEditorUnavailable');
  });
  return pending;
}
