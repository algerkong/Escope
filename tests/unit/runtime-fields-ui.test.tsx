import { act, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { selectDataView } from '../../src/domain/data-views';
import { createQuery } from '../../src/domain/query';
import { parseFieldCaps, type FieldCatalog } from '../../src/domain/resource';
import { RuntimeFieldsDialog } from '../../src/features/query/RuntimeFieldsDialog';
import { i18n } from '../../src/locales';

beforeEach(async () => { await i18n.changeLanguage('en-US'); });
const source = {
  ...createQuery('connection'), index: 'events-*', dsl: '{"query":{"term":{"n":9007199254740993}}}',
  dataView: selectDataView({ id: 'view', name: 'Runtime', connectionId: 'connection', index: 'events-*', defaultTimeField: null,
    runtimeFields: { version: 1, entries: [{ field: 'n', type: 'long', script: { lang: 'painless', source: 'emit(9007199254740993L);' } }] } }),
};
function fixture(catalog?: FieldCatalog) {
  const onCommit = vi.fn(() => true);
  const onClose = vi.fn();
  const props = { source, current: source, targetCurrent: true, onCommit, onClose, catalog };
  const view = render(<I18nextProvider i18n={i18n}><RuntimeFieldsDialog {...props} /></I18nextProvider>);
  return { ...view, onCommit, onClose, props };
}
const preview = () => fireEvent.click(screen.getByRole('button', { name: 'Preview final DSL' }));
const apply = () => screen.getByRole('button', { name: 'Apply to draft' });
const acknowledge = () => fireEvent.click(screen.getByRole('checkbox', { name: 'Allow field shadowing for this query, including fields absent from the catalog' }));

describe('explicit runtime-field review', () => {
  it('requires preview and acknowledgment of unchecked shadowing before committing only DSL', async () => {
    const styles = readFileSync('src/styles/runtime-fields.css', 'utf8');
    const checkbox = styles.match(/\.runtime-checkbox input\[type="checkbox"\]\s*\{([^}]*)\}/)?.[1];
    expect(checkbox).toContain('padding: 0');
    expect(checkbox).not.toMatch(/width\s*:/);
    const f = fixture();
    expect(apply()).toBeDisabled();
    expect(screen.getByText('Field shadowing not checked')).toBeVisible();
    preview();
    expect((screen.getByLabelText('Final query DSL') as HTMLTextAreaElement).value).toContain('9007199254740993');
    expect(apply()).toBeDisabled();
    acknowledge();
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(screen.getByRole('checkbox', { name: '允许本次查询遮蔽字段，包括目录未返回的字段' })).toBeChecked();
    expect((screen.getByLabelText('最终查询 DSL') as HTMLTextAreaElement).value).toContain('runtime_mappings');
    expect(f.onCommit).not.toHaveBeenCalled();
    await act(async () => { await i18n.changeLanguage('en-US'); });
    fireEvent.click(apply());
    expect(f.onCommit).toHaveBeenCalledExactlyOnceWith(source, expect.stringContaining('runtime_mappings'));
    expect(f.onClose).toHaveBeenCalledOnce();
    expect(source.dsl).not.toContain('runtime_mappings');
  });

  it('invalidates the preview when return-fields options change', () => {
    const f = fixture({ indices: [], fields: [] });
    expect(screen.queryByRole('checkbox', { name: /Allow field shadowing/ })).not.toBeInTheDocument();
    preview();
    expect(apply()).toBeEnabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Return these values in fields' }));
    expect(screen.queryByLabelText('Final query DSL')).not.toBeInTheDocument();
    expect(apply()).toBeDisabled();
    preview();
    const final = (screen.getByLabelText('Final query DSL') as HTMLTextAreaElement).value;
    expect(JSON.parse(final)).not.toHaveProperty('fields');
    fireEvent.click(apply());
    expect(f.onCommit).toHaveBeenCalledWith(source, final);
  });

  it.each([
    ['{"long":{"searchable":false}}', 'Shadows a same-typed field for this query'],
    ['{"keyword":{}}', 'Shadows a field with a different type for this query'],
    ['{"long":{},"keyword":{}}', 'Same-named field has conflicting catalog types'],
  ])('requires explicit shadow acknowledgment for %s without treating it as permission', (types, label) => {
    const catalog = parseFieldCaps(`{"fields":{"n":${types}}}`);
    if (!catalog.ok) throw new Error('fixture');
    fixture(catalog.value);
    expect(screen.getByText(label)).toBeVisible();
    preview();
    expect(apply()).toBeDisabled();
    acknowledge();
    expect(apply()).toBeEnabled();
  });

  it.each(['revision', 'dsl', 'definition', 'target', 'closed'] as const)('rejects a stale %s after preview', (change) => {
    const f = fixture();
    acknowledge();
    preview();
    const current = change === 'closed' ? undefined : { ...source,
      ...(change === 'revision' ? { revision: source.revision + 1 } : {}),
      ...(change === 'dsl' ? { dsl: '{}' } : {}),
      ...(change === 'definition' ? { dataView: selectDataView({ ...source.dataView.definition, name: 'Changed' }) } : {}),
    };
    f.rerender(<I18nextProvider i18n={i18n}><RuntimeFieldsDialog {...f.props} current={current} targetCurrent={change !== 'target'} /></I18nextProvider>);
    expect(screen.getByRole('alert')).toHaveTextContent('The draft or target changed.');
    expect(apply()).toBeDisabled();
    fireEvent.click(apply());
    expect(f.onCommit).not.toHaveBeenCalled();
  });

  it('retains both hand-written DSL and the current draft when a same-named declaration conflicts', () => {
    const f = fixture();
    const query = { ...source, dsl: '{"runtime_mappings":{"n":{"type":"long"}}}' };
    f.rerender(<I18nextProvider i18n={i18n}><RuntimeFieldsDialog {...f.props} source={query} current={query} /></I18nextProvider>);
    acknowledge();
    preview();
    expect(screen.getByRole('alert')).toHaveTextContent('The DSL already defines "n" differently.');
    expect(apply()).toBeDisabled();
    expect(f.onCommit).not.toHaveBeenCalled();
  });

  it('does not repeat a refused compare-and-swap commit or close as though it applied', () => {
    const f = fixture();
    f.onCommit.mockReturnValue(false);
    acknowledge();
    preview();
    fireEvent.click(apply());
    expect(screen.getByRole('alert')).toHaveTextContent('The draft or target changed.');
    expect(f.onClose).not.toHaveBeenCalled();
    expect(apply()).toBeDisabled();
    fireEvent.click(apply());
    expect(f.onCommit).toHaveBeenCalledOnce();
  });
});
