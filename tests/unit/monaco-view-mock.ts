import * as monaco from 'monaco-editor/editor/editor.api';
import { vi } from 'vitest';
import type { QueryEditorRuntime } from '../../src/features/query/editor/monaco-loader';

monaco.languages.register({ id: 'json' });

interface MockViewState {
  cursorState: never[];
  contributionsState: Record<string, never>;
  viewState: { scrollTop: number; scrollLeft: number; selectionStart: number; selectionEnd: number };
}

/** JSDOM substitutes only the view. Text, undo/redo, search, positions and markers are real Monaco. */
export const createEditorView = vi.fn((host: HTMLElement, initial: monaco.editor.IStandaloneEditorConstructionOptions = {}) => {
  const root = document.createElement('div');
  root.className = 'monaco-editor';
  const input = document.createElement('textarea');
  input.className = 'inputarea';
  root.append(input);
  host.append(root);
  let options = initial;
  let model: monaco.editor.ITextModel | null = null;
  let subscription: monaco.IDisposable | undefined;
  let disposed = false;
  const listeners = new Set<(event: monaco.editor.IModelContentChangedEvent) => void>();
  const updateOptions = (next: monaco.editor.IEditorOptions) => {
    options = { ...options, ...next };
    input.setAttribute('aria-label', options.ariaLabel ?? '');
    input.readOnly = Boolean(options.readOnly);
    input.wrap = options.wordWrap === 'off' ? 'off' : 'soft';
  };
  updateOptions(initial);
  const edit = () => {
    if (!model || options.readOnly || input.value === model.getValue()) return;
    const value = input.value;
    model.pushStackElement();
    model.pushEditOperations(null, [{ range: model.getFullModelRange(), text: value }], () => null);
    model.pushStackElement();
  };
  input.addEventListener('input', edit);
  input.addEventListener('change', edit);
  const selection = () => {
    const start = model?.getPositionAt(input.selectionStart) ?? { lineNumber: 1, column: 1 };
    const end = model?.getPositionAt(input.selectionEnd) ?? start;
    return new monaco.Selection(start.lineNumber, start.column, end.lineNumber, end.column);
  };
  const view = {
    setModel: (next: monaco.editor.ITextModel | null) => {
      if (disposed) throw new Error('viewAlreadyDisposed');
      subscription?.dispose();
      model = next;
      input.value = model?.getValue() ?? '';
      subscription = model?.onDidChangeContent((event) => {
        input.value = model?.getValue() ?? '';
        for (const listener of listeners) listener(event);
      });
    },
    getModel: () => model,
    getDomNode: () => root,
    getSelection: selection,
    setSelection: (range: monaco.IRange) => {
      input.setSelectionRange(model?.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn }) ?? 0,
        model?.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn }) ?? 0);
    },
    onDidChangeModelContent: (listener: (event: monaco.editor.IModelContentChangedEvent) => void) => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    trigger: (_source: string, action: string) => {
      if (!model || options.readOnly) return;
      if (action === 'undo') return model.undo();
      if (action === 'redo') return model.redo();
    },
    focus: () => input.focus(),
    hasTextFocus: () => document.activeElement === input,
    updateOptions: vi.fn(updateOptions),
    layout: vi.fn(),
    revealRangeInCenterIfOutsideViewport: vi.fn(),
    saveViewState: (): MockViewState => ({
      cursorState: [], contributionsState: {},
      viewState: { scrollTop: input.scrollTop, scrollLeft: input.scrollLeft,
        selectionStart: input.selectionStart, selectionEnd: input.selectionEnd },
    }),
    restoreViewState: (state: MockViewState) => {
      input.scrollTop = state.viewState.scrollTop;
      input.scrollLeft = state.viewState.scrollLeft;
      input.setSelectionRange(state.viewState.selectionStart, state.viewState.selectionEnd);
    },
    dispose: () => {
      disposed = true;
      subscription?.dispose();
      listeners.clear();
      root.remove();
    },
  };
  return view as unknown as monaco.editor.IStandaloneCodeEditor;
});

const workerListeners = new Set<() => void>();
export const failEditorWorker = () => { for (const listener of workerListeners) listener(); };
export const editorRuntime: QueryEditorRuntime = {
  Uri: monaco.Uri, MarkerSeverity: monaco.MarkerSeverity,
  editor: { ...monaco.editor, create: createEditorView, defineTheme: vi.fn(), setTheme: vi.fn(), remeasureFonts: vi.fn() },
  onWorkerFailure: (listener) => {
    workerListeners.add(listener);
    return { dispose: () => { workerListeners.delete(listener); } };
  },
};
