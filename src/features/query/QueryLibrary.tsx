import { Bookmark, Download, FileDown, FileUp, LoaderCircle, RefreshCw, Star, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { IconButton, Modal } from '../../components/controls';
import type { ConnectionProfile } from '../../domain/connection';
import type { QueryDocument } from '../../domain/query';
import {
  buildCsvExport, buildJsonlExport, createEmptyLibrary, defaultExportFileName, entryFromDocument,
  entryLimitViolation, removeEntry, serializeLibrary, setEntryFavorite, upsertEntry,
  MAX_ENTRY_NAME_CHARS, MAX_SAVED_ENTRIES,
  type EntryLimitCode, type ExportFormat, type SavedQueryEntry, type SavedQueryLibrary,
} from '../../domain/query-library';
import type { ResultHit } from '../../domain/query-result';
import { errorCode } from '../../services/ipc';
import type { QueryLibraryService } from '../../services/query-library';
import '../../styles/query-library.css';

/**
 * Local query drafts/favorites and loaded-result export UI.
 *
 * Library mutations are optimistic but persist through a single promise chain, so two quick
 * actions can never interleave: the chain always writes the latest intended document, and a
 * completed older save never overwrites a newer intent. A load result is applied only when its
 * generation is still current. Saving a draft reads the document by value and never mutates the
 * editor or its revision.
 */

export type LibraryLoadStatus = 'loading' | 'ready' | 'error';
const IMPORT_REJECTIONS = new Set([
  'exchangeInvalid', 'exchangeVersion', 'exchangeTooLarge', 'exchangeSensitive',
  'exchangeMappingRequired', 'exchangeTargetChanged', 'invalidInput', 'unsupported',
]);

export interface SaveStatus {
  readonly status: 'idle' | 'saving' | 'saved' | 'error';
  readonly code?: string;
}

export type SaveDraftResult =
  | { readonly ok: true; readonly entryId: string }
  | { readonly ok: false; readonly code: EntryLimitCode | 'libraryUnavailable' };

export interface QueryLibraryController {
  readonly status: LibraryLoadStatus;
  readonly loadError: string | null;
  readonly entries: readonly SavedQueryEntry[];
  readonly saveStatus: SaveStatus;
  readonly reload: () => void;
  readonly saveDraft: (document: QueryDocument, options: { name: string; favorite: boolean; entryId?: string }) => SaveDraftResult;
  readonly deleteEntry: (id: string) => void;
  readonly setFavorite: (id: string, favorite: boolean) => void;
  readonly retrySave: () => void;
  readonly importing: boolean;
  readonly importLibrary: (expected: SavedQueryLibrary, importer: () => Promise<SavedQueryLibrary>) => Promise<void>;
}

export function useQueryLibrary(service: QueryLibraryService): QueryLibraryController {
  const [status, setStatus] = useState<LibraryLoadStatus>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [entries, setEntries] = useState<readonly SavedQueryEntry[]>([]);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ status: 'idle' });
  const libraryRef = useRef<SavedQueryLibrary>(createEmptyLibrary());
  const persistedRef = useRef<string | null>(null);
  const persistedLibraryRef = useRef<SavedQueryLibrary | null>(null);
  const importingRef = useRef(false);
  const [importing, setImporting] = useState(false);
  const generationRef = useRef(0);
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const statusRef = useRef<LibraryLoadStatus>('loading');
  const serviceRef = useRef(service);
  useEffect(() => { serviceRef.current = service; }, [service]);

  const applyStatus = useCallback((next: LibraryLoadStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const reload = useCallback(() => {
    const generation = ++generationRef.current;
    applyStatus('loading');
    setLoadError(null);
    setSaveStatus({ status: 'idle' });
    // A reload (including a service switch) makes the stored document authoritative again: the
    // previous optimistic state is dropped and any queued write for the old generation is skipped.
    libraryRef.current = createEmptyLibrary();
    persistedRef.current = null;
    persistedLibraryRef.current = null;
    setEntries([]);
    service.load().then(
      (library) => {
        if (generation !== generationRef.current) return;
        libraryRef.current = library;
        persistedRef.current = serializeLibrary(library);
        persistedLibraryRef.current = library;
        setEntries(library.entries);
        applyStatus('ready');
      },
      (error: unknown) => {
        if (generation !== generationRef.current) return;
        // A failed load keeps an empty, non-persisted state: nothing is written back until a
        // later load succeeds, so damaged bytes are never overwritten by an empty library.
        libraryRef.current = createEmptyLibrary();
        persistedRef.current = null;
        setEntries([]);
        setLoadError(errorCode(error));
        applyStatus('error');
      },
    );
  }, [applyStatus, service]);

  const invalidateGeneration = useCallback(() => { generationRef.current++; }, []);
  useEffect(() => { reload(); return invalidateGeneration; }, [reload, invalidateGeneration]);

  const enqueueSave = useCallback(() => {
    // Bind each queued write to the service and load generation that produced it: a service
    // switch or a reload supersedes the intent, and a stale completion must not touch newer state
    // or write the newer document to the old backend.
    const boundService = service;
    const boundGeneration = generationRef.current;
    chainRef.current = chainRef.current.then(async () => {
      if (boundService !== serviceRef.current || boundGeneration !== generationRef.current) return;
      if (statusRef.current !== 'ready') return;
      const payload = libraryRef.current;
      const json = serializeLibrary(payload);
      if (json === persistedRef.current) return;
      setSaveStatus({ status: 'saving' });
      try {
        const expected = persistedLibraryRef.current;
        if (expected === null) return;
        await boundService.save(payload, expected);
        if (boundService !== serviceRef.current || boundGeneration !== generationRef.current) return;
        persistedRef.current = json;
        persistedLibraryRef.current = payload;
        // Only the save that still matches the latest intent may report success; a newer
        // queued save keeps the indicator on "saving" until it settles.
        if (serializeLibrary(libraryRef.current) === json) setSaveStatus({ status: 'saved' });
      } catch (error: unknown) {
        if (boundService !== serviceRef.current || boundGeneration !== generationRef.current) return;
        if (serializeLibrary(libraryRef.current) === json) {
          setSaveStatus({ status: 'error', code: errorCode(error) });
        }
      }
    });
    return chainRef.current;
  }, [service]);

  const commit = useCallback((mutate: (library: SavedQueryLibrary) => SavedQueryLibrary) => {
    const next = mutate(libraryRef.current);
    libraryRef.current = next;
    setEntries(next.entries);
    void enqueueSave();
  }, [enqueueSave]);

  const saveDraft = useCallback((document: QueryDocument, options: {
    name: string; favorite: boolean; entryId?: string;
  }): SaveDraftResult => {
    if (statusRef.current !== 'ready' || importingRef.current) return { ok: false, code: 'libraryUnavailable' };
    const entry = entryFromDocument(document, {
      id: options.entryId ?? crypto.randomUUID(),
      name: options.name,
      favorite: options.favorite,
      now: new Date(),
    });
    const violation = entryLimitViolation(libraryRef.current, entry);
    if (violation !== null) return { ok: false, code: violation };
    commit((library) => upsertEntry(library, entry));
    return { ok: true, entryId: entry.id };
  }, [commit]);

  const deleteEntry = useCallback((id: string) => {
    if (statusRef.current !== 'ready' || importingRef.current) return;
    commit((library) => removeEntry(library, id));
  }, [commit]);

  const setFavorite = useCallback((id: string, favorite: boolean) => {
    if (statusRef.current !== 'ready' || importingRef.current) return;
    commit((library) => setEntryFavorite(library, id, favorite));
  }, [commit]);

  const retrySave = useCallback(() => { void enqueueSave(); }, [enqueueSave]);

  const importLibrary = useCallback(async (expected: SavedQueryLibrary, importer: () => Promise<SavedQueryLibrary>) => {
    if (importingRef.current || statusRef.current !== 'ready') throw { code: 'busy' };
    importingRef.current = true;
    setImporting(true);
    const generation = generationRef.current;
    const boundService = service;
    const expectedJson = serializeLibrary(expected);
    try {
      await chainRef.current;
      if (generation !== generationRef.current || boundService !== serviceRef.current
        || expectedJson !== serializeLibrary(libraryRef.current) || expectedJson !== persistedRef.current) throw { code: 'libraryConflict' };
      const next = await importer();
      if (generation !== generationRef.current || boundService !== serviceRef.current) throw { code: 'libraryConflict' };
      libraryRef.current = next;
      persistedLibraryRef.current = next;
      persistedRef.current = serializeLibrary(next);
      setEntries(next.entries);
      setSaveStatus({ status: 'saved' });
    } catch (error) {
      if (generation === generationRef.current && boundService === serviceRef.current) {
        const code = errorCode(error);
        if (!IMPORT_REJECTIONS.has(code)) {
          setSaveStatus({ status: 'error', code: code === 'libraryConflict' ? 'libraryConflict' : 'importUnconfirmed' });
        }
      }
      throw error;
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  }, [service]);

  return useMemo(() => ({
    status, loadError, entries, saveStatus, reload, saveDraft, deleteEntry, setFavorite, retrySave, importing, importLibrary,
  }), [status, loadError, entries, saveStatus, reload, saveDraft, deleteEntry, setFavorite, retrySave, importing, importLibrary]);
}

const LIMIT_MESSAGE_KEYS: Record<string, string> = {
  tooManyEntries: 'limitTooManyEntries',
  nameTooLong: 'limitNameTooLong',
  dslTooLarge: 'limitDslTooLarge',
  indexTooLarge: 'limitIndexTooLarge',
  invalidEntryId: 'limitInvalidEntryId',
  invalidTimestamp: 'limitInvalidTimestamp',
  connectionIdTooLong: 'limitConnectionIdTooLong',
  libraryUnavailable: 'libraryUnavailable',
  invalidParameters: 'limitInvalidParameters',
  invalidDataView: 'limitInvalidDataView',
  invalidTimeRange: 'limitInvalidTimeRange',
};

function limitMessage(t: TFunction, code: string): string {
  return t(`queryLibrary:${LIMIT_MESSAGE_KEYS[code] ?? 'limitUnknown'}`, { count: MAX_SAVED_ENTRIES });
}

function loadMessage(t: TFunction, code: string | null): string {
  return code === 'invalidResponse' ? t('queryLibrary:loadFailedInvalidLibrary') : t('queryLibrary:loadFailedGeneric');
}

export interface SaveDraftDialogProps {
  open: boolean;
  /** The entry this document was last saved as, if any: saving updates it instead of duplicating. */
  entry: SavedQueryEntry | null;
  initialName: string;
  status: LibraryLoadStatus;
  loadError: string | null;
  saveStatus: SaveStatus;
  onClose: () => void;
  onSave: (values: { name: string; favorite: boolean }) => SaveDraftResult;
  onRetrySave: () => void;
}

export function SaveDraftDialog({ open, entry, initialName, status, loadError, saveStatus, onClose, onSave, onRetrySave }: SaveDraftDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [favorite, setFavorite] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(entry?.name ?? initialName);
    setFavorite(entry?.favorite ?? false);
    setLocalError(null);
  }, [open, entry, initialName]);

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed === '') {
      setLocalError(t('queryLibrary:nameRequired'));
      return;
    }
    const result = onSave({ name: trimmed, favorite });
    if (!result.ok) {
      setLocalError(limitMessage(t, result.code));
      return;
    }
    onClose();
  };

  return <Modal open={open} onClose={onClose}
    title={t(entry ? 'queryLibrary:saveTitleUpdate' : 'queryLibrary:saveTitle')}>
    <div className="qlib-form">
      <label htmlFor="qlib-draft-name">{t('queryLibrary:name')}</label>
      <input id="qlib-draft-name" value={name} maxLength={MAX_ENTRY_NAME_CHARS}
        placeholder={t('queryLibrary:namePlaceholder')} spellCheck={false}
        onChange={(event) => { setName(event.target.value); setLocalError(null); }} />
      <label className="qlib-check">
        <input type="checkbox" checked={favorite} onChange={(event) => setFavorite(event.target.checked)} />
        {t('queryLibrary:favoriteMark')}
      </label>
      {status === 'loading' ? <div className="notice neutral" role="status">
        {t('queryLibrary:loading')}
      </div> : null}
      {status === 'error' ? <div className="notice error" role="alert">
        <span>{loadMessage(t, loadError)}</span>
      </div> : null}
      {localError ? <div className="notice error" role="alert"><span>{localError}</span></div> : null}
      {saveStatus.status === 'error' ? <div className="notice warning" role="status">
        <span>{t('queryLibrary:saveFailed')}</span>
        <button type="button" className="secondary compact-button" onClick={onRetrySave}>{t('retry')}</button>
      </div> : null}
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={onClose}>{t('cancel')}</button>
        <button type="button" className="primary" disabled={status !== 'ready'} onClick={submit}>{t('save')}</button>
      </div>
    </div>
  </Modal>;
}

