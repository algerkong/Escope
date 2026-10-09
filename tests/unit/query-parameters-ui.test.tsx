import { fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryParametersDialog } from '../../src/features/query/QueryParametersDialog';
import { createQuery } from '../../src/domain/query';
import { i18n } from '../../src/locales';

const source = {
  ...createQuery('c1'), index: 'orders-*', dsl: '{"size":25}', revision: 3,
  parameters: { version: 1, template: '{"query":{"term":{"sequence":{"$param":"id"}}},"size":25}',
    definitions: [{ name: 'id', type: 'number' as const }] },
};
beforeEach(async () => { await i18n.changeLanguage('en-US'); });

function mount() {
  const onClose = vi.fn();
  const onCommit = vi.fn(() => true);
  const tree = (current = source) => <I18nextProvider i18n={i18n}>
    <QueryParametersDialog source={source} current={current} onClose={onClose} onCommit={onCommit} />
  </I18nextProvider>;
  const view = render(tree());
  return { onClose, onCommit, view, tree };
}

describe('parameter review and explicit application', () => {
  it('does not change the draft until an exact preview is explicitly applied', () => {
    const { onCommit } = mount();
    expect(screen.getByRole('button', { name: 'Apply to draft' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Value 1' }), { target: { value: '900719925474099312345' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview final DSL' }));
    const dsl = source.parameters.template.replace('{"$param":"id"}', '900719925474099312345');
    expect(screen.getByRole('textbox', { name: 'Final DSL' })).toHaveValue(dsl);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply to draft' }));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(source, { parameters: source.parameters, dsl });
    expect(source.dsl).toBe('{"size":25}');
  });

  it('invalidates the preview after any value or template edit', () => {
    mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Value 1' }), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview final DSL' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Value 1' }), { target: { value: '6' } });
    expect(screen.queryByRole('textbox', { name: 'Final DSL' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply to draft' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview final DSL' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Template DSL' }), { target: { value: '{' } });
    expect(screen.getByRole('button', { name: 'Apply to draft' })).toBeDisabled();
  });

  it('saves an incomplete template definition without saving values or changing the executable DSL', () => {
    const { onCommit } = mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Value 1' }), { target: { value: '987654321' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Template DSL' }), { target: { value: '{' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save definition' }));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(source, { parameters: { ...source.parameters, template: '{' } });
    expect(JSON.stringify(onCommit.mock.calls)).not.toContain('987654321');
  });

  it('blocks a changed draft without rebasing or discarding the parameter inputs', () => {
    const { view, tree, onCommit } = mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Value 1' }), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview final DSL' }));
    view.rerender(tree({ ...source, revision: 4, dsl: '{"size":100}' }));
    expect(screen.getByRole('alert')).toHaveTextContent('The target draft changed');
    expect(screen.getByRole('textbox', { name: 'Value 1' })).toHaveValue('5');
    expect(screen.getByRole('button', { name: 'Apply to draft' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save definition' })).toBeDisabled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('shows a late host conflict and retains the preview for inspection', () => {
    const { onCommit, onClose } = mount();
    onCommit.mockReturnValue(false);
    fireEvent.change(screen.getByRole('textbox', { name: 'Value 1' }), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview final DSL' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply to draft' }));
    expect(screen.getByRole('alert')).toHaveTextContent('The target draft changed');
    expect(onClose).not.toHaveBeenCalled();
  });
});
