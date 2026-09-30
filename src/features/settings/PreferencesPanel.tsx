import { Monitor, Moon, Sun, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { defaultPreferences, type Preferences } from '../../domain/preferences';
import { IconButton, SettingRow, Toggle } from '../../components/controls';
import type { SettingsRoute } from '../../app/routes';

export function PreferencesPanel({ route, preferences: p, update }:
  { route: SettingsRoute; preferences: Preferences; update: (patch: Partial<Preferences>) => void }) {
  const { t } = useTranslation();
  const toggle = (key: 'grouping' | 'startAI' | 'wrapJson' | 'reduceMotion') =>
    <SettingRow label={t(`settings:${key}`)} htmlFor={key}>
      <Toggle id={key} label={t(`settings:${key}`)} checked={p[key]} onChange={(value) => update({ [key]: value })} />
    </SettingRow>;
  const select = <K extends keyof Preferences>(key: K, options: { value: Preferences[K]; label: string }[]) =>
    <select id={key} value={String(p[key])} onChange={(event) => update({ [key]: event.target.value })}>
      {options.map((option) => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}
    </select>;
  const resetGeneral = () => {
    const { timeZone, dateFormat, grouping, startAI, startView, wrapJson } = defaultPreferences;
    update({ timeZone, dateFormat, grouping, startAI, startView, wrapJson });
  };
  const resetTypography = () => {
    const { uiFont, codeFont, uiSize, codeSize, tableSize, density } = defaultPreferences;
    update({ uiFont, codeFont, uiSize, codeSize, tableSize, density });
  };

  if (route === 'general') return <>
    <div className="section-heading"><h2>{t('settings:languageFormat')}</h2>
      <IconButton icon={RotateCcw} label={t('restore')} onClick={resetGeneral} /></div>
    <div className="settings-section">
      <SettingRow label={t('settings:language')} htmlFor="locale">{select('locale', [
        { value: 'system', label: t('settings:system') }, { value: 'zh-CN', label: '简体中文' }, { value: 'en-US', label: 'English' },
      ])}</SettingRow>
      <SettingRow label={t('settings:timeZone')} htmlFor="timeZone">{select('timeZone', [
        { value: 'system', label: t('settings:system') }, { value: 'Asia/Shanghai', label: t('settings:beijing') }, { value: 'UTC', label: 'UTC' },
      ])}</SettingRow>
      <SettingRow label={t('settings:dateFormat')} htmlFor="dateFormat">{select('dateFormat', [
        { value: 'locale', label: t('settings:localeDate') }, { value: 'iso', label: t('settings:isoDate') },
      ])}</SettingRow>
      {toggle('grouping')}
    </div>
    <div className="section-heading"><h2>{t('settings:startup')}</h2></div>
    <div className="settings-section">
      {toggle('startAI')}
      <SettingRow label={t('settings:startView')} htmlFor="startView">{select('startView', [
        { value: 'table', label: t('query:table') }, { value: 'json', label: 'JSON' },
      ])}</SettingRow>
      {toggle('wrapJson')}
    </div>
  </>;

  if (route === 'appearance') return <>
    <div className="section-heading"><h2>{t('settings:theme')}</h2>
      <IconButton icon={RotateCcw} label={t('restore')} onClick={() => update({
        mode: defaultPreferences.mode, accent: defaultPreferences.accent, reduceMotion: defaultPreferences.reduceMotion,
      })} /></div>
    <div className="theme-options" role="group" aria-label={t('settings:theme')}>
      {([{ value: 'system', icon: Monitor }, { value: 'light', icon: Sun }, { value: 'dark', icon: Moon }] as const).map(({ value, icon: Icon }) =>
        <button className="theme-option" aria-pressed={p.mode === value} key={value} onClick={() => update({ mode: value })}>
          <span className={`theme-miniature ${value}`} aria-hidden="true"><span /><span><i /><i /><i /></span></span>
          <span><Icon size={16} />{t(`settings:${value}`)}</span>
        </button>)}
    </div>
    <div className="settings-section">
      <SettingRow label={t('settings:accent')}>
        <div className="swatches" role="group" aria-label={t('settings:accent')}>
          {(['graphite', 'jade', 'blue', 'violet'] as const).map((accent) =>
            <button type="button" className={`swatch ${accent}`} key={accent} title={t(`settings:${accent}`)}
              aria-label={t(`settings:${accent}`)} aria-pressed={p.accent === accent} onClick={() => update({ accent })} />)}
        </div>
      </SettingRow>
      {toggle('reduceMotion')}
    </div>
  </>;

  if (route === 'typography') return <>
    <div className="section-heading"><h2>{t('settings:fontFamily')}</h2><IconButton icon={RotateCcw} label={t('restore')} onClick={resetTypography} /></div>
    <div className="settings-section">
      <SettingRow label={t('settings:uiFont')} htmlFor="uiFont">{select('uiFont', [
        { value: 'plex', label: 'IBM Plex Sans' }, { value: 'system', label: t('settings:systemFont') },
      ])}</SettingRow>
      <SettingRow label={t('settings:codeFont')} htmlFor="codeFont">{select('codeFont', [
        { value: 'jetbrains', label: 'JetBrains Mono' }, { value: 'system', label: t('settings:systemFont') },
      ])}</SettingRow>
    </div>
    <div className="section-heading"><h2>{t('settings:fontSizes')}</h2></div>
    <div className="settings-section">
      {(['uiSize', 'codeSize', 'tableSize'] as const).map((key) =>
        <SettingRow key={key} label={t(`settings:${key}`)} htmlFor={key}>
          <input type="range" id={key} min={12} max={20} step={1} value={p[key]}
            onChange={(event) => update({ [key]: Number(event.target.value) })} />
          <output htmlFor={key}>{p[key]} px</output>
        </SettingRow>)}
      <SettingRow label={t('settings:density')} htmlFor="density">{select('density', [
        { value: 'comfortable', label: t('settings:comfortable') }, { value: 'compact', label: t('settings:compact') },
      ])}</SettingRow>
    </div>
    <div className="type-preview"><span className="muted">{t('settings:preview')}</span>
      <div>{t('query:results')}</div><code>{'{ "created_at": "2026-09-30T08:00:00Z" }'}</code>
      <table><tbody><tr><td>order_id</td><td>9,007,199,254,740,993</td></tr></tbody></table>
    </div>
  </>;

  const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl';
  return <table className="shortcut-table">
    <thead><tr><th>{t('settings:shortcutAction')}</th><th>{t('settings:shortcutBinding')}</th></tr></thead>
    <tbody>{[
      ['jump', `${modifier}+P`], ['command', `${modifier}+Shift+P`], ['settings', `${modifier}+,`],
      ['newQuery', `${modifier}+N`], ['close', 'Esc'],
    ].map(([key, binding]) => <tr key={key}><td>{t(key ?? '')}</td><td><kbd>{binding}</kbd></td></tr>)}</tbody>
  </table>;
}
