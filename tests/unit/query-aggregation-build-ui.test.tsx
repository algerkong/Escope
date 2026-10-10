import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuery, type QueryDocument, type QueryDocumentPatch } from '../../src/domain/query';
import { parseFieldCaps, type FieldCatalog } from '../../src/domain/resource';
import { QueryAggregationBuildDialog } from '../../src/features/query/QueryAggregationBuildDialog';
import type { Loadable } from '../../src/features/query/useQueryResources';
import { i18n } from '../../src/locales';
import { enQueryAggregationBuild, zhQueryAggregationBuild } from '../../src/locales/query-aggregation-build';

beforeEach(async () => { await i18n.changeLanguage('en-US'); });

const parsed = parseFieldCaps('{"fields":{"n":{"long":{"searchable":true,"aggregatable":true}},'
  + '"date":{"date":{"searchable":true,"aggregatable":true}},"k":{"keyword":{"searchable":true,"aggregatable":true}},'
  + '"txt":{"text":{"searchable":true,"aggregatable":false}}}}');
if (!parsed.ok) throw new Error('fixture');
const ready: Loadable<FieldCatalog> = { status: 'ready', data: parsed.value };
const loading: Loadable<FieldCatalog> = { status: 'loading' };
const failed: Loadable<FieldCatalog> = { status: 'error', code: 'resourceUnavailable' };

function fixture(overrides: Partial<Parameters<typeof QueryAggregationBuildDialog>[0]> = {}) {
  const source: QueryDocument = overrides.source ?? { ...createQuery('connection'), id: 'query', index: 'events',
    dsl: '{"query":{"term":{"original":9007199254740993}},"sort":[{"n":"desc"}],"aggs":{"p":{"percentiles":{"field":"n"}}}}' };
  const props = { source, current: source, endpoint: 'https://fixture.test', fields: ready,
    targetCurrent: true, canInspect: true, onInspect: vi.fn(),
    onCommit: vi.fn<(source: QueryDocument, patch: QueryDocumentPatch) => boolean>(() => true), onClose: vi.fn(), ...overrides };
  const mount = (next = props) => <I18nextProvider i18n={i18n}><QueryAggregationBuildDialog {...next} /></I18nextProvider>;
  const view = render(mount());
  return { ...view, props, source, rerenderWith: (patch: Partial<typeof props>) => view.rerender(mount({ ...props, ...patch })) };
}
const preview = () => fireEvent.click(screen.getByRole('button', { name: enQueryAggregationBuild.preview }));
const apply = () => screen.getByRole('button', { name: enQueryAggregationBuild.apply });
const final = () => (screen.getByLabelText(enQueryAggregationBuild.finalDsl) as HTMLTextAreaElement).value;
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const select = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const groupType = () => screen.getByLabelText(enQueryAggregationBuild.groupType);

