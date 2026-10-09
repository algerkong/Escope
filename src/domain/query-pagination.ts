import { parseRawJson, property, rawTextOf } from './query-result';

/**
 * Only an explicit sort and a first-page body opt into managed PIT pagination.
 * Other DSL is still executable verbatim, but cannot borrow a cursor from another snapshot.
 */
export function supportsSnapshotPaging(rawDsl: string): boolean {
  const root = parseRawJson(rawDsl);
  if (root?.type !== 'object') return false;
  if (['pit', 'search_after', 'collapse'].some((key) => property(root, key) !== undefined)) return false;
  const from = property(root, 'from');
  if (from !== undefined && rawTextOf(rawDsl, from) !== '0') return false;
  const size = property(root, 'size');
  if (size !== undefined && (size.type !== 'number' || Number(size.value) <= 0)) return false;
  const sort = property(root, 'sort');
  return sort !== undefined && (
    (sort.type === 'array' && (sort.children?.length ?? 0) > 0)
    || (sort.type === 'object' && (sort.children?.length ?? 0) > 0)
    || (sort.type === 'string' && String(sort.value).trim() !== '')
  );
}

/** Preview never reads or rewrites a user's query document. */
export const DATA_PREVIEW_DSL = '{\n  "query": { "match_all": {} },\n  "size": 25,\n  "sort": ["_shard_doc"],\n  "track_total_hits": true\n}';
