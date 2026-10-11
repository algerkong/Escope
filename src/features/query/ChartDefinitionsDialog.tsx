import { Copy, FileDown, FileUp, LoaderCircle, Pencil, RefreshCw, Repeat2, Save, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, Modal } from '../../components/controls';
import type { ConnectionProfile } from '../../domain/connection';
import { MAX_CHART_DEFINITIONS, MAX_CHART_NAME_CHARS, sameChartDefinition, type ChartDefinition } from '../../domain/chart-definitions';
import type { ChartDefinitionsController } from './useChartDefinitions';
import '../../styles/chart-definitions.css';

interface Props {
  library: ChartDefinitionsController;
  kind: 'desktop' | 'session';
  profiles: readonly ConnectionProfile[];
  /** Reuse is only offered on the tab whose connection ID and target match the definition. */
  activeTarget: { connectionId: string | null; index: string } | null;
  onReuse: (definition: ChartDefinition) => void;
  onExchange: (mode: 'export' | 'import') => void;
  onClose: () => void;
}

type Panel = { kind: 'list' } | { kind: 'rename'; source: ChartDefinition } | { kind: 'delete'; source: ChartDefinition };

/** The group type stays a DSL literal; a no-grouping definition reads as one single value. */
const shapeLabel = (definition: ChartDefinition, noGroup: string) => definition.draft.group
  ? `${definition.draft.group.type} · ${definition.draft.metrics.length}`
  : `${noGroup} · ${definition.draft.metrics.length}`;

