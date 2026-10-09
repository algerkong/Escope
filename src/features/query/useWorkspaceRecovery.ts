import { useCallback, useEffect, useRef, useState } from 'react';
import { selectConnection, type ConnectionProfile } from '../../domain/connection';
import type { WorkspaceState } from '../../domain/query';
import {
  gridLayout, interruptHistory, parseRecoveryDocument, parseRecoveryRecord, recordHistory, recoveryWorkspace,
  WORKSPACE_RECOVERY_VERSION,
  type ExecutionHistoryEntry, type RecoveryTab, type RecoveryWorkspace, type ResultGridLayout,
  type VisualEditorDraft, type WorkspaceRecoveryDocument,
} from '../../domain/workspace-recovery';
import { errorCode } from '../../services/ipc';
import type { WorkspaceRecoveryService } from '../../services/workspace-recovery';
import type { SaveStatus } from './QueryLibrary';

export type RecoveryLoadStatus = 'loading' | 'ready' | 'error' | 'conflict';

function resolveActive(workspace: RecoveryWorkspace, profiles: readonly ConnectionProfile[]): RecoveryWorkspace {
  const tabConnection = workspace.tabs.find((tab) => tab.document.id === workspace.activeTabId)?.document.connectionId;
  const activeConnectionId = tabConnection && profiles.some((profile) => profile.id === tabConnection)
    ? tabConnection : selectConnection([...profiles], workspace.activeConnectionId);
  return activeConnectionId === workspace.activeConnectionId ? workspace : { ...workspace, activeConnectionId };
}

