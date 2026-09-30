import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en } from './en-US';
import { zh } from './zh-CN';
import { enLive, zhLive } from './query-live';
import { enCluster, zhCluster } from './cluster';

export const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { ...zh, queryLive: zhLive, cluster: zhCluster },
    'en-US': { ...en, queryLive: enLive, cluster: enCluster },
  },
  lng: navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US',
  fallbackLng: 'en-US',
  defaultNS: 'common',
  showSupportNotice: false,
  interpolation: { escapeValue: false },
  initImmediate: false,
});
