import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseFieldCaps, type FieldCatalog } from '../../src/domain/resource';
import { ResourceSidebar } from '../../src/features/query/ResourceSidebar';
import type { Loadable, ResourceReadSource } from '../../src/features/query/useQueryResources';
import { i18n } from '../../src/locales';

const source: ResourceReadSource = { requestId: 'read-1', connectionId: 'c1', endpoint: 'https://es.test/base',
  resource: 'fieldCaps', index: 'events-*' };

function ready(fields: object, indices?: readonly string[]): Loadable<FieldCatalog> & { status: 'ready' } {
  const parsed = parseFieldCaps(JSON.stringify({ fields, indices }));
  if (!parsed.ok) throw new Error('fixture');
  return { status: 'ready', data: parsed.value, source };
}
const normal = () => ready({ amount: { long: { searchable: true, aggregatable: true } } }, ['events-a', 'events-b']);

function setup(patch: Partial<ComponentProps<typeof ResourceSidebar>> = {}) {
  let props: ComponentProps<typeof ResourceSidebar> = {
    available: true, connectionId: source.connectionId, endpoint: source.endpoint, index: source.index!,
    indices: { status: 'idle' }, fields: normal(), mappingFor: () => ({ status: 'idle' }),
    onSelectIndex: vi.fn(), onRefreshIndices: vi.fn(), onLoadFields: vi.fn(), onLoadMapping: vi.fn(), ...patch,
  };
  const view = () => <I18nextProvider i18n={i18n}><ResourceSidebar {...props} /></I18nextProvider>;
  const rendered = render(view());
  return { ...rendered, props, user: userEvent.setup(), rerender: (next: Partial<typeof props>) => {
    props = { ...props, ...next };
    rendered.rerender(view());
  } };
}
const details = (field = 'amount') => screen.getByLabelText(`${field} details`);

beforeEach(async () => { await i18n.changeLanguage('en-US'); });

