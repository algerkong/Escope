import { act, fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createQuery, type QueryDocument } from '../../src/domain/query';
import { selectDataView } from '../../src/domain/data-views';
import { parseFieldCaps, type FieldCatalog } from '../../src/domain/resource';
import { QueryTimeRangeDialog, TimeRangeSummary } from '../../src/features/query/QueryTimeRangeDialog';
import { i18n } from '../../src/locales';
import { enTimeRange, zhTimeRange } from '../../src/locales/query-time-range';

beforeEach(async () => { await i18n.changeLanguage('en-US'); });
const source = {
  ...createQuery('connection'), index: 'events-*', dsl: '{"query":{"term":{"id":9007199254740993}}}',
  dataView: selectDataView({ id: 'view', connectionId: 'connection', index: 'events-*', name: 'View', defaultTimeField: '@timestamp' }),
};
const parsed = parseFieldCaps('{"fields":{"@timestamp":{"date":{"searchable":true}}}}');
if (!parsed.ok) throw new Error('fixture');
const catalog = parsed.value;
function fixture(fields?: FieldCatalog, document: QueryDocument = source) {
  const onCommit = vi.fn(() => true);
  const onClose = vi.fn();
  const props = { source: document, current: document, catalog: fields, targetCurrent: true, initialTimeZone: 'UTC', onCommit, onClose };
  const view = render(<I18nextProvider i18n={i18n}><QueryTimeRangeDialog {...props} /></I18nextProvider>);
  return { ...view, props, onCommit, onClose };
}
const apply = () => screen.getByRole('button', { name: 'Apply to draft' });
const preview = () => fireEvent.click(screen.getByRole('button', { name: 'Preview final DSL' }));
const acknowledge = () => fireEvent.click(screen.getByRole('checkbox', { name: 'Use this field without verified date-type and search-permission evidence' }));

