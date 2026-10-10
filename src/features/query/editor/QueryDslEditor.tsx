import { LoaderCircle, RotateCw, TriangleAlert } from 'lucide-react';
import { useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import type { editor } from 'monaco-editor/editor/editor.api';
import type { Preferences } from '../../../domain/preferences';
import type { QueryDslError } from '../../../domain/query-dsl';
import { IconButton } from '../../../components/controls';
import { loadQueryEditor, type QueryEditorRuntime } from './monaco-loader';
import { queryEditorOptions, queryEditorTheme } from './monaco-options';
import { QueryEditorModels, type QueryEditorModel } from './query-editor-models';
import { QueryEditorFind } from './QueryEditorFind';
import '../../../styles/query-editor.css';

export interface QueryEditorHistory {
  id: string;
  canUndo: boolean;
  canRedo: boolean;
}

export interface QueryDslEditorHandle {
  focus: () => void;
  undo: () => void;
  redo: () => void;
  find: () => void;
}

interface Props {
  ref?: Ref<QueryDslEditorHandle>;
  models: QueryEditorModels;
  queryId: string;
  value: string;
  preferences: Preferences;
  active: boolean;
  readOnly: boolean;
  diagnostic: QueryDslError | null;
  onChange: (value: string) => void;
  onHistory: (history: QueryEditorHistory | null) => void;
}

interface Ready {
  runtime: QueryEditorRuntime;
  instance: editor.IStandaloneCodeEditor;
}

export function QueryDslEditor(props: Props) {
  const { t } = useTranslation();
  const { models, queryId, value, preferences, active, readOnly, diagnostic } = props;
  const shell = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  const current = useRef<Ready | null>(null);
  const record = useRef<QueryEditorModel | null>(null);
  const [ready, setReady] = useState<Ready | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [workerFailed, setWorkerFailed] = useState(false);
  const [findFor, setFindFor] = useState<string | null>(null);
  const composing = useRef(false);

  useLayoutEffect(() => { latest.current = props; });

  const focus = () => {
    if (!latest.current.active || document.querySelector('[role="dialog"]')) return;
    if (current.current) current.current.instance.focus();
    else shell.current?.focus();
  };
  const command = (action: 'undo' | 'redo') => {
    if (!latest.current.active || latest.current.readOnly || composing.current || document.querySelector('[role="dialog"]')) return;
    current.current?.instance.trigger('escope', action, null);
    focus();
  };
  useImperativeHandle(props.ref, () => ({
    focus, undo: () => command('undo'), redo: () => command('redo'),
    find: () => { if (latest.current.active && current.current) setFindFor(latest.current.queryId); },
  }));

  useLayoutEffect(() => {
    let disposed = false;
    let mounted: Ready | null = null;
    let failureListener: { dispose: () => void } | undefined;
    setFailed(false);
    setReady(null);
    const mount = (runtime: QueryEditorRuntime) => {
      if (disposed || !surface.current) return;
      const instance = runtime.editor.create(surface.current, queryEditorOptions(
        latest.current.preferences, '', !latest.current.active || latest.current.readOnly));
      mounted = { runtime, instance };
      current.current = mounted;
      failureListener = runtime.onWorkerFailure(() => { if (!disposed) setWorkerFailed(true); });
      setReady(mounted);
    };
    const fail = () => {
      if (disposed) return;
      mounted?.instance.dispose();
      mounted = null;
      current.current = null;
      surface.current?.replaceChildren();
      setReady(null);
      setFailed(true);
    };
    try {
      const loading = loadQueryEditor();
      if (loading instanceof Promise) void loading.then(mount).catch(fail);
      else mount(loading);
    } catch { fail(); }
    return () => {
      disposed = true;
      failureListener?.dispose();
      if (record.current && !record.current.model.isDisposed() && mounted) {
        record.current.view = mounted.instance.saveViewState();
      }
      mounted?.instance.dispose();
      current.current = null;
      record.current = null;
      latest.current.onHistory(null);
    };
  }, [attempt]);

  useLayoutEffect(() => {
    if (!ready) return;
    const { runtime, instance } = ready;
    const entry = models.get(runtime, queryId, latest.current.value);
    record.current = entry;
    instance.setModel(entry.model);
    if (entry.view) instance.restoreViewState(entry.view);
    instance.layout();
    const publish = () => {
      if (entry.model.isDisposed() || record.current !== entry) return;
      latest.current.onHistory({ id: queryId, canUndo: entry.model.canUndo(), canRedo: entry.model.canRedo() });
    };
    const changed = instance.onDidChangeModelContent(() => {
      if (entry.synchronizing || latest.current.queryId !== queryId || entry.model.isDisposed()) return;
      const source = models.read(entry);
      if (latest.current.active && !latest.current.readOnly) latest.current.onChange(source);
      // Monaco finishes updating the undo/redo stack after its content notification.
      queueMicrotask(publish);
    });
    publish();
    if (document.activeElement === shell.current && latest.current.active && !document.querySelector('[role="dialog"]')) instance.focus();
    return () => {
      changed.dispose();
      if (current.current === ready) {
        if (!entry.model.isDisposed()) entry.view = instance.saveViewState();
        instance.setModel(null);
      }
      if (record.current === entry) record.current = null;
    };
  }, [ready, models, queryId]);

  useLayoutEffect(() => {
    if (!ready || !record.current) return;
    models.synchronize(record.current, value);
    const model = record.current.model;
    latest.current.onHistory({ id: queryId, canUndo: model.canUndo(), canRedo: model.canRedo() });
  }, [ready, models, queryId, value]);

  useLayoutEffect(() => {
    if (!ready || !record.current) return;
    const { runtime, instance } = ready;
    const options = queryEditorOptions(preferences, t('query:dslLabel'), readOnly || !active);
    // Model selection belongs to the lifecycle above, not to preference updates.
    const { model: _model, ...updated } = options;
    void _model;
    instance.updateOptions({ ...updated, readOnlyMessage: { value: t('query:editorReadOnly'), isTrusted: false, supportHtml: false } });
    const model = record.current.model;
    const position = model.validatePosition({ lineNumber: diagnostic?.line ?? 1, column: diagnostic?.column ?? 1 });
    runtime.editor.setModelMarkers(model, 'escope-dsl', diagnostic ? [{
      severity: runtime.MarkerSeverity.Error, message: t(`query:${diagnostic.code}`),
      startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
      startColumn: position.column, endColumn: position.column + 1,
    }] : []);
    const input = instance.getDomNode()?.querySelector('textarea');
    input?.setAttribute('aria-invalid', String(Boolean(diagnostic)));
    if (diagnostic) input?.setAttribute('aria-describedby', 'dsl-diagnostic');
    else input?.removeAttribute('aria-describedby');
    if (active) instance.layout();
  }, [ready, queryId, preferences, active, readOnly, diagnostic, t]);

  useLayoutEffect(() => {
    if (!ready) return;
    const root = document.documentElement;
    const contrast = matchMedia('(forced-colors: active)');
    const update = () => {
      ready.runtime.editor.defineTheme('escope-query', queryEditorTheme(root, contrast.matches));
      ready.runtime.editor.setTheme('escope-query');
      ready.runtime.editor.remeasureFonts();
      ready.instance.layout();
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-accent', 'data-code-font', 'style'] });
    contrast.addEventListener('change', update);
    document.fonts?.addEventListener('loadingdone', update);
    return () => {
      observer.disconnect();
      contrast.removeEventListener('change', update);
      document.fonts?.removeEventListener('loadingdone', update);
    };
  }, [ready]);

  return <>
    {ready && findFor === queryId && active ? <QueryEditorFind key={queryId} instance={ready.instance}
      onClose={() => { setFindFor(null); focus(); }} /> : null}
    <div className="dsl-editor" ref={shell} tabIndex={-1} aria-busy={!ready && !failed}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onFocus={(event) => { if (event.target === event.currentTarget && current.current && active) focus(); }}
      onKeyDownCapture={(event) => {
        if (!active || event.nativeEvent.isComposing || composing.current || event.keyCode === 229
          || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey) || document.querySelector('[role="dialog"]')) return;
        if (event.key.toLowerCase() === 'f' && ready) {
          event.preventDefault(); event.stopPropagation();
          if (!event.repeat) setFindFor(queryId);
        }
      }}>
      <div ref={surface} className="query-monaco-surface" />
      {!ready ? <div className="query-editor-loading">
        {failed ? <><div className="notice error" role="alert"><TriangleAlert size={16} aria-hidden="true" />
          <span>{t('query:editorLoadFailed')}</span><IconButton icon={RotateCw} label={t('retry')} onClick={() => setAttempt((value) => value + 1)} /></div>
          <pre>{value}</pre></> : <span role="status"><LoaderCircle className="spin" size={16} aria-hidden="true" />{t('query:editorLoading')}</span>}
      </div> : null}
    </div>
    {workerFailed ? <div className="notice error" role="alert"><TriangleAlert size={16} aria-hidden="true" />
      <span>{t('query:editorWorkerFailed')}</span></div> : null}
  </>;
}
