import {
  ArrowDown, ChevronDown, Copy, FileCode, LoaderCircle, Monitor, Paperclip, RefreshCw,
  RotateCcw, Send, Settings2, Sparkles, Square, Trash2, TriangleAlert, X,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState, IconButton, Modal, SelectControl } from '../../components/controls';
import {
  MAX_AI_CONTEXT_BYTES, MAX_AI_HISTORY_MESSAGES, MAX_AI_PROMPT_BYTES, MAX_AI_TURNS,
  type AiChatBackend, type AiChatMessage, type AiChatOutcome, type AiChatRequest, type AiChatResponse,
} from '../../domain/ai-chat';
import type { ModelProfile } from '../../domain/models';
import type { QueryDocument } from '../../domain/query';
import { aiErrorCode, desktopAiChatBackend, utf8ByteLength } from '../../services/ai-chat';
import type { ModelService } from '../../services/models';
import { useCopyText } from '../query/useCopyText';
import { AiMarkdown } from './AiMarkdown';
import { aiFailureText } from './error-text';
import '../../styles/ai-chat.css';

interface Props {
  /** Model profile persistence; the app passes the service it already created for settings. */
  modelService: ModelService;
  /** Injectable seam for tests; the default is the desktop IPC, which is unsupported in the browser. */
  backend?: AiChatBackend;
  /** The current query draft the attach tool may freeze; the panel never reads anything else. */
  query?: QueryDocument | null;
  /** Panel visibility. Drafts, attachments and transcripts are kept while hidden. */
  open: boolean;
  /** False while the query workspace is covered by settings; a running request is cancelled. */
  active: boolean;
  onClose: () => void;
  onSettings: () => void;
}

type ProfilesState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly code: string }
  | {
    readonly status: 'ready';
    readonly profiles: readonly ModelProfile[];
    readonly defaultModelId: string | null;
    /** Last re-read failure; the list stays visible but new sends are disabled. */
    readonly stale: string | null;
    /** A re-read is in flight; the visible list is not yet confirmed, so sending stays disabled. */
    readonly refreshing: boolean;
  };

/** The exact saved target a request is frozen against; the conversation belongs to this identity. */
interface FrozenTarget {
  readonly id: string;
  readonly displayName: string;
  readonly protocol: ModelProfile['protocol'];
  readonly endpoint: string;
  readonly modelId: string;
  readonly hasApiKey: boolean;
}

/** A byte-exact copy of the query draft, taken only when the user attaches it. */
interface QueryAttachment {
  readonly queryId: string;
  readonly connectionId: string;
  readonly revision: number;
  readonly name: string;
  readonly index: string;
  readonly dsl: string;
}

type TurnStatus = 'running' | AiChatOutcome | 'cancelled' | 'error';

/** One exchange in the in-memory transcript; the wire prompt is what later history replays. */
interface ChatTurn {
  readonly id: string;
  readonly requestId: string;
  readonly target: FrozenTarget;
  readonly requestedAt: number;
  /** Exactly what the user typed, rendered apart from the attachment. */
  readonly userText: string;
  readonly attachment: QueryAttachment | null;
  /** Exactly what was sent as `prompt`, including the serialized attachment. */
  readonly prompt: string;
  /** The exact history sent with this attempt; kept only while the turn can still be retried. */
  readonly history: readonly AiChatMessage[];
  /** True when earlier complete exchanges were left out of this attempt's history. */
  readonly historyTrimmed: boolean;
  readonly text: string;
  readonly actualModelId: string | null;
  readonly status: TurnStatus;
  readonly error: string | null;
}

/** Everything the composer and transcript for one target keep; nothing here is persisted. */
interface TargetConversation {
  readonly draft: string;
  readonly attachment: QueryAttachment | null;
  readonly turns: readonly ChatTurn[];
}

interface InFlight {
  readonly key: string;
  readonly turnId: string;
  readonly requestId: string;
  readonly modelProfileId: string;
  /** The backend this request was started with; cancellation must not go through a replacement. */
  readonly backend: AiChatBackend;
}

const EMPTY_CONVERSATION: TargetConversation = { draft: '', attachment: null, turns: [] };

/** Bounds drafts and attachments kept for targets that are not the selected one. */
const MAX_TARGET_RECORDS = 12;

