import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import { Modal, SelectControl } from '../../src/components/controls';
import { i18n } from '../../src/locales';

const appCss = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8');
const controlsCss = readFileSync(resolve(process.cwd(), 'src/styles/controls.css'), 'utf8');
const clusterCss = readFileSync(resolve(process.cwd(), 'src/styles/cluster.css'), 'utf8');
const rowSelectionCss = readFileSync(resolve(process.cwd(), 'src/styles/table-selection.css'), 'utf8');

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (match === null) throw new Error(`missing CSS rule ${selector}`);
  return match[1]!;
}

function block(css: string, opener: string): string {
  const start = css.indexOf(opener);
  if (start === -1) throw new Error(`missing block ${opener}`);
  let depth = 0;
  for (let index = css.indexOf('{', start); index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    else if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced block ${opener}`);
}

function Controlled({ onChange }: { onChange?: (value: string) => void }) {
  const [value, setValue] = useState('a');
  return <SelectControl aria-label="示例选项" value={value}
    onChange={(event) => { onChange?.(event.target.value); setValue(event.target.value); }}>
    <option value="a">A</option><option value="b">B</option><option value="c">C</option>
  </SelectControl>;
}

function ModalHarness({ removable = false }: { removable?: boolean }) {
  const [open, setOpen] = useState(false);
  const [openerMounted, setOpenerMounted] = useState(true);
  return <>
    {openerMounted ? <button onClick={() => setOpen(true)}>打开对话框</button> : null}
    <Modal open={open} onClose={() => setOpen(false)} title="对话框标题" description="对话框说明">
      {removable ? <button onClick={() => setOpenerMounted(false)}>移除触发按钮</button> : <p>对话框内容</p>}
    </Modal>
  </>;
}

describe('SelectControl', () => {
  it('renders a real native select and keeps id, className, aria props and ref on it', () => {
    const ref = createRef<HTMLSelectElement>();
    render(<SelectControl id="sample" className="extra-class" aria-label="示例选项" ref={ref} defaultValue="a">
      <option value="a">A</option><option value="b">B</option>
    </SelectControl>);
    const select = screen.getByRole('combobox', { name: '示例选项' });
    expect(select).toBeInstanceOf(HTMLSelectElement);
    expect(ref.current).toBe(select);
    expect(select).toHaveAttribute('id', 'sample');
    expect(select.className.split(' ')).toEqual(['select-control-input', 'extra-class']);
    expect(select).toHaveValue('a');
    const wrapper = select.parentElement!;
    expect(wrapper).toHaveClass('select-control');
    // The wrapper adds a decorative chevron only — no second field, button or label.
    expect(wrapper.querySelectorAll('select, input, button')).toHaveLength(1);
    const chevron = wrapper.querySelector('svg.select-control-chevron');
    expect(chevron).not.toBeNull();
    expect(chevron).toHaveAttribute('aria-hidden', 'true');
  });

  it('keeps the label association of a wrapping label', () => {
    render(<label>环境
      <SelectControl defaultValue="development"><option value="development">开发</option></SelectControl>
    </label>);
    const select = screen.getByLabelText('环境');
    expect(select).toBeInstanceOf(HTMLSelectElement);
    expect(select).toHaveValue('development');
  });

  it('keeps the change semantics userEvent.selectOptions relies on', async () => {
    const user = userEvent.setup();
    const changes: string[] = [];
    render(<Controlled onChange={(value) => changes.push(value)} />);
    const select = screen.getByRole('combobox', { name: '示例选项' });
    await user.selectOptions(select, 'b');
    expect(changes).toEqual(['b']);
    expect(select).toHaveValue('b');
  });

  it('keeps a disabled select inert without losing its value', async () => {
    const user = userEvent.setup();
    render(<SelectControl aria-label="禁用选项" defaultValue="a" disabled>
      <option value="a">A</option><option value="b">B</option>
    </SelectControl>);
    const disabled = screen.getByRole('combobox', { name: '禁用选项' });
    expect(disabled).toBeDisabled();
    await user.selectOptions(disabled, 'b');
    expect(disabled).toHaveValue('a');
  });

  it('is one keyboard focus target', async () => {
    const user = userEvent.setup();
    render(<SelectControl aria-label="键盘选项" defaultValue="a">
      <option value="a">A</option><option value="b">B</option>
    </SelectControl>);
    await user.tab();
    expect(screen.getByRole('combobox', { name: '键盘选项' })).toHaveFocus();
  });
});

describe('select control stylesheet contract', () => {
  // Text-level checks only: jsdom cannot prove pixels. They pin the affordance, the chevron space
  // and the fallback chain the wrapper relies on.
  it('reserves the chevron space and keeps the chevron passive', () => {
    const input = cssRule(controlsCss, '.select-control > .select-control-input');
    expect(input).toMatch(/appearance:\s*none/);
    expect(input).toMatch(/padding-right:/);
    expect(cssRule(controlsCss, '.select-control-chevron')).toMatch(/pointer-events:\s*none/);
    expect(cssRule(controlsCss, '.select-control-chevron')).toMatch(/position:\s*absolute/);
    expect(cssRule(controlsCss, '.select-control > select')).toMatch(/width:\s*100%/);
  });

  it('upgrades the picker progressively and returns to the native control in forced colors', () => {
    const supported = block(controlsCss, '@supports (appearance: base-select)');
    expect(supported).toMatch(/::picker\(select\)/);
    expect(supported).toMatch(/::picker-icon\s*\{\s*display:\s*none/);
    const forced = block(controlsCss, '@media (forced-colors: active)');
    expect(forced).toMatch(/appearance:\s*auto/);
    expect(forced).toMatch(/\.select-control-chevron\s*\{\s*display:\s*none/);
  });
});

describe('base control stylesheet contract', () => {
  it('keeps selected rows themed after hover and restricts native text suppression to active row drags', () => {
    const tokens = cssRule(rowSelectionCss, '.table-selection-body');
    expect(tokens).toMatch(/--row-selected-bg:\s*color-mix\(in srgb, var\(--accent\) 16%, var\(--app\)\)/);
    expect(tokens).toMatch(/--row-selected-hover-bg:/);
    expect(cssRule(rowSelectionCss, '.table-selection-body > tr[aria-selected="true"]'))
      .toMatch(/background:\s*var\(--row-selected-bg\)/);
    expect(cssRule(rowSelectionCss, '.table-selection-body > tr[aria-selected="true"]:hover'))
      .toMatch(/background:\s*var\(--row-selected-hover-bg\)/);
    expect(cssRule(rowSelectionCss, '.table-selection-body > tr:focus-visible')).toMatch(/outline:/);
    expect(rowSelectionCss).toMatch(/\.table-selection-body\[data-row-dragging="true"\] \*\s*\{[^}]*user-select:\s*none/);
    expect(tokens).not.toMatch(/user-select:\s*none/);
    expect(block(rowSelectionCss, '@media (forced-colors: active)')).toMatch(/background:\s*Highlight;\s*color:\s*HighlightText/);
  });

  it('applies action backgrounds and sizing only to buttons, not same-named status labels', () => {
    const sizing = ':where(button).primary, :where(button).secondary, :where(button).danger';
    expect(cssRule(appCss, sizing)).toMatch(/min-height:\s*34px/);
    for (const variant of ['primary', 'secondary', 'danger']) {
      const selector = `:where(button).${variant}`;
      expect(cssRule(appCss, selector)).toMatch(/background:/);
      const button = document.createElement('button');
      button.className = `${variant} compact-button`;
      const label = document.createElement('span');
      label.className = `cluster-role ${variant}`;
      expect(button.matches(selector)).toBe(true);
      expect(button.matches(sizing)).toBe(true);
      expect(label.matches(selector)).toBe(false);
      expect(label.matches(sizing)).toBe(false);
    }
    expect(appCss).not.toMatch(/^\.(?:primary|secondary|danger)\b/m);
    expect(cssRule(appCss, ':where(button).primary:not(:disabled):hover')).toMatch(/background:/);
    expect(cssRule(appCss, ':where(button).primary:not(:disabled):active')).toMatch(/box-shadow:/);
    expect(cssRule(appCss, ':where(button).secondary:not(:disabled):hover')).toMatch(/background:/);
    expect(cssRule(appCss, '.compact-button')).toMatch(/min-height:\s*30px/);
  });

  it('uses theme text colors for shard roles without giving them filled button backgrounds', () => {
    const roles = cssRule(clusterCss, '.cluster-role');
    expect(roles).toMatch(/color:\s*var\(--muted\)/);
    expect(roles).toMatch(/white-space:\s*nowrap/);
    expect(roles).not.toMatch(/(?:background|box-shadow|padding|min-height):/);
    const primary = cssRule(clusterCss, '.cluster-role[data-role="primary"]');
    expect(primary).toMatch(/color:\s*var\(--text\)/);
    expect(primary).toMatch(/font-weight:\s*500/);
    expect(primary).not.toMatch(/(?:background|box-shadow|padding|min-height):/);
    expect(clusterCss).not.toContain('.cluster-role.primary');
  });

  it('keeps base form rules at element specificity so component classes can win', () => {
    // The old three-`:not` chain outranked `input.query-name`, the DSL editor and the model and
    // visual-query form rules; `:where()` restores them without touching the base look.
    expect(appCss).not.toMatch(/input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\)/);
    expect(appCss).toMatch(/input:where\(:not\(\[type="checkbox"\], \[type="radio"\], \[type="range"\]\)\)/);
    expect(appCss).toMatch(/input\[aria-invalid="true"\], select\[aria-invalid="true"\], textarea\[aria-invalid="true"\]/);
  });

  it('themes checkboxes, radios and ranges uniformly with a forced-colors fallback', () => {
    expect(cssRule(appCss, 'input:where([type="checkbox"], [type="radio"])')).toMatch(/margin:\s*0/);
    expect(appCss).toMatch(/input\[type="range"\]::-webkit-slider-thumb/);
    expect(appCss).toMatch(/input\[type="range"\]::-moz-range-thumb/);
    const forced = block(appCss, '@media (forced-colors: active)');
    expect(forced).toMatch(/input\[type="range"\]\s*\{\s*appearance:\s*auto/);
  });
});

describe('Modal focus restoration', () => {
  it('returns focus to the opener after close', async () => {
    const user = userEvent.setup();
    render(<I18nextProvider i18n={i18n}><ModalHarness /></I18nextProvider>);
    const opener = screen.getByRole('button', { name: '打开对话框' });
    await user.click(opener);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('never forces focus onto an opener that was removed while the dialog was open', async () => {
    const user = userEvent.setup();
    render(<I18nextProvider i18n={i18n}><ModalHarness removable /></I18nextProvider>);
    const opener = screen.getByRole('button', { name: '打开对话框' });
    await user.click(opener);
    await user.click(await screen.findByRole('button', { name: '移除触发按钮' }));
    expect(opener.isConnected).toBe(false);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).not.toBe(opener);
    expect(document.activeElement?.isConnected ?? true).toBe(true);
  });
});
