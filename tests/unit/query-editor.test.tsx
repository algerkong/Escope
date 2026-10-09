import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryWorkspace } from '../../src/features/query/QueryWorkspace';
import { createQuery, selectWorkspaceTab, updateWorkspaceDocument, type WorkspaceState } from '../../src/domain/query';
import { defaultPreferences } from '../../src/domain/preferences';
import { i18n } from '../../src/locales';

const original = '{"query":{"term":{"id":9007199254740993}}}';

function setup(dsl = original) {
  const update = vi.fn();
  function Harness() {
    const [state, setState] = useState<WorkspaceState>(() => {
      const a = { ...createQuery(null), dsl };
      const b = { ...createQuery(null), dsl: '{"size":3}' };
      return { activeConnectionId: null, activeTabId: a.id, tabs: [a, b].map((document) => ({ kind: 'query', document })), lastTabByConnection: {} };
    });
    return <I18nextProvider i18n={i18n}><QueryWorkspace state={state} profiles={[]} preferences={defaultPreferences}
      aiOpen={false} testResults={{}} toggleAI={() => {}} onSettings={() => {}}
      updateQuery={(id, patch) => {
        update(id, patch);
        setState((current) => updateWorkspaceDocument(current, id, patch));
      }}
      selectTab={(id) => setState((current) => selectWorkspaceTab(current, id))}
      openIndex={() => { throw new Error('No live index backend'); }}
      addQuery={() => {}} closeTab={() => {}} /></I18nextProvider>;
  }
  render(<Harness />);
  return { user: userEvent.setup(), update };
}

beforeEach(async () => { await i18n.changeLanguage('zh-CN'); });

describe('local DSL editor actions', () => {
  it('validates without editing, formats losslessly and can restore the exact original text', async () => {
    const { user, update } = setup();
    await user.click(screen.getByRole('button', { name: '校验 JSON' }));
    expect(screen.getByText('JSON 语法有效')).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '格式化 JSON' }));
    const input = screen.getByRole('textbox', { name: '查询 DSL' });
    expect(input).toHaveValue('{\n  "query": {\n    "term": {\n      "id": 9007199254740993\n    }\n  }\n}');
    expect(input).toHaveFocus();
    expect(screen.getByRole('button', { name: '执行查询' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '撤销格式化' }));
    expect(input).toHaveValue(original);
    expect(screen.getByRole('button', { name: '撤销格式化' })).toBeDisabled();
  });

  it('rejects duplicate keys without rewriting the draft and clears diagnostics on edits', async () => {
    const source = '{"size":25,"size":25}';
    const { user, update } = setup(source);
    await user.click(screen.getByRole('button', { name: '格式化 JSON' }));
    expect(screen.getByRole('alert')).toHaveTextContent('JSON 属性重复。');
    const input = screen.getByRole('textbox', { name: '查询 DSL' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveValue(source);
    expect(update).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '{}' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'false');
  });

  it('does not apply formatting undo or a prior diagnostic to a different tab', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: '格式化 JSON' }));
    await user.click(screen.getAllByRole('tab')[2]!);
    expect(screen.getByRole('button', { name: '撤销格式化' })).toBeDisabled();
    expect(screen.queryByText('JSON 语法有效')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '查询 DSL' })).toHaveValue('{"size":3}');
  });

  it('localizes validation messages without exposing the invalid source', async () => {
    await i18n.changeLanguage('en-US');
    const { user } = setup('{"private-field":@}');
    await user.click(screen.getByRole('button', { name: 'Validate JSON' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid JSON syntax.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('private-field');
  });
});
