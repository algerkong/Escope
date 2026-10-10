import { afterEach, describe, expect, it } from 'vitest';
import { QueryEditorModels } from '../../src/features/query/editor/query-editor-models';
import { formatQueryDsl } from '../../src/domain/query-dsl';
import { editorRuntime } from './monaco-view-mock';

const exact = '{"query":{"term":{"id":9223372036854775807}},"other":{"value":-0.12345678901234567890123456789,"exp":1E+400,"s":"a\\u0062\\n\\"c\\""}}';
const stores: QueryEditorModels[] = [];
const makeStore = () => { const store = new QueryEditorModels(); stores.push(store); return store; };
afterEach(() => { stores.splice(0).forEach((store) => store.dispose()); });

describe('real Monaco query models', () => {
  it('keeps raw unsupported DSL and exact tokens without an initial edit', () => {
    const store = makeStore();
    const entry = store.get(editorRuntime, 'query-a', exact);
    expect(entry.model.getValue()).toBe(exact);
    expect(entry.source).toBe(exact);
    expect(entry.model.canUndo()).toBe(false);
    expect(entry.model.getLanguageId()).toBe('json');
  });

  it.each([exact, ` \r\n${exact}\r\n\t`, ` \r${exact}\n\t`, `\uFEFF${exact}`])('never writes normalized model text back on adoption', (source) => {
    const store = makeStore();
    const entry = store.get(editorRuntime, 'a', source);
    expect(store.read(entry)).toBe(source);
    expect(store.get(editorRuntime, 'a', source)).toBe(entry);
    expect(entry.model.canUndo()).toBe(false);
  });

  it('formats in one undoable change and restores the verbatim original including mixed newlines', async () => {
    const store = makeStore();
    const source = ` \r\n${exact}\n\t`;
    const result = formatQueryDsl(source);
    if (!result.ok) throw new Error('expected valid fixture');
    const entry = store.get(editorRuntime, 'a', source);
    store.synchronize(entry, result.formatted);
    expect(store.read(entry)).toBe(result.formatted);
    await entry.model.undo();
    expect(store.read(entry)).toBe(source);
    expect(entry.model.canUndo()).toBe(false);
    await entry.model.redo();
    expect(store.read(entry)).toBe(result.formatted);
    expect(entry.model.canRedo()).toBe(false);
  });

  it('keeps typing, external reviewed edits and a redo branch within the original model', async () => {
    const store = makeStore();
    const entry = store.get(editorRuntime, 'a', exact);
    const typed = `${exact} `;
    entry.model.pushEditOperations(null, [{ range: entry.model.getFullModelRange(), text: typed }], () => null);
    entry.model.pushStackElement();
    expect(store.read(entry)).toBe(typed);
    expect(store.get(editorRuntime, 'a', typed)).toBe(entry);
    store.synchronize(entry, '{"size":7}');
    await entry.model.undo();
    expect(store.read(entry)).toBe(typed);
    await entry.model.undo();
    expect(store.read(entry)).toBe(exact);
    await entry.model.redo();
    expect(store.read(entry)).toBe(typed);
  });

  it('marks external changes as synchronizing until the model has accepted them', () => {
    const store = makeStore();
    const entry = store.get(editorRuntime, 'a', exact);
    const observed: boolean[] = [];
    const listener = entry.model.onDidChangeContent(() => observed.push(entry.synchronizing));
    store.synchronize(entry, '{"size":7}');
    expect(observed).toEqual([true]);
    expect(entry.synchronizing).toBe(false);
    listener.dispose();
  });

  it('isolates identical document IDs in different workspaces and never puts targets in model URIs', async () => {
    const first = makeStore();
    const second = makeStore();
    const id = 'https://private.example/private-index';
    const a = first.get(editorRuntime, id, exact);
    const b = second.get(editorRuntime, id, '{"size":2}');
    expect(a.model.uri.toString()).not.toContain('private');
    expect(a.model.uri.toString()).not.toBe(b.model.uri.toString());
    first.synchronize(a, '{}');
    await a.model.undo();
    expect(first.read(a)).toBe(exact);
    expect(b.model.getValue()).toBe('{"size":2}');
    expect(b.model.canUndo()).toBe(false);
  });

  it('retains inactive models and releases only closed documents, including their undo history', () => {
    const store = makeStore();
    const a = store.get(editorRuntime, 'a', exact);
    const b = store.get(editorRuntime, 'b', '{}');
    store.synchronize(a, '{"size":5}');
    store.retain(['a', 'b']);
    expect(store.get(editorRuntime, 'a', '{"size":5}')).toBe(a);
    store.retain(['b']);
    expect(a.model.isDisposed()).toBe(true);
    expect(b.model.isDisposed()).toBe(false);
    const reopened = store.get(editorRuntime, 'a', exact);
    expect(reopened.model).not.toBe(a.model);
    expect(reopened.model.canUndo()).toBe(false);
    store.dispose();
    expect(reopened.model.isDisposed()).toBe(true);
    expect(b.model.isDisposed()).toBe(true);
  });

  it('preserves an EOL-only external change as an undoable raw version', async () => {
    const store = makeStore();
    const source = '{\r\n  "size": 3\r\n}';
    const entry = store.get(editorRuntime, 'a', source);
    store.synchronize(entry, source.replace(/\r/g, ''));
    expect(entry.model.canUndo()).toBe(true);
    await entry.model.undo();
    expect(store.read(entry)).toBe(source);
  });
});
