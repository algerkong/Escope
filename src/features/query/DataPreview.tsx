import { Database, FilePlus2, FolderOpen, Layers, Plus, RefreshCw } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton } from '../../components/controls';
import type { ConnectionProfile } from '../../domain/connection';
import type { QueryDocument } from '../../domain/query';

interface Props {
  document: QueryDocument;
  target: ConnectionProfile | undefined;
  available: boolean;
  locked: boolean;
  busy: boolean;
  refreshBlockedReason?: string;
  summary?: ReactNode;
  children?: ReactNode;
  onOpen: (index: string) => void;
  onRefresh: () => void;
  onNewQuery: () => void;
  onConnections: () => void;
}

/** Index tabs have immutable targets; only the empty opener accepts a new target. */
export function DataPreview({ document, target, available, locked, busy, refreshBlockedReason, summary, children, onOpen, onRefresh, onNewQuery, onConnections }: Props) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(document.index);
  useEffect(() => { setIndex(document.index); }, [document.id, document.index]);
  const canPreview = available && target !== undefined && index.trim() !== '';
  return <>
    <form className="preview-toolbar" aria-label={t('queryLive:previewToolbar')} data-locked={locked} onSubmit={(event) => {
      event.preventDefault();
      if (canPreview && !locked) onOpen(index.trim());
    }}>
      <div className="preview-context">
        <span className="preview-connection"><Database size={14} aria-hidden="true" />
          <span title={target?.displayName}>{target?.displayName ?? t(document.connectionId ? 'removedConnection' : 'noConnection')}</span></span>
        {locked ? <div className="preview-index-target"><Layers size={15} aria-hidden="true" />
          <code title={document.index}>{document.index}</code></div> : <label className="index-input"><Layers size={15} aria-hidden="true" />
          <input aria-label={t('queryLive:previewIndex')} placeholder={t('query:indexPlaceholder')}
            autoComplete="off" value={index} spellCheck={false} onChange={(event) => setIndex(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
            }} /></label>}
      </div>
      {summary}
      <div className="preview-actions">
        {children}
        {locked ? <>
          <IconButton icon={FilePlus2} label={t('queryLive:queryIndex', { index: document.index })} onClick={onNewQuery} disabled={!target} />
          <IconButton icon={RefreshCw} label={t('queryLive:refreshIndex')} disabled={!canPreview || busy || Boolean(refreshBlockedReason)}
            title={refreshBlockedReason ?? t('queryLive:refreshIndex')} onClick={onRefresh} />
        </> : <IconButton type="submit" icon={FolderOpen} label={t('queryLive:openIndex')} disabled={!canPreview} />}
        {!target ? <button type="button" className="primary compact-button" onClick={onConnections}>
          <Plus size={15} />{t('connections:add')}</button> : null}
      </div>
    </form>
  </>;
}
