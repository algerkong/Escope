import {
  CheckCircle2, FlaskConical, KeyRound, LoaderCircle, Monitor, Pencil, Plus, RefreshCw, RotateCcw,
  Search, Sparkles, Square, Trash2, TriangleAlert,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState, IconButton, Modal } from '../../components/controls';
import type { AiChatBackend, AiChatResponse } from '../../domain/ai-chat';
import type { ModelCredentialChange } from '../../domain/model-access';
import type { ModelInput, ModelProfile } from '../../domain/models';
import { aiErrorCode, desktopAiChatBackend } from '../../services/ai-chat';
import { desktopModelService, modelErrorCode, type ModelService } from '../../services/models';
import { modelFailureText } from './error-text';
import { ModelEditor } from './ModelEditor';
import { useModels } from './useModels';
import '../../styles/models.css';

interface Props {
  /**
   * Persistence adapter. The app passes the desktop/session service created once at startup; the
   * default is the desktop IPC, which reports `unsupported` in the browser instead of pretending.
   */
  service?: ModelService;
  /** Generation-test transport; the app passes the same injected backend the AI panel uses. */
  backend?: AiChatBackend;
}

/** Fixed harmless prompt for the explicit generation test: no history, no query, no context. */
const TEST_PROMPT = 'Reply with OK.';
/** Characters of the reply kept for the preview; the rest is dropped from the UI. */
const TEST_REPLY_LIMIT = 240;

type TestState =
  | { readonly status: 'running'; readonly phase: 'waiting' | 'streaming' }
  | {
    readonly status: 'passed';
    readonly latencyMs: number;
    readonly actualModelId: string | null;
    readonly at: number;
    readonly reply: string;
  }
  | { readonly status: 'failed'; readonly code: string; readonly at: number }
  | { readonly status: 'cancelled'; readonly at: number };

/** The tested identity of a profile: any change here discards a previous test result. */
function keyOf(profile: ModelProfile): string {
  return `${profile.protocol}\u0000${profile.endpoint}\u0000${profile.modelId}\u0000${profile.hasApiKey ? 'key' : 'none'}`;
}

/** A generation test passes only on a completed, nonblank reply; everything else is a failure. */
function verdict(response: AiChatResponse, latencyMs: number): TestState {
  if (response.outcome !== 'complete') return { status: 'failed', code: 'testIncomplete', at: Date.now() };
  if (response.text.trim() === '') return { status: 'failed', code: 'testEmptyReply', at: Date.now() };
  return {
    status: 'passed',
    latencyMs,
    actualModelId: response.actualModelId,
    at: Date.now(),
    reply: response.text.length > TEST_REPLY_LIMIT
      ? `${response.text.slice(0, TEST_REPLY_LIMIT)}…` : response.text,
  };
}

/**
 * Model profile settings page.
 *
 * Configuration, a saved key and a fetched model list are stored locally and labelled "not
 * verified"; only the explicit "test model" command sends the fixed harmless prompt through the
 * chat backend (no history, no key override — the backend resolves the saved credential) and
 * records a pass on a completed nonblank reply with latency, actual model and time. The test never
 * touches the conversation, the default selection or the stored profiles, and its status is
 * discarded as soon as the tested target changes, disappears or the list is re-read with different
 * data.
 */
