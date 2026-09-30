import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { WindowTitleBar } from '../../src/components/window/WindowTitleBar';
import { i18n } from '../../src/locales';
import { createWindowChrome, type WindowChrome, type WindowChromeState, type WindowPlatform } from '../../src/services/window';
import { createSessionStorage } from '../../src/services/storage';

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

interface Harness {
  chrome: WindowChrome;
  minimize: ReturnType<typeof vi.fn>;
  toggleMaximize: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  push: (state: WindowChromeState) => void;
}

// The service reports the current state when subscribing, so the harness does the same.
function harness(platform: WindowPlatform, initial: WindowChromeState = { maximized: false, fullscreen: false }): Harness {
  let handler: ((state: WindowChromeState) => void) | null = null;
  const minimize = vi.fn(async () => {});
  const toggleMaximize = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const unsubscribe = vi.fn();
  const chrome: WindowChrome = {
    platform,
    minimize, toggleMaximize, close,
    subscribe: vi.fn((next: (state: WindowChromeState) => void) => { handler = next; next(initial); return unsubscribe; }),
  };
  return { chrome, minimize, toggleMaximize, close, unsubscribe, push: (state) => handler?.(state) };
}

function renderBar(platform: WindowPlatform, initial?: WindowChromeState) {
  const context = harness(platform, initial);
  const view = render(<I18nextProvider i18n={i18n}><WindowTitleBar chrome={context.chrome}>
    <div className="brand"><strong>EScope</strong></div>
    <div className="header-actions"><button type="button">设置</button></div>
  </WindowTitleBar></I18nextProvider>);
  return { ...context, view };
}

const controls = () => within(screen.getByRole('group', { name: '窗口控制' }));

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
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

