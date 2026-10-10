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
import { enQueryParameters, zhQueryParameters } from './query-parameters';
import { enQueryExchange, zhQueryExchange } from './query-exchange';
import { enQueryExport, zhQueryExport } from './query-export';
import { enDataViews, zhDataViews } from './data-views';
import { enRuntimeFields, zhRuntimeFields } from './runtime-fields';
import { enTimeRange, zhTimeRange } from './query-time-range';
import { enQueryFilters, zhQueryFilters } from './query-filters';
import { enQuerySort, zhQuerySort } from './query-sort';
import { enPinnedFilters, zhPinnedFilters } from './pinned-filters';
import { enQueryHistory, enWorkspaceRecovery, zhQueryHistory, zhWorkspaceRecovery } from './workspace-recovery';

export const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { ...zh, queryLive: zhLive, cluster: zhCluster, models: zhModels, aiChat: zhAiChat, visualQuery: zhVisualQuery, resultGrid: zhResultGrid,
      connectionSettings: zhConnectionSettings, connectionAccess: zhConnectionAccess, queryLibrary: zhQueryLibrary, queryParameters: zhQueryParameters, queryExchange: zhQueryExchange,
      workspaceRecovery: zhWorkspaceRecovery, queryHistory: zhQueryHistory, queryExport: zhQueryExport, dataViews: zhDataViews, runtimeFields: zhRuntimeFields, timeRange: zhTimeRange, queryFilters: zhQueryFilters, querySort: zhQuerySort, pinnedFilters: zhPinnedFilters },
    'en-US': { ...en, queryLive: enLive, cluster: enCluster, models: enModels, aiChat: enAiChat, visualQuery: enVisualQuery, resultGrid: enResultGrid,
      connectionSettings: enConnectionSettings, connectionAccess: enConnectionAccess, queryLibrary: enQueryLibrary, queryParameters: enQueryParameters, queryExchange: enQueryExchange,
      workspaceRecovery: enWorkspaceRecovery, queryHistory: enQueryHistory, queryExport: enQueryExport, dataViews: enDataViews, runtimeFields: enRuntimeFields, timeRange: enTimeRange, queryFilters: enQueryFilters, querySort: enQuerySort, pinnedFilters: enPinnedFilters },
  },
  lng: navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US',
  fallbackLng: 'en-US',
  defaultNS: 'common',
  showSupportNotice: false,
  interpolation: { escapeValue: false },
  initImmediate: false,
});
