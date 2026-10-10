import type { editor } from 'monaco-editor/editor/editor.api';
import type { QueryEditorRuntime } from './monaco-loader';

interface VerbatimVersion {
  source: string;
  rendered: string;
}

export interface QueryEditorModel {
  readonly model: editor.ITextModel;
  readonly verbatim: Map<number, VerbatimVersion>;
  source: string;
  synchronizing: boolean;
  view: editor.ICodeEditorViewState | null;
}

const modelText = (source: string) => source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

/** Owned by one workspace, not by the currently visible editor or a global model registry. */
export class QueryEditorModels {
  private readonly records = new Map<string, QueryEditorModel>();

  get(runtime: QueryEditorRuntime, id: string, source: string): QueryEditorModel {
    let record = this.records.get(id);
    if (!record) {
      const model = runtime.editor.createModel(modelText(source), 'json',
        runtime.Uri.from({ scheme: 'escope-query', path: `/${crypto.randomUUID()}.json` }));
      model.setEOL(runtime.editor.EndOfLineSequence.LF);
      model.updateOptions({ tabSize: 2, insertSpaces: true, trimAutoWhitespace: false });
      record = { model, source, verbatim: new Map(), synchronizing: false, view: null };
      this.remember(record, source);
      this.records.set(id, record);
    } else this.synchronize(record, source);
    return record;
  }

  private remember(record: QueryEditorModel, source: string) {
    const version = record.model.getAlternativeVersionId();
    const rendered = record.model.getValue();
    if (rendered !== source) record.verbatim.set(version, { source, rendered });
    else record.verbatim.delete(version);
    record.source = source;
  }

  /** Controlled updates are undoable, but never echo back as a second draft mutation. */
  synchronize(record: QueryEditorModel, source: string) {
    if (source === record.source || record.model.isDisposed()) return;
    this.remember(record, record.source);
    record.synchronizing = true;
    try {
      record.model.pushStackElement();
      record.model.pushEditOperations(null, [{ range: record.model.getFullModelRange(), text: modelText(source) }], () => null);
      record.model.pushStackElement();
      this.remember(record, source);
    } finally {
      record.synchronizing = false;
    }
  }

  read(record: QueryEditorModel): string {
    const rendered = record.model.getValue();
    const saved = record.verbatim.get(record.model.getAlternativeVersionId());
    record.source = saved?.rendered === rendered ? saved.source : rendered;
    return record.source;
  }

  retain(ids: readonly string[]) {
    const kept = new Set(ids);
    for (const [id, record] of this.records) {
      if (kept.has(id)) continue;
      record.model.dispose();
      record.verbatim.clear();
      this.records.delete(id);
    }
  }

  dispose() { this.retain([]); }
}