describe('field capability evidence sidebar', () => {
  it('separates reported type conflicts, search restrictions and aggregation restrictions', async () => {
    const fields = ready({ amount: {
      long: { searchable: true, aggregatable: false, indices: ['events-a', 'events-b'], non_searchable_indices: ['events-b'] },
      keyword: { searchable: false, aggregatable: true, indices: ['events-c', 'events-d'], non_aggregatable_indices: ['events-d'] },
    } }, ['events-a', 'events-b', 'events-c', 'events-d']);
    const f = setup({ fields });
    expect(screen.getByText('Search restricted by index')).not.toBeVisible();
    await f.user.click(details());
    expect(screen.getByText('Multiple types were reported. Capabilities are separate for each type.')).toBeVisible();
    expect(screen.getByText('Search restricted by index')).toHaveAttribute('data-state', 'restricted');
    expect(screen.getByText('Not aggregatable')).toHaveAttribute('data-state', 'unsupported');
    expect(screen.getByText('Not searchable')).toHaveAttribute('data-state', 'unsupported');
    expect(screen.getByText('Aggregation restricted by index')).toHaveAttribute('data-state', 'restricted');
    await f.user.click(screen.getByText('Non-searchable indices (1)'));
    expect(await screen.findByRole('list', { name: 'Non-searchable indices' })).toHaveTextContent('events-b');
    await f.user.click(screen.getByText('Non-aggregatable indices (1)'));
    expect(await screen.findByRole('list', { name: 'Non-aggregatable indices' })).toHaveTextContent('events-d');
    expect(f.props.onLoadFields).not.toHaveBeenCalled();
    expect(f.props.onLoadMapping).not.toHaveBeenCalled();
    expect(f.props.onSelectIndex).not.toHaveBeenCalled();
  });

  it('does not label missing or malformed flags as unavailable, or missing lists as empty', async () => {
    const f = setup({ fields: ready({ amount: { long: { searchable: 'true', non_searchable_indices: [null],
      non_aggregatable_indices: [] } } }) });
    await f.user.click(details());
    expect(screen.getByText('Search capability unknown')).toBeVisible();
    expect(screen.getByText('Aggregation capability unknown')).toBeVisible();
    expect(screen.getByText('Invalid list; scope unknown')).toBeVisible();
    expect(screen.getByText('Empty list')).toBeVisible();
    expect(within(details().closest('details')!).getByText('Not listed')).toBeVisible();
    expect(screen.queryByText('Not searchable')).not.toBeInTheDocument();
    expect(screen.queryByText('Not aggregatable')).not.toBeInTheDocument();
    expect(screen.getByText('Metadata flag not reported or invalid.')).toBeVisible();
  });

  it('shows exact request provenance apart from the returned index set, without implying permission or runtime evidence', async () => {
    const f = setup();
    await f.user.click(screen.getByText('Field capabilities evidence'));
    const provenance = f.container.querySelector('.ql-evidence-source')!;
    expect(provenance).toHaveTextContent('c1');
    expect(provenance).toHaveTextContent('https://es.test/base');
    expect(provenance).toHaveTextContent('events-*');
    expect(provenance).toHaveTextContent('read-1');
    expect(provenance).toHaveTextContent('not an execution snapshot or permission check');
    expect(provenance).toHaveTextContent('query-time runtime fields are not inferred');
    await f.user.click(screen.getByText('Response indices (2)'));
    expect(await screen.findByRole('list', { name: 'Response indices' })).toHaveTextContent('events-aevents-b');
    expect(f.props.onLoadFields).not.toHaveBeenCalled();
    expect(f.props.onLoadMapping).not.toHaveBeenCalled();
  });

  it('mounts only one page of exact index names on demand and permits every reported index to be inspected', async () => {
    const indices = Array.from({ length: 45 }, (_, index) => `events-${index.toString().padStart(2, '0')}`);
    const f = setup({ fields: ready({ amount: { long: { searchable: true, aggregatable: true,
      non_searchable_indices: indices } } }, indices) });
    expect(screen.queryByRole('list', { name: 'Non-searchable indices' })).not.toBeInTheDocument();
    await f.user.click(details());
    await f.user.click(screen.getByText('Non-searchable indices (45)'));
    const names = () => within(screen.getByRole('list', { name: 'Non-searchable indices' })).getAllByRole('listitem');
    expect(await screen.findByText('events-00')).toBeVisible();
    expect(names()).toHaveLength(20);
    expect(screen.queryByText('events-20')).not.toBeInTheDocument();
    const next = screen.getByRole('button', { name: 'Non-searchable indices: next page' });
    const previous = screen.getByRole('button', { name: 'Non-searchable indices: previous page' });
    expect(previous).toBeDisabled();
    await f.user.click(next);
    expect(names()).toHaveLength(20);
    expect(screen.getByText('events-20')).toBeVisible();
    expect(screen.queryByText('events-00')).not.toBeInTheDocument();
    await f.user.click(next);
    expect(names()).toHaveLength(5);
    expect(screen.getByText('events-44')).toBeVisible();
    expect(next).toBeDisabled();
    await f.user.click(previous);
    expect(screen.getByText('events-20')).toBeVisible();
    await f.user.click(screen.getByText('Non-searchable indices (45)'));
    expect(screen.queryByRole('list', { name: 'Non-searchable indices' })).not.toBeInTheDocument();
    expect(f.props.onLoadFields).not.toHaveBeenCalled();
  });

  it.each([
    ['connection', { ...source, connectionId: 'c2' }],
    ['endpoint', { ...source, endpoint: 'https://es.test/other' }],
    ['target', { ...source, index: 'events*' }],
    ['ordered targets', { ...source, index: 'events-b,events-a' }],
    ['resource', { ...source, resource: 'mapping' as const }],
    ['absent source', undefined],
  ])('does not display a ready catalog with a mismatched %s', (_label, origin) => {
    setup({ fields: { ...normal(), source: origin } });
    expect(screen.queryByText('amount')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('does not match the current connection, endpoint and target');
    expect(screen.queryByText('Field capabilities evidence')).not.toBeInTheDocument();
  });

  it('withholds old evidence while refreshing and after failure, then accepts a new successful read', async () => {
    const fields = normal();
    const f = setup({ fields });
    await f.user.click(details());
    f.rerender({ fields: { ...fields, refreshing: true } });
    expect(screen.queryByText('amount')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Refreshing field evidence');
    expect(screen.getByRole('button', { name: 'Refresh fields' })).toBeDisabled();
    f.rerender({ fields: { ...fields, refreshError: 'networkError' } });
    expect(screen.queryByText('amount')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Field refresh failed');
    await f.user.click(screen.getByRole('button', { name: 'Refresh fields' }));
    expect(f.props.onLoadFields).toHaveBeenCalledOnce();
    f.rerender({ fields: { ...fields, source: { ...source, requestId: 'read-2' } } });
    expect(details()).toBeVisible();
    expect(screen.getByText('Searchable')).not.toBeVisible();
    expect(screen.queryByText('read-1')).not.toBeInTheDocument();
  });

  it('resets expanded field and index details across scopes even when both report the same field', async () => {
    const f = setup();
    await f.user.click(details());
    expect(screen.getByText('Searchable')).toBeVisible();
    f.rerender({ index: 'other-*', fields: { ...normal(), source: { ...source, index: 'other-*' } } });
    expect(details()).toBeVisible();
    expect(screen.getByText('Searchable')).not.toBeVisible();
    expect(f.props.onLoadFields).not.toHaveBeenCalled();
  });

  it('resets index pages on a new successful response even when the loading render was batched away', async () => {
    const indices = Array.from({ length: 21 }, (_, index) => `events-${index}`);
    const fields = ready({ amount: { long: { searchable: true, non_searchable_indices: indices } } }, indices);
    const f = setup({ fields });
    await f.user.click(details());
    await f.user.click(screen.getByText('Non-searchable indices (21)'));
    await screen.findByRole('list', { name: 'Non-searchable indices' });
    await f.user.click(screen.getByRole('button', { name: 'Non-searchable indices: next page' }));
    expect(screen.getByText('events-20')).toBeVisible();
    f.rerender({ fields: { ...fields, source: { ...source, requestId: 'new-read' } } });
    expect(screen.queryByRole('list', { name: 'Non-searchable indices' })).not.toBeInTheDocument();
    await f.user.click(screen.getByText('Non-searchable indices (21)'));
    expect(await screen.findByText('events-0')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Non-searchable indices: previous page' })).toBeDisabled();
  });

  it('keeps metadata collapsed, filters literal names and distinguishes empty evidence from absent fields', async () => {
    const f = setup({ fields: ready({ amount: { long: {} }, _id: { _id: { searchable: true, aggregatable: false, metadata_field: true } } }) });
    expect(screen.getByText('_id', { selector: '.ql-field-name' })).not.toBeVisible();
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter fields' }), { target: { value: '_id' } });
    expect(screen.getByText('_id', { selector: '.ql-field-name' })).toBeVisible();
    expect(screen.queryByText('amount')).not.toBeInTheDocument();
    f.rerender({ fields: ready({}) });
    expect(screen.getByText('No field capabilities were returned. This does not prove that fields are absent.')).toBeVisible();
    expect(f.props.onLoadFields).not.toHaveBeenCalled();
  });

  it('bounds field rows and does not invent missing keyword or nested paths', async () => {
    const f = setup({ fields: ready(Object.fromEntries(Array.from({ length: 151 }, (_, index) =>
      [`literal.${index}`, { keyword: { searchable: true, aggregatable: true } }]))) });
    expect(f.container.querySelectorAll('.ql-field')).toHaveLength(150);
    expect(screen.getByText('Showing the first 150 of 151 fields. Filter to narrow the list.')).toBeVisible();
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter fields' }), { target: { value: 'literal.150' } });
    expect(f.container.querySelectorAll('.ql-field')).toHaveLength(1);
    await f.user.click(details('literal.150'));
    expect(screen.queryByText('literal.150.keyword')).not.toBeInTheDocument();
    expect(f.props.onLoadMapping).not.toHaveBeenCalled();
  });

  it('renders literal server text without HTML and changes language without reads', async () => {
    const name = '<script>literal</script>.' + 'long'.repeat(100);
    const f = setup({ fields: ready({ [name]: { keyword: { searchable: true, aggregatable: false,
      indices: ['<img src=x onerror=alert(1)>'] } } }) });
    await f.user.click(details(name));
    await f.user.click(screen.getByText('Type indices (1)'));
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeVisible();
    expect(f.container.querySelector('script, img')).toBeNull();
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(screen.queryByText('Searchable')).not.toBeInTheDocument();
    expect(f.props.onLoadFields).not.toHaveBeenCalled();
    expect(f.props.onSelectIndex).not.toHaveBeenCalled();
  });

  it.each(['permissionDenied', 'serverForbidden'])('keeps a denied field read separate from index listing and query permissions: %s', async (code) => {
    const f = setup({ fields: { status: 'error', code } });
    expect(screen.getByRole('status')).toHaveTextContent('Field capabilities read was denied. Search authorization is checked separately.');
    expect(screen.queryByText(/Index listing was denied/)).not.toBeInTheDocument();
    expect(f.props.onLoadFields).not.toHaveBeenCalled();
    await f.user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(f.props.onLoadFields).toHaveBeenCalledOnce();
  });

  it('does not silently drop a field whose type entries were not returned', async () => {
    const f = setup({ fields: ready({ amount: {} }) });
    expect(details()).toBeVisible();
    await f.user.click(details());
    expect(within(details().closest('details')!).getAllByText('Type not reported')).toHaveLength(2);
    expect(screen.queryByText('Searchable')).not.toBeInTheDocument();
    expect(screen.queryByText('Not searchable')).not.toBeInTheDocument();
  });
});
