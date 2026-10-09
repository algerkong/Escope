import { describe, expect, it } from 'vitest';
import {
  MAX_PARAMETER_OCCURRENCES, MAX_PARAMETER_TEMPLATE_BYTES, MAX_PARAMETER_VALUE_BYTES,
  parameterSlots, parseQueryParameters, resolveQueryParameters, type QueryParameters,
} from '../../src/domain/query-parameters';
import { createQuery, createValidatedSnapshot, matchesQueryDraft, updateWorkspaceDocument } from '../../src/domain/query';
import { createEmptyLibrary, documentFromEntry, entryFromDocument, parseLibraryPayload, upsertEntry } from '../../src/domain/query-library';
import { emptyRecoveryDocument, parseRecoveryDocument, recoveryWorkspace } from '../../src/domain/workspace-recovery';

const parameters: QueryParameters = {
  version: 1,
  template: '{ "query": {"range":{"amount":{"gte":{"$param":"min"}}}}, "size": 25, "precise": 1.23000000000000000001e+8 }',
  definitions: [{ name: 'min', type: 'number' }],
};

describe('typed query parameters', () => {
  it.each(['900719925474099312345', '-0', '1.234567890123456789', '1e+400'])('preserves the token %s and unrelated text', (token) => {
    expect(resolveQueryParameters(parameters, { min: token })).toEqual({
      ok: true, dsl: parameters.template.replace('{"$param":"min"}', token),
    });
  });

  it('only replaces a complete value, with exact JSON string escaping', () => {
    const definition: QueryParameters = {
      version: 1, template: '{"{{name}}":"{{name}}","a":{"$param":"name"},"b":[{"$param":"name"}]}',
      definitions: [{ name: 'name', type: 'string' }],
    };
    const result = resolveQueryParameters(definition, { name: '"}, "size":999,\n\\' });
    expect(result).toEqual({ ok: true, dsl: `{"{{name}}":"{{name}}","a":${JSON.stringify('"}, "size":999,\n\\')},"b":[${JSON.stringify('"}, "size":999,\n\\')}]}` });
  });

  it.each([
    ['boolean', 'false'], ['null', 'null'], ['array', '[9007199254740993, "\\u0061"]'],
    ['object', '{"n":1.234567890123456789, "z":-0}'],
  ] as const)('supports exact %s values', (type, value) => {
    expect(resolveQueryParameters({ ...parameters, definitions: [{ name: 'min', type }] }, { min: value }))
      .toEqual({ ok: true, dsl: parameters.template.replace('{"$param":"min"}', value) });
  });

  it.each(['"12"', 'NaN', 'Infinity', '01', '+1', '1, "size":999', '/*x*/1', ''])('refuses invalid number %s', (min) => {
    expect(resolveQueryParameters(parameters, { min })).toMatchObject({ ok: false, code: 'invalidValue' });
  });

  it('rejects missing, duplicate, malformed, recursive and undeclared values', () => {
    expect(resolveQueryParameters(parameters, {})).toMatchObject({ ok: false, code: 'missingValue' });
    expect(parameterSlots({ ...parameters, template: '{"query":{"$param":"missing"}}' })).toMatchObject({ code: 'unknownParameter' });
    expect(parameterSlots({ ...parameters, template: '{"query":{"$param":"min","extra":0}}' })).toMatchObject({ code: 'invalidPlaceholder' });
    expect(parameterSlots({ ...parameters, template: '{"$param":"min"}' })).toMatchObject({ code: 'invalidPlaceholder' });
    expect(parameterSlots({ ...parameters, template: '{"query":1,"qu\\u0065ry":2}' })).toMatchObject({ code: 'invalidTemplate' });
    expect(parameterSlots({ ...parameters, template: '{}' })).toMatchObject({ code: 'unusedParameter' });
    expect(resolveQueryParameters({ ...parameters, definitions: [{ name: 'min', type: 'object' }] },
      { min: '{"a":{"$param":"min"}}' })).toMatchObject({ code: 'invalidValue' });
    expect(resolveQueryParameters({ ...parameters, definitions: [{ name: 'min', type: 'object' }] },
      { min: '{"x":1,"x":2}' })).toMatchObject({ code: 'invalidValue' });
  });

  it('bounds stored definitions, replacement work and final bytes', () => {
    expect(parseQueryParameters({ ...parameters, values: { min: 'secret' } })).toBeNull();
    expect(parseQueryParameters({ ...parameters, version: 2 })).toBeNull();
    expect(parseQueryParameters({ ...parameters, definitions: [parameters.definitions[0], parameters.definitions[0]] })).toBeNull();
    expect(parseQueryParameters({ ...parameters, definitions: [{ name: 'min', type: 'number', value: '5' }] })).toBeNull();
    expect(parseQueryParameters({ ...parameters, template: 'x'.repeat(MAX_PARAMETER_TEMPLATE_BYTES + 1) })).toBeNull();
    expect(resolveQueryParameters(parameters, { min: '9'.repeat(MAX_PARAMETER_VALUE_BYTES + 1) })).toMatchObject({ code: 'tooLarge' });
    const many = { ...parameters, template: `{"values":[${Array.from({ length: MAX_PARAMETER_OCCURRENCES + 1 }, () => '{"$param":"min"}').join(',')}]}` };
    expect(parameterSlots(many)).toMatchObject({ code: 'tooLarge' });
    expect(resolveQueryParameters({ ...parameters, template: '{"a":[{"$param":"min"},{"$param":"min"},{"$param":"min"},{"$param":"min"},{"$param":"min"}]}' },
      { min: '9'.repeat(MAX_PARAMETER_VALUE_BYTES) })).toMatchObject({ code: 'tooLarge' });
  });

  it('checks the final byte and nesting budgets rather than intermediate replacement order', () => {
    const spaced = { ...parameters, template: `{"a":{${' '.repeat(200_000)}"$param":"min"},"b":{"$param":"min"}}` };
    expect(resolveQueryParameters(spaced, { min: '9'.repeat(MAX_PARAMETER_VALUE_BYTES) }).ok).toBe(true);
    const deep = { ...parameters, template: `{"q":${'['.repeat(40)}{"$param":"min"}${']'.repeat(40)}}`,
      definitions: [{ name: 'min', type: 'array' as const }] };
    const value = '['.repeat(40) + '1' + ']'.repeat(40);
    expect(resolveQueryParameters(deep, { min: value })).toMatchObject({ code: 'tooLarge' });
  });

  it('stores only definitions in library and recovery v1, preserving incomplete templates', () => {
    const query = { ...createQuery('c1'), parameters: { ...parameters, template: '{' } };
    const entry = entryFromDocument(query, { id: 'e1', name: 'Draft', favorite: false, now: new Date() });
    const library = upsertEntry(createEmptyLibrary(), entry);
    expect(parseLibraryPayload(library)).toMatchObject({ ok: true });
    const restored = documentFromEntry(entry);
    expect(restored.parameters).toEqual(query.parameters);
    expect(restored.parameters).not.toBe(query.parameters);
    const workspace = recoveryWorkspace({ activeConnectionId: 'c1', activeTabId: query.id, tabs: [{ kind: 'query', document: query }], lastTabByConnection: {} });
    expect(parseRecoveryDocument({ ...emptyRecoveryDocument(), workspace })).not.toBeNull();
    expect(parseLibraryPayload({ ...library, entries: [{ ...entry, parameters: null }] }).ok).toBe(false);
    expect(parseRecoveryDocument({ ...emptyRecoveryDocument(), workspace: { ...workspace,
      tabs: [{ ...workspace.tabs[0], document: { ...query, parameters: { ...parameters, values: {} } } }] } })).toBeNull();
  });

  it('freezes only the applied DSL, refuses unresolved execution, and checks draft conflicts', () => {
    const query = { ...createQuery('c1'), index: 'orders', parameters, dsl: parameters.template };
    expect(createValidatedSnapshot(query, 'r1', new Date())).toMatchObject({ ok: false, error: { code: 'dslUnresolvedParameters' } });
    const result = resolveQueryParameters(parameters, { min: '9007199254740993' });
    if (!result.ok) throw new Error('resolution failed');
    const state = { activeConnectionId: 'c1', activeTabId: query.id, tabs: [{ kind: 'query' as const, document: query }], lastTabByConnection: {} };
    const updated = updateWorkspaceDocument(state, query.id, { dsl: result.dsl });
    const applied = updated.tabs[0]!.document;
    expect(applied.revision).toBe(1);
    expect(query.dsl).toBe(parameters.template);
    expect(matchesQueryDraft(applied, query)).toBe(false);
    expect(matchesQueryDraft(undefined, query)).toBe(false);
    expect(matchesQueryDraft({ ...query, connectionId: 'other' }, query)).toBe(false);
    const snapshot = createValidatedSnapshot(applied, 'r1', new Date());
    expect(snapshot).toMatchObject({ ok: true, snapshot: { rawDsl: result.dsl } });
    if (snapshot.ok) expect(snapshot.snapshot).not.toHaveProperty('parameters');
  });
});