export interface QueryLibraryDialogProps {
  open: boolean;
  kind: 'desktop' | 'session';
  status: LibraryLoadStatus;
  loadError: string | null;
  entries: readonly SavedQueryEntry[];
  saveStatus: SaveStatus;
  profiles: readonly ConnectionProfile[];
  onClose: () => void;
  /** Restore capability; without the host callback a draft must not be loaded anywhere. */
  onRestore?: (entry: SavedQueryEntry) => void;
  onDelete: (id: string) => void;
  onToggleFavorite: (entry: SavedQueryEntry) => void;
  onRetrySave: () => void;
  onReload: () => void;
  onExchange?: (mode: 'import' | 'export') => void;
}

export function QueryLibraryDialog({
  open, kind, status, loadError, entries, saveStatus, profiles,
  onClose, onRestore, onDelete, onToggleFavorite, onRetrySave, onReload, onExchange,
}: QueryLibraryDialogProps) {
  const { t, i18n } = useTranslation();
  const listRef = useRef<HTMLUListElement>(null);
  const [confirming, setConfirming] = useState<SavedQueryEntry | null>(null);
  const connections = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile.displayName])), [profiles]);
  const timeFormat = useMemo(() => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }), [i18n.language]);
  const reloadRequired = saveStatus.code === 'libraryConflict' || saveStatus.code === 'importUnconfirmed';

  useEffect(() => { if (!open) setConfirming(null); }, [open]);

  const formatTime = (value: string) => {
    const time = new Date(value);
    return Number.isNaN(time.getTime()) ? value : timeFormat.format(time);
  };

  const confirmDelete = () => {
    if (!confirming) return;
    const id = confirming.id;
    setConfirming(null);
    onDelete(id);
    // The opener (this row's delete button) is gone with the row; keep keyboard focus usable.
    requestAnimationFrame(() => listRef.current?.focus());
  };

  return <Modal open={open} onClose={onClose} title={t('queryLibrary:title')}>
    <div className="qlib-panel">
      <div className="qlib-status">
        {kind === 'session' ? <span className="qlib-chip" title={t('sessionDetail')}>{t('session')}</span> : null}
        {saveStatus.status === 'saving' ? <span className="ql-status" role="status">
          <LoaderCircle className="spin" size={14} aria-hidden="true" />{t('queryLibrary:saving')}</span> : null}
        {saveStatus.status === 'saved' ? <span className="ql-status" role="status">{t('queryLibrary:saved')}</span> : null}
        {saveStatus.status === 'error' ? <>
          <span className="ql-status qlib-error" role="alert">{t(saveStatus.code === 'importUnconfirmed' ? 'queryLibrary:importUnconfirmed'
            : saveStatus.code === 'libraryConflict' ? 'queryLibrary:saveConflict' : 'queryLibrary:saveFailed')}</span>
          <button type="button" className="secondary compact-button" onClick={reloadRequired ? onReload : onRetrySave}>
            {t(reloadRequired ? 'queryLibrary:reloadSaved' : 'retry')}</button>
        </> : null}
        {onExchange ? <div className="qexchange-actions">
          <IconButton icon={FileDown} label={t('queryExchange:export')} disabled={status !== 'ready' || entries.length === 0}
            onClick={() => onExchange('export')} />
          <IconButton icon={FileUp} label={t('queryExchange:import')} disabled={status !== 'ready'} onClick={() => onExchange('import')} />
        </div> : null}
      </div>
      {status === 'loading' ? <div className="qlib-empty" role="status">
        <LoaderCircle className="spin" size={20} aria-hidden="true" />
        <p>{t('queryLibrary:loading')}</p>
      </div> : null}
      {status === 'error' ? <div className="notice error" role="alert">
        <span>{loadMessage(t, loadError)}</span>
        <button type="button" className="secondary compact-button" onClick={onReload}>
          <RefreshCw size={13} aria-hidden="true" />{t('queryLibrary:reloadSaved')}
        </button>
      </div> : null}
      {status === 'ready' && entries.length === 0 ? <div className="qlib-empty">
        <Bookmark size={22} strokeWidth={1.5} aria-hidden="true" />
        <h3>{t('queryLibrary:savedEmpty')}</h3>
        <p>{t('queryLibrary:savedEmptyDetail')}</p>
      </div> : null}
      {status === 'ready' && entries.length > 0 ? <ul className="qlib-list" ref={listRef} tabIndex={-1} aria-label={t('queryLibrary:title')}>
        {entries.map((entry) => {
          const connection = entry.connectionId === null ? t('noConnection')
            : connections.get(entry.connectionId) ?? t('removedConnection');
          return <li key={entry.id} className="qlib-entry">
            <IconButton className={`qlib-star${entry.favorite ? ' active' : ''}`}
              icon={Star} aria-pressed={entry.favorite}
              label={t(entry.favorite ? 'queryLibrary:favoriteRemove' : 'queryLibrary:favoriteAdd')}
              onClick={() => onToggleFavorite(entry)} />
            <div className="qlib-entry-body">
              <strong>{entry.name || t('queryLibrary:untitled')}</strong>
              <span className="qlib-meta">
                {entry.index || t('queryLibrary:noIndex')} · {connection} · {t('queryLibrary:updated', { time: formatTime(entry.updatedAt) })}
              </span>
            </div>
            <button type="button" className="secondary compact-button"
              title={onRestore ? t('queryLibrary:restoreHint') : t('queryLibrary:restoreUnavailable')}
              disabled={onRestore === undefined}
              onClick={() => onRestore?.(entry)}>{t('queryLibrary:restore')}</button>
            <IconButton className="qlib-delete" icon={Trash2} label={t('delete')} onClick={() => setConfirming(entry)} />
          </li>;
        })}
      </ul> : null}
    </div>
    <Modal open={confirming !== null} onClose={() => setConfirming(null)} title={t('queryLibrary:deleteTitle')}
      description={t('queryLibrary:deleteDetail', { name: confirming?.name || t('queryLibrary:untitled') })}>
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={() => setConfirming(null)}>{t('cancel')}</button>
        <button type="button" className="danger" onClick={confirmDelete}>{t('delete')}</button>
      </div>
    </Modal>
  </Modal>;
}