/** Identity a conversation is isolated by: same profile, protocol, endpoint, model and key state. */
function targetKey(target: { id: string; protocol: ModelProfile['protocol']; endpoint: string; modelId: string; hasApiKey: boolean }): string {
  return [target.id, target.protocol, target.endpoint, target.modelId, target.hasApiKey ? '1' : '0'].join('\u0000');
}

function freeze(profile: ModelProfile): FrozenTarget {
  return {
    id: profile.id,
    displayName: profile.displayName,
    protocol: profile.protocol,
    endpoint: profile.endpoint,
    modelId: profile.modelId,
    hasApiKey: profile.hasApiKey,
  };
}

function freezeQuery(query: QueryDocument): QueryAttachment {
  return {
    queryId: query.id,
    connectionId: query.connectionId ?? '',
    revision: query.revision,
    name: query.name,
    index: query.index,
    dsl: query.dsl,
  };
}

/**
 * The outgoing prompt: the exact typed text plus the frozen attachment as plain text — verbatim
 * DSL, name and index only. Never a connection/query id, endpoint, credential or result; the DSL
 * is opaque bytes here, not parsed JSON.
 */
function buildPrompt(userText: string, attachment: QueryAttachment | null): string {
  if (attachment === null) return userText;
  const lines = ['Attached query draft'];
  if (attachment.name.trim() !== '') lines.push(`Name: ${attachment.name}`);
  if (attachment.index.trim() !== '') lines.push(`Index: ${attachment.index}`);
  lines.push('DSL:', attachment.dsl);
  const serialized = lines.join('\n');
  return userText.trim() === '' ? serialized : `${userText}\n\n${serialized}`;
}

/**
 * Earlier complete user/assistant pairs, oldest dropped first, bounded to the message count and
 * to the combined prompt+history byte budget. Cancelled, failed and incomplete exchanges are
 * never replayed, and every content string stays byte-exact. `trimmed` reports whether any
 * complete exchange was left out, so the turn can say so instead of implying all history went.
 */
function buildHistory(turns: readonly ChatTurn[], promptBytes: number): { messages: AiChatMessage[]; trimmed: boolean } {
  const pairs: AiChatMessage[][] = [];
  for (const turn of turns) {
    if (turn.status !== 'complete' || turn.text.trim() === '') continue;
    pairs.push([
      { role: 'user', content: turn.prompt },
      { role: 'assistant', content: turn.text },
    ]);
  }
  const recent = pairs.slice(-(MAX_AI_HISTORY_MESSAGES / 2));
  const size = (pair: AiChatMessage[]) => utf8ByteLength(pair[0]!.content) + utf8ByteLength(pair[1]!.content);
  let bytes = promptBytes + recent.reduce((sum, pair) => sum + size(pair), 0);
  let first = 0;
  while (first < recent.length && bytes > MAX_AI_CONTEXT_BYTES) {
    bytes -= size(recent[first]!);
    first += 1;
  }
  return { messages: recent.slice(first).flat(), trimmed: first > 0 || recent.length < pairs.length };
}

/** Global transcript cap: the oldest turn of the least recent target is dropped first. */
function boundTurns(store: ReadonlyMap<string, TargetConversation>): ReadonlyMap<string, TargetConversation> {
  let total = 0;
  for (const conversation of store.values()) total += conversation.turns.length;
  if (total <= MAX_AI_TURNS) return store;
  const next = new Map(store);
  while (total > MAX_AI_TURNS) {
    let pick: { key: string; turn: ChatTurn } | null = null;
    for (const [key, conversation] of next) {
      const first = conversation.turns[0];
      if (first === undefined) continue;
      if (pick === null || first.requestedAt < pick.turn.requestedAt) pick = { key, turn: first };
    }
    if (pick === null) break;
    const conversation = next.get(pick.key)!;
    next.set(pick.key, { ...conversation, turns: conversation.turns.slice(1) });
    total -= 1;
  }
  return next;
}

/** Record cap: evict the least recently used target, never the one being written or running. */
function boundRecords(
  store: ReadonlyMap<string, TargetConversation>, keepKey: string, runningKey: string | null,
): ReadonlyMap<string, TargetConversation> {
  if (store.size <= MAX_TARGET_RECORDS) return store;
  let next = store;
  for (const key of store.keys()) {
    if (next.size <= MAX_TARGET_RECORDS) break;
    if (key === keepKey || key === runningKey) continue;
    const copy = new Map(next);
    copy.delete(key);
    next = copy;
  }
  return next;
}

