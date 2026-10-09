import { ChevronLeft, ChevronRight, FileSearch, LoaderCircle, PanelRight, Plus, Table2, X } from 'lucide-react';
import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton } from '../../components/controls';
import type { ConnectionProfile } from '../../domain/connection';
import type { WorkspaceState } from '../../domain/query';
import type { ExecutionEntry } from './useQueryExecutions';
import '../../styles/workspace-tabs.css';

interface Props {
  state: WorkspaceState;
  profiles: readonly ConnectionProfile[];
  entries: Readonly<Record<string, ExecutionEntry>>;
  aiOpen: boolean;
  dirtyIds: ReadonlySet<string>;
  onSelect: (id: string | null) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
  onToggleAI: () => void;
}

export const workspaceTabId = (id: string | null) => `workspace-tab-${id ?? 'home'}`;

export function WorkspaceTabs({ state, profiles, entries, aiOpen, dirtyIds, onSelect, onClose, onAdd, onToggleAI }: Props) {
  const { t } = useTranslation();
  const list = useRef<HTMLDivElement>(null);
  const ids = [null, ...state.tabs.map((tab) => tab.document.id)];
  const activePosition = ids.indexOf(state.activeTabId);
  useLayoutEffect(() => {
    document.getElementById(workspaceTabId(state.activeTabId))?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [state.activeTabId]);

  const activate = (position: number) => {
    const id = ids[position];
    if (id === undefined) return;
    onSelect(id);
    document.getElementById(workspaceTabId(id))?.focus();
  };
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, position: number) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
    const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (offset || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      activate(event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : (position + offset + ids.length) % ids.length);
    } else if (event.key === 'Delete' && position > 0 && !event.repeat) {
      event.preventDefault();
      onClose(ids[position]!);
    }
  };
  let queryNumber = 0;

  return <div className="tabs-toolbar workspace-tabs-toolbar">
    <div className="query-tabs" ref={list} role="tablist" aria-label={t('workspace')}>
      <div className="query-tab preview-tab" data-active={state.activeTabId === null}>
        <button id={workspaceTabId(null)} type="button" role="tab" aria-selected={state.activeTabId === null}
          aria-controls="workspace-panel" tabIndex={state.activeTabId === null ? 0 : -1}
          onClick={() => onSelect(null)} onKeyDown={(event) => keyDown(event, 0)}>
          <Table2 size={15} aria-hidden="true" /><span>{t('queryLive:dataPreview')}</span>
        </button>
      </div>
      {state.tabs.map(({ kind, document: item }, position) => {
        if (kind === 'query') queryNumber++;
        const connection = profiles.find((profile) => profile.id === item.connectionId)?.displayName
          ?? t(item.connectionId ? 'removedConnection' : 'noConnection');
        const title = kind === 'index' ? item.index : item.name || `${t('query:title')} ${queryNumber}`;
        const label = kind === 'index' ? `${title} (${connection})` : title;
        const closeLabel = kind === 'index' ? t('queryLive:closeIndex', { index: item.index, connection })
          : `${t('query:closeQuery')} ${queryNumber}`;
        const selected = state.activeTabId === item.id;
        const busy = entries[item.id]?.state.status === 'running' || entries[item.id]?.continuing;
        const Icon = busy ? LoaderCircle : kind === 'index' ? Table2 : FileSearch;
        return <div className="query-tab" data-active={selected} data-kind={kind} key={item.id}
          onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
          onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onClose(item.id); } }}>
          <button id={workspaceTabId(item.id)} type="button" role="tab" aria-selected={selected}
            aria-controls="workspace-panel" aria-label={label} aria-keyshortcuts="Delete" aria-busy={busy || undefined}
            title={`${title} (${connection})`} tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(item.id)} onKeyDown={(event) => keyDown(event, position + 1)}>
            <Icon size={15} aria-hidden="true" className={busy ? 'spin' : undefined} />
            <span>{title}</span>
            {(kind === 'query' && item.revision > 0) || dirtyIds.has(item.id) ? <span className="draft-dot" /> : null}
          </button>
          <IconButton icon={X} label={closeLabel} tabIndex={-1} onClick={() => onClose(item.id)} />
        </div>;
      })}
    </div>
    <div className="workspace-tab-actions">
      {state.tabs.length > 2 ? <>
        <IconButton icon={ChevronLeft} label={t('queryLive:previousTab')} disabled={activePosition <= 0}
          onClick={() => activate(activePosition - 1)} />
        <IconButton icon={ChevronRight} label={t('queryLive:nextTab')} disabled={activePosition >= ids.length - 1}
          onClick={() => activate(activePosition + 1)} />
      </> : null}
      <IconButton icon={Plus} label={t('newQuery')} onClick={onAdd} />
      <IconButton icon={PanelRight} label={t('query:toggleAI')} aria-pressed={aiOpen} onClick={onToggleAI} />
    </div>
  </div>;
}
