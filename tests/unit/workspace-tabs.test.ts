import { describe, expect, it } from 'vitest';
import {
  addWorkspaceTab, closeWorkspaceTab, createIndexTab, createQuery, createWorkspace,
  selectWorkspaceTab, switchConnection, updateWorkspaceDocument,
} from '../../src/domain/query';

describe('ordered workspace documents', () => {
  it('starts with an empty opener and an unexecuted query', () => {
    const state = createWorkspace('a', 'json');
    expect(state.activeTabId).toBeNull();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({ kind: 'query', document: { connectionId: 'a', index: '', resultView: 'json' } });
  });

  it('appends independent index tabs and deduplicates only the same stable connection and target', () => {
    const first = createIndexTab('a', ' orders ', 'json');
    const second = createIndexTab('a', 'events', 'table');
    let state = addWorkspaceTab(createWorkspace('a'), first);
    state = addWorkspaceTab(state, second);
    const ids = state.tabs.map((tab) => tab.document.id);
    state = addWorkspaceTab(state, createIndexTab('a', 'orders', 'table'));
    expect(state.tabs.map((tab) => tab.document.id)).toEqual(ids);
    expect(state.activeTabId).toBe(first.document.id);
    expect(state.tabs[1]?.document.resultView).toBe('json');
    expect(state.tabs[1]?.document.index).toBe('orders');
    state = addWorkspaceTab(state, createIndexTab('b', 'orders', 'table'));
    expect(state.tabs).toHaveLength(4);
    expect(state.tabs.at(-1)?.document.connectionId).toBe('b');
  });

  it('does not conflate delimiter-like strings or aliases with a different index', () => {
    let state = createWorkspace('a');
    for (const [connection, index] of [['a:b', 'c'], ['a', 'b:c'], ['a', 'alias'], ['a', 'index']]) {
      state = addWorkspaceTab(state, createIndexTab(connection!, index!, 'table'));
    }
    expect(state.tabs).toHaveLength(5);
  });

  it('keeps index targets immutable while allowing their result view to change', () => {
    const tab = createIndexTab('a', 'orders', 'table');
    const state = addWorkspaceTab(createWorkspace('a'), tab);
    const next = updateWorkspaceDocument(state, tab.document.id, { index: 'other', dsl: '{"size":0}', name: 'changed', resultView: 'json' });
    expect(next.tabs[1]?.document).toEqual({ ...tab.document, resultView: 'json' });
    expect(state.tabs[1]?.document.resultView).toBe('table');
  });

  it('changes only the selected query and does not revise an identical patch or view change', () => {
    const query = createQuery('a');
    let state = addWorkspaceTab(createWorkspace('a'), { kind: 'query', document: query });
    state = updateWorkspaceDocument(state, query.id, { dsl: query.dsl });
    expect(state.tabs[1]?.document.revision).toBe(0);
    state = updateWorkspaceDocument(state, query.id, { dsl: '{"size":2}', resultView: 'json' });
    expect(state.tabs[1]?.document.revision).toBe(1);
    expect(state.tabs[0]?.document.revision).toBe(0);
    state = updateWorkspaceDocument(state, query.id, { resultView: 'table' });
    expect(state.tabs[1]?.document.revision).toBe(1);
  });

  it('restores the last selected tab per connection without adding or rebinding documents', () => {
    const orders = createIndexTab('a', 'orders', 'table');
    const events = createIndexTab('a', 'events', 'table');
    let state = addWorkspaceTab(addWorkspaceTab(createWorkspace('a'), orders), events);
    state = selectWorkspaceTab(state, orders.document.id);
    const originalTabs = state.tabs;
    state = switchConnection(state, 'b');
    expect(state.activeTabId).toBeNull();
    expect(state.tabs).toBe(originalTabs);
    state = switchConnection(state, 'a');
    expect(state.activeTabId).toBe(orders.document.id);
    state = selectWorkspaceTab(state, null);
    state = switchConnection(switchConnection(state, 'b'), 'a');
    expect(state.activeTabId).toBeNull();
  });

  it('closing a background tab preserves the active tab; active close selects a neighbor', () => {
    const a = createIndexTab('a', 'orders', 'table');
    const b = createIndexTab('a', 'events', 'table');
    const c = createIndexTab('a', 'users', 'table');
    let state = addWorkspaceTab(addWorkspaceTab(addWorkspaceTab(createWorkspace('a'), a), b), c);
    state = closeWorkspaceTab(state, a.document.id);
    expect(state.activeTabId).toBe(c.document.id);
    state = closeWorkspaceTab(state, c.document.id);
    expect(state.activeTabId).toBe(b.document.id);
    state = closeWorkspaceTab(state, b.document.id);
    expect(state.activeTabId).toBe(state.tabs[0]?.document.id);
    state = closeWorkspaceTab(state, state.tabs[0]!.document.id);
    expect(state.activeTabId).toBeNull();
    expect(state.tabs).toHaveLength(0);
    expect(Object.values(state.lastTabByConnection)).not.toContain(c.document.id);
  });

  it('reopening a closed index gets a fresh document identity for request isolation', () => {
    const original = createIndexTab('a', 'orders', 'table');
    const state = closeWorkspaceTab(addWorkspaceTab(createWorkspace('a'), original), original.document.id);
    const reopened = createIndexTab('a', 'orders', 'table');
    const next = addWorkspaceTab(state, reopened);
    expect(reopened.document.id).not.toBe(original.document.id);
    expect(next.activeTabId).toBe(reopened.document.id);
    expect(next.tabs.some((tab) => tab.document.id === original.document.id)).toBe(false);
  });

  it('ignores stale tab selection and close actions', () => {
    const state = createWorkspace('a');
    expect(selectWorkspaceTab(state, 'missing')).toBe(state);
    expect(closeWorkspaceTab(state, 'missing')).toBe(state);
  });
});