describe('explicit time range review', () => {
  it('requires preview and unverified-field acknowledgment without committing on language changes', async () => {
    const f = fixture();
    expect(screen.getByLabelText('Time field')).toHaveValue('@timestamp');
    expect(apply()).toBeDisabled();
    preview();
    expect((screen.getByLabelText('Final query DSL') as HTMLTextAreaElement).value).toContain('9007199254740993');
    expect(apply()).toBeDisabled();
    acknowledge();
    expect(apply()).toBeEnabled();
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(screen.getByRole('checkbox', { name: zhTimeRange.acknowledge })).toBeChecked();
    expect((screen.getByLabelText('最终查询 DSL') as HTMLTextAreaElement).value).toContain('"gte"');
    expect(f.onCommit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '应用到草稿' }));
    expect(f.onCommit).toHaveBeenCalledOnce();
    expect(f.onCommit).toHaveBeenCalledWith(source, expect.objectContaining({
      dsl: expect.stringContaining('9007199254740993'), timeRange: expect.objectContaining({ version: 1, binding: { connectionId: 'connection', index: 'events-*' } }),
    }));
    expect(f.onClose).toHaveBeenCalledOnce();
  });

  it('invalidates preview and acknowledgment after edits to field, date type, zone, duration or mode', () => {
    const f = fixture(catalog);
    preview();
    expect(apply()).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Last'), { target: { value: '30' } });
    expect(apply()).toBeDisabled();
    expect(screen.queryByLabelText('Final query DSL')).not.toBeInTheDocument();
    preview();
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: '+08:00' } });
    expect(apply()).toBeDisabled();
    preview();
    fireEvent.change(screen.getByLabelText('Date type'), { target: { value: 'date_nanos' } });
    expect(apply()).toBeDisabled();
    preview();
    expect(screen.getByRole('alert')).toHaveTextContent(enTimeRange.fieldNotDate);
    fireEvent.click(screen.getByRole('button', { name: 'Absolute' }));
    expect(screen.getByLabelText('From (inclusive)')).toHaveValue('');
    expect(f.onCommit).not.toHaveBeenCalled();
  });

  it.each(['revision', 'dsl', 'index', 'closed', 'target'] as const)('rejects a changed %s after review without rebasing', (change) => {
    const f = fixture(catalog);
    preview();
    const current = change === 'closed' ? undefined : { ...source,
      ...(change === 'revision' ? { revision: source.revision + 1 } : {}),
      ...(change === 'dsl' ? { dsl: '{}' } : {}), ...(change === 'index' ? { index: 'other' } : {}) };
    f.rerender(<I18nextProvider i18n={i18n}><QueryTimeRangeDialog {...f.props} current={current} targetCurrent={change !== 'target'} /></I18nextProvider>);
    expect(screen.getByRole('alert')).toHaveTextContent(enTimeRange.draftChanged);
    expect(apply()).toBeDisabled();
    fireEvent.click(apply());
    expect(f.onCommit).not.toHaveBeenCalled();
  });

  it('rejects nonexistent local time and milliseconds-only fields without rounding the input', () => {
    fixture(catalog);
    fireEvent.click(screen.getByRole('button', { name: 'Absolute' }));
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'America/New_York' } });
    fireEvent.change(screen.getByLabelText('From (inclusive)'), { target: { value: '2026-03-08T02:30:00' } });
    fireEvent.change(screen.getByLabelText('To (exclusive)'), { target: { value: '2026-03-08T04:00:00' } });
    preview();
    expect(screen.getByRole('alert')).toHaveTextContent(enTimeRange.ambiguousTime);
    expect(screen.getByLabelText('From (inclusive)')).toHaveValue('2026-03-08T02:30:00');
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'UTC' } });
    fireEvent.change(screen.getByLabelText('From (inclusive)'), { target: { value: '2026-03-08T02:30:00.000000001' } });
    preview();
    expect(screen.getByRole('alert')).toHaveTextContent(enTimeRange.precisionMismatch);
  });

  it('preserves handwritten conditions when the time range conflicts', () => {
    const input = { ...source, dsl: '{"query":{"range":{"@timestamp":{"gte":"now-1d"}}}}' };
    const f = fixture(catalog, input);
    preview();
    expect(screen.getByRole('alert')).toHaveTextContent(enTimeRange.manualConflict);
    expect(apply()).toBeDisabled();
    expect(f.onCommit).not.toHaveBeenCalled();
  });

  it('previews removal and applies it only on explicit confirmation', () => {
    const shared = JSON.parse(readFileSync('tests/fixtures/query-time-range-v1.json', 'utf8')) as { draft: QueryDocument };
    const f = fixture(undefined, shared.draft);
    fireEvent.click(screen.getByRole('button', { name: 'Preview removal of managed range' }));
    expect((screen.getByLabelText('Final query DSL') as HTMLTextAreaElement).value).not.toContain('"range"');
    expect(apply()).toBeEnabled();
    expect(f.onCommit).not.toHaveBeenCalled();
    fireEvent.click(apply());
    expect(f.onCommit).toHaveBeenCalledWith(shared.draft, { timeRange: null,
      dsl: '{"query":{"term":{"sequence":9007199254740993}},"size":25}' });
  });

  it('does not treat a rejected compare-and-swap as success or repeat the commit', () => {
    const f = fixture(catalog);
    f.onCommit.mockReturnValue(false);
    preview();
    fireEvent.click(apply());
    expect(screen.getByRole('alert')).toHaveTextContent(enTimeRange.draftChanged);
    expect(f.onClose).not.toHaveBeenCalled();
    expect(apply()).toBeDisabled();
    fireEvent.click(apply());
    expect(f.onCommit).toHaveBeenCalledOnce();
  });

  it('keeps bilingual keys and displays the original executed nanoseconds without using display preferences', () => {
    expect(Object.keys(enTimeRange).sort()).toEqual(Object.keys(zhTimeRange).sort());
    const shared = JSON.parse(readFileSync('tests/fixtures/query-time-range-v1.json', 'utf8')) as { draft: QueryDocument };
    render(<I18nextProvider i18n={i18n}><TimeRangeSummary time={shared.draft.timeRange!} /></I18nextProvider>);
    expect(screen.getByRole('group', { name: 'Executed time' })).toHaveTextContent('2026-10-09T11:45:00.123000000Z');
    const style = readFileSync('src/styles/query-time-range.css', 'utf8');
    expect(style).toContain('var(--muted)');
    expect(style).not.toContain('var(--text-secondary)');
    expect(style.match(/\.qtime-checkbox input\[type="checkbox"\]\s*\{([^}]*)\}/)?.[1]).toContain('padding: 0');
    expect(style).not.toMatch(/background:\s*#|gradient|letter-spacing:\s*-/);
  });
});
