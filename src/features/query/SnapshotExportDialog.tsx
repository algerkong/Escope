import { Braces, FileDown, Info, LoaderCircle, Minimize2, Square } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, Modal } from '../../components/controls';
import {
  DEFAULT_SNAPSHOT_EXPORT_BYTES, DEFAULT_SNAPSHOT_EXPORT_PAGE_SIZE, DEFAULT_SNAPSHOT_EXPORT_ROWS,
  MAX_SNAPSHOT_EXPORT_BYTES, MAX_SNAPSHOT_EXPORT_PAGE_SIZE, MAX_SNAPSHOT_EXPORT_ROWS,
  prepareSnapshotExportDsl, validSnapshotExportFileName,
  type SnapshotExportOutcome, type SnapshotExportProgress, type SnapshotExportRequest, type SnapshotExportSource,
} from '../../domain/query-export';
import { formatQueryDsl } from '../../domain/query-dsl';
import { defaultExportFileName, type ExportFormat } from '../../domain/query-library';
import { errorCode } from '../../services/ipc';
import type { SnapshotExportService } from '../../services/query-export';
import { executionErrorKey } from './error-message';
import '../../styles/query-export.css';

interface Props {
  open?: boolean;
  source: SnapshotExportSource;
  service: SnapshotExportService;
  targetAvailable: boolean;
  onClose: () => void;
  onHide?: () => void;
  onTaskState?: (state: SnapshotExportTaskState) => void;
}

export type SnapshotExportTaskState = 'idle' | 'running' | 'saved' | 'incomplete' | 'error';

type JobState =
  | { status: 'idle' }
  | { status: 'running'; progress: SnapshotExportProgress }
  | { status: 'finished'; outcome: SnapshotExportOutcome }
  | { status: 'error'; code: string };

const MIB = 1024 * 1024;

