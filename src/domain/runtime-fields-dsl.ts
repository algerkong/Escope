import { applyEdits, getNodeValue, type Edit, type Node } from 'jsonc-parser';
import { formatQueryDsl, validateQueryDsl } from './query-dsl';
import { boundedParameterJson } from './query-parameters';
import { parseRawJson, property } from './query-result';
import {
  parseRuntimeFields, parseRuntimeMappings, runtimeMappingPayload, type DataViewRuntimeFields,
} from './runtime-fields';

export const MAX_RUNTIME_DSL_BYTES = 256 * 1024;
export type RuntimeDslError = 'invalidDefinition' | 'invalidDsl' | 'dslConflict' | 'fieldsConflict' | 'tooLarge' | 'empty';
export type RuntimeDslPreview =
  | { readonly ok: true; readonly dsl: string }
  | { readonly ok: false; readonly code: RuntimeDslError; readonly field?: string };

const bytes = (value: string) => new TextEncoder().encode(value).length;

/** Read only the immutable executed DSL, never the current library or an unapplied definition. */
export function runtimeFieldNamesFromDsl(source: string): readonly string[] {
  const root = parseRawJson(source);
  const mappings = root && property(root, 'runtime_mappings');
  return mappings ? parseRuntimeMappings(getNodeValue(mappings))?.map(({ field }) => field) ?? [] : [];
}

function append(node: Node, values: readonly string[]): Edit {
  const last = node.children?.at(-1);
  return {
    offset: last ? last.offset + last.length : node.offset + 1, length: 0,
    content: `${last ? ',' : ''}\n${values.join(',\n')}`,
  };
}

/**
 * Append only missing members using AST offsets. Existing tokens never pass through Number
 * or object serialization, and a different hand-written declaration is never replaced.
 */
export function previewRuntimeFields(source: string, definition: DataViewRuntimeFields, returnFields: boolean): RuntimeDslPreview {
  const runtime = parseRuntimeFields(definition);
  if (!runtime) return { ok: false, code: 'invalidDefinition' };
  if (!runtime.entries.length) return { ok: false, code: 'empty' };
  if (bytes(source) > MAX_RUNTIME_DSL_BYTES) return { ok: false, code: 'tooLarge' };
  if (!validateQueryDsl(source).ok) return { ok: false, code: 'invalidDsl' };
  const root = boundedParameterJson(source);
  if (!root || root.type !== 'object') return { ok: false, code: 'invalidDsl' };
  const mappings = property(root, 'runtime_mappings');
  const existing = mappings ? parseRuntimeMappings(getNodeValue(mappings)) : [];
  if (!existing) return { ok: false, code: 'invalidDsl' };
  const added: string[] = [];
  for (const entry of runtime.entries) {
    const previous = existing.find((item) => item.field === entry.field);
    if (previous) {
      if (previous.type !== entry.type || previous.script?.source !== entry.script?.source) {
        return { ok: false, code: 'dslConflict', field: entry.field };
      }
    } else added.push(`${JSON.stringify(entry.field)}: ${JSON.stringify(runtimeMappingPayload(entry))}`);
  }
  const edits: Edit[] = [];
  const rootFields: string[] = [];
  if (added.length) {
    if (mappings) edits.push(append(mappings, added));
    else rootFields.push(`"runtime_mappings": {\n${added.join(',\n')}\n}`);
  }
  if (returnFields) {
    const fields = property(root, 'fields');
    if (fields && fields.type !== 'array') return { ok: false, code: 'fieldsConflict' };
    const names = new Set((fields?.children ?? []).flatMap((node) => {
      const name = node.type === 'string' ? node : property(node, 'field');
      return name?.type === 'string' ? [name.value as string] : [];
    }));
    const requested = runtime.entries.filter(({ field }) => !names.has(field)).map(({ field }) => JSON.stringify(field));
    if (requested.length) {
      if (fields) edits.push(append(fields, requested));
      else rootFields.push(`"fields": [${requested.join(', ')}]`);
    }
  }
  if (rootFields.length) edits.push(append(root, rootFields));
  if (!edits.length) return { ok: true, dsl: source };
  const result = applyEdits(source, edits);
  if (bytes(result) > MAX_RUNTIME_DSL_BYTES) return { ok: false, code: 'tooLarge' };
  const formatted = formatQueryDsl(result);
  if (!formatted.ok || bytes(formatted.formatted) > MAX_RUNTIME_DSL_BYTES || !boundedParameterJson(formatted.formatted)) {
    return { ok: false, code: 'tooLarge' };
  }
  return { ok: true, dsl: formatted.formatted };
}
