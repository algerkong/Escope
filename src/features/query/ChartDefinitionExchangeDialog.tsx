import { Download, Eye, FileUp, LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, SelectControl } from '../../components/controls';
import type { ConnectionProfile } from '../../domain/connection';
import {
  buildChartDefinitionExchange, validateChartConnectionMappings,
  type ChartConnectionMapping, type ChartDefinitionExchange,
} from '../../domain/chart-definition-exchange';
import type { ChartDefinitionRecord } from '../../domain/chart-definitions';
import { errorCode } from '../../services/ipc';
import type { ChartDefinitionExchangeService } from '../../services/chart-definition-exchange';
import type { ChartDefinitionsController } from './useChartDefinitions';
import '../../styles/query-exchange.css';

interface Props {
  mode: 'export' | 'import';
  library: ChartDefinitionsController;
  kind: 'desktop' | 'session';
  profiles: readonly ConnectionProfile[];
  service: ChartDefinitionExchangeService;
  record: ChartDefinitionRecord | null;
  onClose: () => void;
}

/** Every exchange code resolves to a translated key, so no raw code can reach the screen. */
const ERROR_KEYS: Record<string, string> = {
  exchangeInvalid: 'chartDefinitions:exchangeInvalid', exchangeVersion: 'chartDefinitions:exchangeVersion',
  exchangeTooLarge: 'chartDefinitions:exchangeTooLarge', exchangeSensitive: 'chartDefinitions:exchangeSensitive',
  exchangeMappingRequired: 'chartDefinitions:exchangeMappingRequired', exchangeTargetChanged: 'chartDefinitions:exchangeTargetChanged',
  chartDefinitionConflict: 'chartDefinitions:exchangeConflict', importFailed: 'chartDefinitions:exchangeImportFailed',
  exportFailed: 'chartDefinitions:exchangeExportFailed', invalidResponse: 'chartDefinitions:exchangeUnverified',
  invalidInput: 'chartDefinitions:exchangeInvalid', storageUnavailable: 'chartDefinitions:exchangeStorageUnavailable',
  unsupported: 'chartDefinitions:exchangeUnsupported', busy: 'errors:busy',
};

const OUTCOME_KEYS = { saved: 'exchangeSaved', cancelled: 'exchangeCancelled', downloadRequested: 'exchangeDownloadRequested' };

/**
 * Export selected chart definitions to a reviewable document, or import such a document as new
 * definitions. Nothing here runs a query: an imported definition only appears in the library and
 * still needs a matching tab, an explicit reuse, a full DSL preview and an explicit apply.
 */
