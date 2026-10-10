import { ListFilter, Pin, RefreshCw, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, Modal } from '../../components/controls';
import type { ConnectionProfile } from '../../domain/connection';
import {
  MAX_PINNED_FILTER_NAME_CHARS, MAX_PINNED_FILTERS, pinFilterDefinition,
  type PinnedFilterDefinition,
} from '../../domain/pinned-filters';
import type { QueryFilterDraft } from '../../domain/query-filters';
import type { QueryDocument } from '../../domain/query';
import type { PinnedFiltersController } from './usePinnedFilters';
import '../../styles/pinned-filters.css';

function LibraryStatus({ library }: { library: PinnedFiltersController }) {
  const { t, i18n } = useTranslation();
  return <>
    {library.status === 'loading' || library.saving ? <span className="muted" role="status">
      {t(library.saving ? 'pinnedFilters:saving' : 'pinnedFilters:loading')}</span> : null}
    {library.error ? <div className="notice error" role="alert">
      <span>{t(library.error === 'invalidResponse' ? 'pinnedFilters:invalidStorage'
        : i18n.exists(`errors:${library.error}`) ? `errors:${library.error}` : 'errors:unexpected')}</span>
      <IconButton icon={RefreshCw} label={t('pinnedFilters:reload')} disabled={library.saving} onClick={library.reload} />
    </div> : null}
  </>;
}