type ExportDialogStatus =
  | { readonly status: 'idle' | 'busy' | 'saved' | 'cancelled' | 'downloadRequested' }
  | { readonly status: 'error'; readonly code: string };

type FrozenExport = Pick<ResultExportDialogProps, 'service' | 'hits' | 'pages' | 'baseName' | 'partial'>;

export interface ResultExportDialogProps {
  open: boolean;
  service: QueryLibraryService;
  hits: readonly ResultHit[];
  pages: readonly { readonly rawResponse: string }[];
  /** Index or query name used for the default file name. */
  baseName: string;
  partial: boolean;
  onClose: () => void;
}

/**
 * Export of the results already loaded. The content is built from the displayed pages only —
 * no request is sent, no next page is fetched — and the outcome is reported as saved, cancelled
 * or (browser) download requested; "requested" is never presented as saved on disk.
 */
export function ResultExportDialog({ open, service, hits, pages, baseName, partial, onClose }: ResultExportDialogProps) {
  const { t } = useTranslation();
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [fileName, setFileName] = useState('');
  const [state, setState] = useState<ExportDialogStatus>({ status: 'idle' });
  // The export is bound to the snapshot that was on screen when the dialog opened: a continuation
  // that lands while the dialog is up cannot silently extend (or shrink) the exported rows, and a
  // query change cannot re-freeze (the effect only reacts to `open`).
  const [frozen, setFrozen] = useState<FrozenExport | null>(null);
  const latest = useRef<FrozenExport>({ service, hits, pages, baseName, partial });
  /** Submission token: every opening and unmount invalidates completions of earlier attempts. */
  const attempt = useRef(0);
  /** Same-tick guard: a second click before the busy state commits must not start another write. */
  const submitting = useRef(false);
  useEffect(() => { latest.current = { service, hits, pages, baseName, partial }; });
  useEffect(() => () => { attempt.current += 1; }, []);

  useEffect(() => {
    attempt.current += 1;
    submitting.current = false;
    if (!open) {
      setFrozen(null);
      return;
    }
    const snapshot = latest.current;
    setFrozen(snapshot);
    setFormat('csv');
    setFileName(defaultExportFileName(snapshot.baseName, 'csv', new Date()));
    setState({ status: 'idle' });
  }, [open]);

  const active = frozen ?? { service, hits, pages, baseName, partial };
  const changeFormat = (next: ExportFormat) => {
    setFormat(next);
    setFileName(defaultExportFileName(active.baseName, next, new Date()));
    setState({ status: 'idle' });
  };

  const rows = active.hits.length;
  const busy = state.status === 'busy';
  /** While a native write is pending the dialog stays open: no user path may close it mid-write. */
  const requestClose = () => {
    if (submitting.current) return;
    onClose();
  };

  const submit = async () => {
    if (submitting.current || rows === 0 || fileName.trim() === '') return;
    const token = attempt.current;
    submitting.current = true;
    setState({ status: 'busy' });
    try {
      let content: string;
      if (format === 'csv') {
        content = buildCsvExport(active.hits).content;
      } else {
        const built = buildJsonlExport(active.pages);
        // Fewer lines than the grid shows is a hard failure, never a smaller "successful" file.
        if (!built.ok || built.rows !== rows) {
          submitting.current = false;
          setState({ status: 'error', code: 'invalidPage' });
          return;
        }
        content = built.content;
      }
      const outcome = await active.service.saveExportFile({ format, fileName: fileName.trim(), content });
      if (token !== attempt.current) return;
      setState({ status: outcome.status });
    } catch (error: unknown) {
      if (token !== attempt.current) return;
      setState({ status: 'error', code: errorCode(error) });
    } finally {
      if (token === attempt.current) submitting.current = false;
    }
  };

  return <Modal open={open} onClose={requestClose} title={t('queryLibrary:exportTitle')}
    description={t('queryLibrary:exportLoadedOnly')}>
    <div className="qlib-form">
      <div className="qlib-export-row">
        <span className="qlib-label">{t('queryLibrary:exportFormat')}</span>
        <div className="segment" role="group" aria-label={t('queryLibrary:exportFormat')}>
          {(['csv', 'jsonl'] as const).map((option) => <button key={option} type="button"
            aria-pressed={format === option} disabled={busy}
            onClick={() => changeFormat(option)}>{option.toUpperCase()}</button>)}
        </div>
        <span className="ql-status">{t('queryLibrary:exportRows', { count: rows })}</span>
      </div>
      <label htmlFor="qlib-export-name">{t('queryLibrary:exportFileName')}</label>
      <input id="qlib-export-name" value={fileName} spellCheck={false} disabled={busy}
        onChange={(event) => { setFileName(event.target.value); setState({ status: 'idle' }); }} />
      <p className="muted small">{t(format === 'csv' ? 'queryLibrary:exportCsvHint' : 'queryLibrary:exportJsonlHint')}</p>
      {active.partial ? <div className="notice warning" role="status"><span>{t('queryLibrary:exportPartial')}</span></div> : null}
      {state.status === 'saved' ? <div className="notice neutral" role="status"><span>{t('queryLibrary:exportSaved')}</span></div> : null}
      {state.status === 'cancelled' ? <div className="notice neutral" role="status"><span>{t('queryLibrary:exportCancelled')}</span></div> : null}
      {state.status === 'downloadRequested' ? <div className="notice warning" role="status">
        <span>{t('queryLibrary:exportDownloadRequested')}</span>
      </div> : null}
      {state.status === 'error' ? <div className="notice error" role="alert">
        <span>{t(state.code === 'invalidPage' ? 'queryLibrary:exportInvalidPages' : 'queryLibrary:exportFailed')}</span>
      </div> : null}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={requestClose}>{t('cancel')}</button>
        <button type="button" className="primary" disabled={busy || rows === 0 || fileName.trim() === ''} onClick={() => { void submit(); }}>
          {busy ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
          {t(busy ? 'queryLibrary:exporting' : 'queryLibrary:exportAction')}
        </button>
      </div>
    </div>
  </Modal>;
}
