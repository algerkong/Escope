import { TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { windowChrome, type WindowChrome, type WindowChromeState } from '../../services/window';
import { WindowControls } from './WindowControls';
import '../../styles/window.css';

const INITIAL_STATE: WindowChromeState = { maximized: false, fullscreen: false };

// Merged title bar: the application header doubles as the window chrome. macOS keeps its
// native traffic lights and only reserves a safe area; other desktop platforms get the
// in-app caption buttons. Dragging and double click to maximize are handled by Tauri's own
// drag region, so this component never registers its own mouse handlers.
export function WindowTitleBar({ chrome = windowChrome, children }: { chrome?: WindowChrome; children: ReactNode }) {
  const { t } = useTranslation();
  const platform = chrome.platform;
  const desktop = platform !== 'browser';
  // A platform that was not recognized must still have a close affordance.
  const showControls = desktop && platform !== 'macos';
  const [state, setState] = useState<WindowChromeState>(INITIAL_STATE);
  const [failure, setFailure] = useState<(() => Promise<void>) | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    // The subscription reports the current state and every later change, so this component
    // never starts its own read that could overwrite a newer state.
    const apply = (next: WindowChromeState) => {
      if (!active) return;
      setState((current) => current.maximized === next.maximized && current.fullscreen === next.fullscreen ? current : next);
    };
    const unsubscribe = chrome.subscribe(apply);
    return () => { active = false; unsubscribe(); };
  }, [chrome]);

  const run = useCallback((action: () => Promise<void>) => {
    setFailure(null);
    // The failed action is kept as state through the updater form so it can be retried.
    void action().catch(() => { if (alive.current) setFailure(() => action); });
  }, []);

  return <>
    <header className="app-header window-titlebar"
      data-window-platform={platform}
      data-window-controls={showControls ? 'true' : undefined}
      data-window-maximized={state.maximized ? 'true' : undefined}
      data-window-fullscreen={state.fullscreen ? 'true' : undefined}
      data-tauri-drag-region={desktop ? 'deep' : undefined}>
      {platform === 'macos' ? <span className="window-traffic-lights" aria-hidden="true" /> : null}
      <div className="window-titlebar-content">{children}</div>
      {showControls ? <WindowControls maximized={state.maximized}
        onMinimize={() => run(() => chrome.minimize())}
        onToggleMaximize={() => run(() => chrome.toggleMaximize())}
        onClose={() => run(() => chrome.close())} /> : null}
    </header>
    {failure ? <div className="notice error global-error" role="alert"><TriangleAlert size={16} />
      <span>{t('window:controlFailed')}</span>
      <button onClick={() => run(failure)}>{t('retry')}</button></div> : null}
  </>;
}
