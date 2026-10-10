import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, StrictMode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryDslEditor, type QueryDslEditorHandle } from '../../src/features/query/editor/QueryDslEditor';
import { QueryEditorModels } from '../../src/features/query/editor/query-editor-models';
import { loadQueryEditor, type QueryEditorRuntime } from '../../src/features/query/editor/monaco-loader';
import { defaultPreferences } from '../../src/domain/preferences';
import { i18n } from '../../src/locales';
import { createEditorView, editorRuntime, failEditorWorker } from './monaco-view-mock';

const original = '{"query":{"term":{"id":9007199254740993}},"v":0.1234567890123456789,"escaped":"\\u0061"}';
const stores: QueryEditorModels[] = [];

function setup(overrides: Partial<React.ComponentProps<typeof QueryDslEditor>> = {}, strict = false) {
  const models = new QueryEditorModels();
  stores.push(models);
  const handle = createRef<QueryDslEditorHandle>();
  const onChange = vi.fn();
  const onHistory = vi.fn();
  let props: React.ComponentProps<typeof QueryDslEditor> = {
    models, ref: handle, queryId: 'a', value: original, preferences: { ...defaultPreferences },
    active: true, readOnly: false, diagnostic: null, onChange, onHistory, ...overrides,
  };
  const tree = () => <I18nextProvider i18n={i18n}>{strict ? <StrictMode><QueryDslEditor {...props} /></StrictMode>
    : <QueryDslEditor {...props} />}</I18nextProvider>;
  const result = render(tree());
  return {
    ...result, models, handle, onChange, onHistory, user: userEvent.setup(),
    update: (patch: Partial<typeof props>) => { props = { ...props, ...patch }; result.rerender(tree()); },
    input: () => screen.getByRole('textbox', { name: 'Query DSL' }) as HTMLTextAreaElement,
    view: () => createEditorView.mock.results.at(-1)!.value as ReturnType<typeof createEditorView>,
  };
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US');
  vi.mocked(loadQueryEditor).mockImplementation(() => editorRuntime);
  createEditorView.mockClear();
});
afterEach(() => { stores.splice(0).forEach((store) => store.dispose()); });

