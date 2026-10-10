import type { editor, IDisposable, languages } from 'monaco-editor/editor/editor.api';
import { MAX_COMPLETION_DSL_BYTES, queryCompletions, type QueryCompletion, type QueryCompletionContext } from '../../../domain/query-completions';
import type { QueryEditorRuntime } from './monaco-loader';

export function registerQueryCompletions(
  runtime: QueryEditorRuntime,
  model: editor.ITextModel,
  context: () => QueryCompletionContext | null,
  describe: (completion: QueryCompletion) => string,
): IDisposable {
  let disposed = false;
  const provider: languages.CompletionItemProvider = {
    provideCompletionItems(requested, position, trigger, token) {
      if (disposed || requested !== model || model.isDisposed() || token.isCancellationRequested
        || trigger.triggerKind === runtime.languages.CompletionTriggerKind.TriggerCharacter
        || model.getValueLength() > MAX_COMPLETION_DSL_BYTES) return { suggestions: [] };
      const current = context();
      if (!current) return { suggestions: [] };
      const suggestions = queryCompletions(model.getValue(), model.getOffsetAt(position), current).map((completion) => {
        const start = model.getPositionAt(completion.offset);
        const end = model.getPositionAt(completion.offset + completion.length);
        return {
          label: { label: completion.name, description: describe(completion) },
          kind: completion.origin === 'parameter' ? runtime.languages.CompletionItemKind.Variable : runtime.languages.CompletionItemKind.Field,
          insertText: completion.text, filterText: completion.filterText, sortText: completion.name,
          insertTextRules: runtime.languages.CompletionItemInsertTextRule.None,
          range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column },
        };
      });
      // While an explicitly opened list is filtered, recompute from this model's newest text.
      return { suggestions, incomplete: true };
    },
  };
  const registration = runtime.languages.registerCompletionItemProvider({
    language: 'json', scheme: model.uri.scheme, pattern: model.uri.path,
  }, provider);
  return { dispose: () => { disposed = true; registration.dispose(); } };
}
