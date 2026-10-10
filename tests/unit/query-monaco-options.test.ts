import { afterEach, describe, expect, it } from 'vitest';
import { queryEditorOptions, queryEditorTheme } from '../../src/features/query/editor/monaco-options';
import { defaultPreferences } from '../../src/domain/preferences';

afterEach(() => {
  document.documentElement.removeAttribute('style');
  delete document.documentElement.dataset.theme;
});

describe('Monaco query options and semantic theme', () => {
  it('keeps language services, external links, implicit formatting, rich paste and cross-document suggestions off', () => {
    expect(queryEditorOptions(defaultPreferences, 'Query DSL', false)).toMatchObject({
      ariaLabel: 'Query DSL', readOnly: false, domReadOnly: false, editContext: false,
      wordBasedSuggestions: 'off', links: false, contextmenu: false, quickSuggestions: false,
      suggestOnTriggerCharacters: false, formatOnPaste: false, formatOnType: false,
      autoIndentOnPaste: false, trimAutoWhitespace: false, unusualLineTerminators: 'off',
      dropIntoEditor: { enabled: false }, pasteAs: { enabled: false },
    });
  });

  it('honors code font/size, wrap, density, reduced motion and a keyboard escape from the editor', () => {
    expect(queryEditorOptions({
      ...defaultPreferences, codeFont: 'system', codeSize: 20, density: 'compact', wrapJson: false, reduceMotion: true,
    }, '查询 DSL', true)).toMatchObject({
      fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace', fontSize: 20, lineHeight: 32,
      wordWrap: 'off', padding: { top: 8, bottom: 8 }, readOnly: true, domReadOnly: true,
      tabFocusMode: true, cursorBlinking: 'solid', letterSpacing: 0, mouseWheelZoom: false,
    });
  });

  it('uses existing semantic tokens for text, data roles, focus and selections', () => {
    const root = document.documentElement;
    root.style.setProperty('--subtle', '#eee');
    root.style.setProperty('--accent', '#087c69');
    root.style.setProperty('--text', '#111111');
    root.style.setProperty('--success', '#127658');
    const theme = queryEditorTheme(root, false);
    expect(theme.colors).toMatchObject({
      'editor.background': '#eeeeee', 'editor.foreground': '#111111',
      'editorCursor.foreground': '#087c69', 'editor.selectionBackground': '#087c6933',
    });
    expect(theme.rules).toContainEqual({ token: 'string.value.json', foreground: '127658' });
  });

  it('provides dark fallbacks and preserves native high-contrast themes', () => {
    const root = document.documentElement;
    root.dataset.theme = 'dark';
    expect(queryEditorTheme(root, false)).toMatchObject({
      base: 'vs-dark', colors: { 'editor.background': '#222427', 'editor.foreground': '#ecedef' },
    });
    expect(queryEditorTheme(root, true)).toEqual({ base: 'hc-black', inherit: true, rules: [], colors: {} });
    root.dataset.theme = 'light';
    expect(queryEditorTheme(root, true).base).toBe('hc-light');
  });
});
