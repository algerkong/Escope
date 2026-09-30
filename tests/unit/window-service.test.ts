import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWindowChrome, detectWindowPlatform, windowChrome, type WindowChromeState } from '../../src/services/window';

const tauri = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(),
  appWindow: {
    minimize: vi.fn<() => Promise<void>>(),
    toggleMaximize: vi.fn<() => Promise<void>>(),
    close: vi.fn<() => Promise<void>>(),
    isMaximized: vi.fn<() => Promise<boolean>>(),
    isFullscreen: vi.fn<() => Promise<boolean>>(),
  },
  getCurrentWindow: vi.fn(),
  listen: vi.fn<(event: string, handler: () => void) => Promise<() => void>>(),
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: tauri.isTauri }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: tauri.getCurrentWindow }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));

function userAgent(agent: string) {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(agent);
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// A rejected listener registration or state read must never surface as an unhandled rejection.
async function expectNoUnhandledRejection(body: () => void | Promise<void>) {
  const seen = vi.fn();
  process.on('unhandledRejection', seen);
  await body();
  await flush();
  await flush();
  process.off('unhandledRejection', seen);
  expect(seen).not.toHaveBeenCalled();
}

beforeEach(() => {
  tauri.isTauri.mockReturnValue(false);
  tauri.getCurrentWindow.mockReset();
  tauri.getCurrentWindow.mockReturnValue(tauri.appWindow);
  tauri.appWindow.minimize.mockResolvedValue(undefined);
  tauri.appWindow.toggleMaximize.mockResolvedValue(undefined);
  tauri.appWindow.close.mockResolvedValue(undefined);
  tauri.appWindow.isMaximized.mockResolvedValue(false);
  tauri.appWindow.isFullscreen.mockResolvedValue(false);
  tauri.listen.mockReset();
  tauri.listen.mockResolvedValue(() => {});
});

describe('window platform detection', () => {
  it('stays in browser mode without the desktop runtime, whatever the user agent claims', () => {
    userAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    expect(detectWindowPlatform()).toBe('browser');
  });

  it.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'windows'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 'macos'],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15', 'linux'],
    ['Mozilla/5.0 (Unknown; rv:1.0)', 'unknown'],
    ['', 'unknown'],
  ])('maps %s to %s in the desktop runtime', (agent, expected) => {
    tauri.isTauri.mockReturnValue(true);
    userAgent(agent);
    expect(detectWindowPlatform()).toBe(expected);
  });
});

