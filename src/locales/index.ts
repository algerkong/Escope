import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en } from './en-US';
import { zh } from './zh-CN';
import { enLive, zhLive } from './query-live';
import { enCluster, zhCluster } from './cluster';
import { enModels, zhModels } from './models';
import { enAiChat, zhAiChat } from './ai-chat';
import { enVisualQuery, zhVisualQuery } from './visual-query';
import { enResultGrid, zhResultGrid } from './result-grid';
import { enConnectionSettings, zhConnectionSettings } from './connection-settings';
import { enConnectionAccess, zhConnectionAccess } from './connection-access';
import { enQueryLibrary, zhQueryLibrary } from './query-library';

export const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { ...zh, queryLive: zhLive, cluster: zhCluster, models: zhModels, aiChat: zhAiChat, visualQuery: zhVisualQuery, resultGrid: zhResultGrid,
      connectionSettings: zhConnectionSettings, connectionAccess: zhConnectionAccess, queryLibrary: zhQueryLibrary },
    'en-US': { ...en, queryLive: enLive, cluster: enCluster, models: enModels, aiChat: enAiChat, visualQuery: enVisualQuery, resultGrid: enResultGrid,
      connectionSettings: enConnectionSettings, connectionAccess: enConnectionAccess, queryLibrary: enQueryLibrary },
  },
  lng: navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US',
  fallbackLng: 'en-US',
  defaultNS: 'common',
  showSupportNotice: false,
  interpolation: { escapeValue: false },
  initImmediate: false,
});
