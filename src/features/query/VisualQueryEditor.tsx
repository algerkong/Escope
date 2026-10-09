import { Plus, Trash2, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, SelectControl } from '../../components/controls';
import type { FieldCapability } from '../../domain/resource';
import type { VisualEditorDraft } from '../../domain/workspace-recovery';
import {
  buildVisualDsl, parseVisualForm, VISUAL_SIZE_MAX,
  type ProblemCode, type VisualBuildProblem, type VisualCondition, type VisualForm,
  type VisualMode, type VisualOperator, type VisualValueType,
} from '../../domain/visual-query';
import '../../styles/visual-query.css';

interface Props {
  rawDsl: string;
  fields: readonly FieldCapability[];
  onChange: (rawDsl: string) => void;
  onValidityChange?: (valid: boolean) => void;
  draft?: VisualEditorDraft;
  onDraftChange?: (draft: VisualEditorDraft) => void;
}

export type { VisualEditorDraft } from '../../domain/workspace-recovery';

const OPERATORS: readonly VisualOperator[] = ['eq', 'neq', 'match', 'gt', 'gte', 'lt', 'lte', 'exists', 'missing'];
const VALUE_TYPES: readonly VisualValueType[] = ['string', 'number', 'boolean'];
const OPERATOR_KEYS: Record<VisualOperator, string> = {
  eq: 'opEq', neq: 'opNeq', match: 'opMatch', gt: 'opGt', gte: 'opGte', lt: 'opLt', lte: 'opLte',
  exists: 'opExists', missing: 'opMissing',
};
const VALUE_TYPE_KEYS: Record<VisualValueType, string> = {
  string: 'typeString', number: 'typeNumber', boolean: 'typeBoolean',
};
const FIELD_PROBLEMS: readonly ProblemCode[] = ['fieldRequired', 'fieldConflict', 'fieldNested', 'fieldNotSearchable'];
const VALUE_PROBLEMS: readonly ProblemCode[] = ['valueRequired', 'valueInvalidNumber', 'valueInvalidBoolean'];

function problemKey(code: ProblemCode): string {
  return `problem${code.charAt(0).toUpperCase()}${code.slice(1)}`;
}

/**
 * Compact visual editor for the lossless query subset in `domain/visual-query`.
 *
 * The draft text is never replaced wholesale: a reverse parse builds the form, every user
 * edit is validated locally, and only the affected part (`query`/`size`/`sort`) is rewritten
 * through source edits. Invalid drafts, unsupported DSL and conflicting fields keep the last
 * valid text and report a concise problem instead; nothing is emitted on mount or resync.
 */
