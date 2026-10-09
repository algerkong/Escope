import { useCallback, useEffect, useRef, useState } from 'react';
import {
  parseDataViewLibrary, parseDataViewRecord, sameDataView,
  type DataViewDefinition, type DataViewLibrary, type DataViewRecord,
} from '../../domain/data-views';
import type { DataViewService } from '../../services/data-views';
import { errorCode } from '../../services/ipc';

interface State {
  readonly status: 'loading' | 'ready' | 'error';
  readonly record: DataViewRecord | null;
  readonly saving: boolean;
  readonly error: string | null;
}
const EMPTY_ENTRIES: readonly DataViewDefinition[] = [];

export function useDataViews(service: DataViewService) {
  const [state, setState] = useState<State>({ status: 'loading', record: null, saving: false, error: null });
  const stateRef = useRef(state);
  const generation = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const publish = useCallback((next: State) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const reload = useCallback(() => {
    const token = ++generation.current;
    publish({ status: 'loading', record: null, saving: false, error: null });
    // Finish any already-dispatched write before reading its result. Older queued intents skip.
    const loading = queue.current.then(async () => {
      if (generation.current !== token) return;
      try {
        const record = parseDataViewRecord(await service.load());
        if (!record) throw { code: 'invalidResponse' };
        if (generation.current === token) publish({ status: 'ready', record, saving: false, error: null });
      } catch (error) {
        if (generation.current === token) publish({ status: 'error', record: null, saving: false, error: errorCode(error) });
      }
    });
    queue.current = loading;
  }, [publish, service]);

  const invalidate = useCallback(() => { generation.current++; }, []);
  useEffect(() => { reload(); return invalidate; }, [reload, invalidate]);

  const mutate = useCallback((change: (library: DataViewLibrary) => DataViewLibrary): Promise<boolean> => {
    const token = generation.current;
    const operation = queue.current.then(async () => {
      const current = stateRef.current;
      if (generation.current !== token || current.status !== 'ready' || !current.record || current.error) return false;
      publish({ ...current, saving: true });
      try {
        const library = parseDataViewLibrary(change(current.record.library));
        if (!library) throw { code: 'invalidInput' };
        const revision = await service.save(current.record.revision, library);
        if (revision !== current.record.revision + 1) throw { code: 'invalidResponse' };
        if (generation.current !== token) return false;
        publish({ status: 'ready', record: { revision, library }, saving: false, error: null });
        return true;
      } catch (error) {
        // A failed/ambiguous save requires an explicit reload, never a forced overwrite.
        if (generation.current === token) publish({ ...current, saving: false, error: errorCode(error) });
        return false;
      }
    });
    queue.current = operation;
    return operation;
  }, [publish, service]);

  const save = useCallback((entry: DataViewDefinition, expected?: DataViewDefinition) => {
    const captured = { ...entry };
    const reviewed = expected ? { ...expected } : undefined;
    return mutate((library) => {
      const previous = library.entries.find((item) => item.id === captured.id);
      if (reviewed ? !previous || !sameDataView(previous, reviewed) : previous !== undefined) throw { code: 'dataViewConflict' };
      if (previous && previous.connectionId !== captured.connectionId) throw { code: 'invalidInput' };
      return { ...library, entries: previous ? library.entries.map((item) => item.id === captured.id ? captured : item)
        : [...library.entries, captured] };
    });
  }, [mutate]);

  const remove = useCallback((expected: DataViewDefinition) => {
    const reviewed = { ...expected };
    return mutate((library) => {
      const previous = library.entries.find((item) => item.id === reviewed.id);
      if (!previous || !sameDataView(previous, reviewed)) throw { code: 'dataViewConflict' };
      return { ...library, entries: library.entries.filter((item) => item.id !== reviewed.id) };
    });
  }, [mutate]);

  return { status: state.status, entries: state.record?.library.entries ?? EMPTY_ENTRIES,
    saving: state.saving, error: state.error, reload, save, remove };
}

export type DataViewsController = ReturnType<typeof useDataViews>;