export function ChartDefinitionsDialog({ library, kind, profiles, activeTarget, onReuse, onExchange, onClose }: Props) {
  const { t, i18n } = useTranslation();
  const [panel, setPanel] = useState<Panel>({ kind: 'list' });
  const [name, setName] = useState('');
  const [filter, setFilter] = useState('');
  const list = useRef<HTMLUListElement>(null);
  const showList = () => {
    setPanel({ kind: 'list' });
    requestAnimationFrame(() => list.current?.focus());
  };
  const canEdit = library.status === 'ready' && !library.error && !library.saving;
  // The cap is a library rule: at the limit no new definition can be created, so every adding affordance stops.
  const atLimit = library.entries.length >= MAX_CHART_DEFINITIONS;
  const entries = library.entries.filter((entry) => `${entry.name} ${entry.index}`.toLowerCase().includes(filter.toLowerCase()));
  const title = panel.kind === 'rename' ? t('chartDefinitions:renameTitle')
    : panel.kind === 'delete' ? t('chartDefinitions:deleteTitle') : t('chartDefinitions:title');
  const rename = panel.kind === 'rename' ? panel.source : null;
  const trimmed = name.trim();
  const renameEntry = rename ? { ...rename, name: trimmed } : null;
  return <Modal open onClose={onClose} title={title}>
    <div className="chart-definitions-panel">
      {kind === 'session' ? <span className="muted">{t('chartDefinitions:session')}</span> : null}
      <p className="muted chart-definitions-scope" title={t('chartDefinitions:scopeBoundary')}>{t('chartDefinitions:scope')}</p>
      {library.status === 'loading' || library.saving ? <div className="chart-definitions-status" role="status">
        <LoaderCircle size={14} className="spin" aria-hidden="true" />
        {t(library.saving ? 'chartDefinitions:saving' : 'chartDefinitions:loading')}
      </div> : null}
      {library.error ? <div className="notice error" role="alert">
        <span>{t(library.error === 'invalidResponse' ? 'chartDefinitions:invalidStorage'
          : library.error === 'invalidInput' ? 'chartDefinitions:invalidDefinition'
            : i18n.exists(`errors:${library.error}`) ? `errors:${library.error}` : 'errors:unexpected')}</span>
        <button className="secondary compact-button" disabled={library.saving} onClick={() => { showList(); library.reload(); }}>
          <RefreshCw size={14} />{t(panel.kind === 'list' ? 'chartDefinitions:reload' : 'chartDefinitions:discardAndReload')}
        </button>
      </div> : null}
      {panel.kind === 'list' ? <>
        <div className="chart-definitions-actions">
          <input type="search" aria-label={t('chartDefinitions:filter')} value={filter} disabled={!canEdit}
            onChange={(event) => setFilter(event.target.value)} />
          <IconButton icon={RefreshCw} label={t('chartDefinitions:reload')} disabled={!canEdit} onClick={library.reload} />
          <IconButton icon={FileDown} label={t('chartDefinitions:exportDefinitions')} disabled={!canEdit}
            title={t('chartDefinitions:exportDefinitions')} onClick={() => onExchange('export')} />
          <IconButton icon={FileUp} label={t('chartDefinitions:importDefinitions')} disabled={!canEdit}
            title={t('chartDefinitions:importDefinitions')} onClick={() => onExchange('import')} />
        </div>
        {atLimit ? <span className="chart-definitions-bound" role="status">{t('chartDefinitions:limit', { count: MAX_CHART_DEFINITIONS })}</span> : null}
        {library.status === 'ready' && entries.length === 0
          ? <p className="muted">{t(filter ? 'chartDefinitions:noMatches' : 'chartDefinitions:empty')}</p> : null}
        <ul ref={list} className="chart-definitions-list" tabIndex={-1} aria-label={t('chartDefinitions:title')}>
          {entries.map((entry) => {
            const connection = profiles.find((profile) => profile.id === entry.connectionId);
            const onActive = activeTarget !== null && activeTarget.connectionId === entry.connectionId
              && activeTarget.index.trim() === entry.index;
            // Reuse needs both a matching tab and a connection that still exists; a deleted
            // connection keeps the definition unbound instead of pointing it at a new one.
            const reusable = onActive && connection !== undefined;
            return <li key={entry.id}>
              <div className="chart-definitions-entry">
                <strong>{entry.name}</strong>
                <span>{connection?.displayName ?? t(entry.connectionId ? 'removedConnection' : 'noConnection')}: {entry.index}</span>
                <span>{shapeLabel(entry, t('chartDefinitions:shapeNoGroup'))}</span>
                <span>{t('chartDefinitions:measure')} {entry.measure}</span>
              </div>
              <IconButton icon={Repeat2} label={t('chartDefinitions:reuse')} disabled={!canEdit || !reusable}
                title={reusable ? t('chartDefinitions:reuseHint')
                  : t(connection ? 'chartDefinitions:reuseOtherTarget' : 'chartDefinitions:reuseNoConnection')}
                onClick={() => { onReuse(entry); onClose(); }} />
              <IconButton icon={Copy} label={t('chartDefinitions:copy')} disabled={!canEdit || atLimit}
                title={t('chartDefinitions:copyHint')}
                onClick={() => {
                  void library.save({ ...structuredClone(entry), id: crypto.randomUUID(), name: `${entry.name} (${t('chartDefinitions:copySuffix')})` });
                }} />
              <IconButton icon={Pencil} label={t('chartDefinitions:rename')} disabled={!canEdit}
                onClick={() => { setPanel({ kind: 'rename', source: entry }); setName(entry.name); }} />
              <IconButton icon={Trash2} label={t('chartDefinitions:delete')} disabled={!canEdit}
                onClick={() => setPanel({ kind: 'delete', source: entry })} />
            </li>;
          })}
        </ul>
      </> : null}
      {rename ? <div className="chart-definitions-rename">
        <label htmlFor="chart-definitions-rename-name">{t('chartDefinitions:name')}</label>
        <input id="chart-definitions-rename-name" value={name} maxLength={MAX_CHART_NAME_CHARS} autoFocus disabled={!canEdit}
          onChange={(event) => setName(event.target.value)} />
        <span className="chart-definitions-bound" role="status">{t('chartDefinitions:identityBound')}</span>
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={showList}>{t('cancel')}</button>
          <button type="button" className="primary" disabled={!canEdit || !renameEntry || sameChartDefinition(renameEntry, rename)
            || trimmed === '' || trimmed !== name || [...trimmed].length > MAX_CHART_NAME_CHARS}
            onClick={() => { if (renameEntry) void library.save(renameEntry, rename).then((saved) => { if (saved) showList(); }); }}>
            <Save size={14} />{t('chartDefinitions:renameSave')}
          </button>
        </div>
      </div> : null}
      {panel.kind === 'delete' ? <>
        <p>{t('chartDefinitions:deleteDetail', { name: panel.source.name })}</p>
        <p className="muted" title={t('chartDefinitions:deleteBoundary')}>{t('chartDefinitions:deleteBoundaryHint')}</p>
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={showList}>{t('cancel')}</button>
          <button type="button" className="danger" disabled={!canEdit}
            onClick={() => { void library.remove(panel.source).then((saved) => { if (saved) showList(); }); }}>
            <Trash2 size={14} />{t('chartDefinitions:deleteConfirm')}
          </button>
        </div>
      </> : null}
    </div>
  </Modal>;
}
