import { isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

export type WindowPlatform = 'browser' | 'windows' | 'linux' | 'macos' | 'unknown';

export interface WindowChromeState {
  maximized: boolean;
  fullscreen: boolean;
}

export interface WindowChrome {
  readonly platform: WindowPlatform;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  // Reports the current state once and then every later change, so callers never run a
  // second read that could race a newer one. Results that resolve after unsubscribe, or
  // after a newer read started, are dropped.
  subscribe(handler: (state: WindowChromeState) => void): () => void;
}

// Tauri has no dedicated maximize or fullscreen event, so both are re-read whenever one
// of these fires. Focus and blur matter because the OS can change the window state while
// the window is in the background.
const STATE_EVENTS = ['tauri://resize', 'tauri://focus', 'tauri://blur'] as const;

// The user agent is only a hint for which window chrome to draw. It is never used for
// authorization, and an unrecognized desktop platform still gets in-app controls.
export function detectWindowPlatform(): WindowPlatform {
  if (!isTauri()) return 'browser';
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/macintosh|mac os x/i.test(agent)) return 'macos';
  if (/windows/i.test(agent)) return 'windows';
  if (/linux|x11/i.test(agent)) return 'linux';
  return 'unknown';
}

function createBrowserChrome(): WindowChrome {
  return {
    platform: 'browser',
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
    subscribe: (handler) => {
      // The browser state is constant and never changes, so it is only reported once.
      handler({ maximized: false, fullscreen: false });
      return () => {};
    },
  };
}

function createDesktopChrome(platform: WindowPlatform): WindowChrome {
  // Resolved per call so a missing runtime handle surfaces as a rejected action or state
  // read that the caller already handles, instead of failing while the module loads.
  const current = () => getCurrentWindow();
  const readState = async (): Promise<WindowChromeState> => {
    const appWindow = current();
    const [maximized, fullscreen] = await Promise.all([appWindow.isMaximized(), appWindow.isFullscreen()]);
    return { maximized, fullscreen };
  };
  return {
    platform,
    minimize: async () => current().minimize(),
    toggleMaximize: async () => current().toggleMaximize(),
    close: async () => current().close(),
    subscribe: (handler) => {
      let disposed = false;
      let generation = 0;
      const listeners: UnlistenFn[] = [];
      const refresh = () => {
        if (disposed) return;
        const request = ++generation;
        // State reads are advisory: a rejected read must not become an unhandled rejection,
        // and a read that resolves after unsubscribe or after a newer read started must not
        // deliver a stale state.
        void readState().then((state) => {
          if (disposed || request !== generation) return;
          handler(state);
        }, () => {});
      };
      for (const event of STATE_EVENTS) {
        // Listener registration resolves asynchronously. A listener that resolves after the
        // caller unsubscribed is removed immediately, and a failed registration stays silent.
        const registration = listen(event, refresh);
        void registration.then((unlisten) => {
          if (disposed) unlisten();
          else listeners.push(unlisten);
        }, () => {});
      }
      // The first read belongs to this subscription, so no caller-side read can overtake it.
      refresh();
      return () => {
        disposed = true;
        for (const unlisten of listeners) unlisten();
        listeners.length = 0;
      };
    },
  };
}

export function createWindowChrome(platform: WindowPlatform = detectWindowPlatform()): WindowChrome {
  return platform === 'browser' ? createBrowserChrome() : createDesktopChrome(platform);
}

export const windowChrome: WindowChrome = createWindowChrome();
