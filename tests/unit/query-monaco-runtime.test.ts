import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as runtime from '../../src/features/query/editor/monaco-runtime';
import { queryEditorOptions } from '../../src/features/query/editor/monaco-options';
import { defaultPreferences } from '../../src/domain/preferences';
import { registerQueryCompletions } from '../../src/features/query/editor/monaco-completions';
import { localizeQueryCompletionWidget } from '../../src/features/query/editor/monaco-completion-labels';
import type { IDisposable } from 'monaco-editor/editor/editor.api';

afterAll(() => { vi.unstubAllGlobals(); });

describe('bundled Monaco runtime boundary', () => {
  it('registers real JSON coloring without requesting a schema or changing the raw text', () => {
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    const source = '{"$schema":"https://untrusted.example/schema","long":9223372036854775807}';
    const model = runtime.editor.createModel(source, 'json');
    const tokens = runtime.editor.tokenize(source, 'json')[0]!;
    expect(tokens.some((token) => token.type === 'string.key.json')).toBe(true);
    expect(tokens.some((token) => token.type === 'string.value.json')).toBe(true);
    expect(tokens.some((token) => token.type === 'number.json')).toBe(true);
    expect(model.getLanguageId()).toBe('json');
    expect(model.getValue()).toBe(source);
    expect(model.canUndo()).toBe(false);
    expect(network).not.toHaveBeenCalled();
    model.dispose();
  });

  it('runs undo/redo on a real Monaco view with JSDOM-only font metrics', () => {
    const metrics = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      font: '', measureText: () => ({ width: 8 }),
    } as unknown as CanvasRenderingContext2D);
    const host = document.createElement('div');
    document.body.append(host);
    const source = '{"id":9007199254740993}';
    const model = runtime.editor.createModel(source, 'json');
    let instance: ReturnType<typeof runtime.editor.create> | undefined;
    try {
      instance = runtime.editor.create(host, {
        ...queryEditorOptions(defaultPreferences, 'Query DSL', false),
        automaticLayout: false, dimension: { width: 500, height: 190 }, model,
      });
      instance.executeEdits('test', [{ range: model.getFullModelRange(), text: '{"id":9007199254740995}' }]);
      instance.pushUndoStop();
      expect(model.getValue()).toBe('{"id":9007199254740995}');
      instance.trigger('test', 'undo', null);
      expect(model.getValue()).toBe(source);
      instance.trigger('test', 'redo', null);
      expect(model.getValue()).toBe('{"id":9007199254740995}');
      expect(host.querySelector('textarea')).toHaveAttribute('aria-label', 'Query DSL');
    } finally {
      instance?.dispose();
      model.dispose();
      host.remove();
      metrics.mockRestore();
    }
  });

  it('constructs only the packaged editor worker and reports construction failures without exposing details', () => {
    const worker = { addEventListener: vi.fn() };
    const WorkerStub = vi.fn(function (url: string | URL, options?: WorkerOptions) {
      void url; void options;
      return worker;
    });
    vi.stubGlobal('Worker', WorkerStub);
    const environment = globalThis.MonacoEnvironment!;
    expect(environment.getWorker!('', 'editorWorkerService')).toBe(worker);
    const url = String(WorkerStub.mock.calls[0]?.[0]);
    expect(url).toContain('editor.worker');
    expect(url).not.toMatch(/^https?:\/\//);
    expect(() => environment.getWorker!('', 'json')).toThrow('unsupportedQueryEditorWorker');
    const failed = vi.fn();
    const listener = runtime.onWorkerFailure(failed);
    WorkerStub.mockImplementationOnce(() => { throw new Error('private details'); });
    expect(() => environment.getWorker!('', 'editorWorkerService')).toThrow('queryEditorWorkerUnavailable');
    expect(failed).toHaveBeenCalledOnce();
    listener.dispose();
  });

  it.each(['status', 'st${value}"\\raw'])('shows, explicitly accepts and undoes a literal completion on a real Monaco view: %s', async (name) => {
    const metrics = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      font: '', measureText: () => ({ width: 8 }),
    } as unknown as CanvasRenderingContext2D);
    const host = document.createElement('div');
    document.body.append(host);
    const source = '{"query":{"term":{"st":9007199254740993}},"exact":0.1234567890123456789}';
    const model = runtime.editor.createModel(source, 'json', runtime.Uri.from({ scheme: 'escope-query', path: '/real-completion.json' }));
    const target = { connectionId: 'c1', endpoint: 'http://localhost:9200', index: 'logs' };
    const registration = registerQueryCompletions(runtime, model, () => ({ target, fields: { target, catalog: {
      indices: ['logs'], fields: [{ name, conflict: false,
        types: [{ type: 'keyword', searchable: true, aggregatable: true, metadata: false }] }],
    } } }), (item) => `Field caps: ${item.type}`);
    let instance: ReturnType<typeof runtime.editor.create> | undefined;
    let labels: IDisposable | undefined;
    try {
      instance = runtime.editor.create(host, {
        ...queryEditorOptions(defaultPreferences, 'Query DSL', false),
        automaticLayout: false, dimension: { width: 500, height: 190 }, model,
      });
      labels = localizeQueryCompletionWidget(instance, {
        title: 'Local suggestions', empty: 'No matching local suggestions.', loading: 'Loading suggestions',
        field: 'Field evidence', parameter: 'Parameter',
      });
      instance.focus();
      instance.setPosition(model.getPositionAt(source.indexOf('"st"') + 3));
      const action = instance.getAction('editor.action.triggerSuggest');
      expect(action).not.toBeNull();
      await action!.run();
      await vi.waitFor(() => expect(host.querySelector('.suggest-widget .monaco-list-row')?.textContent).toContain(name));
      await vi.waitFor(() => expect(host.querySelector('.suggest-widget [role="listbox"]')).toHaveAttribute('aria-label', 'Local suggestions'));
      expect(host.querySelector('.suggest-widget .monaco-list-row')).toHaveAttribute('aria-label', expect.stringContaining('Field evidence'));
      expect(model.getValue()).toBe(source);
      instance.trigger('test', 'selectNextSuggestion', null);
      instance.trigger('test', 'acceptSelectedSuggestion', null);
      expect(model.getValue()).toBe(source.replace('"st"', () => JSON.stringify(name)));
      instance.trigger('test', 'undo', null);
      expect(model.getValue()).toBe(source);
      instance.trigger('test', 'redo', null);
      expect(model.getValue()).toBe(source.replace('"st"', () => JSON.stringify(name)));
      instance.trigger('test', 'hideSuggestWidget', null);
      model.setValue('{"fields":["missing"]}');
      instance.setPosition(model.getPositionAt(19));
      await action!.run();
      await vi.waitFor(() => expect(host.querySelector('.suggest-widget .message')).toHaveTextContent('No matching local suggestions.'));
    } finally {
      labels?.dispose();
      registration.dispose();
      instance?.dispose();
      model.dispose();
      host.remove();
      metrics.mockRestore();
    }
  });

  it('permits same-origin workers without allowing remote scripts, blob workers, eval or new network origins', () => {
    const config = JSON.parse(readFileSync(resolve('src-tauri/tauri.conf.json'), 'utf8')) as { app: { security: { csp: string } } };
    const directives = Object.fromEntries(config.app.security.csp.split(';').map((part) => {
      const [name, ...sources] = part.trim().split(/\s+/);
      return [name, sources];
    }));
    expect(directives['worker-src']).toEqual(["'self'"]);
    expect(directives['script-src']).toEqual(["'self'"]);
    expect(directives['connect-src']).toEqual(['ipc:', 'http://ipc.localhost']);
    expect(config.app.security.csp).not.toContain('unsafe-eval');
    expect(config.app.security.csp).not.toContain('blob:');
  });
});