describe('aggregation build review dialog', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('seeds rows from the existing block and lists handwritten aggregations as kept', () => {
    fixture({ source: { ...createQuery('connection'), id: 'query', index: 'events',
      dsl: '{"aggs":{"by_host":{"terms":{"field":"k","size":5},"aggs":{"total":{"sum":{"field":"n"}}}},'
        + '"p":{"percentiles":{"field":"n"}}}}' } });
    expect(groupType()).toHaveValue('terms');
    expect(screen.getByLabelText(enQueryAggregationBuild.groupName)).toHaveValue('by_host');
    expect(screen.getByLabelText(enQueryAggregationBuild.groupField)).toHaveValue('k');
    expect(screen.getByLabelText(enQueryAggregationBuild.size)).toHaveValue('5');
    expect(screen.getByLabelText('Metric name 1')).toHaveValue('total');
    expect(screen.getByLabelText('Metric type 1')).toHaveValue('sum');
    expect(screen.getByLabelText('Metric field 1')).toHaveValue('n');
    expect(screen.getByText(enQueryAggregationBuild.preserved.replace('{{count}}', '1'))).toBeVisible();
    fireEvent.click(screen.getByText(enQueryAggregationBuild.preserved.replace('{{count}}', '1')));
    expect(screen.getByText('p')).toBeVisible();
    expect(screen.getByText('{"percentiles":{"field":"n"}}')).toBeVisible();
    expect(apply()).toBeDisabled();
  });

  it('starts empty, asks for a field before grouping and keeps the run-free scope note visible', () => {
    fixture({ source: { ...createQuery('connection'), id: 'query', index: 'events', dsl: '{"query":{"match_all":{}}}' } });
    expect(groupType()).toHaveValue('none');
    expect(screen.getByText(enQueryAggregationBuild.noGroupHint)).toBeVisible();
    expect(screen.getByTitle(enQueryAggregationBuild.scopeBoundary)).toHaveTextContent(enQueryAggregationBuild.scope);
    select(enQueryAggregationBuild.groupType, 'terms');
    expect(screen.getByLabelText(enQueryAggregationBuild.groupField)).toHaveValue('');
    expect(screen.getByRole('button', { name: enQueryAggregationBuild.add })).toBeEnabled();
  });

  it('builds a group with metrics, previews the whole DSL and commits only what was reviewed', () => {
    const f = fixture();
    select(enQueryAggregationBuild.groupType, 'date_histogram');
    expect(screen.getByLabelText(enQueryAggregationBuild.groupName)).toHaveValue('per_day');
    change(enQueryAggregationBuild.groupField, 'date');
    change(enQueryAggregationBuild.intervalValue, '30d');
    change(enQueryAggregationBuild.zone, 'UTC');
    fireEvent.click(screen.getByRole('button', { name: enQueryAggregationBuild.add }));
    change('Metric name 1', 'total');
    select('Metric type 1', 'avg');
    change('Metric field 1', 'n');
    expect(apply()).toBeDisabled();
    preview();
    const text = final();
    expect(text).toContain('"original": 9007199254740993');
    expect(text).toContain('"sort": [');
    expect(text).toContain('"percentiles": {');
    expect(text).toContain('"per_day": {');
    expect(text).toContain('"date_histogram": {');
    expect(text).toContain('"field": "date"');
    expect(text).toContain('"fixed_interval": "30d"');
    expect(text).toContain('"time_zone": "UTC"');
    expect(text).toContain('"avg": {');
    expect(text).toContain('"field": "n"');
    expect(text.indexOf('"per_day"')).toBeLessThan(text.indexOf('"p":'));
    fireEvent.click(apply());
    expect(f.props.onCommit).toHaveBeenCalledExactlyOnceWith(f.source, { dsl: text });
    expect(f.props.onClose).toHaveBeenCalledOnce();
  });

  it('invalidates the review when a row changes after previewing', () => {
    const f = fixture();
    select(enQueryAggregationBuild.groupType, 'terms');
    change(enQueryAggregationBuild.groupField, 'k');
    preview();
    expect(apply()).toBeEnabled();
    change(enQueryAggregationBuild.size, '9');
    expect(apply()).toBeDisabled();
    expect(() => screen.getByLabelText(enQueryAggregationBuild.finalDsl)).toThrow();
    preview();
    expect(final()).toContain('"size": 9');
    fireEvent.click(apply());
    expect(f.props.onCommit).toHaveBeenCalledOnce();
  });

  it('refuses a name that belongs to a handwritten aggregation without touching the draft', () => {
    fixture();
    select(enQueryAggregationBuild.groupType, 'terms');
    change(enQueryAggregationBuild.groupField, 'k');
    change(enQueryAggregationBuild.groupName, 'p');
    preview();
    expect(screen.getByRole('alert')).toHaveTextContent(enQueryAggregationBuild.nameConflict);
    expect(apply()).toBeDisabled();
    expect(() => screen.getByLabelText(enQueryAggregationBuild.finalDsl)).toThrow();
  });

  it('reports the field evidence gate per row and the conservative refusal for text fields', () => {
    fixture();
    select(enQueryAggregationBuild.groupType, 'terms');
    change(enQueryAggregationBuild.groupField, 'txt');
    expect(screen.getByText(enQueryAggregationBuild.fieldUnsupported)).toBeVisible();
    change(enQueryAggregationBuild.groupField, 'ghost');
    expect(screen.getByText(enQueryAggregationBuild.fieldMissing)).toBeVisible();
    change(enQueryAggregationBuild.groupField, 'k');
    expect(screen.getByText(/keyword/)).toBeVisible();
  });

  it('shows the unchanged notice when the draft already matches the block', () => {
    const f = fixture({ source: { ...createQuery('connection'), id: 'query', index: 'events',
      dsl: '{"aggs":{"total":{"sum":{"field":"n"}}}}' } });
    expect(screen.getByLabelText('Metric name 1')).toHaveValue('total');
    preview();
    expect(screen.getByText(enQueryAggregationBuild.unchanged)).toBeVisible();
    expect(apply()).toBeDisabled();
    expect(f.props.onCommit).not.toHaveBeenCalled();
  });

  it('blocks every control and apply when the reviewed draft or target is no longer current', () => {
    const f = fixture({ targetCurrent: false });
    expect(groupType()).toBeDisabled();
    expect(screen.getByRole('button', { name: enQueryAggregationBuild.add })).toBeDisabled();
    expect(screen.getByLabelText(enQueryAggregationBuild.inspect)).toBeDisabled();
    expect(apply()).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(enQueryAggregationBuild.draftChanged);
    expect(f.props.onInspect).not.toHaveBeenCalled();
  });

  it('marks the field read as working or failed and only inspects on an explicit click', () => {
    const f = fixture({ fields: loading });
    expect(screen.getByText(enQueryAggregationBuild.inspecting)).toBeVisible();
    expect(screen.getByLabelText(enQueryAggregationBuild.inspect)).toBeDisabled();
    f.rerenderWith({ fields: failed });
    expect(screen.getByText(enQueryAggregationBuild.inspectionFailed)).toBeVisible();
    expect(screen.getByTitle(enQueryAggregationBuild.evidenceBoundary)).toBeVisible();
    f.rerenderWith({ fields: ready });
    fireEvent.click(screen.getByLabelText(enQueryAggregationBuild.inspect));
    expect(f.props.onInspect).toHaveBeenCalledOnce();
  });

  it('refuses a DSL whose aggregation block cannot be reviewed instead of offering a partial build', () => {
    fixture({ source: { ...createQuery('connection'), id: 'query', index: 'events',
      dsl: '{"aggs":{"a":{"terms":{"field":"k"}},"b":{"terms":{"field":"n"}}}}' } });
    expect(screen.getByRole('alert')).toHaveTextContent(enQueryAggregationBuild.tooManyGroups);
    expect(() => screen.getByRole('button', { name: enQueryAggregationBuild.preview })).toThrow();
    expect(apply()).toBeDisabled();
  });

  it('switches to Chinese without losing the reviewed text', async () => {
    fixture({ source: { ...createQuery('connection'), id: 'query', index: 'events', dsl: '{"query":{"match_all":{}}}' } });
    select(enQueryAggregationBuild.groupType, 'terms');
    change(enQueryAggregationBuild.groupField, 'k');
    preview();
    const text = final();
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(screen.getByLabelText(zhQueryAggregationBuild.finalDsl)).toHaveValue(text);
    expect(screen.getByRole('button', { name: zhQueryAggregationBuild.apply })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: zhQueryAggregationBuild.apply }));
    expect(screen.queryByText(zhQueryAggregationBuild.preserved.replace('{{count}}', '1'))).toBeNull();
  });

  it('sends no request, opens no PIT and calls no network while reviewing', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const f = fixture();
    select(enQueryAggregationBuild.groupType, 'date_histogram');
    change(enQueryAggregationBuild.groupField, 'date');
    change(enQueryAggregationBuild.intervalValue, '1d');
    fireEvent.click(screen.getByRole('button', { name: enQueryAggregationBuild.add }));
    change('Metric field 1', 'n');
    preview();
    fireEvent.click(apply());
    expect(fetch).not.toHaveBeenCalled();
    expect(f.props.onCommit).toHaveBeenCalledOnce();
  });

  it('keeps metric rows reorderable and removable inside the review', () => {
    fixture({ source: { ...createQuery('connection'), id: 'query', index: 'events',
      dsl: '{"aggs":{"one":{"sum":{"field":"n"}},"two":{"avg":{"field":"n"}}}}' } });
    expect(within(screen.getByLabelText(enQueryAggregationBuild.metricOrder)).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Move metric 2 up' }));
    expect(screen.getByLabelText('Metric name 1')).toHaveValue('two');
    fireEvent.click(screen.getByRole('button', { name: 'Remove metric 1' }));
    expect(screen.getByLabelText('Metric name 1')).toHaveValue('one');
    fireEvent.click(screen.getByLabelText(enQueryAggregationBuild.clear));
    expect(screen.getByText(enQueryAggregationBuild.noAggregations)).toBeVisible();
  });
});
