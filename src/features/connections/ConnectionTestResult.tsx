import { CheckCircle2, Clock3, LoaderCircle, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ConnectionTestState } from './useConnectionTests';

export function ConnectionTestResult({ result, timeZone }: { result?: ConnectionTestState; timeZone: string }) {
  const { t, i18n } = useTranslation();
  if (!result) return <span className="muted small">{t('notTested')}</span>;
  if (result.status === 'running') return <div className="connection-test-status muted small" role="status">
    <LoaderCircle size={14} className="spin" />{t('connections:testing')}
  </div>;
  if (result.status === 'stale') return <div className="connection-test-status muted small" role="status">
    <Clock3 size={14} />{t('connections:testStale')}
  </div>;
  if (result.status === 'error') return <div className="connection-test-error small" role="alert">
    <span className="connection-test-status"><TriangleAlert size={14} />{t('connections:testFailed')}</span>
    <p>{t(`errors:${result.code}`, { defaultValue: t('errors:unexpected') })}</p>
  </div>;

  const { identity, completedAt } = result;
  const checkedAt = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: 'short', timeStyle: 'medium', ...(timeZone === 'system' ? {} : { timeZone }),
  }).format(new Date(completedAt));
  return <div className="connection-test-result small">
    <div className="connection-test-status success-text" role="status"><CheckCircle2 size={14} />{t('connections:identityConfirmed')}</div>
    <dl className="connection-identity">
      <div><dt>{t('connections:clusterName')}</dt><dd>{identity.clusterName}</dd></div>
      <div><dt>{t('connections:clusterUuid')}</dt><dd className="identity-uuid">{identity.clusterUuid}</dd></div>
      <div><dt>{t('connections:version')}</dt><dd>{identity.version}</dd></div>
      <div><dt>{t('connections:duration')}</dt><dd>{t('connections:milliseconds', { value: identity.elapsedMs })}</dd></div>
      <div><dt>{t('connections:checkedAt')}</dt><dd><time dateTime={completedAt}>{checkedAt}</time></dd></div>
    </dl>
    {!identity.testedVersion ? <p className="connection-version-warning"><TriangleAlert size={14} />{t('connections:untestedVersion')}</p> : null}
  </div>;
}