describe('browser window chrome', () => {
  it('never touches the desktop API and reports a constant state once', async () => {
    const chrome = createWindowChrome('browser');
    const handler = vi.fn();
    const unsubscribe = chrome.subscribe(handler);
    expect(handler).toHaveBeenCalledExactlyOnceWith({ maximized: false, fullscreen: false });
    await expect(chrome.minimize()).resolves.toBeUndefined();
    await expect(chrome.toggleMaximize()).resolves.toBeUndefined();
    await expect(chrome.close()).resolves.toBeUndefined();
    unsubscribe();
    unsubscribe();
    expect(tauri.getCurrentWindow).not.toHaveBeenCalled();
    expect(tauri.listen).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('keeps the default export on the browser branch outside the desktop runtime', () => {
    expect(windowChrome.platform).toBe('browser');
  });
});

describe('desktop window chrome', () => {
  it('rejects unavailable runtime handles through the async action contract', async () => {
    tauri.getCurrentWindow.mockImplementation(() => { throw new Error('runtime unavailable'); });
    const chrome = createWindowChrome('windows');
    await expect(chrome.minimize()).rejects.toThrow('runtime unavailable');
    await expect(chrome.toggleMaximize()).rejects.toThrow('runtime unavailable');
    await expect(chrome.close()).rejects.toThrow('runtime unavailable');
  });

  it('forwards minimize, maximize toggle and close to the current window', async () => {
    const chrome = createWindowChrome('windows');
    await chrome.minimize();
    await chrome.toggleMaximize();
    await chrome.close();
    expect(tauri.getCurrentWindow).toHaveBeenCalled();
    expect(tauri.appWindow.minimize).toHaveBeenCalledTimes(1);
    expect(tauri.appWindow.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(tauri.appWindow.close).toHaveBeenCalledTimes(1);
  });

  it('reports the current maximize and fullscreen state when subscribing', async () => {
    tauri.appWindow.isMaximized.mockResolvedValue(true);
    tauri.appWindow.isFullscreen.mockResolvedValue(true);
    const states: WindowChromeState[] = [];
    createWindowChrome('linux').subscribe((state) => { states.push(state); });
    await flush();
    expect(states).toEqual([{ maximized: true, fullscreen: true }]);
    expect(tauri.getCurrentWindow).toHaveBeenCalled();
  });

  it('re-reads the state on resize, focus and blur', async () => {
    const handlers = new Map<string, () => void>();
    tauri.listen.mockImplementation(async (event, handler) => {
      handlers.set(event, handler);
      return () => { handlers.delete(event); };
    });
    const chrome = createWindowChrome('windows');
    const states: WindowChromeState[] = [];
    const unsubscribe = chrome.subscribe((state) => { states.push(state); });
    await flush();
    expect([...handlers.keys()]).toEqual(['tauri://resize', 'tauri://focus', 'tauri://blur']);
    expect(states).toEqual([{ maximized: false, fullscreen: false }]);

    tauri.appWindow.isMaximized.mockResolvedValue(true);
    handlers.get('tauri://resize')!();
    await flush();
    expect(states.at(-1)).toEqual({ maximized: true, fullscreen: false });

    tauri.appWindow.isFullscreen.mockResolvedValue(true);
    handlers.get('tauri://focus')!();
    await flush();
    expect(states.at(-1)).toEqual({ maximized: true, fullscreen: true });
    expect(states).toHaveLength(3);

    unsubscribe();
    handlers.get('tauri://blur')?.();
    await flush();
    expect(states).toHaveLength(3);
  });

  it('drops a read that resolves after a newer read started', async () => {
    const gates: { resolve: (value: boolean) => void }[] = [];
    const gate = () => new Promise<boolean>((resolve) => { gates.push({ resolve }); });
    tauri.appWindow.isMaximized.mockImplementation(gate);
    tauri.appWindow.isFullscreen.mockImplementation(gate);

    const handlers = new Map<string, () => void>();
    tauri.listen.mockImplementation(async (event, handler) => {
      handlers.set(event, handler);
      return () => { handlers.delete(event); };
    });
    const states: WindowChromeState[] = [];
    createWindowChrome('windows').subscribe((state) => { states.push(state); });
    // Read 1 is the initial one, read 2 is triggered by the resize event.
    handlers.get('tauri://resize')!();
    expect(gates).toHaveLength(4);

    // The newer read resolves first and wins.
    gates[2]!.resolve(true);
    gates[3]!.resolve(false);
    await flush();
    expect(states).toEqual([{ maximized: true, fullscreen: false }]);

    // The older read resolving later must not overwrite the newer state.
    gates[0]!.resolve(false);
    gates[1]!.resolve(true);
    await flush();
    expect(states).toEqual([{ maximized: true, fullscreen: false }]);
  });

  it('drops a read that resolves after unsubscribe', async () => {
    const gates: { resolve: (value: boolean) => void }[] = [];
    const gate = () => new Promise<boolean>((resolve) => { gates.push({ resolve }); });
    tauri.appWindow.isMaximized.mockImplementation(gate);
    tauri.appWindow.isFullscreen.mockImplementation(gate);

    const handler = vi.fn();
    const unsubscribe = createWindowChrome('windows').subscribe(handler);
    expect(gates).toHaveLength(2);
    unsubscribe();
    for (const item of gates) item.resolve(true);
    await flush();
    expect(handler).not.toHaveBeenCalled();
  });

  it('unsubscribes every listener exactly once and cleans up late registrations', async () => {
    const resolvers: (() => void)[] = [];
    const unlisten = vi.fn();
    tauri.listen.mockImplementation(() => new Promise((resolve) => {
      resolvers.push(() => resolve(unlisten));
    }));
    const chrome = createWindowChrome('macos');
    const unsubscribe = chrome.subscribe(() => {});
    expect(tauri.listen).toHaveBeenCalledTimes(3);

    unsubscribe();
    unsubscribe();
    expect(unlisten).not.toHaveBeenCalled();
    for (const resolve of resolvers) resolve();
    await flush();
    expect(unlisten).toHaveBeenCalledTimes(3);
  });

  it('stays silent when a listener registration or a state read fails', async () => {
    await expectNoUnhandledRejection(async () => {
      tauri.listen.mockRejectedValue({ code: 'permissionDenied' });
      tauri.appWindow.isMaximized.mockRejectedValue({ code: 'permissionDenied' });
      tauri.appWindow.isFullscreen.mockRejectedValue({ code: 'permissionDenied' });
      const chrome = createWindowChrome('windows');
      const handler = vi.fn();
      const unsubscribe = chrome.subscribe(handler);
      await flush();
      expect(handler).not.toHaveBeenCalled();
      unsubscribe();
    });
  });

  it('propagates a failed window action to the caller', async () => {
    tauri.appWindow.close.mockRejectedValue({ code: 'permissionDenied' });
    await expect(createWindowChrome('windows').close()).rejects.toEqual({ code: 'permissionDenied' });
  });
});
