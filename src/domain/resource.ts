import { boolOf, items, parseRawJson, property, textOf } from './query-result';

/**
 * Read-only resource metadata: index discovery (`_resolve/index`), mapping and field
 * capabilities (`_field_caps`). Names, types and flags are read from the response tree;
 * no ES object is reconstructed and nothing is inferred beyond what the server returned.
 */

export interface IndexEntry {
  readonly name: string;
  readonly aliases: readonly string[];
  /** Raw `attributes` list from `_resolve/index`, e.g. `open`, `hidden`, `closed`, `frozen`. */
  readonly attributes: readonly string[];
  readonly hidden: boolean;
  readonly system: boolean;
  readonly closed: boolean;
  /** Backing data stream name when this index belongs to one. */
  readonly dataStream: string | null;
}

export interface AliasEntry {
  readonly name: string;
  readonly indices: readonly string[];
}

export interface DataStreamEntry {
  readonly name: string;
  readonly backingIndices: readonly string[];
  readonly timestampField: string | null;
}

export interface IndexCatalog {
  readonly indices: readonly IndexEntry[];
  readonly aliases: readonly AliasEntry[];
  readonly dataStreams: readonly DataStreamEntry[];
}

export interface FieldTypeCapability {
  readonly type: string;
  readonly searchable: boolean;
  readonly aggregatable: boolean;
  readonly metadata: boolean;
}

export interface FieldCapability {
  readonly name: string;
  readonly types: readonly FieldTypeCapability[];
  /** More than one type across the resolved indices: values are not comparable as one field. */
  readonly conflict: boolean;
}

export interface FieldCatalog {
  readonly indices: readonly string[];
  readonly fields: readonly FieldCapability[];
}

export interface MappingField {
  readonly index: string;
  readonly path: string;
  readonly type: string;
}

export type ResourceParse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: 'invalidResponse' };

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function stringList(node: ReturnType<typeof property>): string[] {
  return items(node).map(textOf).filter((value): value is string => value !== undefined);
}

/**
 * `_resolve/index/*` returns indices, aliases and data streams; only the indices array is a
 * plain index list, so the caller must not treat aliases or data streams as targets.
 */
export function parseIndexCatalog(raw: string): ResourceParse<IndexCatalog> {
  const root = parseRawJson(raw);
  if (!root || root.type !== 'object') return { ok: false, code: 'invalidResponse' };
  const dataStreams: DataStreamEntry[] = items(property(root, 'data_streams')).flatMap((node) => {
    const name = textOf(property(node, 'name'));
    if (name === undefined) return [];
    return [{
      name,
      backingIndices: stringList(property(node, 'backing_indices')),
      timestampField: textOf(property(node, 'timestamp_field')) ?? null,
    }];
  });
  const backing = new Map<string, string>();
  for (const stream of dataStreams) {
    for (const index of stream.backingIndices) backing.set(index, stream.name);
  }
  const indices: IndexEntry[] = items(property(root, 'indices')).flatMap((node) => {
    const name = textOf(property(node, 'name'));
    if (name === undefined) return [];
    const attributes = stringList(property(node, 'attributes'));
    return [{
      name, attributes,
      aliases: stringList(property(node, 'aliases')),
      hidden: attributes.includes('hidden') || name.startsWith('.'),
      system: name.startsWith('.'),
      closed: attributes.includes('closed'),
      dataStream: backing.get(name) ?? null,
    }];
  });
  const aliases: AliasEntry[] = items(property(root, 'aliases')).flatMap((node) => {
    const name = textOf(property(node, 'name'));
    if (name === undefined) return [];
    return [{ name, indices: stringList(property(node, 'indices')) }];
  });
  return { ok: true, value: { indices: indices.sort(byName), aliases: aliases.sort(byName), dataStreams: dataStreams.sort(byName) } };
}

/**
 * `_field_caps` response: `fields.<name>.<typeName>` carries `type`, `searchable`,
 * `aggregatable` and `metadata_field`. Multiple type entries on one field mean the
 * resolved indices disagree, which the UI must show instead of silently picking one.
 */
export function parseFieldCaps(raw: string): ResourceParse<FieldCatalog> {
  const root = parseRawJson(raw);
  if (!root || root.type !== 'object') return { ok: false, code: 'invalidResponse' };
  const fieldsNode = property(root, 'fields');
  if (!fieldsNode || fieldsNode.type !== 'object') return { ok: false, code: 'invalidResponse' };
  const fields: FieldCapability[] = (fieldsNode.children ?? []).flatMap((entry) => {
    if (entry.type !== 'property') return [];
    const name = textOf(entry.children?.[0]);
    const caps = entry.children?.[1];
    if (name === undefined || caps?.type !== 'object') return [];
    const types: FieldTypeCapability[] = (caps.children ?? []).flatMap((cap) => {
      if (cap.type !== 'property') return [];
      const typeName = textOf(cap.children?.[0]);
      const body = cap.children?.[1];
      if (typeName === undefined) return [];
      return [{
        type: textOf(property(body, 'type')) ?? typeName,
        searchable: boolOf(property(body, 'searchable')) === true
          && stringList(property(body, 'non_searchable_indices')).length === 0,
        aggregatable: boolOf(property(body, 'aggregatable')) ?? false,
        metadata: boolOf(property(body, 'metadata_field')) ?? false,
      }];
    });
    return [{ name, types, conflict: types.length > 1 }];
  });
  return { ok: true, value: { indices: stringList(property(root, 'indices')), fields: fields.sort(byName) } };
}

function flattenProperties(index: string, prefix: string, properties: ReturnType<typeof property>, out: MappingField[]): void {
  if (properties?.type !== 'object') return;
  for (const entry of properties.children ?? []) {
    if (entry.type !== 'property') continue;
    const key = textOf(entry.children?.[0]);
    const body = entry.children?.[1];
    if (key === undefined || body?.type !== 'object') continue;
    const path = prefix === '' ? key : `${prefix}.${key}`;
    const nested = property(body, 'properties');
    const type = textOf(property(body, 'type')) ?? (nested ? 'object' : 'unknown');
    out.push({ index, path, type });
    flattenProperties(index, path, nested, out);
  }
}

/** Flatten every mapping in the response into `index`/`path`/`type` rows for the detail view. */
export function parseMappingFields(raw: string): ResourceParse<MappingField[]> {
  const root = parseRawJson(raw);
  if (!root || root.type !== 'object') return { ok: false, code: 'invalidResponse' };
  const fields: MappingField[] = [];
  for (const entry of root.children ?? []) {
    if (entry.type !== 'property') continue;
    const index = textOf(entry.children?.[0]);
    const mappings = property(entry.children?.[1], 'mappings');
    if (index === undefined || mappings?.type !== 'object') continue;
    flattenProperties(index, '', property(mappings, 'properties'), fields);
  }
  return { ok: true, value: fields };
}
