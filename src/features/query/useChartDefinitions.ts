import { useCallback, useEffect, useRef, useState } from 'react';
import {
  parseChartDefinitionLibrary, parseChartDefinitionRecord, sameChartDefinition,
  type ChartDefinition, type ChartDefinitionLibrary, type ChartDefinitionRecord,
} from '../../domain/chart-definitions';
import type { ChartDefinitionService } from '../../services/chart-definitions';
import { errorCode } from '../../services/ipc';

interface State {
  readonly status: 'loading' | 'ready' | 'error';
  readonly record: ChartDefinitionRecord | null;
  readonly saving: boolean;
  readonly error: string | null;
}
const EMPTY_ENTRIES: readonly ChartDefinition[] = [];

/**
 * Serial library access for saved chart definitions. Writes compare the revision the caller
 * reviewed; a failure or an ambiguous completion leaves the stored library untouched and asks for
 * an explicit reload instead of overwriting. Loading never runs a query.
 */
export function useChartDefinitions(service: ChartDefinitionService) {
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
    const loading = queue.current.then(async () => {
      if (generation.current !== token) return;
      try {
        const record = parseChartDefinitionRecord(await service.load());
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

  const mutate = useCallback((change: (library: ChartDefinitionLibrary) => ChartDefinitionLibrary): Promise<boolean> => {
    const token = generation.current;
    const operation = queue.current.then(async () => {
      const current = stateRef.current;
      if (generation.current !== token || current.status !== 'ready' || !current.record || current.error) return false;
      publish({ ...current, saving: true });
      try {
        const library = parseChartDefinitionLibrary(change(current.record.library));
        if (!library) throw { code: 'invalidInput' };
        const revision = await service.save(current.record.revision, library);
        if (revision !== current.record.revision + 1) throw { code: 'invalidResponse' };
        if (generation.current !== token) return false;
        publish({ status: 'ready', record: { revision, library }, saving: false, error: null });
        return true;
      } catch (error) {
        if (generation.current === token) publish({ ...current, saving: false, error: errorCode(error) });
        return false;
      }
    });
    queue.current = operation;
    return operation;
  }, [publish, service]);

  const save = useCallback((entry: ChartDefinition, expected?: ChartDefinition) => {
    const captured = structuredClone(entry);
    const reviewed = expected ? structuredClone(expected) : undefined;
    return mutate((library) => {
      const previous = library.entries.find((item) => item.id === captured.id);
      if (reviewed ? !previous || !sameChartDefinition(previous, reviewed) : previous !== undefined) throw { code: 'chartDefinitionConflict' };
      if (previous && previous.connectionId !== captured.connectionId) throw { code: 'invalidInput' };
      return { ...library, entries: previous ? library.entries.map((item) => item.id === captured.id ? captured : item)
        : [...library.entries, captured] };
    });
  }, [mutate]);

  const remove = useCallback((expected: ChartDefinition) => {
    const reviewed = structuredClone(expected);
    return mutate((library) => {
      const previous = library.entries.find((item) => item.id === reviewed.id);
      if (!previous || !sameChartDefinition(previous, reviewed)) throw { code: 'chartDefinitionConflict' };
      return { ...library, entries: library.entries.filter((item) => item.id !== reviewed.id) };
    });
  }, [mutate]);

  return { status: state.status, entries: state.record?.library.entries ?? EMPTY_ENTRIES,
    saving: state.saving, error: state.error, reload, save, remove };
}

export type ChartDefinitionsController = ReturnType<typeof useChartDefinitions>;
