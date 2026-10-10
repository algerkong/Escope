declare module 'monaco-editor/languages/features/json/tokenization' {
  import type { languages } from 'monaco-editor/editor/editor.api';
  /** Lexical provider shipped by the pinned Monaco version; no JSON language-service worker. */
  export function createTokenizationSupport(supportComments: boolean): languages.TokensProvider;
}