/** A removable attachment with the frozen snapshot one click away; no remove tool on sent turns. */
const AttachmentView = memo(function AttachmentView({ attachment, onRemove }:
  { attachment: QueryAttachment; onRemove?: () => void }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const name = attachment.name.trim() !== '' ? attachment.name : t('aiChat:attachmentUntitled');
  return <div className="ai-attachment">
    <div className="ai-attachment-head">
      <FileCode size={14} />
      <span className="ai-attachment-name" title={name}>{name}</span>
      {attachment.index.trim() !== '' ? <span className="ai-chip" title={attachment.index}>{attachment.index}</span> : null}
      <span className="ai-attachment-spacer" />
      <IconButton icon={ChevronDown} label={t('aiChat:attachmentSnapshot')} aria-pressed={expanded}
        onClick={() => setExpanded((value) => !value)} />
      {onRemove ? <IconButton icon={X} label={t('aiChat:attachmentRemove')} onClick={onRemove} /> : null}
    </div>
    {expanded ? <div className="ai-attachment-body">
      <dl className="ai-attachment-meta">
        <dt>{t('aiChat:attachmentName')}</dt><dd>{attachment.name || '-'}</dd>
        <dt>{t('aiChat:attachmentIndex')}</dt><dd>{attachment.index || '-'}</dd>
        <dt>{t('aiChat:attachmentQueryId')}</dt><dd>{attachment.queryId}</dd>
        <dt>{t('aiChat:attachmentConnectionId')}</dt><dd>{attachment.connectionId || '-'}</dd>
        <dt>{t('aiChat:attachmentRevision')}</dt><dd>{attachment.revision}</dd>
      </dl>
      <pre className="ai-attachment-dsl">{attachment.dsl}</pre>
    </div> : null}
  </div>;
});

/**
 * Memoized so a streaming chunk or a keystroke in the composer only re-renders the turn that
 * changed; earlier Markdown trees are not parsed again.
 */
const TurnCard = memo(function TurnCard({ turn, isLast, formatTime, onRetry }:
  { turn: ChatTurn; isLast: boolean; formatTime: (value: number) => string; onRetry: (turn: ChatTurn) => void }) {
  const { t } = useTranslation();
  const { status: copyStatus, copy } = useCopyText();
  const partial = turn.text !== '' && (turn.status === 'error' || turn.status === 'cancelled');
  return <article className="ai-turn">
    <div className="ai-turn-head">
      <span className="ai-turn-role">{t('aiChat:you')}</span>
      <time className="ai-turn-time" dateTime={new Date(turn.requestedAt).toISOString()}>
        {formatTime(turn.requestedAt)}</time>
    </div>
    {turn.userText !== '' ? <p className="ai-turn-prompt">{turn.userText}</p> : null}
    {turn.attachment !== null ? <AttachmentView attachment={turn.attachment} /> : null}
    <div className="ai-turn-head">
      <span className="ai-turn-model" title={turn.target.modelId}>{turn.target.displayName}</span>
      <span className="ai-chip">{t(turn.target.protocol === 'ollama' ? 'models:protocolOllama' : 'models:protocolOpenaiCompatible')}</span>
      {turn.status !== 'running' ? <span className="ai-turn-actual muted">
        {turn.actualModelId === null
          ? t('aiChat:actualModelNotReported')
          : t('aiChat:actualModel', { id: turn.actualModelId })}</span> : null}
    </div>
    {turn.text !== '' ? <div className="ai-turn-text ai-md"><AiMarkdown content={turn.text} /></div> : null}
    <div className="ai-turn-status">
      {turn.status === 'running' ? <span className="ai-chip" role="status">
        <LoaderCircle size={12} className="spin" />
        {turn.text === '' ? t('aiChat:waiting') : t('aiChat:streaming')}</span> : null}
      {turn.status === 'complete' ? <span className="ai-chip success">{t('aiChat:completed')}</span> : null}
      {turn.status === 'length' ? <span className="ai-chip partial">{t('aiChat:truncated')}</span> : null}
      {turn.status === 'filtered' ? <span className="ai-chip partial">{t('aiChat:filtered')}</span> : null}
      {turn.status === 'cancelled' ? <span className="ai-chip cancelled">{t('aiChat:cancelled')}</span> : null}
      {turn.status === 'error' ? <span className="ai-chip failed">{t('aiChat:failed')}</span> : null}
      {turn.historyTrimmed ? <span className="ai-chip">{t('aiChat:historyTrimmed')}</span> : null}
      {turn.status === 'error'
        ? <span className="ai-turn-note failed">{aiFailureText(t, turn.error ?? 'aiProviderError')}</span> : null}
      {turn.status === 'cancelled' ? <span className="ai-turn-note">{t('aiChat:cancelledDetail')}</span> : null}
      {turn.status === 'length' ? <span className="ai-turn-note">{t('aiChat:truncatedDetail')}</span> : null}
      {turn.status === 'filtered' ? <span className="ai-turn-note">{t('aiChat:filteredDetail')}</span> : null}
      {partial ? <span className="ai-turn-note">{t('aiChat:incompleteText')}</span> : null}
    </div>
    {turn.status !== 'running' ? <div className="ai-turn-foot">
      <div className="ai-turn-actions">
        {turn.text !== '' ? <IconButton icon={Copy} label={t('aiChat:copyReply')} onClick={() => copy(turn.text)} /> : null}
        {turn.status === 'error' && isLast
          ? <IconButton icon={RotateCcw} label={t('aiChat:retryReply')} onClick={() => onRetry(turn)} /> : null}
        {copyStatus !== 'idle' ? <span className={`ai-copy-note ${copyStatus}`} role="status">
          {t(copyStatus === 'copied' ? 'queryLive:copied' : 'queryLive:copyFailed')}</span> : null}
      </div>
    </div> : null}
  </article>;
});

