import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INITIAL_RESULT_GRID_STATE, type ResultGridRow } from '../../src/domain/result-grid';
import { parseQueryResult } from '../../src/domain/query-result';
import { QueryResultGrid } from '../../src/features/query/QueryResultGrid';
import { i18n } from '../../src/locales';

beforeEach(async () => { await i18n.changeLanguage('en-US'); });
const parsed = parseQueryResult('{"hits":{"hits":[{"_id":"one","_source":{"n":9007199254740993}},{"_id":"two","_source":{"n":2}},{"_id":"three","_source":{"other":true}}]}}');
if (!parsed.ok) throw new Error('fixture');
const rows = parsed.summary.hits.map((hit, position) => ({ hit, pageIndex: 0, position }));
function Harness({ onFilter, onDocument, active = true }: {
  onFilter: (row: ResultGridRow, field: string) => void; onDocument: () => void; active?: boolean;
}) {
  const [state, setState] = useState(INITIAL_RESULT_GRID_STATE);
  return <I18nextProvider i18n={i18n}><QueryResultGrid rows={rows} fieldNames={['n', 'other']} state={state} active={active}
    onStateChange={setState} onFilterCell={onFilter} onDocument={onDocument} executionKey="first"
    fieldFormats={{ version: 1, entries: [{ field: 'n', format: { kind: 'number', grouping: true } }] }} />
  </I18nextProvider>;
}

describe('cell-filter grid action', () => {
  it('passes the original row after local sorting and does not select rows or open document details', async () => {
    const onFilter = vi.fn();
    const onDocument = vi.fn();
    render(<Harness onFilter={onFilter} onDocument={onDocument} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sort by n' }));
    const cell = screen.getByText('9,007,199,254,740,993').closest('td')!;
    const row = cell.closest('tr')!;
    const user = userEvent.setup();
    await user.click(within(cell).getByRole('button', { name: 'Filter n' }));
    expect(onFilter).toHaveBeenCalledExactlyOnceWith(rows[0], 'n');
    expect(onFilter.mock.calls[0]![0].hit.columns[0]!.value.text).toBe('9007199254740993');
    expect(row).toHaveAttribute('aria-selected', 'false');
    expect(onDocument).not.toHaveBeenCalled();
    expect(screen.queryByText('1 row selected')).not.toBeInTheDocument();
    const missing = screen.getByText('three').closest('tr')!;
    await user.click(within(missing).getByRole('button', { name: 'Filter n' }));
    expect(onFilter).toHaveBeenLastCalledWith(rows[2], 'n');
  });

  it('has keyboard-focusable named controls, no metadata substitution, and disables hidden workspace actions', () => {
    const onFilter = vi.fn();
    const onDocument = vi.fn();
    const view = render(<Harness onFilter={onFilter} onDocument={onDocument} />);
    const button = screen.getAllByRole('button', { name: 'Filter n' })[0]!;
    button.focus();
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('title', 'Filter n');
    expect(screen.queryByRole('button', { name: 'Filter _id' })).not.toBeInTheDocument();
    view.rerender(<Harness onFilter={onFilter} onDocument={onDocument} active={false} />);
    expect(screen.getAllByRole('button', { name: 'Filter n' })[0]).toBeDisabled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Filter n' })[0]!);
    expect(onFilter).not.toHaveBeenCalled();
  });
});
