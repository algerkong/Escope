import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CHART_LIBRARY_VERSION,
  parseChartLibrary,
  parseChartRecord,
  type SavedChartDefinition,
  type SavedChartLibrary,
  type SavedChartRecord,
} from '../../domain/saved-charts';
import type { SavedChartService } from '../../services/saved-charts';
import { errorCode } from '../../services/ipc';

interface State {
  readonly status: 'loading' | 'ready' | 'error';
  readonly record: SavedChartRecord | null;
  readonly saving: boolean;
  readonly error: string | null;
}

const EMPTY_ENTRIES: readonly SavedChartDefinition[] = [];

export interface SavedChartsController {
  readonly status: 'loading' | 'ready' | 'error';
  readonly entries: readonly SavedChartDefinition[];
  readonly saving: boolean;
  readonly error: string | null;
  readonly reload: () => void;
  readonly saveChart: (entry: SavedChartDefinition) => Promise<boolean>;
  readonly deleteChart: (id: string) => Promise<boolean>;
  readonly importCharts: (entries: readonly SavedChartDefinition[]) => Promise<boolean>;
}

export function useSavedCharts(service: SavedChartService): SavedChartsController {
  const [state, setState] = useState<State>({ status: 'loading', record: null, saving: false, error: null });
  const stateRef = useRef(state);
  const generation = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const publish = useCallback((next: State) => { stateRef.current = next; setState(next); }, []);

  const reload = useCallback(() => {
    const token = ++generation.current;
    publish({ status: 'loading', record: null, saving: false, error: null });
    queue.current = queue.current.then(async () => {
      if (generation.current !== token) return;
      try {
        const record = parseChartRecord(await service.load());
        if (!record) throw { code: 'invalidResponse' };
        if (generation.current === token) publish({ status: 'ready', record, saving: false, error: null });
      } catch (error) {
        if (generation.current === token) publish({ status: 'error', record: null, saving: false, error: errorCode(error) });
      }
    });
  }, [publish, service]);

  const invalidate = useCallback(() => { generation.current++; }, []);
  useEffect(() => { reload(); return invalidate; }, [reload, invalidate]);

  const mutate = useCallback((change: (library: SavedChartLibrary) => SavedChartLibrary): Promise<boolean> => {
    const token = generation.current;
    const operation = queue.current.then(async () => {
      const current = stateRef.current;
      if (generation.current !== token || current.status !== 'ready' || !current.record || current.error) return false;
      publish({ ...current, saving: true });
      try {
        const library = parseChartLibrary(change(current.record.library));
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

  const saveChart = useCallback((entry: SavedChartDefinition) => {
    const captured = structuredClone(entry);
    return mutate((library) => {
      const existingIndex = library.entries.findIndex((item) => item.id === captured.id);
      if (existingIndex >= 0) {
        const updated = [...library.entries];
        updated[existingIndex] = captured;
        return { version: CHART_LIBRARY_VERSION, entries: updated };
      }
      return { version: CHART_LIBRARY_VERSION, entries: [...library.entries, captured] };
    });
  }, [mutate]);

  const deleteChart = useCallback((id: string) => {
    return mutate((library) => ({
      version: CHART_LIBRARY_VERSION,
      entries: library.entries.filter((item) => item.id !== id),
    }));
  }, [mutate]);

  const importCharts = useCallback((imported: readonly SavedChartDefinition[]) => {
    return mutate((library) => {
      const existingIds = new Set(library.entries.map((item) => item.id));
      const newEntries = [...library.entries];
      for (const item of imported) {
        if (!existingIds.has(item.id)) {
          existingIds.add(item.id);
          newEntries.push(structuredClone(item));
        }
      }
      return { version: CHART_LIBRARY_VERSION, entries: newEntries };
    });
  }, [mutate]);

  return {
    status: state.status,
    entries: state.record?.library.entries ?? EMPTY_ENTRIES,
    saving: state.saving,
    error: state.error,
    reload,
    saveChart,
    deleteChart,
    importCharts,
  };
}