export function VisualQueryEditor({ rawDsl, fields, onChange, onValidityChange, draft, onDraftChange }: Props) {
  const { t } = useTranslation('visualQuery');
  const parsed = useMemo(() => parseVisualForm(rawDsl), [rawDsl]);
  const [form, setForm] = useState<VisualForm | null>(() => draft?.source === rawDsl ? draft.form : parsed.ok ? parsed.form : null);
  const [problems, setProblems] = useState<readonly VisualBuildProblem[]>(() => draft?.source === rawDsl ? draft.problems : []);
  const lastSeen = useRef(rawDsl);
  const listId = useId();
  const formValid = problems.length === 0;

  useEffect(() => { onValidityChange?.(formValid); }, [formValid, onValidityChange]);

  // External draft changes (tab switch, DSL edits) replace the form without ever emitting.
  useEffect(() => {
    if (rawDsl === lastSeen.current) return;
    lastSeen.current = rawDsl;
    setForm(parsed.ok ? parsed.form : null);
    setProblems([]);
    onDraftChange?.({ source: rawDsl, form: parsed.ok ? parsed.form : null, problems: [] });
  }, [rawDsl, parsed, onDraftChange]);

  const update = useCallback((next: VisualForm) => {
    setForm(next);
    const result = buildVisualDsl(rawDsl, next, fields, parsed.ok ? parsed.form : undefined);
    setProblems(result.problems);
    onValidityChange?.(result.problems.length === 0);
    onDraftChange?.({ source: result.dsl ?? rawDsl, form: next, problems: result.problems });
    if (result.dsl !== undefined) {
      lastSeen.current = result.dsl;
      onChange(result.dsl);
    }
  }, [rawDsl, fields, parsed, onChange, onValidityChange, onDraftChange]);

  if (!parsed.ok) {
    const message = parsed.reason === 'invalidDsl'
      ? `${t('invalidDsl')}${parsed.error.line !== undefined && parsed.error.column !== undefined
        ? t('invalidDslPosition', { line: parsed.error.line, column: parsed.error.column }) : ''}`
      : t(parsed.reason === 'query' ? 'unsupportedQuery' : parsed.reason === 'size' ? 'unsupportedSize' : 'unsupportedSort');
    return <div className="vq-state" role="status"><TriangleAlert size={16} aria-hidden="true" /><span>{message}</span></div>;
  }

  const current = form ?? parsed.form;
  const nextId = () => `vq-new-${crypto.randomUUID()}`;
  const patch = (id: string, changes: Partial<Omit<VisualCondition, 'id'>>) => {
    update({ ...current, conditions: current.conditions.map((item) => (item.id === id ? { ...item, ...changes } : item)) });
  };
  const problemCode = (condition: VisualCondition): ProblemCode | undefined =>
    problems.find((problem) => problem.conditionId === condition.id)?.code;
  const sizeProblem = problems.find((problem) => problem.conditionId === undefined && problem.code.startsWith('size'));
  const sortProblem = problems.some((problem) => problem.code.startsWith('sort'));
  const suggestions = [...new Set(fields.map((field) => field.name))];

  return <div className="vq-editor">
    <div className="vq-toolbar">
      <label className="vq-inline"><span>{t('matchMode')}</span>
        <SelectControl value={current.mode} onChange={(event) => update({ ...current, mode: event.target.value as VisualMode })}>
          <option value="all">{t('all')}</option><option value="any">{t('any')}</option>
        </SelectControl></label>
      <label className="vq-inline"><span>{t('size')}</span>
        <input className="vq-size" inputMode="numeric" aria-invalid={sizeProblem !== undefined || undefined}
          aria-label={t('size')} value={current.size}
          onChange={(event) => update({ ...current, size: event.target.value })} /></label>
      <label className="vq-inline"><span>{t('sortField')}</span>
        <input list={listId} spellCheck={false} aria-label={t('sortField')} aria-invalid={sortProblem || undefined}
          value={current.sort?.field ?? ''}
          onChange={(event) => update({
            ...current,
            sort: event.target.value === '' ? null : { field: event.target.value, direction: current.sort?.direction ?? 'asc' },
          })} /></label>
      <label className="vq-inline"><span>{t('sortDirection')}</span>
        <SelectControl aria-label={t('sortDirection')} disabled={current.sort === null} value={current.sort?.direction ?? 'asc'}
          onChange={(event) => {
            if (!current.sort) return;
            update({ ...current, sort: { field: current.sort.field, direction: event.target.value === 'desc' ? 'desc' : 'asc' } });
          }}>
          <option value="asc">{t('asc')}</option><option value="desc">{t('desc')}</option>
        </SelectControl></label>
    </div>
    <div className="vq-conditions">
      {current.conditions.map((condition, index) => {
        const code = problemCode(condition);
        const optionalValue = condition.operator === 'exists' || condition.operator === 'missing';
        return <div className="vq-row" key={condition.id}>
          <input className="vq-field" list={listId} spellCheck={false} placeholder={t('fieldPlaceholder')}
            aria-label={`${t('field')} ${index + 1}`} value={condition.field}
            aria-invalid={code !== undefined && FIELD_PROBLEMS.includes(code) || undefined}
            onChange={(event) => patch(condition.id, { field: event.target.value })} />
          <SelectControl aria-label={`${t('operator')} ${index + 1}`} value={condition.operator}
            aria-invalid={code !== undefined && (code === 'operatorNotAllowed' || code === 'negativeInAny') || undefined}
            onChange={(event) => patch(condition.id, { operator: event.target.value as VisualOperator })}>
            {OPERATORS.map((operator) => <option key={operator} value={operator}>{t(OPERATOR_KEYS[operator])}</option>)}
          </SelectControl>
          <SelectControl aria-label={`${t('valueType')} ${index + 1}`} disabled={optionalValue} value={condition.valueType}
            aria-invalid={code === 'valueTypeMismatch' || undefined}
            onChange={(event) => patch(condition.id, { valueType: event.target.value as VisualValueType })}>
            {VALUE_TYPES.map((type) => <option key={type} value={type}>{t(VALUE_TYPE_KEYS[type])}</option>)}
          </SelectControl>
          <input className="vq-value" disabled={optionalValue} aria-label={`${t('value')} ${index + 1}`}
            inputMode={condition.valueType === 'number' ? 'decimal' : undefined} spellCheck={false}
            value={optionalValue ? '' : condition.value}
            aria-invalid={code !== undefined && VALUE_PROBLEMS.includes(code) || undefined}
            onChange={(event) => patch(condition.id, { value: event.target.value })} />
          {current.mode === 'all' ? <SelectControl aria-label={`${t('context')} ${index + 1}`} value={condition.context}
            onChange={(event) => patch(condition.id, { context: event.target.value === 'must' ? 'must' : 'filter' })}>
            <option value="filter">{t('contextFilter')}</option><option value="must">{t('contextMust')}</option>
          </SelectControl> : null}
          <IconButton className="vq-remove" icon={Trash2} label={`${t('removeCondition')} ${index + 1}`}
            onClick={() => update({ ...current, conditions: current.conditions.filter((item) => item.id !== condition.id) })} />
        </div>;
      })}
    </div>
    <button type="button" className="vq-add"
      onClick={() => update({
        ...current,
        conditions: [...current.conditions, { id: nextId(), field: '', operator: 'eq', context: 'filter', valueType: 'string', value: '' }],
      })}>
      <Plus size={14} aria-hidden="true" />{t('addCondition')}
    </button>
    {problems.length > 0 ? <ul className="vq-problems" role="alert">
      {problems.map((problem, index) => <li key={`${problem.code}-${problem.conditionId ?? index}`}>
        {t(problemKey(problem.code), { max: VISUAL_SIZE_MAX })}
      </li>)}
    </ul> : null}
    <datalist id={listId}>{suggestions.map((name) => <option key={name} value={name} />)}</datalist>
  </div>;
}