describe('merged title bar', () => {
  it('renders the in-app controls and drives minimize, maximize toggle and close', async () => {
    const user = userEvent.setup();
    const context = renderBar('windows');
    const header = screen.getByRole('banner');
    expect(header).toHaveAttribute('data-window-platform', 'windows');
    expect(header).toHaveAttribute('data-window-controls', 'true');
    expect(header).toHaveAttribute('data-tauri-drag-region', 'deep');

    await user.click(controls().getByRole('button', { name: '最小化' }));
    await user.click(controls().getByRole('button', { name: '最大化' }));
    await user.click(controls().getByRole('button', { name: '关闭' }));
    expect(context.minimize).toHaveBeenCalledTimes(1);
    expect(context.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it('keeps the drag region on the bar only, never on interactive controls', () => {
    const context = renderBar('windows');
    const header = screen.getByRole('banner');
    expect(header.querySelectorAll('[data-tauri-drag-region]')).toHaveLength(0);
    for (const button of screen.getAllByRole('button')) {
      expect(button).not.toHaveAttribute('data-tauri-drag-region');
    }
    // Dragging and double click to maximize belong to Tauri's drag region, so this layer must
    // not add a second maximize path that would toggle the window twice.
    fireEvent.mouseDown(header, { button: 0, detail: 1 });
    fireEvent.doubleClick(header, { button: 0, detail: 2 });
    expect(context.toggleMaximize).not.toHaveBeenCalled();
    expect(context.minimize).not.toHaveBeenCalled();
    expect(context.close).not.toHaveBeenCalled();
  });

  it('follows the maximize and fullscreen state without changing the control set', () => {
    const context = renderBar('windows');
    expect(controls().getByRole('button', { name: '最大化' })).toHaveAttribute('aria-pressed', 'false');

    act(() => context.push({ maximized: true, fullscreen: false }));
    const restore = controls().getByRole('button', { name: '还原' });
    expect(restore).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('banner')).toHaveAttribute('data-window-maximized', 'true');
    expect(controls().getAllByRole('button')).toHaveLength(3);

    act(() => context.push({ maximized: false, fullscreen: true }));
    expect(screen.getByRole('banner')).toHaveAttribute('data-window-fullscreen', 'true');
    expect(screen.queryByRole('button', { name: '还原' })).not.toBeInTheDocument();
  });

  it('renders the state reported when subscribing, before any later change', () => {
    const context = renderBar('windows', { maximized: true, fullscreen: true });
    expect(controls().getByRole('button', { name: '还原' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('banner')).toHaveAttribute('data-window-fullscreen', 'true');

    act(() => context.push({ maximized: false, fullscreen: false }));
    expect(controls().getByRole('button', { name: '最大化' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('banner')).not.toHaveAttribute('data-window-fullscreen');
  });

  it.each(['linux', 'unknown'] as const)('keeps the right side controls on %s', (platform) => {
    const context = harness(platform);
    const view = render(<I18nextProvider i18n={i18n}><WindowTitleBar chrome={context.chrome}>brand</WindowTitleBar></I18nextProvider>);
    expect(screen.getByRole('banner')).toHaveAttribute('data-window-platform', platform);
    expect(controls().getAllByRole('button')).toHaveLength(3);
    view.unmount();
  });

  it('keeps the native traffic lights on macOS and never draws duplicate controls', () => {
    const context = renderBar('macos', { maximized: true, fullscreen: false });
    const header = screen.getByRole('banner');
    expect(header).toHaveAttribute('data-window-platform', 'macos');
    expect(header).toHaveAttribute('data-tauri-drag-region', 'deep');
    expect(header).not.toHaveAttribute('data-window-controls');
    expect(screen.queryByRole('group', { name: '窗口控制' })).not.toBeInTheDocument();
    const safeArea = header.querySelector('.window-traffic-lights');
    expect(safeArea).toHaveAttribute('aria-hidden', 'true');
    // The state still arrives on macOS, it is only rendered by the native controls.
    expect(header).toHaveAttribute('data-window-maximized', 'true');
    expect(context.chrome.subscribe).toHaveBeenCalledTimes(1);
  });

  it('reports a failed window action in the active language and retries the same action', async () => {
    const user = userEvent.setup();
    const context = harness('windows');
    context.close.mockRejectedValueOnce({ code: 'permissionDenied' });
    render(<I18nextProvider i18n={i18n}><WindowTitleBar chrome={context.chrome}>brand</WindowTitleBar></I18nextProvider>);

    await user.click(controls().getByRole('button', { name: '关闭' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('窗口操作失败。');
    expect(alert).not.toHaveTextContent('permissionDenied');

    await user.click(within(alert).getByRole('button', { name: '重试' }));
    expect(context.close).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('unsubscribes the window state listener on unmount', () => {
    const context = renderBar('windows');
    expect(context.chrome.subscribe).toHaveBeenCalledTimes(1);
    context.view.unmount();
    expect(context.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('wires the real desktop window service into the controls', async () => {
    const user = userEvent.setup();
    tauri.appWindow.isMaximized.mockResolvedValue(true);
    render(<I18nextProvider i18n={i18n}><WindowTitleBar chrome={createWindowChrome('windows')}>brand</WindowTitleBar></I18nextProvider>);
    await act(async () => {});
    expect(tauri.getCurrentWindow).toHaveBeenCalled();
    expect(tauri.listen).toHaveBeenCalledTimes(3);
    // The subscription itself delivers the first state, so the bar opens on the real one.
    expect(controls().getByRole('button', { name: '还原' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(controls().getByRole('button', { name: '最小化' }));
    expect(tauri.appWindow.minimize).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('banner')).toHaveAttribute('data-tauri-drag-region', 'deep');
  });
});

describe('browser preview window chrome', () => {
  it('renders no desktop controls and never calls the desktop window API', async () => {
    const service = createSessionStorage();
    const initial = await service.load();
    initial.preferences.locale = 'zh-CN';
    render(<I18nextProvider i18n={i18n}><App service={service} initial={initial} /></I18nextProvider>);
    const header = screen.getByRole('banner');
    expect(header).toHaveAttribute('data-window-platform', 'browser');
    expect(header).not.toHaveAttribute('data-tauri-drag-region');
    expect(screen.queryByRole('group', { name: '窗口控制' })).not.toBeInTheDocument();
    expect(tauri.getCurrentWindow).not.toHaveBeenCalled();
    expect(tauri.appWindow.close).not.toHaveBeenCalled();
  });
});
