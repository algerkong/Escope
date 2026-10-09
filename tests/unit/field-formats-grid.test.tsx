import { readFileSync } from 'node:fs';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectDataView, type DataViewLibrary } from '../../src/domain/data-views';
import { createQuery, createSnapshot, type QueryDocument } from '../../src/domain/query';
import { parseQueryResult } from '../../src/domain/query-result';
import { buildCsvExport, buildJsonlExport } from '../../src/domain/query-library';
import { QueryResults } from '../../src/features/query/QueryResults';
import type { ExecutionEntry } from '../../src/features/query/useQueryExecutions';
import { i18n } from '../../src/locales';

const fixture = JSON.parse(readFileSync('tests/fixtures/data-view-field-formats-v1.json', 'utf8')) as DataViewLibrary;
const definition = fixture.entries[0]!;
const dataView = selectDataView({ ...definition, fieldFormats: { version: 1, entries: [
  ...definition.fieldFormats!.entries, { field: 'values', format: { kind: 'number', grouping: true } },
  { field: 'object', format: { kind: 'number', grouping: true } },
] } });
const raw = '{"took":1,"timed_out":false,"_shards":{"total":1,"successful":1,"failed":0},"hits":{"total":{"value":2,"relation":"eq"},"hits":['
  + '{"_index":"events-1","_id":"first","_source":{"sequence":9007199254740993,"ratio":0.123456789012345678901,'
  + '"size":1537,"@timestamp":"2026-10-10T08:15:20.123456789+08:00","epoch":0,"values":[9007199254740993,null],"object":{"n":1}}},'
  + '{"_index":"events-1","_id":"second","_source":{"sequence":9007199254740992,"ratio":"0.5",'
  + '"size":null,"@timestamp":"invalid","epoch":9007199254740993,"values":[[1]],"object":{}}}]}}';
const query = { ...createQuery(definition.connectionId), index: definition.index, dataView, id: 'formatted-query' };
function result(formatted = true): ExecutionEntry {
  const parsed = parseQueryResult(raw);
  if (!parsed.ok) throw new Error('Invalid fixture');
  const document: QueryDocument = { ...query };
  if (!formatted) delete document.dataView;
  const snapshot = createSnapshot(document, 'formatted-execution', new Date('2026-10-10T00:00:00.000Z'));
  return {
    state: { status: 'success', snapshot, rawResponse: raw }, endpoint: 'https://fixture.test', parsed, rawResponse: raw,
    pages: [{ rawResponse: raw, summary: parsed.summary, cursor: null, partial: false }],
    pitId: null, continuing: false, continuationError: null,
  };
}
const noAction = vi.fn();
function Harness({ entry = result() }: { entry?: ExecutionEntry }) {
  const [view, setView] = useState<QueryDocument['resultView']>('table');
  return <I18nextProvider i18n={i18n}><QueryResults query={{ ...query, resultView: view }} entry={entry}
    available stale={false} endpointChanged={false} onCancel={noAction} onRun={noAction}
    onLoadMore={noAction} onViewChange={setView} /></I18nextProvider>;
}
const cells = (field: string) => [...document.querySelectorAll<HTMLElement>(`tbody td[data-column-id="field:${field}"] .rg-cell`)];
const rows = () => [...document.querySelectorAll('tbody tr')];
function selectText(first: Node, last = first, partial = false) {
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  const range = document.createRange();
  range.setStart(first.firstChild!, partial ? 1 : 0);
  range.setEnd(last.firstChild!, partial ? 3 : last.textContent!.length);
  selection.addRange(range);
}

beforeEach(async () => { await i18n.changeLanguage('en-US'); noAction.mockClear(); });
afterEach(() => { document.getSelection()?.removeAllRanges(); });

