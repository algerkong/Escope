import type { editor } from 'monaco-editor/editor/editor.api';
import type { Preferences } from '../../../domain/preferences';

export function queryEditorOptions(preferences: Preferences, label: string, readOnly: boolean): editor.IStandaloneEditorConstructionOptions {
  return {
    model: null, ariaLabel: label, readOnly, domReadOnly: readOnly, editContext: false,
    automaticLayout: true, minimap: { enabled: false }, glyphMargin: false, lineNumbersMinChars: 3,
    scrollBeyondLastLine: false, scrollBeyondLastColumn: 3, overviewRulerLanes: 0,
    wordWrap: preferences.wrapJson ? 'on' : 'off', wordBasedSuggestions: 'off',
    fontFamily: preferences.codeFont === 'jetbrains'
      ? '"JetBrains Mono", "Cascadia Code", Consolas, monospace' : '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
    fontSize: preferences.codeSize, lineHeight: Math.round(preferences.codeSize * (preferences.density === 'compact' ? 1.6 : 1.8)),
    padding: { top: preferences.density === 'compact' ? 8 : 12, bottom: preferences.density === 'compact' ? 8 : 12 },
    fontLigatures: false, letterSpacing: 0, mouseWheelZoom: false, smoothScrolling: false,
    cursorBlinking: preferences.reduceMotion ? 'solid' : 'blink', cursorSmoothCaretAnimation: 'off',
    contextmenu: false, links: false, hover: { enabled: 'off' }, stickyScroll: { enabled: false },
    quickSuggestions: false, suggestOnTriggerCharacters: false, parameterHints: { enabled: false },
    acceptSuggestionOnEnter: 'off', acceptSuggestionOnCommitCharacter: false, tabCompletion: 'off',
    snippetSuggestions: 'none', suggestSelection: 'first', inlineSuggest: { enabled: false }, suggest: {
      selectionMode: 'never', shareSuggestSelections: false, localityBonus: false, preview: false,
      showStatusBar: false, insertMode: 'replace',
    },
    occurrencesHighlight: 'off', selectionHighlight: false, bracketPairColorization: { enabled: false },
    formatOnPaste: false, formatOnType: false, autoIndent: 'keep', autoIndentOnPaste: false, trimAutoWhitespace: false,
    unusualLineTerminators: 'off', unicodeHighlight: { ambiguousCharacters: false, nonBasicASCII: false },
    dropIntoEditor: { enabled: false }, pasteAs: { enabled: false }, tabFocusMode: true,
    accessibilitySupport: 'auto', renderValidationDecorations: 'on', renderLineHighlight: 'line',
  };
}

export function queryEditorTheme(root: HTMLElement, highContrast: boolean): editor.IStandaloneThemeData {
  const dark = root.dataset.theme === 'dark';
  if (highContrast) return { base: dark ? 'hc-black' : 'hc-light', inherit: true, rules: [], colors: {} };
  const style = getComputedStyle(root);
  const color = (name: string, light: string, night: string) => {
    const value = style.getPropertyValue(name).trim();
    return /^#[\da-f]{6}$/i.test(value) ? value : /^#[\da-f]{3}$/i.test(value)
      ? `#${value.slice(1).split('').map((part) => part + part).join('')}` : dark ? night : light;
  };
  const text = color('--text', '#24262a', '#ecedef');
  const muted = color('--muted', '#646870', '#adb1ba');
  const accent = color('--accent', '#292c31', '#e4e6ea');
  const border = color('--border', '#e5e6e9', '#34373d');
  const success = color('--success', '#087c69', '#6cdbc1');
  const warning = color('--warning', '#876012', '#eaca7d');
  return {
    base: dark ? 'vs-dark' : 'vs', inherit: true,
    rules: [
      { token: 'string.key.json', foreground: text.slice(1) },
      { token: 'string.value.json', foreground: success.slice(1) },
      { token: 'number.json', foreground: warning.slice(1) },
      { token: 'keyword.json', foreground: warning.slice(1) },
    ],
    colors: {
      'editor.background': color('--subtle', '#f4f5f6', '#222427'), 'editor.foreground': text,
      'editorLineNumber.foreground': muted, 'editorLineNumber.activeForeground': text,
      'editorCursor.foreground': accent, 'editor.selectionBackground': `${accent}33`,
      'editor.inactiveSelectionBackground': `${accent}22`, 'editor.lineHighlightBorder': '#00000000',
      'editor.lineHighlightBackground': color('--app', '#ffffff', '#191a1c'),
      'editorBracketMatch.background': `${accent}22`, 'editorBracketMatch.border': accent,
      'editorError.foreground': color('--error', '#b42337', '#ffa6b1'), 'editorWarning.foreground': warning,
      'editorWidget.background': color('--elevated', '#ffffff', '#282a2e'), 'editorWidget.border': border,
      'editorSuggestWidget.background': color('--elevated', '#ffffff', '#282a2e'),
      'editorSuggestWidget.border': border, 'editorSuggestWidget.foreground': text,
      'editorSuggestWidget.selectedBackground': `${accent}29`,
      'editorSuggestWidget.selectedForeground': text, 'editorSuggestWidget.highlightForeground': success,
      'editorSuggestWidget.focusHighlightForeground': success,
      'scrollbarSlider.background': `${muted}55`, 'scrollbarSlider.hoverBackground': `${muted}88`,
      'scrollbarSlider.activeBackground': `${muted}aa`, focusBorder: accent,
    },
  };
}
