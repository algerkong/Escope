import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PINNED_FILTERS_VERSION, parsePinnedFilterLibrary, parsePinnedFilterRecord, samePinnedFilter,
  type PinnedFilterDefinition, type PinnedFilterLibrary, type PinnedFilterRecord,
} from '../../domain/pinned-filters';
import type { PinnedFilterService } from '../../services/pinned-filters';
import { errorCode } from '../../services/ipc';

interface State {
  readonly status: 'loading' | 'ready' | 'error';
  readonly record: PinnedFilterRecord | null;
  readonly saving: boolean;
  readonly error: string | null;
}
const EMPTY_ENTRIES: readonly PinnedFilterDefinition[] = [];

export function usePinnedFilters(service: PinnedFilterService) {
  const [state, setState] = useState<State>({ status: 'loading', record: null, saving: false, error: null });
  const stateRef = useRef(state);
  const generation = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const publish = useCallback((next: State) => { stateRef.current = next; setState(next); }, []);

  const reload = useCallback(() => {
    const token = ++generation.current;
    publish({ status: 'loading', record: null, saving: false, error: null });
    // Read after any dispatched write, but abandon old queued intents and completion callbacks.
    queue.current = queue.current.then(async () => {
      if (generation.current !== token) return;
      try {
        const record = parsePinnedFilterRecord(await service.load());
        if (!record) throw { code: 'invalidResponse' };
        if (generation.current === token) publish({ status: 'ready', record, saving: false, error: null });
      } catch (error) {
        if (generation.current === token) publish({ status: 'error', record: null, saving: false, error: errorCode(error) });
      }
    });
  }, [publish, service]);
  const invalidate = useCallback(() => { generation.current++; }, []);
  useEffect(() => { reload(); return invalidate; }, [reload, invalidate]);

  const mutate = useCallback((change: (library: PinnedFilterLibrary) => PinnedFilterLibrary): Promise<boolean> => {
    const token = generation.current;
    const operation = queue.current.then(async () => {
      const current = stateRef.current;
      if (generation.current !== token || current.status !== 'ready' || !current.record || current.error) return false;
      publish({ ...current, saving: true });
      try {
        const library = parsePinnedFilterLibrary(change(current.record.library));
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

  const save = useCallback((entry: PinnedFilterDefinition) => {
    const captured = structuredClone(entry);
    return mutate((library) => {
      if (library.entries.some((item) => item.id === captured.id)) throw { code: 'pinnedFilterConflict' };
      return { version: PINNED_FILTERS_VERSION, entries: [...library.entries, captured] };
    });
  }, [mutate]);
  const remove = useCallback((entry: PinnedFilterDefinition) => {
    const reviewed = structuredClone(entry);
    return mutate((library) => {
      const previous = library.entries.find((item) => item.id === reviewed.id);
      if (!previous || !samePinnedFilter(previous, reviewed)) throw { code: 'pinnedFilterConflict' };
      return { ...library, entries: library.entries.filter((item) => item.id !== reviewed.id) };
    });
  }, [mutate]);

  return { status: state.status, entries: state.record?.library.entries ?? EMPTY_ENTRIES,
    saving: state.saving, error: state.error, reload, save, remove };
}

export type PinnedFiltersController = ReturnType<typeof usePinnedFilters>;
