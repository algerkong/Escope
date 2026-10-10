import { describe, expect, it } from 'vitest';
import { createQuery, createSnapshot } from '../../src/domain/query';
import { dataViewTimeFieldStatus, selectDataView } from '../../src/domain/data-views';
import { fieldFormatEvidence } from '../../src/domain/field-formats';
import { parseNestedFilterMapping } from '../../src/domain/query-filter-mapping';
import { nestedQueryFilterFieldEvidence, queryFilterFieldEvidence } from '../../src/domain/query-filters';
import { querySortEvidence } from '../../src/domain/query-sort';
import { timeRangeFieldEvidence, type TimeRangeDefinition } from '../../src/domain/query-time-range';
import { queryCompletions } from '../../src/domain/query-completions';
import { parseFieldCaps } from '../../src/domain/resource';
import { runtimeFieldEvidence } from '../../src/domain/runtime-fields';
import { buildVisualDsl, emptyVisualForm } from '../../src/domain/visual-query';

const source = { ...createQuery('c1'), index: 'events-*', dsl: '{}' };
const snapshot = createSnapshot(source, 'execution', new Date('2026-10-10T00:00:00Z'));
const target = { connectionId: 'c1', endpoint: 'https://es.test', index: source.index };
const time: TimeRangeDefinition = { field: 'when', fieldType: 'date', timeZone: 'UTC',
  range: { kind: 'relative', unit: 'minutes', amount: 5 } };

function catalog(patch: object) {
  const parsed = parseFieldCaps(JSON.stringify({ indices: ['events-a', 'events-b'],
    fields: Object.fromEntries([['value', 'long'], ['when', 'date'], ['items.value', 'long']].map(([field, type]) =>
      [field!, { [type!]: { searchable: true, aggregatable: true, ...patch } }])) }));
  if (!parsed.ok) throw new Error('fixture');
  return parsed.value;
}

function suggestions(marked: string, fields = catalog({}), dsl?: string) {
  const offset = marked.indexOf('|');
  const raw = marked.replace('|', '');
  const text = dsl ? raw.replace('{', `${dsl.slice(0, -1)},`) : raw;
  return queryCompletions(text, offset + text.length - raw.length, { target, fields: { target, catalog: fields } })
    .map((entry) => entry.name);
}

