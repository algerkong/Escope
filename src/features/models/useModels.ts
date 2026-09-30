import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelInput, ModelProfile } from '../../domain/models';
import { errorCode } from '../../services/ipc';
import type { ModelService } from '../../services/models';

/**
 * Load state of the model settings page.
 *
 * `ready.error` is a failed re-read after a change: the list that was already loaded stays visible
 * instead of being replaced by an empty page or a failure screen, and the notice says the stored
 * values were not modified.
 */
export type ModelsLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly code: string }
  | {
    readonly status: 'ready';
    readonly profiles: readonly ModelProfile[];
    readonly defaultModelId: string | null;
    readonly error: string | null;
  };

export interface ModelsController {
  readonly state: ModelsLoad;
  /** True while a change is being written; buttons stay disabled until the re-read finished. */
  readonly busy: boolean;
  readonly reload: () => void;
  /** Writes one profile. Rejects with the backend error so the editor can keep the draft. */
  save: (input: ModelInput, id?: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  select: (id: string | null) => Promise<void>;
}

/**
 * Model profile state for one panel. Nothing here caches a write: every change is re-read from the
 * service, so the list, the order and the default selection always come from the stored data
 * instead of from a second copy of the rules.
 *
 * A stale read never overwrites a newer one (each read carries a token), and no state is written
 * after unmount. `service` is read through a ref, so a caller that re-creates the object on every
 * render cannot restart the initial load.
 */
export function useModels(service: ModelService): ModelsController {
  const [state, setState] = useState<ModelsLoad>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const serviceRef = useRef(service);
  serviceRef.current = service;
  const latest = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const reload = useCallback(() => {
    const token = ++latest.current;
    void (async () => {
      try {
        const loaded = await serviceRef.current.load();
        if (!mounted.current || token !== latest.current) return;
        setState({ status: 'ready', profiles: loaded.profiles, defaultModelId: loaded.defaultModelId, error: null });
      } catch (failure) {
        if (!mounted.current || token !== latest.current) return;
        const code = errorCode(failure);
        setState((previous) => previous.status === 'ready' ? { ...previous, error: code } : { status: 'error', code });
      }
    })();
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const write = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      if (mounted.current) {
        setBusy(false);
        reload();
      }
    }
  }, [reload]);

  return {
    state,
    busy,
    reload,
    save: (input, id) => write(async () => { await serviceRef.current.save(input, id); }),
    remove: (id) => write(() => serviceRef.current.delete(id)),
    select: (id) => write(() => serviceRef.current.select(id)),
  };
}