describe('Monaco view integration with real text models', () => {
  it('adopts a draft without echoing changes and preserves exact values on edits and undo/redo', async () => {
    const f = setup();
    expect(f.input()).toHaveValue(original);
    expect(f.onChange).not.toHaveBeenCalled();
    fireEvent.change(f.input(), { target: { value: `${original} ` } });
    expect(f.onChange).toHaveBeenLastCalledWith(`${original} `);
    f.update({ value: `${original} ` });
    act(() => f.handle.current?.undo());
    await waitFor(() => expect(f.onChange).toHaveBeenLastCalledWith(original));
    f.update({ value: original });
    act(() => f.handle.current?.redo());
    await waitFor(() => expect(f.onChange).toHaveBeenLastCalledWith(`${original} `));
  });

  it('keeps each tab model, undo stack, selection and scroll position independent', async () => {
    const f = setup();
    const a = f.view().getModel();
    f.update({ value: `${original} ` });
    f.input().setSelectionRange(3, 11);
    f.input().scrollTop = 80;
    f.input().scrollLeft = 17;
    f.update({ queryId: 'b', value: '{"size":3}' });
    expect(f.view().getModel()).not.toBe(a);
    expect(f.view().getModel()?.canUndo()).toBe(false);
    f.update({ queryId: 'a', value: `${original} ` });
    expect(f.view().getModel()).toBe(a);
    expect(f.input().selectionStart).toBe(3);
    expect(f.input().selectionEnd).toBe(11);
    expect(f.input().scrollTop).toBe(80);
    expect(f.input().scrollLeft).toBe(17);
    act(() => f.handle.current?.undo());
    await waitFor(() => expect(f.onChange).toHaveBeenLastCalledWith(original));
  });

  it('updates options and translated diagnostics without replacing a model or clearing history', async () => {
    const f = setup({ diagnostic: { code: 'dslSyntaxError', line: 1, column: 7 } });
    const model = f.view().getModel()!;
    expect(editorRuntime.editor.getModelMarkers({ resource: model.uri })[0]?.message).toBe('Invalid JSON syntax.');
    expect(f.input()).toHaveAttribute('aria-invalid', 'true');
    f.update({ value: `${original} `, preferences: { ...defaultPreferences, codeSize: 20, codeFont: 'system', density: 'compact', wrapJson: false } });
    expect(f.view().updateOptions).toHaveBeenLastCalledWith(expect.objectContaining({
      fontSize: 20, lineHeight: 32, wordWrap: 'off', readOnly: false,
    }));
    await act(() => i18n.changeLanguage('zh-CN'));
    expect(screen.getByLabelText('查询 DSL')).toBe(f.view().getDomNode()?.querySelector('textarea'));
    expect(editorRuntime.editor.getModelMarkers({ resource: model.uri })[0]?.message).toBe('JSON 语法无效。');
    expect(f.view().getModel()).toBe(model);
    expect(model.canUndo()).toBe(true);
    expect(f.onChange).not.toHaveBeenCalled();
    f.update({ diagnostic: null });
    expect(editorRuntime.editor.getModelMarkers({ resource: model.uri })).toEqual([]);
  });

  it('blocks editing and undo while read-only or hidden, but retains the draft and model', () => {
    const f = setup();
    const model = f.view().getModel();
    f.update({ value: '{"size":2}', readOnly: true });
    expect(f.input()).toHaveProperty('readOnly', true);
    act(() => f.handle.current?.undo());
    expect(model?.getValue()).toBe('{"size":2}');
    f.update({ readOnly: false, active: false });
    act(() => f.handle.current?.undo());
    expect(model?.getValue()).toBe('{"size":2}');
    f.update({ active: true });
    expect(f.input()).toHaveProperty('readOnly', false);
    expect(f.view().getModel()).toBe(model);
    expect(f.onChange).not.toHaveBeenCalled();
  });

  it('does not steal focus on tab or preference changes', () => {
    const f = setup();
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    f.update({ queryId: 'b', value: '{}' });
    f.update({ preferences: { ...defaultPreferences, codeSize: 18 } });
    expect(elsewhere).toHaveFocus();
    elsewhere.remove();
  });

  it('retains a model when its view unmounts, and releases it when the tab closes', () => {
    const f = setup({}, true);
    const model = f.view().getModel()!;
    f.unmount();
    expect(model.isDisposed()).toBe(false);
    f.models.retain([]);
    expect(model.isDisposed()).toBe(true);
  });

  it('keeps only the latest tab and text after a delayed editor load', async () => {
    let resolve!: (runtime: QueryEditorRuntime) => void;
    vi.mocked(loadQueryEditor).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const f = setup();
    expect(screen.getByText('Loading editor')).toBeInTheDocument();
    f.update({ queryId: 'b', value: '{"size":5}' });
    await act(async () => { resolve(editorRuntime); });
    expect(f.input()).toHaveValue('{"size":5}');
    expect(f.onChange).not.toHaveBeenCalled();
  });

  it('drops an editor load after unmount without creating a model or stealing focus', async () => {
    let resolve!: (runtime: QueryEditorRuntime) => void;
    vi.mocked(loadQueryEditor).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const before = editorRuntime.editor.getModels().length;
    const f = setup();
    f.unmount();
    await act(async () => { resolve(editorRuntime); });
    expect(createEditorView).not.toHaveBeenCalled();
    expect(editorRuntime.editor.getModels()).toHaveLength(before);
  });

  it('preserves a read-only draft on load failure and retries the newest text without a network execution', async () => {
    vi.mocked(loadQueryEditor).mockRejectedValueOnce(new Error('do not show details'));
    const f = setup();
    expect(await screen.findByRole('alert')).toHaveTextContent('The editor could not load. The draft is unchanged.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('do not show');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(f.container.querySelector('pre')).toHaveTextContent(original);
    f.update({ value: '{"size":19}' });
    await f.user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(f.input()).toHaveValue('{"size":19}');
    expect(f.onChange).not.toHaveBeenCalled();
  });

  it('reports worker failure without discarding or rewriting the model', () => {
    const f = setup();
    const model = f.view().getModel();
    act(failEditorWorker);
    expect(screen.getByRole('alert')).toHaveTextContent('local editor worker is unavailable');
    expect(f.view().getModel()).toBe(model);
    expect(f.input()).toHaveValue(original);
    expect(f.onChange).not.toHaveBeenCalled();
  });

  it('searches the current model with literal text, case sensitivity and keyboard navigation', async () => {
    const f = setup({ value: '{"a":"Exact", "b":"exact", "pattern":".*"}' });
    fireEvent.keyDown(f.input(), { key: 'f', ctrlKey: true });
    const find = screen.getByRole('searchbox', { name: 'Find text' });
    expect(find).toHaveFocus();
    await f.user.type(find, 'exact');
    expect(fireEvent.keyDown(find, { key: 'f', ctrlKey: true, repeat: true })).toBe(false);
    expect(find).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('2 matches');
    await f.user.click(screen.getByRole('button', { name: 'Match case' }));
    expect(screen.getByRole('status')).toHaveTextContent('1 match');
    fireEvent.keyDown(find, { key: 'Enter' });
    expect(f.view().getModel()?.getValueInRange(f.view().getSelection()!)).toBe('exact');
    fireEvent.change(find, { target: { value: '.*' } });
    expect(screen.getByRole('status')).toHaveTextContent('1 match');
    fireEvent.keyDown(find, { key: 'Escape' });
    expect(screen.queryByRole('search')).not.toBeInTheDocument();
    expect(f.input()).toHaveFocus();
    expect(f.onChange).not.toHaveBeenCalled();
  });

  it('refreshes find results after an external edit and bounds counts without bounding navigation', () => {
    const f = setup({ value: '{"a":"value value"}' });
    act(() => f.handle.current?.find());
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'value' } });
    expect(screen.getByRole('status')).toHaveTextContent('2 matches');
    f.update({ value: '{"a":"value"}' });
    expect(screen.getByRole('status')).toHaveTextContent('1 match');
    f.update({ value: `{"a":"${'value '.repeat(1002)}"}` });
    expect(screen.getByRole('status')).toHaveTextContent('More than 1000 matches');
    expect(f.onChange).not.toHaveBeenCalled();
  });

  it('keeps IME keystrokes out of find/undo and resets find input on a different tab', () => {
    const f = setup();
    fireEvent.keyDown(f.input(), { key: 'f', ctrlKey: true, isComposing: true });
    expect(screen.queryByRole('search')).not.toBeInTheDocument();
    fireEvent.keyDown(f.input(), { key: 'f', ctrlKey: true, keyCode: 229 });
    expect(screen.queryByRole('search')).not.toBeInTheDocument();
    f.update({ value: '{}' });
    fireEvent.compositionStart(f.input());
    act(() => f.handle.current?.undo());
    expect(f.view().getModel()?.getValue()).toBe('{}');
    fireEvent.compositionEnd(f.input());
    fireEvent.keyDown(f.input(), { key: 'f', ctrlKey: true });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'retained only here' } });
    f.update({ queryId: 'b', value: '{"size":1}' });
    expect(screen.queryByRole('search')).not.toBeInTheDocument();
    fireEvent.keyDown(f.input(), { key: 'f', ctrlKey: true });
    expect(screen.getByRole('searchbox')).toHaveValue('');
  });
});
