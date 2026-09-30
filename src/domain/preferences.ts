export interface Preferences {
  mode: 'system' | 'light' | 'dark';
  accent: 'graphite' | 'jade' | 'blue' | 'violet';
  locale: 'system' | 'zh-CN' | 'en-US';
  uiFont: 'plex' | 'system';
  codeFont: 'jetbrains' | 'system';
  uiSize: number;
  codeSize: number;
  tableSize: number;
  density: 'comfortable' | 'compact';
  timeZone: 'system' | 'Asia/Shanghai' | 'UTC';
  dateFormat: 'locale' | 'iso';
  grouping: boolean;
  startAI: boolean;
  startView: 'table' | 'json';
  wrapJson: boolean;
  reduceMotion: boolean;
}

export const defaultPreferences: Readonly<Preferences> = Object.freeze({
  mode: 'system', accent: 'graphite', locale: 'system', uiFont: 'plex', codeFont: 'jetbrains',
  uiSize: 14, codeSize: 13, tableSize: 13, density: 'comfortable', timeZone: 'system',
  dateFormat: 'locale', grouping: true, startAI: false, startView: 'table', wrapJson: true,
  reduceMotion: false,
});

const choices = {
  mode: ['system', 'light', 'dark'], accent: ['graphite', 'jade', 'blue', 'violet'],
  locale: ['system', 'zh-CN', 'en-US'], uiFont: ['plex', 'system'], codeFont: ['jetbrains', 'system'],
  density: ['comfortable', 'compact'], timeZone: ['system', 'Asia/Shanghai', 'UTC'],
  dateFormat: ['locale', 'iso'], startView: ['table', 'json'],
} as const;

export function parsePreferences(value: unknown): Preferences {
  const result = { ...defaultPreferences };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(choices) as (keyof typeof choices)[]) {
    if ((choices[key] as readonly unknown[]).includes(source[key])) {
      Object.assign(result, { [key]: source[key] });
    }
  }
  for (const key of ['uiSize', 'codeSize', 'tableSize'] as const) {
    const size = source[key];
    if (typeof size === 'number' && Number.isInteger(size) && size >= 12 && size <= 20) result[key] = size;
  }
  for (const key of ['grouping', 'startAI', 'wrapJson', 'reduceMotion'] as const) {
    if (typeof source[key] === 'boolean') result[key] = source[key];
  }
  return result;
}

export function resolveLocale(preferences: Preferences, systemLanguage: string): 'zh-CN' | 'en-US' {
  return preferences.locale === 'system'
    ? (systemLanguage.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US')
    : preferences.locale;
}