describe('parsed field evidence consumers', () => {
  it.each([null, 'events-b', [null], ['events-b', 42], ['events-b'], ['events-b', 'events-b']])(
    'keeps mapped search gates closed for malformed or restricted evidence: %j', (indices) => {
      const fields = catalog({ non_searchable_indices: indices });
      expect(queryFilterFieldEvidence(source, snapshot, 'value', fields)).toMatchObject({ ok: false, code: 'fieldNotSearchable' });
      expect(dataViewTimeFieldStatus('when', fields)).toBe('notSearchable');
      expect(timeRangeFieldEvidence(source, time, fields)).toBe('fieldNotSearchable');
      expect(suggestions('{"query":{"term":{"|":1}}}', fields)).not.toContain('value');
      expect(suggestions('{"query":{"exists":{"field":"|"}}}', fields)).not.toContain('value');
      const visual = buildVisualDsl('{}', { ...emptyVisualForm(), conditions: [
        { id: 'x', context: 'filter', field: 'value', operator: 'eq', valueType: 'number', value: '1' },
      ] }, fields.fields);
      expect(visual.problems).toContainEqual(expect.objectContaining({ code: 'fieldNotSearchable' }));
      const mapping = parseNestedFilterMapping(JSON.stringify(Object.fromEntries(['events-a', 'events-b'].map((name) =>
        [name, { mappings: { properties: { items: { type: 'nested', properties: { value: { type: 'long' } } } } } }]))));
      expect(nestedQueryFilterFieldEvidence(source, snapshot, 'items', 'items.value', fields, mapping))
        .toMatchObject({ ok: false, code: 'fieldNotSearchable' });
      // A search restriction does not pretend to be a doc-values or formatting restriction.
      expect(querySortEvidence('{}', ['value'], fields)[0]).toMatchObject({ ok: true, origin: 'mapped' });
      expect(fieldFormatEvidence({ field: 'value', format: { kind: 'number', grouping: true } }, fields)).toBe('valid');
    });

  it.each([null, 'events-b', [null], ['events-b'], ['events-b', 'events-b']])(
    'keeps server and visual sort closed without suppressing a searchable field: %j', (indices) => {
      const fields = catalog({ non_aggregatable_indices: indices });
      expect(querySortEvidence('{}', ['value'], fields)[0]).toMatchObject({ ok: false, code: 'fieldNotSortable' });
      expect(suggestions('{"sort":[{"|":"asc"}]}', fields)).not.toContain('value');
      expect(buildVisualDsl('{}', { ...emptyVisualForm(), sort: { field: 'value', direction: 'asc' } }, fields.fields).problems)
        .toContainEqual(expect.objectContaining({ code: 'sortFieldInvalid' }));
      expect(queryFilterFieldEvidence(source, snapshot, 'value', fields)).toMatchObject({ ok: true, evidence: 'mapped' });
      expect(suggestions('{"query":{"term":{"|":1}}}', fields)).toContain('value');
    });

  it('keeps missing flags closed while still listing literal fields for projections', () => {
    const fields = catalog({ searchable: null, aggregatable: null });
    expect(queryFilterFieldEvidence(source, snapshot, 'value', fields)).toMatchObject({ ok: false });
    expect(querySortEvidence('{}', ['value'], fields)[0]).toMatchObject({ ok: false });
    expect(suggestions('{"fields":["|"]}', fields)).toContain('value');
    expect(suggestions('{"_source":["|"]}', fields)).toContain('value');
    expect(suggestions('{"fields":["value.|"]}', fields)).toEqual([]);
  });

  it('does not let optional report detail change valid search, time or sort evidence', () => {
    const fields = catalog({ non_searchable_indices: [], non_aggregatable_indices: [] });
    expect(queryFilterFieldEvidence(source, snapshot, 'value', fields)).toMatchObject({ ok: true, evidence: 'mapped' });
    expect(querySortEvidence('{}', ['value'], fields)[0]).toMatchObject({ ok: true, origin: 'mapped' });
    expect(dataViewTimeFieldStatus('when', fields)).toBe('valid');
    expect(timeRangeFieldEvidence(source, time, fields)).toBe('valid');
  });

  it('uses only applied runtime declarations, never the field report or unapplied view definition', () => {
    const fields = catalog({ searchable: false, aggregatable: false });
    const dsl = '{"runtime_mappings":{"value":{"type":"long"},"when":{"type":"date"}}}';
    const applied = { ...source, dsl };
    expect(queryFilterFieldEvidence(applied, createSnapshot(applied, 'runtime', new Date('2026-10-10T00:00:00Z')), 'value', fields))
      .toMatchObject({ ok: true, evidence: 'runtime' });
    expect(querySortEvidence(dsl, ['value'], fields)[0]).toMatchObject({ ok: true, origin: 'runtime' });
    expect(timeRangeFieldEvidence(applied, time, fields)).toBe('runtime');
    expect(suggestions('{"query":{"term":{"|":1}}}', fields, dsl)).toContain('value');
    expect(runtimeFieldEvidence({ field: 'value', type: 'long' }, fields)).toBe('shadow');
    const unapplied = { ...source, dataView: selectDataView({ id: 'view', name: 'View', connectionId: 'c1',
      index: source.index, defaultTimeField: null, runtimeFields: { version: 1, entries: [{ field: 'when', type: 'date' }] } }) };
    expect(timeRangeFieldEvidence(unapplied, time, fields)).toBe('runtimeNotApplied');
  });
});