export function ModelPanel({ service = desktopModelService, backend = desktopAiChatBackend }: Props) {
  const { t } = useTranslation();
  const { state, busy, reload, save, remove, select, cleanup } = useModels(service);
  const [editing, setEditing] = useState<ModelProfile | 'new' | null>(null);
  const [removing, setRemoving] = useState<ModelProfile | null>(null);
  const [filter, setFilter] = useState('');
  const [actionError, setActionError] = useState<{ label: 'deleteFailed' | 'selectFailed' | 'notFound'; code: string } | null>(null);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});

  const inFlight = useRef<{ requestId: string; profileId: string; backend: AiChatBackend } | null>(null);
  /** Synchronous submit guard; released at the end of the stack, after any sync settle/throw. */
  const startLock = useRef(false);
  const alive = useRef(true);
  const knownKeys = useRef<Map<string, string>>(new Map());
  const formatTime = useMemo(() => {
    const format = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return (value: number) => format.format(value);
  }, []);

  /** Stop the running generation test through the backend it was started with. */
  const cancelTest = () => {
    const current = inFlight.current;
    if (!current) return;
    inFlight.current = null;
    setTests((state2) => state2[current.profileId]?.status === 'running'
      ? { ...state2, [current.profileId]: { status: 'cancelled', at: Date.now() } } : state2);
    void current.backend.cancel({ requestId: current.requestId, modelProfileId: current.profileId })
      .catch(() => undefined);
  };
  const cancelTestRef = useRef(cancelTest);
  cancelTestRef.current = cancelTest;

  /** Forget one profile's test state (running tests are cancelled first). */
  const invalidateTest = (profileId: string) => {
    if (inFlight.current?.profileId === profileId) cancelTest();
    setTests((state2) => {
      if (!(profileId in state2)) return state2;
      const next = { ...state2 };
      delete next[profileId];
      return next;
    });
  };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      const current = inFlight.current;
      inFlight.current = null;
      if (current !== null) {
        void current.backend.cancel({ requestId: current.requestId, modelProfileId: current.profileId })
          .catch(() => undefined);
      }
    };
  }, []);

  // A re-read that failed cannot confirm a running target; a re-read that changed or removed a
  // profile discards its test state. Identical data keeps a finished result.
  useEffect(() => {
    if (state.status !== 'ready') return;
    if (state.error !== null) cancelTestRef.current();
    const keys = new Map(state.profiles.map((profile) => [profile.id, keyOf(profile)]));
    const previous = knownKeys.current;
    knownKeys.current = keys;
    const changed = new Set<string>();
    for (const [id, key] of previous) {
      if (keys.get(id) !== key) changed.add(id);
    }
    if (changed.size === 0) return;
    const running = inFlight.current;
    if (running !== null && changed.has(running.profileId)) cancelTestRef.current();
    setTests((state2) => {
      if (!Object.keys(state2).some((id) => changed.has(id))) return state2;
      const next: Record<string, TestState> = {};
      for (const [id, value] of Object.entries(state2)) {
        if (!changed.has(id)) next[id] = value;
      }
      return next;
    });
  }, [state]);

  const startTest = (profile: ModelProfile) => {
    // Guards run synchronously and independently of the disabled buttons: same-frame duplicates,
    // writes, unconfirmed re-reads and a target that no longer matches the stored profile all refuse.
    if (startLock.current || inFlight.current !== null) return;
    if (busy || !backend.available || state.status !== 'ready' || state.refreshing || state.error !== null) return;
    const current = state.profiles.find((item) => item.id === profile.id);
    if (current === undefined || keyOf(current) !== keyOf(profile)) return;
    startLock.current = true;
    // The lock survives this whole stack (including a backend that settles or throws synchronously)
    // and is released before any later user event can run.
    queueMicrotask(() => { startLock.current = false; });

    const requestId = crypto.randomUUID();
    const sentBackend = backend;
    const startedAt = Date.now();
    inFlight.current = { requestId, profileId: profile.id, backend: sentBackend };
    setTests((state2) => ({ ...state2, [profile.id]: { status: 'running', phase: 'waiting' } }));

    const take = (): boolean => {
      const active = inFlight.current;
      if (active === null || active.requestId !== requestId || active.profileId !== profile.id || !alive.current) return false;
      inFlight.current = null;
      return true;
    };
    let started: Promise<AiChatResponse>;
    try {
      started = sentBackend.chat({
        requestId,
        modelProfileId: profile.id,
        prompt: TEST_PROMPT,
        // No history and no apiKey: the backend resolves the saved credential for this exact target.
        authorization: {
          scope: 'conversation',
          protocol: profile.protocol,
          endpoint: profile.endpoint,
          modelId: profile.modelId,
        },
      }, (delta) => {
        // A delta for another request or target must never move this row into streaming.
        if (delta.requestId !== requestId || delta.modelProfileId !== profile.id) return;
        const active = inFlight.current;
        if (active === null || active.requestId !== requestId || !alive.current) return;
        setTests((state2) => state2[profile.id]?.status === 'running'
          ? { ...state2, [profile.id]: { status: 'running', phase: 'streaming' } } : state2);
      });
    } catch (failure) {
      started = Promise.reject(failure);
    }
    // Two-argument `then` keeps a backend that settles within this call (or throws synchronously)
    // from crashing the handler; a foreign or stale answer is discarded without touching this row.
    void started.then((response) => {
      if (!take()) return;
      const bound = response.requestId === requestId
        && response.modelProfileId === profile.id
        && response.protocol === profile.protocol
        && response.endpoint === profile.endpoint
        && response.modelId === profile.modelId;
      setTests((state2) => ({ ...state2, [profile.id]: bound
        ? verdict(response, Date.now() - startedAt)
        : { status: 'failed', code: 'aiTargetChanged', at: Date.now() } }));
    }, (failure) => {
      if (!take()) return;
      const code = aiErrorCode(failure);
      setTests((state2) => ({ ...state2, [profile.id]: code === 'cancelled'
        ? { status: 'cancelled', at: Date.now() }
        : { status: 'failed', code, at: Date.now() } }));
    });
  };

  const profiles = state.status === 'ready' ? state.profiles : [];
  const defaultModelId = state.status === 'ready' ? state.defaultModelId : null;
  const cleanupPending = state.status === 'ready' ? state.credentialCleanupPending : false;
  const refreshing = state.status === 'ready' ? state.refreshing : false;
  const visible = profiles.filter((profile) =>
    `${profile.displayName} ${profile.endpoint} ${profile.modelId}`.toLowerCase().includes(filter.trim().toLowerCase()));

  /** A rejected change keeps the list and reports the backend code; a deleted row is re-read. */
  const change = async (label: 'deleteFailed' | 'selectFailed', action: () => Promise<void>) => {
    setActionError(null);
    try {
      await action();
    } catch (failure) {
      const code = modelErrorCode(failure);
      setActionError(code === 'notFound' ? { label: 'notFound', code } : { label, code });
    }
  };

  const confirmRemove = async () => {
    if (!removing) return;
    await change('deleteFailed', async () => { await remove(removing.id); });
    setRemoving(null);
  };

  const retryCleanup = async () => {
    setCleanupError(null);
    try {
      await cleanup();
    } catch (failure) {
      setCleanupError(modelErrorCode(failure));
    }
  };

  /** A refresh cannot confirm the current rows, so a running test is stopped before the re-read. */
  const refresh = () => {
    cancelTest();
    reload();
  };

  /** Saving may change the tested target (or replace its key), so the old result is discarded first. */
  const saveProfile = async (input: ModelInput, id?: string, credential?: ModelCredentialChange) => {
    if (id !== undefined) invalidateTest(id);
    await save(input, id, credential);
  };

  const testBlocked = busy || refreshing || !backend.available
    || state.status !== 'ready' || (state.status === 'ready' && state.error !== null)
    || inFlight.current !== null;

  return <div className="models-page">
    {service.kind === 'session' ? <div className="notice models-notice" role="status">
      <Monitor size={16} /><span>{t('models:sessionNotice')}</span></div> : null}

    <div className="models-toolbar">
      <label className="models-filter">
        <Search size={15} />
        <input aria-label={t('models:filter')} placeholder={t('models:filter')} value={filter}
          onChange={(event) => setFilter(event.target.value)} />
      </label>
      <IconButton icon={RefreshCw} label={t('models:refresh')}
        disabled={busy || state.status === 'loading'} onClick={refresh} />
      <button type="button" className="primary" disabled={busy || state.status !== 'ready'}
        onClick={() => { setActionError(null); setEditing('new'); }}>
        <Plus size={15} />{t('models:add')}</button>
    </div>

    {state.status === 'loading' ? <p className="muted models-state" role="status">
      <LoaderCircle size={15} className="spin" />{t('models:loading')}</p> : null}

    {state.status === 'error' ? <div className="notice error models-state" role="alert">
      <TriangleAlert size={16} /><span>{t('models:loadFailed')} {modelFailureText(t, state.code)}</span>
      <button type="button" className="secondary" onClick={refresh}>{t('retry')}</button></div> : null}

    {state.status === 'ready' ? <>
      {state.error ? <div className="notice warning models-state" role="alert">
        <TriangleAlert size={16} /><span>{t('models:refreshFailed')} {modelFailureText(t, state.error)}</span>
        <button type="button" className="secondary" onClick={refresh}>{t('retry')}</button></div> : null}
      {actionError ? <div className="notice error models-state" role="alert">
        <TriangleAlert size={16} /><span>{t(`models:${actionError.label}`)}
          {actionError.label === 'notFound' ? '' : ` ${modelFailureText(t, actionError.code)}`}</span></div> : null}
      {cleanupPending ? <div className="notice warning models-notice" role="alert">
        <KeyRound size={16} /><span>{t('models:cleanupPending')}</span>
        <button type="button" className="secondary compact-button" disabled={busy}
          onClick={() => void retryCleanup()}>{t('models:cleanupRetry')}</button></div> : null}
      {cleanupError ? <div className="notice error models-notice" role="alert">
        <TriangleAlert size={16} /><span>{t('models:cleanupFailed')} {modelFailureText(t, cleanupError)}</span></div> : null}

      <div className="subheading muted">{t('models:profileCount', { count: profiles.length })}</div>

      {profiles.length === 0 ? <EmptyState icon={Sparkles} title={t('models:empty')} description={t('models:emptyDetail')}>
        <button type="button" className="secondary" disabled={busy} onClick={() => setEditing('new')}>
          <Plus size={15} />{t('models:add')}</button>
      </EmptyState> : visible.length === 0 ? <p className="muted models-state">{t('noMatches')}</p> : <ul className="model-list">
        {visible.map((profile) => {
          const isDefault = profile.id === defaultModelId;
          const test = tests[profile.id];
          const runningThis = test?.status === 'running' && inFlight.current?.profileId === profile.id;
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
                {test?.status === 'passed'
                  ? <span className="model-badge success">{t('models:testPassed')}</span>
                  : <span className="model-badge warn">{t('models:notVerified')}</span>}
              </div>
              <span className="endpoint model-endpoint">{profile.endpoint}</span>
              <span className="model-id muted">{t('models:modelId')} <code>{profile.modelId}</code></span>
              <span className={`model-key-status${profile.hasApiKey ? '' : ' muted'}`}
                title={profile.hasApiKey ? t('models:keyConfigured') : t('models:keyNone')}>
                <KeyRound size={12} />{profile.hasApiKey ? t('models:keyConfigured') : t('models:keyNone')}</span>
              {test ? <div className="model-test">
                {test.status === 'running' ? <>
                  <LoaderCircle size={13} className="spin" />
                  <span role="status">{t(test.phase === 'waiting' ? 'models:testRunning' : 'models:testStreaming')}</span>
                </> : null}
                {test.status === 'passed' ? <>
                  <CheckCircle2 size={13} className="model-test-ok" />
                  <span className="muted">{t('models:testLatency', { value: test.latencyMs })}</span>
                  <span className="muted">{test.actualModelId === null
                    ? t('models:testActualUnknown') : t('models:testActualModel', { id: test.actualModelId })}</span>
                  <span className="muted">{t('models:testAt', { time: formatTime(test.at) })}</span>
                </> : null}
                {test.status === 'failed' ? <>
                  <TriangleAlert size={13} className="model-test-fail" />
                  <span role="alert">{t('models:testFailed')} {modelFailureText(t, test.code)}</span>
                  <IconButton icon={RotateCcw} label={t('models:testRetry')} disabled={testBlocked}
                    onClick={() => startTest(profile)} />
                </> : null}
                {test.status === 'cancelled' ? <>
                  <span className="muted">{t('models:testCancelled')}</span>
                  <IconButton icon={RotateCcw} label={t('models:testRetry')} disabled={testBlocked}
                    onClick={() => startTest(profile)} />
                </> : null}
              </div> : null}
              {test?.status === 'passed' ? <p className="model-test-reply">{test.reply}</p> : null}
            </div>
            <div className="model-actions">
              {runningThis
                ? <IconButton icon={Square} label={t('models:testCancel')} onClick={cancelTest} />
                : <IconButton icon={FlaskConical}
                  label={backend.available ? t('models:test') : t('models:testDesktopOnly')}
                  disabled={testBlocked} onClick={() => startTest(profile)} />}
              <IconButton icon={Pencil} label={t('models:edit')} disabled={busy}
                onClick={() => { setActionError(null); invalidateTest(profile.id); setEditing(profile); }} />
              <IconButton icon={Trash2} label={t('delete')} disabled={busy}
                onClick={() => { setActionError(null); invalidateTest(profile.id); setRemoving(profile); }} />
            </div>
          </li>;
        })}
      </ul>}
    </> : null}

    <ModelEditor key={editing === 'new' ? 'new' : editing?.id ?? 'closed'} value={editing} service={service}
      busy={busy} onClose={() => { if (!busy) setEditing(null); }} onSave={saveProfile} />

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
