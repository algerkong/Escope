import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelCredentialChange } from '../../domain/model-access';
import type { ModelInput, ModelProfile } from '../../domain/models';
import { modelErrorCode, type ModelService } from '../../services/models';

/**
 * Load state of the model settings page.
 *
 * `ready.error` is a failed re-read after a change: the list that was already loaded stays visible
 * instead of being replaced by an empty page or a failure screen, and the notice says the stored
 * values were not modified. `credentialCleanupPending` reports keys the backend could not remove
 * yet; a committed save with pending cleanup is a stored change, not a failed save.
 */
export type ModelsLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly code: string }
  | {
    readonly status: 'ready';
    readonly profiles: readonly ModelProfile[];
    readonly defaultModelId: string | null;
    readonly credentialCleanupPending: boolean;
    /** A re-read is in flight; the visible list is not yet confirmed. */
    readonly refreshing: boolean;
    readonly error: string | null;
  };

export interface ModelsController {
  readonly state: ModelsLoad;
  /** True while a change is being written; buttons stay disabled until the re-read finished. */
  readonly busy: boolean;
  readonly reload: () => void;
  /** Writes one profile together with a credential change. Rejects so the editor can keep the draft. */
  save: (input: ModelInput, id?: string, credential?: ModelCredentialChange) => Promise<void>;
  remove: (id: string) => Promise<void>;
  select: (id: string | null) => Promise<void>;
  /** Retries the backend's pending credential cleanup; resolves to true when nothing is left. */
  cleanup: () => Promise<boolean>;
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

  const load = useCallback(async () => {
    const token = ++latest.current;
    // While a re-read is in flight the visible list is not confirmed: mark it so callers can block
    // mutations and generation tests instead of acting on possibly stale rows.
    setState((current) => current.status === 'ready' ? { ...current, refreshing: true } : { status: 'loading' });
    try {
      const loaded = await serviceRef.current.load();
      if (!mounted.current || token !== latest.current) return;
      setState({
        status: 'ready',
        profiles: loaded.profiles,
        defaultModelId: loaded.defaultModelId,
        credentialCleanupPending: loaded.credentialCleanupPending,
        refreshing: false,
        error: null,
      });
    } catch (failure) {
      if (!mounted.current || token !== latest.current) return;
      const code = modelErrorCode(failure);
      setState((previous) => previous.status === 'ready'
        ? { ...previous, refreshing: false, error: code }
        : { status: 'error', code });
    }
  }, []);

  const reload = useCallback(() => { void load(); }, [load]);

  useEffect(() => { void load(); }, [load]);

  const write = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      if (mounted.current) {
        // Busy spans the re-read, so a caller never observes a released lock and stale rows.
        await load();
        if (mounted.current) setBusy(false);
      }
    }
  }, [load]);

  return {
    state,
    busy,
    reload,
    save: (input, id, credential) => write(async () => {
      await serviceRef.current.save(input, id, credential);
    }),
    remove: (id) => write(() => serviceRef.current.delete(id)),
    select: (id) => write(() => serviceRef.current.select(id)),
    cleanup: async () => {
      setBusy(true);
      try {
        return await serviceRef.current.cleanupCredentials();
      } finally {
        if (mounted.current) {
          await load();
          if (mounted.current) setBusy(false);
        }
      }
    },
  };
}
