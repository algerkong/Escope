import { applyEdits, format, parseTree, type FormattingOptions, type Node, type ParseError } from 'jsonc-parser';

/**
 * Local failure codes for `_search` request-body DSL text.
 * UI copy (zh-CN/en-US) is wired in the editor task; this module only reports codes.
 */
export type QueryDslErrorCode =
  | 'dslEmpty'
  | 'dslSyntaxError'
  | 'dslNotObject'
  | 'dslDuplicateKey'
  | 'dslParseFailed';

/**
 * Structured validation failure. It never carries parser messages, key names or values:
 * parsers quote the offending input, so only the code and a best-effort position survive.
 */
export interface QueryDslError {
  readonly code: QueryDslErrorCode;
  /** 1-based line of the offending token, when the parser reported a position. */
  readonly line?: number;
  /** 1-based column of the offending token, when the parser reported a position. */
  readonly column?: number;
}

export type QueryDslValidation =
  | { readonly ok: true; readonly source: string }
  | { readonly ok: false; readonly error: QueryDslError };

export type QueryDslFormatting =
  | { readonly ok: true; readonly source: string; readonly formatted: string }
  | { readonly ok: false; readonly error: QueryDslError };

/** Two-space indentation matches the draft seeded by `createQuery`. */
export const DSL_FORMAT_INDENT = 2;

/** ES rejects comments and trailing commas in a request body, so strict JSON only. */
const STRICT_JSON = { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false };

const FORMAT_OPTIONS: FormattingOptions = {
  insertSpaces: true,
  tabSize: DSL_FORMAT_INDENT,
  eol: '\n',
  insertFinalNewline: false,
};

function locate(source: string, offset: number | undefined): Pick<QueryDslError, 'line' | 'column'> {
  if (offset === undefined) return {};
  let line = 1;
  let column = 1;
  for (let i = 0; i < Math.min(offset, source.length); i += 1) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

/**
 * Offset of the first repeated property name, walking the whole tree.
 * `parseTree` keeps every property and decodes string escapes, so equal values are still
 * duplicates and `"\u0073ize"` collides with `"size"`. Each object gets its own set:
 * sibling array items may legitimately repeat a key.
 */
function duplicateKeyOffset(root: Node): number | undefined {
  const pending: Node[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    if (node.type === 'object') {
      const seen = new Set<string>();
      for (const property of node.children ?? []) {
        const [keyNode, valueNode] = property.children ?? [];
        const key: unknown = keyNode?.value;
        if (keyNode !== undefined && typeof key === 'string') {
          if (seen.has(key)) return keyNode.offset + 1;
          seen.add(key);
        }
        if (valueNode !== undefined) pending.push(valueNode);
      }
    } else if (node.type === 'array') {
      for (const child of node.children ?? []) pending.push(child);
    }
  }
  return undefined;
}

type DslStructure = { readonly ok: true } | { readonly ok: false; readonly error: QueryDslError };

/**
 * Structural check: strict JSON, object root, no repeated key anywhere.
 * Unknown or unsupported ES DSL is *not* a syntax error: anything that parses as an
 * object is accepted, because ES authorization and query validity are decided by the
 * backend, not here.
 */
function checkStructure(source: string): DslStructure {
  if (source.trim() === '') return { ok: false, error: { code: 'dslEmpty' } };
  const parseErrors: ParseError[] = [];
  let root: Node | undefined;
  try {
    root = parseTree(source, parseErrors, STRICT_JSON);
  } catch {
    // Nesting beyond the recursive parser's stack is a resource failure, not a syntax error.
    return { ok: false, error: { code: 'dslParseFailed' } };
  }
  const firstError = parseErrors[0];
  if (firstError !== undefined || root === undefined) {
    return { ok: false, error: { code: 'dslSyntaxError', ...locate(source, firstError?.offset) } };
  }
  if (root.type !== 'object') return { ok: false, error: { code: 'dslNotObject' } };
  const duplicate = duplicateKeyOffset(root);
  if (duplicate !== undefined) {
    return { ok: false, error: { code: 'dslDuplicateKey', ...locate(source, duplicate) } };
  }
  return { ok: true };
}

/**
 * Check that `source` is a JSON object usable as an ES `_search` request body.
 * The draft text stays the source of truth; this never rewrites it.
 */
export function validateQueryDsl(source: string): QueryDslValidation {
  const structure = checkStructure(source);
  return structure.ok ? { ok: true, source } : { ok: false, error: structure.error };
}

/**
 * Pretty-print the draft with whitespace-only edits: token text is never re-serialized,
 * so integers beyond `Number.MAX_SAFE_INTEGER`, long decimals, exponents, escape
 * sequences and key order all survive unchanged. The verbatim `source` is returned
 * alongside, so callers can keep it as the source of truth and only replace the editor
 * content on an explicit user action.
 */
export function formatQueryDsl(source: string): QueryDslFormatting {
  const structure = checkStructure(source);
  if (!structure.ok) return { ok: false, error: structure.error };
  return { ok: true, source, formatted: applyEdits(source, format(source, undefined, FORMAT_OPTIONS)) };
}
