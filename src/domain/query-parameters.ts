import { applyEdits, type Edit, type Node } from 'jsonc-parser';
import { parseRawJson, property } from './query-result';

export const QUERY_PARAMETERS_VERSION = 1;
export const MAX_PARAMETERS = 32;
export const MAX_PARAMETER_TEMPLATE_BYTES = 256 * 1024;
export const MAX_PARAMETER_VALUE_BYTES = 64 * 1024;
export const MAX_PARAMETER_OCCURRENCES = 1000;
export const PARAMETER_TYPES = ['string', 'number', 'boolean', 'null', 'object', 'array'] as const;
export type ParameterType = typeof PARAMETER_TYPES[number];

export interface ParameterDefinition {
  readonly name: string;
  readonly type: ParameterType;
}

/** Only the reusable definition is persisted. Input values and previews are session-local. */
export interface QueryParameters {
  readonly version: number;
  readonly template: string;
  readonly definitions: readonly ParameterDefinition[];
}

export type ParameterError =
  | 'invalidDefinition' | 'invalidTemplate' | 'invalidPlaceholder' | 'unknownParameter'
  | 'unusedParameter' | 'missingValue' | 'invalidValue' | 'tooLarge';
export type ParameterResult =
  | { readonly ok: true; readonly dsl: string }
  | { readonly ok: false; readonly code: ParameterError; readonly parameter?: string };

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).length;
const validName = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value);

function shape(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Incomplete template text is a valid saved draft, but cannot be previewed or exchanged. */
export function parseQueryParameters(value: unknown): QueryParameters | null {
  if (!shape(value, ['version', 'template', 'definitions']) || value.version !== QUERY_PARAMETERS_VERSION
    || typeof value.template !== 'string' || bytes(value.template) > MAX_PARAMETER_TEMPLATE_BYTES
    || !Array.isArray(value.definitions) || value.definitions.length > MAX_PARAMETERS) return null;
  const names = new Set<string>();
  const definitions: ParameterDefinition[] = [];
  for (const definition of value.definitions) {
    if (!shape(definition, ['name', 'type']) || !validName(definition.name) || names.has(definition.name)
      || !PARAMETER_TYPES.includes(definition.type as ParameterType)) return null;
    names.add(definition.name);
    definitions.push({ name: definition.name, type: definition.type as ParameterType });
  }
  return { version: QUERY_PARAMETERS_VERSION, template: value.template, definitions };
}

export function parametersPayload(value: QueryParameters): QueryParameters {
  return {
    version: value.version, template: value.template,
    definitions: value.definitions.map(({ name, type }) => ({ name, type })),
  };
}

/** The shared JSON reader rejects duplicate/escaped duplicate keys; this adds work bounds. */
export function boundedParameterJson(raw: string): Node | null {
  const root = parseRawJson(raw);
  if (!root) return null;
  const pending = [{ node: root, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++count > 200_000 || depth > 64) return null;
    if (node.type === 'object') {
      for (const entry of node.children ?? []) {
        const child = entry.children?.[1];
        if (child) pending.push({ node: child, depth: depth + 1 });
      }
    } else if (node.type === 'array') {
      for (const child of node.children ?? []) pending.push({ node: child, depth: depth + 1 });
    }
  }
  return root;
}

type TemplateResult =
  | { readonly ok: true; readonly slots: readonly { node: Node; name: string }[] }
  | Exclude<ParameterResult, { ok: true }>;

export function parameterSlots(parameters: QueryParameters): TemplateResult {
  if (parseQueryParameters(parameters) === null) return { ok: false, code: 'invalidDefinition' };
  const root = boundedParameterJson(parameters.template);
  if (!root || root.type !== 'object') return { ok: false, code: 'invalidTemplate' };
  const names = new Set(parameters.definitions.map((item) => item.name));
  const used = new Set<string>();
  const slots: { node: Node; name: string }[] = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    const marker = property(node, '$param');
    if (marker !== undefined) {
      if (node === root || node.children?.length !== 1 || marker.type !== 'string' || !validName(marker.value)) {
        return { ok: false, code: 'invalidPlaceholder' };
      }
      const name = marker.value as string;
      if (!names.has(name)) return { ok: false, code: 'unknownParameter', parameter: name };
      used.add(name);
      slots.push({ node, name });
      if (slots.length > MAX_PARAMETER_OCCURRENCES) return { ok: false, code: 'tooLarge' };
    } else if (node.type === 'object') {
      for (const entry of node.children ?? []) if (entry.children?.[1]) pending.push(entry.children[1]);
    } else if (node.type === 'array') {
      for (const child of node.children ?? []) pending.push(child);
    }
  }
  const unused = parameters.definitions.find(({ name }) => !used.has(name));
  return unused ? { ok: false, code: 'unusedParameter', parameter: unused.name } : { ok: true, slots };
}

/** Replace entire value nodes only. Never interpolate keys, string fragments, URLs or indices. */
export function resolveQueryParameters(parameters: QueryParameters, values: Readonly<Record<string, string>>): ParameterResult {
  const parsed = parameterSlots(parameters);
  if (!parsed.ok) return parsed;
  const tokens = new Map<string, string>();
  for (const definition of parameters.definitions) {
    if (!Object.hasOwn(values, definition.name)) return { ok: false, code: 'missingValue', parameter: definition.name };
    const input = values[definition.name]!;
    if (typeof input !== 'string' || bytes(input) > MAX_PARAMETER_VALUE_BYTES) return { ok: false, code: 'tooLarge', parameter: definition.name };
    const token = definition.type === 'string' ? JSON.stringify(input) : input.trim();
    const node = boundedParameterJson(token);
    if (!node || node.type !== definition.type) return { ok: false, code: 'invalidValue', parameter: definition.name };
    // A value cannot introduce another unresolved placeholder, even inside an object/array.
    const pending = [node];
    while (pending.length) {
      const child = pending.pop()!;
      if (property(child, '$param')) return { ok: false, code: 'invalidValue', parameter: definition.name };
      for (const item of child.children ?? []) pending.push(item);
    }
    tokens.set(definition.name, token);
  }
  let size = bytes(parameters.template);
  const edits: Edit[] = [];
  for (const { node, name } of parsed.slots) {
    const content = tokens.get(name)!;
    size += bytes(content) - bytes(parameters.template.slice(node.offset, node.offset + node.length));
    edits.push({ offset: node.offset, length: node.length, content });
  }
  if (size > MAX_PARAMETER_TEMPLATE_BYTES) return { ok: false, code: 'tooLarge' };
  const dsl = applyEdits(parameters.template, edits);
  return boundedParameterJson(dsl) ? { ok: true, dsl } : { ok: false, code: 'tooLarge' };
}
