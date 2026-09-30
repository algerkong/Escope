import React, { type ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import './styles/app.css';
import { App, applyPreferences } from './app/App';
import { i18n } from './locales';
import { createStorage } from './services/storage';
import { errorCode } from './services/ipc';

class ErrorBoundary extends React.Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <div className="startup-state"><h1>EScope</h1>
      <p>{i18n.t('errors:unexpected')}</p><button className="primary" onClick={() => location.reload()}>{i18n.t('retry')}</button></div> : this.props.children;
  }
}

const root = ReactDOM.createRoot(document.getElementById('root')!);
const service = createStorage();
let disposed = false;
// Entry-module replacement must not leave a root or pending storage callback alive.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposed = true;
    root.unmount();
  });
}
async function boot() {
  root.render(<div className="startup-state"><h1>EScope</h1><p>{i18n.t('loading')}</p></div>);
  try {
    const initial = await service.load();
    if (disposed) return;
    applyPreferences(initial.preferences);
    root.render(<React.StrictMode><I18nextProvider i18n={i18n}><ErrorBoundary>
      <App service={service} initial={initial} />
    </ErrorBoundary></I18nextProvider></React.StrictMode>);
  } catch (error) {
    if (disposed) return;
    root.render(<div className="startup-state" role="alert"><h1>{i18n.t('errors:startup')}</h1>
      <p>{i18n.t(`errors:${errorCode(error)}`)}</p><button className="primary" onClick={() => void boot()}>{i18n.t('retry')}</button></div>);
  }
}
void boot();
