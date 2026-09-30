import { LoaderCircle, Monitor, Pencil, Plus, RefreshCw, Search, Sparkles, Trash2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState, IconButton, Modal } from '../../components/controls';
import type { ModelProfile } from '../../domain/models';
import { errorCode } from '../../services/ipc';
import { desktopModelService, type ModelService } from '../../services/models';
import { ModelEditor } from './ModelEditor';
import { useModels } from './useModels';
import '../../styles/models.css';

interface Props {
  /**
   * Persistence adapter. The app passes the desktop/session service created once at startup; the
   * default is the desktop IPC, which reports `unsupported` in the browser instead of pretending.
   */
  service?: ModelService;
}

/**
 * Model profile settings page.
 *
 * This page configures profiles; it never calls a model. Every row is labelled "not verified" and
 * the page states that nothing was sent to the endpoint, so a stored profile is never presented as
 * an available model. Selecting the default changes the stored selection only.
 */
export function ModelPanel({ service = desktopModelService }: Props) {
  const { t } = useTranslation();
  const { state, busy, reload, save, remove, select } = useModels(service);
  const [editing, setEditing] = useState<ModelProfile | 'new' | null>(null);
  const [removing, setRemoving] = useState<ModelProfile | null>(null);
  const [filter, setFilter] = useState('');
  const [actionError, setActionError] = useState<{ key: 'deleteFailed' | 'selectFailed' | 'notFound'; code: string } | null>(null);

  const profiles = state.status === 'ready' ? state.profiles : [];
  const defaultModelId = state.status === 'ready' ? state.defaultModelId : null;
  const visible = profiles.filter((profile) =>
    `${profile.displayName} ${profile.endpoint} ${profile.modelId}`.toLowerCase().includes(filter.trim().toLowerCase()));

  /** A rejected change keeps the list and reports the backend code; a deleted row is re-read. */
  const change = async (key: 'deleteFailed' | 'selectFailed', action: () => Promise<void>) => {
    setActionError(null);
    try {
      await action();
    } catch (failure) {
      const code = errorCode(failure);
      setActionError({ key: code === 'notFound' ? 'notFound' : key, code });
    }
  };

  const confirmRemove = async () => {
    const target = removing;
    await change('deleteFailed', async () => { if (target) await remove(target.id); });
    setRemoving(null);
  };

  return <div className="models-page">
    {service.kind === 'session' ? <div className="notice models-notice" role="status">
      <Monitor size={16} /><span>{t('models:sessionNotice')}</span></div> : null}
    <div className="notice models-notice" role="status">
      <Sparkles size={16} /><span>{t('models:configOnly')} {t('models:callsDisabled')}</span></div>

    <div className="models-toolbar">
      <label className="models-filter">
        <Search size={15} />
        <input aria-label={t('models:filter')} placeholder={t('models:filter')} value={filter}
          onChange={(event) => setFilter(event.target.value)} />
      </label>
      <button type="button" className="secondary" disabled={busy || state.status === 'loading'} onClick={reload}>
        <RefreshCw size={15} />{t('models:refresh')}</button>
      <button type="button" className="primary" disabled={busy || state.status !== 'ready'}
        onClick={() => { setActionError(null); setEditing('new'); }}>
        <Plus size={15} />{t('models:add')}</button>
    </div>

    {state.status === 'loading' ? <p className="muted models-state" role="status">
      <LoaderCircle size={15} className="spin" />{t('models:loading')}</p> : null}

    {state.status === 'error' ? <div className="notice error models-state" role="alert">
      <TriangleAlert size={16} /><span>{t('models:loadFailed')} {t(`errors:${state.code}`)}</span>
      <button type="button" className="secondary" onClick={reload}>{t('retry')}</button></div> : null}

    {state.status === 'ready' ? <>
      {state.error ? <div className="notice warning models-state" role="alert">
        <TriangleAlert size={16} /><span>{t('models:refreshFailed')} {t(`errors:${state.error}`)}</span>
        <button type="button" className="secondary" onClick={reload}>{t('retry')}</button></div> : null}
      {actionError ? <div className="notice error models-state" role="alert">
        <TriangleAlert size={16} /><span>{t(`models:${actionError.key}`)}
          {actionError.key === 'notFound' ? '' : ` ${t(`errors:${actionError.code}`)}`}</span></div> : null}

      <div className="subheading muted">{t('models:profileCount', { count: profiles.length })}</div>
      <p className="muted small">{t('models:defaultHint')}</p>

      {profiles.length === 0 ? <EmptyState icon={Sparkles} title={t('models:empty')} description={t('models:emptyDetail')}>
        <button type="button" className="secondary" disabled={busy} onClick={() => setEditing('new')}>
          <Plus size={15} />{t('models:add')}</button>
      </EmptyState> : visible.length === 0 ? <p className="muted models-state">{t('noMatches')}</p> : <ul className="model-list">
        {visible.map((profile) => {
          const isDefault = profile.id === defaultModelId;
          return <li key={profile.id} className={`model-row${isDefault ? ' is-default' : ''}`}>
            <label className="model-default">
              <input type="radio" name="model-default" checked={isDefault} disabled={busy}
                aria-label={`${t('models:setDefault')}: ${profile.displayName}`}
                onChange={() => void change('selectFailed', async () => { await select(profile.id); })} />
              <span>{isDefault ? t('models:default') : t('models:setDefault')}</span>
            </label>
            <div className="model-info">
              <div className="model-heading">
                <span className="model-name">{profile.displayName}</span>
                <span className="model-badge">{t(profile.protocol === 'ollama' ? 'models:protocolOllama' : 'models:protocolOpenaiCompatible')}</span>
                <span className="model-badge warn">{t('models:notVerified')}</span>
              </div>
              <span className="endpoint model-endpoint">{profile.endpoint}</span>
              <span className="model-id muted">{t('models:modelId')} <code>{profile.modelId}</code></span>
            </div>
            <div className="model-actions">
              <IconButton icon={Pencil} label={t('models:edit')} disabled={busy}
                onClick={() => { setActionError(null); setEditing(profile); }} />
              <IconButton icon={Trash2} label={t('delete')} disabled={busy}
                onClick={() => { setActionError(null); setRemoving(profile); }} />
            </div>
          </li>;
        })}
      </ul>}
    </> : null}

    <ModelEditor key={editing === 'new' ? 'new' : editing?.id ?? 'closed'} value={editing} busy={busy}
      onClose={() => { if (!busy) setEditing(null); }} onSave={save} />

    <Modal open={removing !== null} onClose={() => { if (!busy) setRemoving(null); }}
      title={t('models:deleteTitle')}
      description={removing ? t('models:deleteDetail', { name: removing.displayName }) : undefined}>
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={() => setRemoving(null)}>{t('cancel')}</button>
        <button type="button" className="primary" disabled={busy} onClick={() => void confirmRemove()}>
          {busy ? <LoaderCircle size={14} className="spin" /> : null}{t('delete')}</button>
      </div>
    </Modal>
  </div>;
}
