import * as monaco from 'monaco-editor/editor/editor.api';
import { createTokenizationSupport } from 'monaco-editor/languages/features/json/tokenization';
import 'monaco-editor/features/codeEditor/register';
import 'monaco-editor/features/codicon/register';
import 'monaco-editor/features/bracketMatching/register';
import 'monaco-editor/features/clipboard/register';
import 'monaco-editor/features/cursorUndo/register';
import 'monaco-editor/features/wordOperations/register';
import 'monaco-editor/features/linesOperations/register';
import 'monaco-editor/features/multicursor/register';
import 'monaco-editor/features/readOnlyMessage/register';
import 'monaco-editor/features/tokenization/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

export const { editor, Uri, MarkerSeverity } = monaco;

const workerFailures = new Set<() => void>();
let workerFailed = false;

function reportWorkerFailure() {
  workerFailed = true;
  for (const listener of workerFailures) listener();
}

export function onWorkerFailure(listener: () => void): monaco.IDisposable {
  workerFailures.add(listener);
  if (workerFailed) listener();
  return { dispose: () => { workerFailures.delete(listener); } };
}

globalThis.MonacoEnvironment = {
  getWorker: (_moduleId, label) => {
    if (label !== 'editorWorkerService') throw new Error('unsupportedQueryEditorWorker');
    try {
      const worker = new EditorWorker();
      worker.addEventListener('error', reportWorkerFailure);
      worker.addEventListener('messageerror', reportWorkerFailure);
      return worker;
    } catch {
      reportWorkerFailure();
      throw new Error('queryEditorWorkerUnavailable');
    }
  },
};

// Import only Monaco's lexical provider, not its JSON language service or schema resolver.
monaco.languages.register({ id: 'json', aliases: ['JSON'], extensions: ['.json'] });
monaco.languages.setTokensProvider('json', createTokenizationSupport(false));
monaco.languages.setLanguageConfiguration('json', {
  brackets: [['{', '}'], ['[', ']']],
  autoClosingPairs: [
    { open: '{', close: '}', notIn: ['string'] },
    { open: '[', close: ']', notIn: ['string'] },
    { open: '"', close: '"', notIn: ['string'] },
  ],
});
