import { Download, Eye, FileUp, LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, SelectControl } from '../../components/controls';
import type { ConnectionProfile } from '../../domain/connection';
import { QUERY_LIBRARY_VERSION, type SavedQueryLibrary } from '../../domain/query-library';
import {
  buildQueryExchange, validateConnectionMappings, type ConnectionMapping, type QueryExchange,
} from '../../domain/query-exchange';
import { errorCode } from '../../services/ipc';
import type { QueryExchangeService } from '../../services/query-exchange';
import type { QueryLibraryController } from './QueryLibrary';
import '../../styles/query-exchange.css';

interface Props {
  mode: 'export' | 'import';
  library: QueryLibraryController;
  profiles: readonly ConnectionProfile[];
  service: QueryExchangeService;
  onClose: () => void;
}

const ERROR_CODES = new Set([
  'exchangeInvalid', 'exchangeVersion', 'exchangeTooLarge', 'exchangeSensitive', 'exchangeMappingRequired',
  'exchangeTargetChanged', 'libraryConflict', 'importFailed', 'exportFailed', 'invalidResponse',
  'storageUnavailable', 'unsupported', 'busy',
]);

export function QueryExchangeDialog({ mode, library, profiles, service, onClose }: Props) {
  const { t } = useTranslation();
  const [base] = useState<SavedQueryLibrary>(() => ({ version: QUERY_LIBRARY_VERSION, entries: structuredClone(library.entries) }));
  const [sourceProfiles] = useState(() => profiles.map(({ id, displayName }) => ({ id, displayName })));
  const [selected, setSelected] = useState<string[]>([]);
  const [bundle, setBundle] = useState<QueryExchange | null>(null);
  const preview = useMemo(() => bundle === null ? '' : JSON.stringify(bundle, null, 2), [bundle]);
  const [mappings, setMappings] = useState<ConnectionMapping[]>([]);
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
  let mappingError: string | null = null;
  if (importing && bundle) {
    try { validateConnectionMappings(bundle, mappings, profiles); } catch (failure) { mappingError = errorCode(failure); }
  }
  const targetChanged = mappingError === 'exchangeTargetChanged';
  const setSelection = (ids: string[]) => {
    setSelected(ids); setBundle(null); setReviewed(false); setOutcome(null); setError(null);
  };
  const reportError = (failure: unknown) => {
    const code = errorCode(failure);
    setError(ERROR_CODES.has(code) ? code : 'failed');
  };
  const perform = async (action: () => Promise<void>) => {
    if (pending.current || finished) return;
    pending.current = true; setBusy(true); setError(null); setOutcome(null);
    try { await action(); } catch (failure) { if (alive.current) reportError(failure); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const readFile = (file?: File) => perform(async () => {
    setBundle(null); setMappings([]); setReviewed(false);
    const result = await service.readFile(file);
    if (!alive.current) return;
    if (result.status === 'cancelled') setOutcome('cancelled');
    else setBundle(result.bundle);
  });
  const close = () => { if (!pending.current) onClose(); };

  return <Modal open onClose={close} title={t(`queryExchange:${mode}`)}>
    <div className="qexchange-form">
      {!importing ? <>
        <label className="qexchange-check"><input type="checkbox" aria-label={t('queryExchange:selectAll')}
          disabled={busy} checked={base.entries.length > 0 && selected.length === base.entries.length}
          onChange={(event) => setSelection(event.target.checked ? base.entries.map(({ id }) => id) : [])} />{t('queryExchange:selectAll')}</label>
        <ul className="qexchange-selection" aria-label={t('queryExchange:selection')}>
          {base.entries.map((entry) => <li key={entry.id}>
            <label><input type="checkbox" checked={selected.includes(entry.id)} disabled={busy}
              onChange={(event) => setSelection(event.target.checked ? [...selected, entry.id] : selected.filter((id) => id !== entry.id))} />
              <span><strong>{entry.name || t('queryLibrary:untitled')}</strong><small>
                {entry.index || t('queryExchange:noIndex')} · {sourceProfiles.find(({ id }) => id === entry.connectionId)?.displayName
                  ?? t(entry.connectionId === null ? 'noConnection' : 'removedConnection')}</small></span></label>
          </li>)}
        </ul>
        <button type="button" className="secondary compact-button" disabled={busy || selected.length === 0} onClick={() => {
          try {
            // Only ID/displayName are read by the builder. Endpoint/auth objects never enter the bundle.
            setBundle(buildQueryExchange(base, selected, sourceProfiles)); setError(null); setReviewed(false); setOutcome(null);
          } catch (failure) { setBundle(null); reportError(failure); }
        }}><Eye size={14} aria-hidden="true" />{t('queryExchange:preview')}</button>
      </> : <div className="qexchange-file">
        {service.kind === 'session' ? <input ref={fileInput} type="file" hidden accept=".json,application/json"
          aria-label={t('queryExchange:chooseFile')} disabled={busy || finished} onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void readFile(file);
          }} /> : null}
        <button type="button" className="secondary compact-button" disabled={busy || finished} onClick={() => {
          if (service.kind === 'session') fileInput.current?.click();
          else void readFile();
        }}><FileUp size={14} aria-hidden="true" />{t('queryExchange:chooseFile')}</button>
      </div>}
      {bundle ? <>
        <span className="muted small">{t('queryExchange:queries', { count: bundle.queries.length })}</span>
        {importing && bundle.connections.length > 0 ? <fieldset className="qexchange-mappings">
          <legend>{t('queryExchange:connectionMapping')}</legend>
          {bundle.connections.map((connection) => {
            const mapping = mappings.find((item) => item.sourceKey === connection.key);
            const target = mapping?.target;
            return <label key={connection.key}><span>{connection.label} <small>({connection.key})</small></span>
              <SelectControl aria-label={t('queryExchange:mapTarget', connection)} disabled={busy || finished}
                value={mapping ? target?.connectionId ?? '__unbound__' : ''} onChange={(event) => {
                  const id = event.target.value;
                  const profile = profiles.find((item) => item.id === id);
                  setMappings((current) => [
                    ...current.filter((item) => item.sourceKey !== connection.key),
                    ...(id === '__unbound__' || profile ? [{
                      sourceKey: connection.key, target: profile ? { connectionId: profile.id, endpoint: profile.endpoint } : null,
                    }] : []),
                  ]);
                  setReviewed(false); setError(null);
                }}>
                <option value="">{t('queryExchange:chooseConnection')}</option>
                <option value="__unbound__">{t('queryExchange:unbound')}</option>
                {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName} ({profile.endpoint})</option>)}
              </SelectControl>
              {target ? <small className="qexchange-target">{target.endpoint}</small> : null}
            </label>;
          })}
        </fieldset> : null}
        <label className="qexchange-label" htmlFor="qexchange-preview">{t('queryExchange:review')}</label>
        <textarea className="qexchange-preview" id="qexchange-preview" readOnly spellCheck={false} value={preview} />
        <span className="muted small">{t('queryExchange:scope')}</span>
        <label className="qexchange-check"><input type="checkbox" checked={reviewed} disabled={busy || finished}
          onChange={(event) => setReviewed(event.target.checked)} />{t(importing ? 'queryExchange:mapped' : 'queryExchange:reviewed')}</label>
      </> : null}
      {targetChanged ? <div className="notice error" role="alert">{t('queryExchange:targetChanged')}</div> : null}
      {error ? <div className="notice error" role="alert">{t(`queryExchange:${error}`)}</div> : null}
      {outcome ? <div className="notice neutral" role="status">{t(`queryExchange:${outcome}`)}</div> : null}
      {busy ? <span className="qexchange-busy" role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" />{t('queryExchange:busy')}</span> : null}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={close}>{t('close')}</button>
        <button type="button" className="primary" disabled={busy || !bundle || !reviewed || finished || (importing && mappingError !== null)}
          onClick={() => {
            if (!bundle || !reviewed) return;
            const reviewedBundle = bundle;
            void perform(async () => {
              if (importing) {
                validateConnectionMappings(reviewedBundle, mappings, profiles);
                await library.importLibrary(base, () => service.importDefinitions(reviewedBundle, mappings, base));
                if (alive.current) setOutcome(service.kind === 'session' ? 'sessionImported' : 'imported');
              } else {
                const result = await service.saveFile(reviewedBundle, true);
                if (alive.current) setOutcome(result.status);
              }
            });
          }}>
          {importing ? <FileUp size={14} aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
          {t(importing ? 'queryExchange:importAction' : 'queryExchange:saveFile', { count: bundle?.queries.length ?? 0 })}
        </button>
      </div>
    </div>
  </Modal>;
}