export function PinFiltersDialog({ draft, currentTarget, library, kind, onClose }: {
  draft: QueryFilterDraft; currentTarget: boolean; library: PinnedFiltersController; kind: 'desktop' | 'session'; onClose: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [definitionId] = useState(() => crypto.randomUUID());
  const [name, setName] = useState('');
  const [accepted, setAccepted] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const proposal = pinFilterDefinition(draft, definitionId, name);
  const payload = proposal.ok ? JSON.stringify(proposal.definition, null, 2) : '';
  const canSave = currentTarget && proposal.ok && payload === accepted && !submitting && !library.saving
    && library.status === 'ready' && !library.error && library.entries.length < MAX_PINNED_FILTERS;
  const close = () => { if (!submitting) onClose(); };
  return <Modal open onClose={close} title={t('pinnedFilters:pin')}>
    <div className="pinned-filters">
      <div className="qfilter-origin"><code>{draft.source.connectionId}</code><code>{draft.endpoint}</code><code>{draft.source.index}</code></div>
      {kind === 'session' ? <span className="muted">{t('pinnedFilters:session')}</span> : null}
      <LibraryStatus library={library} />
      <label htmlFor={`${id}-name`}>{t('pinnedFilters:name')}</label>
      <input id={`${id}-name`} value={name} maxLength={MAX_PINNED_FILTER_NAME_CHARS} disabled={submitting}
        onChange={(event) => { setName(event.target.value); setAccepted(null); }} />
      {!proposal.ok && (proposal.code !== 'invalid' || name !== '') ? <span className="qfilter-warning" role="status">
        {t(`pinnedFilters:${proposal.code}`)}</span> : null}
      {proposal.ok ? <>
        <label htmlFor={`${id}-definition`}>{t('pinnedFilters:definition')}</label>
        <textarea id={`${id}-definition`} className="qfilter-code" readOnly spellCheck={false} value={payload} />
        <label className="pinned-confirm"><input type="checkbox" checked={accepted === payload}
          disabled={!currentTarget || submitting} onChange={(event) => setAccepted(event.target.checked ? payload : null)} />
          <span>{t('pinnedFilters:literalConsent')}</span>
        </label>
      </> : null}
      {!currentTarget ? <span className="qfilter-warning" role="alert">{t('pinnedFilters:changed')}</span> : null}
      {library.entries.length >= MAX_PINNED_FILTERS ? <span className="qfilter-warning" role="status">{t('pinnedFilters:limit')}</span> : null}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={submitting} onClick={close}>{t('cancel')}</button>
        <button type="button" className="primary" disabled={!canSave} onClick={async () => {
          if (!canSave || !proposal.ok) return;
          setSubmitting(true);
          const saved = await library.save(proposal.definition);
          setSubmitting(false);
          if (saved) onClose();
        }}><Pin size={14} aria-hidden="true" />{t('pinnedFilters:save')}</button>
      </div>
    </div>
  </Modal>;
}

export function PinnedFiltersDialog({ library, kind, profiles, source, endpoint, canLoad, onLoad, onClose }: {
  library: PinnedFiltersController; kind: 'desktop' | 'session'; profiles: readonly ConnectionProfile[];
  source: QueryDocument | null; endpoint: string | null; canLoad: boolean;
  onLoad: (definition: PinnedFilterDefinition) => boolean; onClose: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [search, setSearch] = useState('');
  const [deleting, setDeleting] = useState<PinnedFilterDefinition | null>(null);
  const [failedLoad, setFailedLoad] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const writable = library.status === 'ready' && !library.error && !library.saving && !submitting;
  const visible = library.entries.filter((entry) =>
    `${entry.name}\n${entry.index}\n${entry.connectionId}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const close = () => { if (!submitting) onClose(); };
  return <Modal open onClose={close} title={t(deleting ? 'pinnedFilters:deleteTitle' : 'pinnedFilters:title')}>
    <div className="pinned-filters">
      {kind === 'session' ? <span className="muted">{t('pinnedFilters:session')}</span> : null}
      <LibraryStatus library={library} />
      {deleting ? <>
        <p>{t('pinnedFilters:deleteDetail', { name: deleting.name })}</p>
        <label htmlFor={`${id}-definition`}>{t('pinnedFilters:definition')}</label>
        <textarea id={`${id}-definition`} className="qfilter-code" readOnly spellCheck={false} value={JSON.stringify(deleting, null, 2)} />
        <div className="dialog-actions">
          <button type="button" className="secondary" disabled={submitting} onClick={() => setDeleting(null)}>{t('cancel')}</button>
          <button type="button" className="danger" disabled={!writable} onClick={async () => {
            if (!writable) return;
            setSubmitting(true);
            const removed = await library.remove(deleting);
            setSubmitting(false);
            if (removed) setDeleting(null);
          }}><Trash2 size={14} aria-hidden="true" />{t('pinnedFilters:delete')}</button>
        </div>
      </> : <>
        {source ? <div className="qfilter-origin"><code>{source.connectionId}</code><code>{endpoint}</code><code>{source.index}</code></div> : null}
        <div className="pinned-toolbar">
          <input type="search" aria-label={t('pinnedFilters:filter')} value={search} onChange={(event) => setSearch(event.target.value)} />
          <IconButton icon={RefreshCw} label={t('pinnedFilters:reload')} disabled={library.saving} onClick={library.reload} />
        </div>
        {!canLoad || failedLoad ? <span className="qfilter-warning" role="status">{t('pinnedFilters:loadBlocked')}</span> : null}
        {library.status === 'ready' && !visible.length ? <p className="muted">{t(search ? 'pinnedFilters:noMatches' : 'pinnedFilters:empty')}</p> : null}
        <ul className="pinned-list" aria-label={t('pinnedFilters:title')}>
          {visible.map((entry) => {
            const profile = profiles.find((profile) => profile.id === entry.connectionId);
            const sameTarget = profile && source?.connectionId === entry.connectionId && source.index === entry.index;
            return <li key={entry.id}>
              <div className="pinned-item">
                <strong>{entry.name}</strong><span>{profile?.displayName ?? t('removedConnection')}</span>
                <code>{entry.connectionId}</code><code>{entry.index}</code>
                <span>{t('pinnedFilters:counts', { count: entry.filters.length, groups: entry.composition.groups.length,
                  enabled: entry.filters.filter((filter) => filter.enabled).length })}</span>
              </div>
              <IconButton icon={ListFilter} label={t('pinnedFilters:load', { name: entry.name })}
                title={t(sameTarget ? 'pinnedFilters:loadReview' : 'pinnedFilters:targetMismatch')}
                disabled={!writable || !canLoad || !sameTarget} onClick={() => {
                  if (!writable || !canLoad || !sameTarget) return;
                  if (!onLoad(entry)) setFailedLoad(true);
                }} />
              <IconButton icon={Trash2} label={t('pinnedFilters:deleteNamed', { name: entry.name })} disabled={!writable}
                onClick={() => setDeleting(structuredClone(entry))} />
            </li>;
          })}
        </ul>
        <div className="dialog-actions"><button type="button" className="secondary" onClick={close}>{t('close')}</button></div>
      </>}
    </div>
  </Modal>;
}
