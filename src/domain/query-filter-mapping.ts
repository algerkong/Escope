import type { Node } from 'jsonc-parser';
import { boundedParameterJson } from './query-parameters';
import { boolOf, property, textOf } from './query-result';
import { validTimeRangeField } from './query-time-range';

export const MAX_FILTER_MAPPING_BYTES = 2 * 1024 * 1024;
export const MAX_FILTER_MAPPING_INDICES = 128;
export const MAX_FILTER_MAPPING_FIELDS = 4096;

export type NestedMappingProblem =
  | 'mappingUnchecked' | 'mappingInvalid' | 'mappingTooLarge' | 'mappingTargetChanged'
  | 'nestedPathUnsupported' | 'nestedPathMissing' | 'nestedPathConflict'
  | 'nestedFieldMissing' | 'nestedFieldConflict' | 'nestedRuntime';

export interface NestedFilterMapping {
  readonly indices: readonly { readonly name: string; readonly mapping: Node }[];
  /** Options are taken from real properties nodes, never split from flattened names. */
  readonly paths: readonly { readonly path: string; readonly fields: readonly string[] }[];
}

export type NestedFilterMappingResult =
  | { readonly ok: true; readonly value: NestedFilterMapping }
  | { readonly ok: false; readonly code: NestedMappingProblem };

export function validNestedFilterSegment(value: unknown): value is string {
  return validTimeRangeField(value) && !/[.[\]/\\]/.test(value);
}

/** A bounded, typeless Mapping response. The resource cache owns its connection/endpoint/target. */
export function parseNestedFilterMapping(raw: string): NestedFilterMappingResult {
  if (new TextEncoder().encode(raw).length > MAX_FILTER_MAPPING_BYTES) return { ok: false, code: 'mappingTooLarge' };
  const root = boundedParameterJson(raw);
  if (root?.type !== 'object' || !root.children?.length) return { ok: false, code: 'mappingInvalid' };
  if (root.children.length > MAX_FILTER_MAPPING_INDICES) return { ok: false, code: 'mappingTooLarge' };
  const indices: { name: string; mapping: Node }[] = [];
  const paths = new Map<string, Set<string>>();
  let count = 0;
  for (const entry of root.children) {
    const name = textOf(entry.children?.[0]);
    const mapping = property(entry.children?.[1], 'mappings');
    if (!name || mapping?.type !== 'object') return { ok: false, code: 'mappingInvalid' };
    const properties = property(mapping, 'properties');
    const runtime = property(mapping, 'runtime');
    if (properties !== undefined && properties.type !== 'object' || runtime !== undefined && runtime.type !== 'object') {
      return { ok: false, code: 'mappingInvalid' };
    }
    indices.push({ name, mapping });
    for (const item of properties?.children ?? []) {
      if (++count > MAX_FILTER_MAPPING_FIELDS) return { ok: false, code: 'mappingTooLarge' };
      const path = textOf(item.children?.[0]);
      const body = item.children?.[1];
      if (!validNestedFilterSegment(path) || textOf(property(body, 'type')) !== 'nested') continue;
      const fields = paths.get(path) ?? new Set<string>();
      paths.set(path, fields);
      const children = property(body, 'properties');
      if (children !== undefined && children.type !== 'object') return { ok: false, code: 'mappingInvalid' };
      for (const child of children?.children ?? []) {
        if (++count > MAX_FILTER_MAPPING_FIELDS) return { ok: false, code: 'mappingTooLarge' };
        const key = textOf(child.children?.[0]);
        if (validNestedFilterSegment(key) && validTimeRangeField(`${path}.${key}`)) fields.add(`${path}.${key}`);
      }
    }
  }
  return { ok: true, value: { indices, paths: [...paths].map(([path, fields]) => ({ path, fields: [...fields].sort() }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) } };
}

export function runtimeOverlapsNestedPath(root: Node, key: 'runtime' | 'runtime_mappings', path: string): boolean {
  return (property(root, key)?.children ?? []).some((entry) => {
    const name = textOf(entry.children?.[0]);
    return name === path || name?.startsWith(`${path}.`) === true;
  });
}

/** Every resolved index must prove the same nested parent and direct mapped leaf. */
export function nestedMappingFieldEvidence(mapping: NestedFilterMappingResult | undefined, indices: readonly string[],
  path: string, field: string):
  { readonly ok: true; readonly fieldType: string } | { readonly ok: false; readonly code: NestedMappingProblem } {
  if (!validNestedFilterSegment(path) || typeof field !== 'string' || !field.startsWith(`${path}.`)
    || !validNestedFilterSegment(field.slice(path.length + 1)) || !validTimeRangeField(field)) {
    return { ok: false, code: 'nestedPathUnsupported' };
  }
  if (!mapping) return { ok: false, code: 'mappingUnchecked' };
  if (!mapping.ok) return mapping;
  const expected = new Set(indices);
  if (!expected.size || expected.size !== indices.length || expected.size !== mapping.value.indices.length
    || mapping.value.indices.some((entry) => !expected.has(entry.name))) return { ok: false, code: 'mappingTargetChanged' };
  let fieldType: string | undefined;
  for (const entry of mapping.value.indices) {
    const properties = property(entry.mapping, 'properties');
    const unsupportedObject = (node: Node) => ['enabled', 'subobjects'].some((key) => {
      const flag = property(node, key);
      return flag !== undefined && boolOf(flag) !== true;
    });
    if (unsupportedObject(entry.mapping)
      || (properties?.children ?? []).some((item) => textOf(item.children?.[0])?.startsWith(`${path}.`))) {
      return { ok: false, code: 'nestedPathUnsupported' };
    }
    const parent = property(properties, path);
    if (!parent) return { ok: false, code: 'nestedPathMissing' };
    if (textOf(property(parent, 'type')) !== 'nested') return { ok: false, code: 'nestedPathConflict' };
    if (unsupportedObject(parent)) {
      return { ok: false, code: 'nestedPathUnsupported' };
    }
    if (runtimeOverlapsNestedPath(entry.mapping, 'runtime', path)) return { ok: false, code: 'nestedRuntime' };
    const leaf = property(property(parent, 'properties'), field.slice(path.length + 1));
    if (!leaf) return { ok: false, code: 'nestedFieldMissing' };
    const type = textOf(property(leaf, 'type'));
    if (!type || property(leaf, 'properties') || type === 'nested' || type === 'object' || type === 'alias') {
      return { ok: false, code: 'nestedPathUnsupported' };
    }
    if (fieldType !== undefined && type !== fieldType) return { ok: false, code: 'nestedFieldConflict' };
    fieldType = type;
  }
  return fieldType ? { ok: true, fieldType } : { ok: false, code: 'nestedFieldMissing' };
}