/** One writer owns tabs, layouts and metadata. CAS also protects overlapping app lifetimes. */
export function useWorkspaceRecovery(service: WorkspaceRecoveryService, initial: WorkspaceState, profiles: readonly ConnectionProfile[]) {
  const [workspace, renderWorkspace] = useState(() => recoveryWorkspace(initial));
  const workspaceRef = useRef(workspace);
  const [history, renderHistory] = useState<readonly ExecutionHistoryEntry[]>([]);
  const historyRef = useRef(history);
  const [status, renderStatus] = useState<RecoveryLoadStatus>('loading');
  const statusRef = useRef(status);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, renderSaveStatus] = useState<SaveStatus>({ status: 'idle' });
  const [restoreVersion, setRestoreVersion] = useState(0);
  const alive = useRef(true);
  const generation = useRef(0);
  const version = useRef(0);
  const edited = useRef(false);
  const editVersion = useRef(0);
  const revision = useRef(0);
  const persisted = useRef<string | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const profileRef = useRef(profiles);
  const serviceRef = useRef(service);
  profileRef.current = profiles;
  serviceRef.current = service;

  const document = useCallback((): WorkspaceRecoveryDocument => ({
    version: WORKSPACE_RECOVERY_VERSION, workspace: workspaceRef.current, history: historyRef.current,
  }), []);
  const saveState = useCallback((next: SaveStatus) => { if (alive.current) renderSaveStatus(next); }, []);
  const loadState = useCallback((next: RecoveryLoadStatus) => {
    statusRef.current = next;
    if (alive.current) renderStatus(next);
  }, []);

  const enqueueSave = useCallback(() => {
    if (statusRef.current !== 'ready') return;
    const owner = service;
    const epoch = generation.current;
    saveState({ status: 'saving' });
    // Read at the head of the queue, coalescing edits made while an earlier write was pending.
    queue.current = queue.current.then(async () => {
      if (owner !== serviceRef.current || epoch !== generation.current || statusRef.current !== 'ready') return;
      const payload = document();
      const json = JSON.stringify(payload);
      if (json === persisted.current) {
        saveState({ status: 'saved' });
        return;
      }
      const intent = version.current;
      try {
        if (parseRecoveryDocument(payload) === null) throw { code: 'invalidInput' };
        const savedRevision = await owner.save(revision.current, payload);
        if (owner !== serviceRef.current || epoch !== generation.current) return;
        revision.current = savedRevision;
        persisted.current = json;
        if (intent === version.current) saveState({ status: 'saved' });
      } catch (error) {
        if (owner !== serviceRef.current || epoch !== generation.current) return;
        const code = errorCode(error);
        // A revision conflict requires an explicit reload; retry must never force an overwrite.
        if (code === 'workspaceConflict') {
          loadState('conflict');
          if (alive.current) setLoadError(code);
        }
        if (intent === version.current || code === 'workspaceConflict') saveState({ status: 'error', code });
      }
    });
  }, [document, loadState, saveState, service]);

  const updateWorkspace = useCallback((change: (current: WorkspaceState) => WorkspaceState) => {
    const next = change(workspaceRef.current);
    if (next === workspaceRef.current) return;
    workspaceRef.current = recoveryWorkspace(next, workspaceRef.current);
    version.current++;
    edited.current = true;
    editVersion.current++;
    if (alive.current) renderWorkspace(workspaceRef.current);
    enqueueSave();
  }, [enqueueSave]);

  const updateTab = useCallback((id: string, change: (tab: RecoveryTab) => RecoveryTab) => {
    const current = workspaceRef.current;
    if (!current.tabs.some((tab) => tab.document.id === id)) return;
    workspaceRef.current = { ...current, tabs: current.tabs.map((tab) => tab.document.id === id ? change(tab) : tab) };
    version.current++;
    edited.current = true;
    editVersion.current++;
    if (alive.current) renderWorkspace(workspaceRef.current);
    enqueueSave();
  }, [enqueueSave]);
  const setGridLayout = useCallback((id: string, value: ResultGridLayout) => {
    const current = workspaceRef.current.tabs.find((tab) => tab.document.id === id);
    const layout = gridLayout(value);
    if (!current || JSON.stringify(current.grid) === JSON.stringify(layout)) return;
    updateTab(id, (tab) => ({ ...tab, grid: layout }));
  }, [updateTab]);
  const setEditorMode = useCallback((id: string, editorMode: 'dsl' | 'visual') => {
    updateTab(id, (tab) => tab.kind === 'query' ? { ...tab, editorMode } : tab);
  }, [updateTab]);
  const setVisualDraft = useCallback((id: string, draft: VisualEditorDraft) => {
    updateTab(id, (tab) => tab.kind === 'query' ? { ...tab, visualDraft: draft } : tab);
  }, [updateTab]);

  const onHistory = useCallback((entry: ExecutionHistoryEntry) => {
    const next = recordHistory(historyRef.current, entry);
    if (next === historyRef.current) return;
    historyRef.current = next;
    version.current++;
    if (alive.current) renderHistory(next);
    enqueueSave();
  }, [enqueueSave]);
  const deleteHistory = useCallback((requestId: string | null) => {
    // Running entries remain until terminal: a late response cannot resurrect a deleted row.
    historyRef.current = historyRef.current.filter((entry) => entry.status === 'running'
      || (requestId !== null && entry.snapshot.requestId !== requestId));
    version.current++;
    if (alive.current) renderHistory(historyRef.current);
    enqueueSave();
  }, [enqueueSave]);

  const reload = useCallback((replaceLocal = true) => {
    const owner = service;
    const epoch = ++generation.current;
    const intentAtLoad = editVersion.current;
    const historyAtLoad = historyRef.current;
    loadState('loading');
    if (alive.current) setLoadError(null);
    saveState({ status: 'idle' });
    // Wait for a write already in progress, even though its callback has been invalidated.
    void queue.current.then(() => owner.load()).then((raw) => {
      if (epoch !== generation.current || owner !== serviceRef.current || !alive.current) return;
      const saved = parseRecoveryRecord(raw);
      if (saved === null) throw { code: 'invalidResponse' };
      revision.current = saved.revision;
      persisted.current = JSON.stringify(saved.document);
      if (saved.document.workspace !== null && ((edited.current && !replaceLocal) || editVersion.current !== intentAtLoad)) {
        setLoadError('workspaceConflict');
        loadState('conflict');
        return;
      }
      if (saved.document.workspace !== null) {
        workspaceRef.current = resolveActive(saved.document.workspace, profileRef.current);
        renderWorkspace(workspaceRef.current);
        if (replaceLocal) setRestoreVersion((value) => value + 1);
      }
      // Only persisted running entries become interrupted. Events from this live session win.
      let merged = interruptHistory(saved.document.history);
      const live = historyRef.current.filter((entry) => entry.status === 'running' || !historyAtLoad.includes(entry));
      for (const entry of [...live].reverse()) {
        merged = recordHistory(merged.filter((item) => item.snapshot.requestId !== entry.snapshot.requestId), entry);
      }
      historyRef.current = merged;
      renderHistory(merged);
      edited.current = false;
      loadState('ready');
      if (JSON.stringify(document()) !== persisted.current) enqueueSave();
    }).catch((error: unknown) => {
      if (epoch !== generation.current || owner !== serviceRef.current || !alive.current) return;
      setLoadError(errorCode(error));
      loadState('error');
    });
  }, [document, enqueueSave, loadState, saveState, service]);

  useEffect(() => {
    alive.current = true;
    reload(false);
    // Already queued writes may finish after unmount, but cannot render into the old app.
    // A new app instance uses CAS, so an older writer can never silently overwrite its edits.
    return () => { alive.current = false; };
  }, [reload]);

  return {
    kind: service.kind, workspace, workspaceRef, history, status, loadError, saveStatus, restoreVersion,
    updateWorkspace, setGridLayout, setEditorMode, setVisualDraft, onHistory, deleteHistory,
    retrySave: enqueueSave, reload,
  };
}

export type WorkspaceRecoveryController = ReturnType<typeof useWorkspaceRecovery>;