export function ChartDefinitionExchangeDialog({ mode, library, kind, profiles, service, record, onClose }: Props) {
  const { t } = useTranslation();
  // The reviewed library is frozen on open: a later write elsewhere must not change what is imported.
  const [base] = useState<ChartDefinitionRecord | null>(() => record && {
    revision: record.revision, library: structuredClone(record.library),
  });
  const [sourceProfiles] = useState(() => profiles.map(({ id, displayName }) => ({ id, displayName })));
  const [selected, setSelected] = useState<string[]>([]);
  const [bundle, setBundle] = useState<ChartDefinitionExchange | null>(null);
  const preview = useMemo(() => bundle === null ? '' : JSON.stringify(bundle, null, 2), [bundle]);
  const [mappings, setMappings] = useState<ChartConnectionMapping[]>([]);
  const [reviewed, setReviewed] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const importing = mode === 'import';
  const finished = outcome === 'imported' || outcome === 'sessionImported';
  const entries = base?.library.entries ?? [];
  let mappingError: string | null = null;
  if (importing && bundle) {
    try { validateChartConnectionMappings(bundle, mappings, profiles); } catch (failure) { mappingError = errorCode(failure); }
  }
  const targetChanged = mappingError === 'exchangeTargetChanged';
  const setSelection = (ids: string[]) => {
    setSelected(ids); setBundle(null); setReviewed(false); setOutcome(null); setError(null);
  };
  const reportError = (failure: unknown) => setError(ERROR_KEYS[errorCode(failure)] ?? 'chartDefinitions:exchangeFailed');
  const perform = async (action: () => Promise<void>) => {
    if (pending.current || finished || !base) return;
    pending.current = true; setBusy(true); setError(null); setOutcome(null);
    try { await action(); } catch (failure) { if (alive.current) reportError(failure); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const readFile = (file?: File) => perform(async () => {
    setBundle(null); setMappings([]); setReviewed(false);
    const result = await service.readFile(file);
    if (!alive.current) return;
    if (result.status === 'cancelled') setOutcome('exchangeCancelled');
    else setBundle(result.bundle);
  });
  const close = () => { if (!pending.current) onClose(); };
  const title = t(`chartDefinitions:${importing ? 'importDefinitions' : 'exportDefinitions'}`);

  if (!base) {
    return <Modal open onClose={onClose} title={title}>
      <div className="qexchange-form">
        <div className="notice neutral" role="status">{t('chartDefinitions:exchangeUnavailable')}</div>
        <div className="dialog-actions"><button type="button" className="secondary" onClick={onClose}>{t('close')}</button></div>
      </div>
    </Modal>;
  }

  return <Modal open onClose={close} title={title}>
    <div className="qexchange-form">
      {kind === 'session' ? <span className="muted">{t('chartDefinitions:session')}</span> : null}
      <p className="muted small qexchange-scope" title={t('chartDefinitions:exchangeScopeBoundary')}>
        {t('chartDefinitions:exchangeScope')}
      </p>
      {!importing ? <>
        <label className="qexchange-check"><input type="checkbox" aria-label={t('chartDefinitions:exchangeSelectAll')}
          disabled={busy || entries.length === 0} checked={entries.length > 0 && selected.length === entries.length}
          onChange={(event) => setSelection(event.target.checked ? entries.map(({ id }) => id) : [])} />
          {t('chartDefinitions:exchangeSelectAll')}</label>
        {entries.length === 0 ? <p className="muted">{t('chartDefinitions:exchangeEmpty')}</p> : null}
        <ul className="qexchange-selection" aria-label={t('chartDefinitions:exchangeSelection')}>
          {entries.map((entry) => <li key={entry.id}>
            <label><input type="checkbox" checked={selected.includes(entry.id)} disabled={busy}
              onChange={(event) => setSelection(event.target.checked ? [...selected, entry.id] : selected.filter((id) => id !== entry.id))} />
              <span><strong>{entry.name}</strong><small>
                {entry.index} · {sourceProfiles.find(({ id }) => id === entry.connectionId)?.displayName
                  ?? t('removedConnection')} · {entry.measure}</small></span></label>
          </li>)}
        </ul>
        <button type="button" className="secondary compact-button" disabled={busy || selected.length === 0} onClick={() => {
          try {
            // Only ID/displayName reach the builder. Endpoints and authentication never enter the document.
            setBundle(buildChartDefinitionExchange(base.library, selected, sourceProfiles));
            setError(null); setReviewed(false); setOutcome(null);
          } catch (failure) { setBundle(null); reportError(failure); }
        }}><Eye size={14} aria-hidden="true" />{t('chartDefinitions:exchangePreview')}</button>
      </> : <div className="qexchange-file">
        {kind === 'session' ? <input ref={fileInput} type="file" hidden accept=".json,application/json"
          aria-label={t('chartDefinitions:exchangeChooseFile')} disabled={busy || finished} onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void readFile(file);
          }} /> : null}
        <button type="button" className="secondary compact-button" disabled={busy || finished} onClick={() => {
          if (kind === 'session') fileInput.current?.click();
          else void readFile();
        }}><FileUp size={14} aria-hidden="true" />{t('chartDefinitions:exchangeChooseFile')}</button>
      </div>}
      {bundle ? <>
        <span className="muted small">{t('chartDefinitions:exchangeDocument', { count: bundle.definitions.length })}</span>
        {importing && bundle.connections.length > 0 ? <fieldset className="qexchange-mappings">
          <legend>{t('chartDefinitions:exchangeMapping')}</legend>
          {bundle.connections.map((connection) => {
            const target = mappings.find((item) => item.sourceKey === connection.key)?.target;
            return <label key={connection.key}><span>{connection.label} <small>({connection.key})</small></span>
              <SelectControl aria-label={t('chartDefinitions:exchangeMapTarget', { label: connection.label, key: connection.key })}
                disabled={busy || finished}
                value={target?.connectionId ?? ''} onChange={(event) => {
                  const profile = profiles.find((item) => item.id === event.target.value);
                  setMappings((current) => [
                    ...current.filter((item) => item.sourceKey !== connection.key),
                    ...(profile ? [{ sourceKey: connection.key, target: { connectionId: profile.id, endpoint: profile.endpoint } }] : []),
                  ]);
                  setReviewed(false); setError(null);
                }}>
                <option value="">{t('chartDefinitions:exchangeChooseConnection')}</option>
                {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName} ({profile.endpoint})</option>)}
              </SelectControl>
              {target ? <small className="qexchange-target">{target.endpoint}</small> : null}
            </label>;
          })}
        </fieldset> : null}
        <label className="qexchange-label" htmlFor="chart-exchange-preview">{t('chartDefinitions:exchangeReviewDocument')}</label>
        <textarea className="qexchange-preview" id="chart-exchange-preview" readOnly spellCheck={false} value={preview} />
        <label className="qexchange-check"><input type="checkbox" checked={reviewed} disabled={busy || finished}
          onChange={(event) => setReviewed(event.target.checked)} />
          {t(importing ? 'chartDefinitions:exchangeMapped' : 'chartDefinitions:exchangeReviewed')}</label>
      </> : null}
      {targetChanged ? <div className="notice error" role="alert">{t('chartDefinitions:exchangeTargetChanged')}</div> : null}
      {error ? <div className="notice error" role="alert">{t(error)}</div> : null}
      {library.error && !error ? <div className="notice error" role="alert">
        {t(ERROR_KEYS[library.error] ?? 'chartDefinitions:exchangeFailed')}</div> : null}
      {outcome ? <div className="notice neutral" role="status">{t(`chartDefinitions:${outcome}`)}</div> : null}
      {busy ? <span className="qexchange-busy" role="status">
        <LoaderCircle size={14} className="spin" aria-hidden="true" />{t('chartDefinitions:exchangeBusy')}</span> : null}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={close}>{t('close')}</button>
        <button type="button" className="primary" disabled={busy || !bundle || !reviewed || finished || (importing && mappingError !== null)}
          onClick={() => {
            if (!bundle || !reviewed) return;
            const reviewedBundle = bundle;
            const reviewedMappings = mappings;
            void perform(async () => {
              if (importing) {
                validateChartConnectionMappings(reviewedBundle, reviewedMappings, profiles);
                const result = await library.importRecord(base, () => service.importDefinitions(reviewedBundle, reviewedMappings, base));
                if (!alive.current) return;
                if (result.applied) setOutcome(kind === 'session' ? 'sessionImported' : 'imported');
                else if (result.error) reportError({ code: result.error });
              } else {
                const result = await service.saveFile(reviewedBundle, true);
                if (alive.current) setOutcome(OUTCOME_KEYS[result.status]);
              }
            });
          }}>
          {importing ? <FileUp size={14} aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
          {t(importing ? 'chartDefinitions:exchangeImportAction' : 'chartDefinitions:exchangeSaveAction', { count: bundle?.definitions.length ?? 0 })}
        </button>
      </div>
    </div>
  </Modal>;
}