/** One opening owns one frozen source. Neither tab changes nor draft edits can replace it. */
export function SnapshotExportDialog({ open = true, source, service, targetAvailable, onClose, onHide, onTaskState }: Props) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [frozen] = useState(() => ({ source: { ...source }, service }));
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [fileName, setFileName] = useState(() => defaultExportFileName(source.index, 'csv', new Date()));
  const [pageSize, setPageSize] = useState(String(DEFAULT_SNAPSHOT_EXPORT_PAGE_SIZE));
  const [maxRows, setMaxRows] = useState(String(DEFAULT_SNAPSHOT_EXPORT_ROWS));
  const [maxMiB, setMaxMiB] = useState(String(DEFAULT_SNAPSHOT_EXPORT_BYTES / MIB));
  const [job, setJob] = useState<JobState>({ status: 'idle' });
  const [cancelling, setCancelling] = useState(false);
  const [cancelFailed, setCancelFailed] = useState(false);
  const pending = useRef<{ request: SnapshotExportRequest; token: number } | null>(null);
  const token = useRef(0);
  const cancelPending = useRef(false);
  const invalidated = useRef(false);
  const alive = useRef(true);
  const busy = job.status === 'running';
  const prepared = useMemo(() => prepareSnapshotExportDsl(frozen.source.rawDsl, Number(pageSize)), [frozen, pageSize]);
  const formatted = useMemo(() => prepared.ok ? formatQueryDsl(prepared.rawDsl) : null, [prepared]);
  const integer = (value: string, maximum: number) => /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) <= maximum;
  const optionsValid = integer(pageSize, MAX_SNAPSHOT_EXPORT_PAGE_SIZE) && integer(maxRows, MAX_SNAPSHOT_EXPORT_ROWS)
    && integer(maxMiB, MAX_SNAPSHOT_EXPORT_BYTES / MIB) && validSnapshotExportFileName(fileName.trim(), format);
  const message = (code: string) => t(i18n.exists(`queryExport:${code}`)
    ? `queryExport:${code}` : executionErrorKey(code, (key) => i18n.exists(key)));

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      token.current += 1;
      const current = pending.current;
      pending.current = null;
      if (current) void frozen.service.cancel(current.request).catch(() => {});
    };
  }, [frozen]);

  useEffect(() => {
    onTaskState?.(job.status === 'finished' ? job.outcome.status === 'saved' ? 'saved' : 'incomplete' : job.status);
  }, [job, onTaskState]);

  const cancel = useCallback(async () => {
    const current = pending.current;
    if (!current || cancelPending.current) return;
    cancelPending.current = true;
    setCancelling(true);
    setCancelFailed(false);
    try {
      // An acknowledgement only confirms delivery, not a completed or cancelled file.
      await frozen.service.cancel(current.request);
    } catch {
      if (alive.current && pending.current === current) {
        setCancelFailed(true);
        setCancelling(false);
        cancelPending.current = false;
      }
    }
  }, [frozen]);

  useEffect(() => {
    if (!targetAvailable && !invalidated.current) {
      invalidated.current = true;
      void cancel();
    }
  }, [targetAvailable, cancel]);

  const submit = async () => {
    if (pending.current || !targetAvailable || invalidated.current || !frozen.service.available || !optionsValid || !prepared.ok) return;
    const request: SnapshotExportRequest = {
      requestId: crypto.randomUUID(), connectionId: frozen.source.connectionId, expectedEndpoint: frozen.source.endpoint,
      index: frozen.source.index, rawDsl: prepared.rawDsl, format, fileName: fileName.trim(),
      maxRows: Number(maxRows), maxBytes: Number(maxMiB) * MIB,
    };
    const current = { request, token: ++token.current };
    pending.current = current;
    cancelPending.current = false;
    setCancelling(false);
    setCancelFailed(false);
    setJob({ status: 'running', progress: {
      requestId: request.requestId, connectionId: request.connectionId, phase: 'choosing', rows: 0, bytes: 0,
    } });
    try {
      const outcome = await frozen.service.run(request, (progress) => {
        if (alive.current && pending.current === current && token.current === current.token && progress.requestId === request.requestId
          && progress.connectionId === request.connectionId) setJob({ status: 'running', progress });
      });
      if (!alive.current || token.current !== current.token) return;
      if (outcome.requestId !== request.requestId || outcome.connectionId !== request.connectionId) {
        setJob({ status: 'error', code: 'invalidResponse' });
      } else setJob({ status: 'finished', outcome });
    } catch (error: unknown) {
      if (alive.current && token.current === current.token) setJob({ status: 'error', code: errorCode(error, 'exportFailed') });
    } finally {
      if (alive.current && token.current === current.token) {
        pending.current = null;
        setCancelling(false);
        cancelPending.current = false;
      }
    }
  };

  const close = () => { if (!pending.current) onClose(); else onHide?.(); };
  const resetStatus = () => { if (!pending.current) setJob({ status: 'idle' }); };
  const counts = job.status === 'running' ? job.progress : job.status === 'finished' ? job.outcome : null;
  const number = new Intl.NumberFormat(i18n.language);
  const outcome = job.status === 'finished' ? job.outcome : null;

  return <Modal open={open} onClose={close} title={t('queryExport:title')}>
    <div className="qexport-form">
      <dl className="qexport-target">
        <dt>{t('queryExport:connection')}</dt><dd title={frozen.source.connectionId}>{frozen.source.connectionName}<code>{frozen.source.endpoint}</code></dd>
        <dt>{t('queryExport:index')}</dt><dd><code>{frozen.source.index}</code></dd>
        <dt>{t('queryExport:snapshot')}</dt><dd>{t('queryExport:newPit')}
          <span className="qexport-info" role="img" tabIndex={0} aria-label={t('queryExport:snapshotHint')} title={t('queryExport:snapshotHint')}>
            <Info size={14} aria-hidden="true" /></span></dd>
      </dl>
      <div className="qexport-format">
        <span>{t('queryExport:format')}</span>
        <div className="segment" role="group" aria-label={t('queryExport:format')}>
          {(['csv', 'jsonl'] as const).map((value) => <button key={value} type="button" disabled={busy}
            aria-pressed={format === value} onClick={() => {
              setFormat(value); setFileName(defaultExportFileName(frozen.source.index, value, new Date())); resetStatus();
            }}>{value.toUpperCase()}</button>)}
        </div>
        <span className="qexport-info" role="img" tabIndex={0} title={t(`queryExport:${format}Schema`)}
          aria-label={t(`queryExport:${format}Schema`)}><Info size={14} aria-hidden="true" /></span>
      </div>
      <div className="qexport-limits">
        <label htmlFor={`${id}-page`}>{t('queryExport:pageSize')}
          <input id={`${id}-page`} type="number" min={1} max={MAX_SNAPSHOT_EXPORT_PAGE_SIZE} step={1}
            value={pageSize} disabled={busy} onChange={(event) => { setPageSize(event.target.value); resetStatus(); }} /></label>
        <label htmlFor={`${id}-rows`}>{t('queryExport:maxRows')}
          <input id={`${id}-rows`} type="number" min={1} max={MAX_SNAPSHOT_EXPORT_ROWS} step={1}
            value={maxRows} disabled={busy} onChange={(event) => { setMaxRows(event.target.value); resetStatus(); }} /></label>
        <label htmlFor={`${id}-bytes`}>{t('queryExport:maxMiB')}
          <input id={`${id}-bytes`} type="number" min={1} max={MAX_SNAPSHOT_EXPORT_BYTES / MIB} step={1}
            value={maxMiB} disabled={busy} onChange={(event) => { setMaxMiB(event.target.value); resetStatus(); }} /></label>
      </div>
      <span className="qexport-limit-note">{t('queryExport:limits')}</span>
      <label className="qexport-name" htmlFor={`${id}-name`}>{t('queryExport:fileName')}
        <input id={`${id}-name`} value={fileName} disabled={busy} maxLength={128} spellCheck={false}
          onChange={(event) => { setFileName(event.target.value); resetStatus(); }} /></label>
      {prepared.ok ? <details className="qexport-dsl">
        <summary><Braces size={14} aria-hidden="true" />{t('queryExport:finalDsl')}</summary>
        <pre>{formatted?.ok ? formatted.formatted : prepared.rawDsl}</pre>
      </details> : <div className="notice warning" role="alert">{message(prepared.code)}</div>}
      {!optionsValid && prepared.ok ? <div className="notice warning" role="alert">{t('queryExport:invalidOptions')}</div> : null}
      {!targetAvailable || invalidated.current ? <div className="notice warning" role="alert">{t('queryExport:targetUnavailable')}</div> : null}
      {counts ? <div className="qexport-progress" role="status">
        {job.status === 'running' ? <><span><LoaderCircle className="spin" size={14} aria-hidden="true" />
          {t(cancelling ? 'queryExport:cancelling' : `queryExport:${job.progress.phase}`)}</span>
          <progress aria-label={t('queryExport:title')} /></> : null}
        <span>{t('queryExport:counts', { rows: number.format(counts.rows), bytes: number.format(counts.bytes) })}</span>
      </div> : null}
      {cancelFailed ? <div className="notice warning" role="alert">{t('queryExport:cancelFailed')}</div> : null}
      {outcome ? <div className={`qexport-outcome notice ${outcome.status === 'saved' ? 'neutral' : 'warning'}`} role="status">
        <strong>{t(`queryExport:${outcome.status}`)}</strong>
        {outcome.reason && outcome.reason !== 'cancelled' ? <span>{message(outcome.reason)}</span> : null}
        {outcome.fileState === 'none' ? <span>{t('queryExport:fileNone')}</span> : <span>
          {t(`queryExport:${outcome.fileState === 'complete' ? 'fileComplete' : outcome.fileState === 'partial' ? 'filePartial' : 'fileUnknown'}`)}
          <code>{outcome.fileName}</code></span>}
        {outcome.pitCleanup === 'pending' ? <span>{t('queryExport:pitPending')}</span> : null}
      </div> : null}
      {job.status === 'error' ? <div className="qexport-outcome notice error" role="alert">
        <strong>{t('queryExport:failed')}</strong><span>{message(job.code)}</span><span>{t('queryExport:outcomeUnknown')}</span>
      </div> : null}
      <div className="dialog-actions">
        {busy && onHide ? <IconButton icon={Minimize2} label={t('queryExport:hide')} onClick={onHide} /> : null}
        {busy ? <button type="button" className="secondary" disabled={cancelling} onClick={() => { void cancel(); }}>
          <Square size={13} aria-hidden="true" />{t(cancelling ? 'queryExport:cancelling' : 'queryExport:cancel')}</button>
          : <button type="button" className="secondary" onClick={close}>{t('close')}</button>}
        <button type="button" className="primary" disabled={busy || !optionsValid || !prepared.ok || !targetAvailable || invalidated.current || !frozen.service.available}
          onClick={() => { void submit(); }}><FileDown size={14} aria-hidden="true" />{t('queryExport:start')}</button>
      </div>
    </div>
  </Modal>;
}