describe('execution-bound field format grid', () => {
  it('renders exact formats and explanatory raw fallbacks without changing local sorting or raw data', async () => {
    const entry = result();
    const source = JSON.stringify(entry.pages);
    render(<Harness entry={entry} />);
    expect(cells('sequence')[0]).toHaveTextContent('9,007,199,254,740,993');
    expect(cells('ratio')[0]).toHaveTextContent('12.3456789012345678901%');
    expect(cells('size')[0]).toHaveTextContent('1.5009765625 KiB');
    expect(cells('@timestamp')[0]).toHaveTextContent('2026-10-10T00:15:20.123456789Z');
    expect(cells('epoch')[0]).toHaveTextContent('1970-01-01T00:00:00.000Z');
    expect(cells('values')[0]).toHaveTextContent('["9,007,199,254,740,993", null]');
    expect(cells('ratio')[1]).toHaveAttribute('title', 'Original value (incompatible value type): 0.5');
    expect(cells('@timestamp')[1]).toHaveAttribute('title', 'Original value (invalid or unsupported date): invalid');
    expect(cells('object')[0]).toHaveAttribute('data-field-format', 'raw');
    expect(cells('values')[1]).toHaveTextContent('[[1]]');
    fireEvent.click(screen.getByRole('button', { name: 'Sort by sequence' }));
    expect(within(rows()[0] as HTMLElement).getByText('second')).toBeVisible();
    expect(cells('sequence')[0]).toHaveTextContent('9,007,199,254,740,992');
    fireEvent.click(screen.getByRole('button', { name: 'Execution field formats' }));
    expect(cells('sequence')[0]).toHaveTextContent('9007199254740992');
    expect(within(rows()[0] as HTMLElement).getByText('second')).toBeVisible();
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(screen.getByRole('button', { name: '执行时字段格式' })).toHaveAttribute('aria-pressed', 'false');
    expect(JSON.stringify(entry.pages)).toBe(source);
    expect(noAction).not.toHaveBeenCalled();
  });

  it('copies full original cell values even from a partial formatted selection, and preserves raw TSV order', () => {
    render(<Harness />);
    selectText(cells('sequence')[0]!, cells('sequence')[0]!, true);
    const clipboardData = { setData: vi.fn() };
    fireEvent.copy(cells('sequence')[0]!, { clipboardData });
    expect(clipboardData.setData).toHaveBeenLastCalledWith('text/plain', '9007199254740993');
    selectText(cells('sequence')[0]!, cells('ratio')[0]!);
    fireEvent.copy(cells('sequence')[0]!, { clipboardData });
    expect(clipboardData.setData).toHaveBeenLastCalledWith('text/plain', '9007199254740993\t0.123456789012345678901');
    selectText(cells('values')[0]!);
    fireEvent.copy(cells('values')[0]!, { clipboardData });
    expect(clipboardData.setData).toHaveBeenLastCalledWith('text/plain', '[9007199254740993,null]');
  });

  it('keeps document/response clipboard and CSV/JSONL exports verbatim, never presentation strings', async () => {
    const user = userEvent.setup();
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText');
    const entry = result();
    render(<Harness entry={entry} />);
    await user.click(screen.getByRole('button', { name: 'Document first' }));
    await user.click(screen.getByRole('button', { name: 'Copy document' }));
    expect(clipboard).toHaveBeenLastCalledWith(expect.stringContaining('"sequence":9007199254740993'));
    expect(clipboard).toHaveBeenLastCalledWith(expect.stringContaining('"ratio":0.123456789012345678901'));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'JSON' }));
    await user.click(screen.getByRole('button', { name: 'Copy raw response' }));
    expect(clipboard).toHaveBeenLastCalledWith(raw);
    const csv = buildCsvExport(entry.pages[0]!.summary.hits);
    const jsonl = buildJsonlExport(entry.pages);
    expect(csv.content).toContain('9007199254740993');
    expect(csv.content).toContain('0.123456789012345678901');
    expect(JSON.stringify([csv, jsonl])).not.toContain('9,007,199,254,740,993');
    expect(JSON.stringify([csv, jsonl])).not.toContain('KiB');
    expect(noAction).not.toHaveBeenCalled();
  });

  it('does not derive result formats from a newer selected draft when the execution has no format copy', () => {
    render(<Harness entry={result(false)} />);
    expect(cells('sequence')[0]).toHaveTextContent('9007199254740993');
    expect(screen.queryByRole('button', { name: 'Execution field formats' })).not.toBeInTheDocument();
  });
});
