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

export type FieldIndexEvidence =
  | { readonly status: 'notReported' | 'invalid' }
  | { readonly status: 'reported'; readonly indices: readonly string[] };

export interface FieldCapabilityReport {
  readonly searchable: boolean | null;
  readonly aggregatable: boolean | null;
  readonly metadata: boolean | null;
  readonly indices: FieldIndexEvidence;
  readonly nonSearchableIndices: FieldIndexEvidence;
  readonly nonAggregatableIndices: FieldIndexEvidence;
}

export type FieldCapabilityStatus = 'supported' | 'unsupported' | 'restricted' | 'unknown';

export interface FieldTypeCapability {
  readonly type: string;
  /** Conservative gates, not permission checks or the original reported flags. */
  readonly searchable: boolean;
  readonly aggregatable: boolean;
  readonly metadata: boolean;
  /** Present on parsed field caps; optional for existing local capability projections. */
  readonly report?: FieldCapabilityReport;
}

export interface FieldCapability {
  readonly name: string;
  readonly types: readonly FieldTypeCapability[];
  /** More than one reported type; capability evidence must stay separate for each. */
  readonly conflict: boolean;
}

export interface FieldCatalog {
  readonly indices: readonly string[];
  readonly fields: readonly FieldCapability[];
  readonly indexEvidence?: FieldIndexEvidence;
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

function fieldIndexEvidence(node: ReturnType<typeof property>): FieldIndexEvidence {
  if (node === undefined) return { status: 'notReported' };
  if (node.type !== 'array') return { status: 'invalid' };
  const indices: string[] = [];
  const seen = new Set<string>();
  for (const child of node.children ?? []) {
    const name = textOf(child);
    if (name === undefined || name === '' || seen.has(name)) return { status: 'invalid' };
    seen.add(name);
    indices.push(name);
  }
  return { status: 'reported', indices };
}

export function fieldCapabilityStatus(report: FieldCapabilityReport | undefined,
  capability: 'searchable' | 'aggregatable'): FieldCapabilityStatus {
  if (!report || report[capability] === null || report.indices.status === 'invalid') return 'unknown';
  const exceptions = capability === 'searchable' ? report.nonSearchableIndices : report.nonAggregatableIndices;
  if (exceptions.status === 'invalid') return 'unknown';
  if (exceptions.status === 'reported' && exceptions.indices.length > 0) return 'restricted';
  return report[capability] ? 'supported' : 'unsupported';
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
  const indexEvidence = fieldIndexEvidence(property(root, 'indices'));
  if (indexEvidence.status === 'invalid') return { ok: false, code: 'invalidResponse' };
  const fields: FieldCapability[] = [];
  for (const entry of fieldsNode.children ?? []) {
    const name = textOf(entry.children?.[0]);
    const caps = entry.children?.[1];
    if (name === undefined || caps?.type !== 'object') return { ok: false, code: 'invalidResponse' };
    const types: FieldTypeCapability[] = [];
    for (const cap of caps.children ?? []) {
      const typeName = textOf(cap.children?.[0]);
      const body = cap.children?.[1];
      if (typeName === undefined || typeName === '' || body?.type !== 'object') return { ok: false, code: 'invalidResponse' };
      const declaredType = property(body, 'type');
      if (declaredType !== undefined && textOf(declaredType) !== typeName) return { ok: false, code: 'invalidResponse' };
      const report: FieldCapabilityReport = {
        searchable: boolOf(property(body, 'searchable')) ?? null,
        aggregatable: boolOf(property(body, 'aggregatable')) ?? null,
        metadata: boolOf(property(body, 'metadata_field')) ?? null,
        indices: fieldIndexEvidence(property(body, 'indices')),
        nonSearchableIndices: fieldIndexEvidence(property(body, 'non_searchable_indices')),
        nonAggregatableIndices: fieldIndexEvidence(property(body, 'non_aggregatable_indices')),
      };
      types.push({
        type: typeName,
        searchable: fieldCapabilityStatus(report, 'searchable') === 'supported',
        aggregatable: fieldCapabilityStatus(report, 'aggregatable') === 'supported',
        metadata: report.metadata === true,
        report,
      });
    }
    fields.push({ name, types, conflict: types.length > 1 });
  }
  return { ok: true, value: {
    indices: indexEvidence.status === 'reported' ? indexEvidence.indices : [],
    indexEvidence, fields: fields.sort(byName),
  } };
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
