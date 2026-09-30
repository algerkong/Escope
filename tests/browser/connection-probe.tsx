// Explicit Vite-only UI fixture. This entry is not included in the production build.
import React from 'react';
import ReactDOM from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '../../src/styles/app.css';
import { App } from '../../src/app/App';
import { i18n } from '../../src/locales';
import { createSessionStorage } from '../../src/services/storage';
import type { ConnectionProbe } from '../../src/services/ipc';

const memory = createSessionStorage();
await memory.saveConnection({ displayName: 'Fixture local', endpoint: 'http://fixture.test/slow', environment: 'development' });
await memory.saveConnection({ displayName: 'Fixture forbidden', endpoint: 'https://fixture.test/forbidden', environment: 'production' });
await memory.saveConnection({ displayName: 'Fixture unverified', endpoint: 'https://fixture.test/unverified', environment: 'staging' });
const initial = await memory.load();
initial.preferences.locale = 'en-US';
async function probe(input: ConnectionProbe) {
  const profile = (await memory.load()).connections.find((item) => item.id === input.connectionId)!;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (profile.endpoint.endsWith('/forbidden')) throw { code: 'serverForbidden' };
  const unverified = profile.endpoint.endsWith('/unverified');
  return { ...input, endpoint: profile.endpoint, clusterName: 'Fixture cluster with a long display name',
    clusterUuid: 'fixture-0123456789-abcdefghijklmnopqrstuvwxyz', version: unverified ? '9.0.0' : '7.17.25',
    testedVersion: !unverified, elapsedMs: 1500 };
}
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><I18nextProvider i18n={i18n}>
    <div style={{ position: 'fixed', bottom: 30, right: 8, zIndex: 30, fontSize: 12, background: 'var(--warning-bg)', color: 'var(--warning)', padding: '2px 8px' }}>
      UI fixture / no network
    </div>
    <App service={{ ...memory, kind: 'desktop' }} initial={initial} connectionProbe={probe} />
  </I18nextProvider></React.StrictMode>,
);
