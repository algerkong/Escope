import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CancellationToken, editor, languages } from 'monaco-editor/editor/editor.api';
import type { QueryCompletionContext } from '../../src/domain/query-completions';
import { registerQueryCompletions } from '../../src/features/query/editor/monaco-completions';
import { editorRuntime as runtime } from './monaco-view-mock';

const target = { connectionId: 'c1', endpoint: 'http://localhost:9200', index: 'logs-*' };
const context: QueryCompletionContext = { target, fields: { target, catalog: { indices: ['logs-1'], fields: [
  { name: 'status', conflict: false, types: [{ type: 'keyword', searchable: true, aggregatable: true, metadata: false }] },
] } } };
const token: CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const models: editor.ITextModel[] = [];
afterEach(() => { models.splice(0).forEach((model) => model.dispose()); vi.restoreAllMocks(); });

function fixture() {
  const spy = vi.spyOn(runtime.languages, 'registerCompletionItemProvider');
  const source = '{\n"query":{"term":{"st":9223372036854775807}}\n}';
  const model = runtime.editor.createModel(source, 'json', runtime.Uri.from({ scheme: 'escope-query', path: `/${crypto.randomUUID()}.json` }));
  models.push(model);
  let current: QueryCompletionContext | null = context;
  const registration = registerQueryCompletions(runtime, model, () => current, (item) => `${item.origin}: ${item.type}`);
  const provider = spy.mock.calls.at(-1)![1];
  const position = model.getPositionAt(source.indexOf('"st"') + 3);
  const request = (requested = model, cancelled = false, triggerKind = runtime.languages.CompletionTriggerKind.Invoke) =>
    provider.provideCompletionItems(requested, position, { triggerKind }, { ...token, isCancellationRequested: cancelled }) as languages.CompletionList;
  return { source, model, spy, registration, request, update: (value: QueryCompletionContext | null) => { current = value; } };
}

describe('model-scoped Monaco completion provider', () => {
  it('registers the anonymous model URI and returns one literal token edit with no executable attachments', () => {
    const f = fixture();
    try {
      expect(f.spy).toHaveBeenLastCalledWith({ language: 'json', scheme: 'escope-query', pattern: f.model.uri.path }, expect.any(Object));
      const list = f.request();
      expect(list.incomplete).toBe(true);
      expect(list.suggestions).toHaveLength(1);
      const item = list.suggestions[0]!;
      expect(item).toMatchObject({
        label: { label: 'status', description: 'mapped: keyword' }, insertText: '"status"', filterText: '"status"',
        kind: runtime.languages.CompletionItemKind.Field, insertTextRules: runtime.languages.CompletionItemInsertTextRule.None,
        range: { startLineNumber: 2, endLineNumber: 2 },
      });
      for (const key of ['command', 'action', 'additionalTextEdits', 'documentation', 'commitCharacters']) expect(item).not.toHaveProperty(key);
      expect(f.model.getValue()).toBe(f.source);
      expect(f.model.canUndo()).toBe(false);
    } finally { f.registration.dispose(); }
  });

  it('does not provide another model with fields or use cancelled and automatic-trigger requests', () => {
    const f = fixture();
    const other = runtime.editor.createModel(f.source, 'json');
    models.push(other);
    try {
      expect(f.request(other).suggestions).toEqual([]);
      expect(f.request(f.model, true).suggestions).toEqual([]);
      expect(f.request(f.model, false, runtime.languages.CompletionTriggerKind.TriggerCharacter).suggestions).toEqual([]);
      f.update(null);
      expect(f.request().suggestions).toEqual([]);
    } finally { f.registration.dispose(); }
  });

  it('rechecks evidence and model contents, and makes retained callbacks inert after disposal', () => {
    const f = fixture();
    expect(f.request().suggestions).toHaveLength(1);
    f.update({ ...context, target: { ...target, endpoint: 'http://localhost:9201' } });
    expect(f.request().suggestions).toEqual([]);
    f.update(context);
    f.model.setValue(f.source.replace('"st"', '"not-current"'));
    expect(f.request().suggestions).toEqual([]);
    f.model.setValue(f.source);
    f.registration.dispose();
    expect(f.request().suggestions).toEqual([]);
  });
});