/**
 * AI side panel: direct, multi-turn chat against one explicitly selected model profile.
 *
 * Enter or the send button starts the request immediately — there is no review dialog. The panel
 * sends the typed text plus, only when the user attached it with the paperclip, a byte-exact
 * snapshot of the current query draft (name, index and DSL as plain text). Conversations, drafts
 * and attachments are kept per target identity in memory for this session and are bounded; a
 * target change (selection or metadata) cancels a running request through the backend it started
 * with and never moves content across. Only complete exchanges are replayed as history, each
 * attempt caches the exact history it was sent with for retry, and a delayed, cancelled or
 * foreign response can never overwrite a result. The saved API key of the selected profile is
 * used by the backend; the panel never asks for or stores a key.
 */
export function AiChatPanel({ modelService, backend = desktopAiChatBackend, query = null, open, active, onClose, onSettings }: Props) {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<ProfilesState>({ status: 'loading' });
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [store, setStore] = useState<ReadonlyMap<string, TargetConversation>>(() => new Map());
  const [running, setRunning] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [following, setFollowing] = useState(true);

  const serviceRef = useRef(modelService);
  serviceRef.current = modelService;
  const alive = useRef(true);
  const loadToken = useRef(0);
  const inFlight = useRef<InFlight | null>(null);
  /** Blocks a second send in the same frame even when the backend settles synchronously. */
  const sending = useRef(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const stick = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  /** Re-read the stored profiles. The loaded list stays visible when a re-read fails, but sends stop. */
  const load = useCallback(() => {
    const token = ++loadToken.current;
    setProfiles((current) => current.status === 'ready'
      ? { ...current, refreshing: true }
      : { status: 'loading' });
    void (async () => {
      try {
        const loaded = await serviceRef.current.load();
        if (!alive.current || token !== loadToken.current) return;
        setProfiles({
          status: 'ready', profiles: loaded.profiles, defaultModelId: loaded.defaultModelId,
          stale: null, refreshing: false,
        });
      } catch (failure) {
        if (!alive.current || token !== loadToken.current) return;
        const code = aiErrorCode(failure);
        setProfiles((current) => current.status === 'ready'
          ? { ...current, stale: code, refreshing: false }
          : { status: 'error', code });
      }
    })();
  }, []);

  // Metadata loads only while the panel is visible in the workspace, and reloads when the user
  // returns from settings or the service is replaced; a newer read discards the older one.
  // Generation itself never starts here.
  useEffect(() => {
    if (!open || !active || !backend.available) return;
    load();
  }, [open, active, backend.available, modelService, load]);

  /** Stop the local request through the backend it was started with; late events are ignored. */
  const cancelLocal = useCallback((notifyBackend: boolean) => {
    const current = inFlight.current;
    if (!current) return;
    inFlight.current = null;
    setRunning(false);
    setStore((previous) => {
      const conversation = previous.get(current.key);
      if (!conversation) return previous;
      const next = new Map(previous);
      next.set(current.key, {
        ...conversation,
        turns: conversation.turns.map((turn) => turn.id === current.turnId && turn.status === 'running'
          ? { ...turn, status: 'cancelled' } : turn),
      });
      return next;
    });
    if (notifyBackend) {
      void current.backend.cancel({ requestId: current.requestId, modelProfileId: current.modelProfileId })
        .catch(() => undefined);
    }
  }, []);

  const cancelRef = useRef(cancelLocal);
  cancelRef.current = cancelLocal;
  // Hiding the panel or leaving the workspace cancels the running request, dismisses the portaled
  // clear dialog and discards a metadata read from the previous visibility state; unmount does the
  // same. Drafts, attachments and transcripts stay in memory, and reopening never resumes a request.
  useEffect(() => {
    if (open && active) return;
    loadToken.current += 1;
    setClearing(false);
    cancelRef.current(true);
  }, [open, active]);
  useEffect(() => () => {
    cancelRef.current(true);
  }, []);

  const list = profiles.status === 'ready' ? profiles.profiles : [];
  const stale = profiles.status === 'ready' ? profiles.stale : null;
  const refreshing = profiles.status === 'ready' ? profiles.refreshing : false;
  const selected = list.find((profile) => profile.id === chosenId)
    ?? list.find((profile) => profile.id === (profiles.status === 'ready' ? profiles.defaultModelId : null))
    // Mirrors the stored-default rule: no valid default means the first profile, so a visible
    // selector and the request target can never disagree and send is never bound to no target.
    ?? list[0]
    ?? null;
  const selectedKey = selected === null ? null : targetKey(selected);
  const conversation = (selectedKey !== null ? store.get(selectedKey) : undefined) ?? EMPTY_CONVERSATION;
  const draft = conversation.draft;
  const attachment = conversation.attachment;
  const effectivePrompt = useMemo(() => buildPrompt(draft, attachment), [draft, attachment]);
  const promptBytes = utf8ByteLength(effectivePrompt);
  const hasContent = draft.trim() !== '' || attachment !== null;
  const tooLarge = hasContent && promptBytes > MAX_AI_PROMPT_BYTES;
  const formatTime = useMemo(() => {
    const format = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
    return (value: number) => format.format(value);
  }, []);

  const followTail = useCallback(() => {
    stick.current = true;
    setFollowing(true);
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, []);

  // A restored conversation opens at its latest message; autoscroll afterwards only while the
  // reader is already near the bottom.
  useEffect(() => {
    if (!open) return;
    followTail();
  }, [selectedKey, open, followTail]);

  // A selection or metadata change rebinds the panel to another target: a request started against
  // the previous identity is cancelled (its partial text stays marked), and the destructive clear
  // dialog never applies to a target the user is no longer looking at.
  useEffect(() => {
    setClearing(false);
    const current = inFlight.current;
    if (current && current.key !== selectedKey) cancelRef.current(true);
  }, [selectedKey]);

  const tail = conversation.turns[conversation.turns.length - 1];
  const transcriptSignal = `${conversation.turns.length}:${tail?.text.length ?? 0}:${tail?.status ?? 'none'}`;
  useEffect(() => {
    if (!open || !stick.current) return;
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [transcriptSignal, open]);

  /** One store mutation; `create` allows the first draft/attachment record for a target. */
  const apply = useCallback((key: string, change: (conversation: TargetConversation) => TargetConversation, create: boolean) => {
    setStore((previous) => {
      const current = previous.get(key);
      if (current === undefined && !create) return previous;
      const next = new Map(previous);
      next.delete(key);
      next.set(key, change(current ?? EMPTY_CONVERSATION));
      return boundRecords(next, key, inFlight.current?.key ?? null);
    });
  }, []);
  const commit = useCallback((key: string, change: (conversation: TargetConversation) => TargetConversation) => apply(key, change, false), [apply]);
  const commitNew = useCallback((key: string, change: (conversation: TargetConversation) => TargetConversation) => apply(key, change, true), [apply]);

  const updateTurn = useCallback((key: string, turnId: string, change: (turn: ChatTurn) => ChatTurn) => {
    commit(key, (conversation) => ({
      ...conversation,
      turns: conversation.turns.map((turn) => turn.id === turnId ? change(turn) : turn),
    }));
  }, [commit]);

  /**
   * Commit one attempt: append a new turn — consuming the draft and attachment atomically — or
   * replace a failed one in place for a retry. Guards run synchronously; the same-frame lock also
   * covers a backend that settles within `chat`.
   */
  const startAttempt = useCallback((options: {
    key: string; target: FrozenTarget; prompt: string; userText: string;
    attachment: QueryAttachment | null; replaceId: string | null; cached?: { messages: readonly AiChatMessage[]; trimmed: boolean };
  }) => {
    if (sending.current || inFlight.current) return;
    sending.current = true;
    void Promise.resolve().then(() => { sending.current = false; });
    const { key, target, prompt, userText, attachment: frozen, replaceId, cached } = options;
    const requestId = crypto.randomUUID();
    const turnId = replaceId ?? crypto.randomUUID();
    const resolved = cached ?? buildHistory(
      store.get(key)?.turns ?? [],
      utf8ByteLength(prompt),
    );
    const turn: ChatTurn = {
      id: turnId, requestId, target, requestedAt: Date.now(), userText, attachment: frozen, prompt,
      history: resolved.messages, historyTrimmed: resolved.trimmed,
      text: '', actualModelId: null, status: 'running', error: null,
    };
    inFlight.current = { key, turnId, requestId, modelProfileId: target.id, backend };
    setStore((previous) => {
      const current = previous.get(key) ?? EMPTY_CONVERSATION;
      const turns = replaceId === null
        // A new exchange makes the previous last turn non-retryable, so its cached history goes.
        ? [...current.turns.map((item) => item.history.length === 0 ? item : { ...item, history: [] }), turn]
        : current.turns.map((item) => item.id === replaceId ? turn : item);
      const next = new Map(previous);
      next.delete(key);
      next.set(key, {
        draft: replaceId === null ? '' : current.draft,
        attachment: replaceId === null ? null : current.attachment,
        turns,
      });
      const bounded = boundTurns(next);
      return boundRecords(bounded, key, inFlight.current?.key ?? null);
    });
    setRunning(true);

    const request: AiChatRequest = {
      requestId,
      modelProfileId: target.id,
      prompt,
      authorization: {
        scope: 'conversation', protocol: target.protocol, endpoint: target.endpoint, modelId: target.modelId,
      },
    };
    if (resolved.messages.length > 0) request.history = resolved.messages;

    let started: Promise<AiChatResponse>;
    try {
      started = backend.chat(request, (delta) => {
        const current = inFlight.current;
        if (!current || current.requestId !== requestId || delta.requestId !== requestId
          || delta.modelProfileId !== current.modelProfileId) return;
        updateTurn(key, turnId, (item) => ({ ...item, text: item.text + delta.text }));
      });
    } catch (failure) {
      started = Promise.reject(failure);
    }
    // Two-argument `then` handles both outcomes without chaining, so a backend that settles within
    // this call (or returns a bare thenable) still cannot crash the handler or double-start a request.
    void started.then((response) => {
      const current = inFlight.current;
      if (!current || current.requestId !== requestId) return;
      inFlight.current = null;
      setRunning(false);
      const outcomeValid = response.outcome === 'complete' || response.outcome === 'length' || response.outcome === 'filtered';
      const identityMatches = response.requestId === requestId
        && response.modelProfileId === target.id
        && response.protocol === target.protocol
        && response.endpoint === target.endpoint
        && response.modelId === target.modelId;
      // An injected backend can violate the wire contract the IPC path enforces; a mismatched or
      // empty answer is marked as failed instead of being shown as a blank completed turn.
      if (!identityMatches || !outcomeValid) {
        updateTurn(key, turnId, (item) => ({ ...item, status: 'error', error: 'aiUnsupportedResponse' }));
        return;
      }
      if (response.outcome === 'complete' && response.text.trim() === '') {
        updateTurn(key, turnId, (item) => ({ ...item, status: 'error', error: 'aiEmptyReply' }));
        return;
      }
      updateTurn(key, turnId, (item) => ({
        ...item, text: response.text, actualModelId: response.actualModelId, status: response.outcome, error: null,
      }));
    }, (failure) => {
      const current = inFlight.current;
      if (!current || current.requestId !== requestId) return;
      inFlight.current = null;
      setRunning(false);
      const code = aiErrorCode(failure);
      updateTurn(key, turnId, (item) => ({
        ...item, status: code === 'cancelled' ? 'cancelled' : 'error', error: code,
      }));
    });
  }, [backend, store, updateTurn]);

  /** Send the current draft immediately; no review, no dialog, no automatic retry. */
  const send = () => {
    if (!open || !active || !backend.available || inFlight.current || sending.current) return;
    if (profiles.status !== 'ready' || profiles.refreshing || profiles.stale !== null) return;
    if (selected === null || selectedKey === null) return;
    const prompt = buildPrompt(draft, attachment);
    if (prompt.trim() === '' || utf8ByteLength(prompt) > MAX_AI_PROMPT_BYTES) return;
    startAttempt({ key: selectedKey, target: freeze(selected), prompt, userText: draft, attachment, replaceId: null });
    // Every new send is a deliberate move to the end of the transcript, even after scrolling up.
    followTail();
    composerRef.current?.focus();
  };

  /** Retry only the failed last turn with its exact prompt/attachment/history and a fresh request id. */
  const retryRef = useRef<(turn: ChatTurn) => void>(() => {});
  retryRef.current = (turn: ChatTurn) => {
    if (!open || !active || !backend.available || inFlight.current || sending.current) return;
    if (profiles.status !== 'ready' || profiles.refreshing || profiles.stale !== null) return;
    if (selectedKey === null) return;
    const turns = conversation.turns;
    if (turns[turns.length - 1]?.id !== turn.id) return;
    startAttempt({
      key: selectedKey, target: turn.target, prompt: turn.prompt, userText: turn.userText,
      attachment: turn.attachment, replaceId: turn.id,
      cached: { messages: turn.history, trimmed: turn.historyTrimmed },
    });
  };
  const handleRetry = useCallback((turn: ChatTurn) => retryRef.current(turn), []);

  const attach = useCallback(() => {
    if (query === null || selectedKey === null) return;
    const frozen = freezeQuery(query);
    commitNew(selectedKey, (current) => ({ ...current, attachment: frozen }));
  }, [query, selectedKey, commitNew]);

  const detach = useCallback(() => {
    if (selectedKey === null) return;
    commitNew(selectedKey, (current) => ({ ...current, attachment: null }));
  }, [selectedKey, commitNew]);

  const clearConversation = () => {
    cancelLocal(true);
    if (selectedKey !== null) {
      commit(selectedKey, (current) => ({ ...current, turns: [] }));
    }
    setClearing(false);
  };

  const ready = profiles.status === 'ready';
  const canSend = open && active && backend.available && ready && !refreshing && stale === null
    && selected !== null && hasContent && !tooLarge && !running;

  return <aside id="workspace-ai" className="ai-sidebar" aria-label={t('query:ai')} hidden={!open}>
    <div className="sidebar-heading"><span><Sparkles size={16} />{t('query:ai')}</span>
      <div className="ai-heading-actions">
        {conversation.turns.length > 0
          ? <IconButton icon={Trash2} label={t('aiChat:clear')} onClick={() => setClearing(true)} /> : null}
        <IconButton icon={X} label={t('close')} onClick={onClose} />
      </div>
    </div>

    {!backend.available ? <EmptyState icon={Monitor} title={t('aiChat:desktopOnly')}
      description={t('aiChat:desktopOnlyDetail')}>
      <button type="button" className="secondary" onClick={onSettings}>
        <Settings2 size={15} />{t('query:configureAI')}</button>
    </EmptyState> : null}

    {backend.available && profiles.status === 'loading'
      ? <p className="ai-state muted" role="status"><LoaderCircle size={15} className="spin" />{t('aiChat:loading')}</p>
      : null}

    {backend.available && profiles.status === 'error' ? <div className="notice error ai-notice" role="alert">
      <TriangleAlert size={16} /><span>{t('aiChat:loadFailed')} {aiFailureText(t, profiles.code)}</span>
      <IconButton icon={RefreshCw} label={t('retry')} onClick={load} />
    </div> : null}

    {backend.available && ready && list.length === 0 ? <EmptyState icon={Sparkles}
      title={t('query:aiEmpty')} description={t('aiChat:emptyModelDetail')}>
      <button type="button" className="secondary" onClick={onSettings}>
        <Settings2 size={15} />{t('query:configureAI')}</button>
    </EmptyState> : null}

    {backend.available && ready && list.length > 0 ? <>
      <div className="ai-body-wrap">
        <div className="ai-body" ref={bodyRef} onScroll={(event) => {
          const node = event.currentTarget;
          const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= 24;
          stick.current = nearBottom;
          setFollowing((current) => current === nearBottom ? current : nearBottom);
        }}>
          {stale !== null ? <div className="notice warning ai-notice" role="alert"><TriangleAlert size={16} />
            <span>{t('aiChat:stale')} {aiFailureText(t, stale)}</span>
            <IconButton icon={RefreshCw} label={t('retry')} disabled={refreshing} onClick={load} /></div> : null}
          <div className="ai-turns">
            {conversation.turns.length === 0 ? <p className="muted small">{t('aiChat:emptyTranscript')}</p>
              : conversation.turns.map((turn, index) => <TurnCard key={turn.id} turn={turn} formatTime={formatTime}
                isLast={index === conversation.turns.length - 1} onRetry={handleRetry} />)}
          </div>
        </div>
        {conversation.turns.length > 0 && !following
          ? <IconButton icon={ArrowDown} label={t('aiChat:scrollToLatest')} className="ai-jump" onClick={followTail} />
          : null}
      </div>

      <div className="ai-composer">
        {tooLarge ? <div className="notice error ai-notice" role="alert"><TriangleAlert size={15} />
          <span>{t('aiChat:promptTooLarge')}</span></div> : null}
        <div className="ai-composer-target">
          <SelectControl className="ai-composer-model" aria-label={t('aiChat:model')}
            title={selected === null ? undefined : selected.modelId}
            value={selected?.id ?? ''}
            onChange={(event) => { cancelLocal(true); setChosenId(event.target.value); }}>
            {list.map((profile) => <option key={profile.id} value={profile.id} title={profile.modelId}>{profile.displayName}</option>)}
          </SelectControl>
          {selected && selected.endpoint.toLowerCase().startsWith('http://')
            ? <span className="ai-chip warning" title={t('aiChat:httpWarning')}>{t('aiChat:httpChip')}</span>
            : null}
          {refreshing ? <span className="ai-chip" role="status">
            <LoaderCircle size={12} className="spin" />{t('aiChat:refreshing')}</span> : null}
          <IconButton icon={RefreshCw} label={t('aiChat:refresh')} disabled={refreshing} onClick={load} />
          <IconButton icon={Settings2} label={t('query:configureAI')} onClick={onSettings} />
        </div>
        {attachment !== null ? <div className="ai-attachment-row">
          <AttachmentView attachment={attachment} onRemove={detach} /></div> : null}
        <div className="ai-composer-surface">
          <textarea ref={composerRef} className="ai-composer-input" aria-label={t('aiChat:composer')}
            placeholder={t('aiChat:composerPlaceholder')} value={draft}
            onChange={(event) => {
              const value = event.target.value;
              if (selectedKey === null) return;
              commitNew(selectedKey, (current) => ({ ...current, draft: value }));
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key !== 'Enter' || event.shiftKey || event.altKey) return;
              event.preventDefault();
              if (event.repeat) return;
              if (document.querySelector('[role="dialog"]')) return;
              send();
            }} />
          <div className="ai-composer-foot">
            {attachment === null
              ? <IconButton icon={Paperclip} label={query === null ? t('aiChat:attachUnavailable') : t('aiChat:attach')}
                disabled={query === null} onClick={attach} />
              : null}
            <span className="ai-composer-spacer" />
            {running
              ? <IconButton icon={Square} label={t('aiChat:stop')} onClick={() => cancelLocal(true)} />
              : <IconButton icon={Send} label={t('aiChat:send')} disabled={!canSend} onClick={send} />}
          </div>
        </div>
      </div>
    </> : null}

    <Modal open={clearing} onClose={() => setClearing(false)} title={t('aiChat:clearTitle')}
      description={t('aiChat:clearDetail')}>
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={() => setClearing(false)}>{t('cancel')}</button>
        <button type="button" className="danger" onClick={clearConversation}>{t('clear')}</button>
      </div>
    </Modal>
  </aside>;
}
