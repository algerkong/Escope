import { applyEdits, parseTree, type Edit, type Node } from 'jsonc-parser';
import { validateQueryDsl } from './query-dsl';
import { property } from './query-result';
import type { FieldCatalog } from './resource';
import type {
  AggregationBuilderType,
  ChartAggregationClause,
  ChartSubMetric,
} from './saved-charts';

export const MAX_AGGREGATION_DSL_BYTES = 256 * 1024;
export const MAX_AGGREGATION_CLAUSES = 32;

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

const NUMERIC_TYPES = new Set([
  'long', 'integer', 'short', 'byte', 'double', 'float', 'half_float', 'scaled_float', 'unsigned_long',
]);

const DATE_TYPES = new Set(['date', 'date_nanos']);

export interface FieldSuitability {
  readonly suitable: boolean;
  readonly warning?: string;
  readonly primaryType?: string;
}

export function isFieldSuitableForAggregation(
  field: string,
  aggType: AggregationBuilderType,
  catalog?: FieldCatalog,
): FieldSuitability {
  if (!catalog || !catalog.fields || catalog.fields.length === 0) {
    return { suitable: true };
  }

  const capability = catalog.fields.find((f) => f.name === field);
  if (!capability) {
    return { suitable: true, warning: 'fieldNotReported' };
  }

  if (capability.conflict) {
    return { suitable: false, warning: 'typeConflict' };
  }

  const typeCap = capability.types[0];
  if (!typeCap) {
    return { suitable: true, warning: 'fieldNotReported' };
  }

  const primaryType = typeCap.type;

  if (aggType === 'date_histogram') {
    if (!DATE_TYPES.has(primaryType)) {
      return { suitable: false, warning: 'notDateField', primaryType };
    }
    return { suitable: true, primaryType };
  }

  if (['sum', 'avg', 'min', 'max'].includes(aggType)) {
    if (!NUMERIC_TYPES.has(primaryType)) {
      return { suitable: false, warning: 'notNumericField', primaryType };
    }
    return { suitable: true, primaryType };
  }

  if (aggType === 'terms') {
    if (!typeCap.aggregatable) {
      return { suitable: false, warning: 'notAggregatable', primaryType };
    }
    if (primaryType === 'text') {
      return { suitable: false, warning: 'textFieldTerms', primaryType };
    }
    return { suitable: true, primaryType };
  }

  // cardinality and value_count
  if (!typeCap.aggregatable && primaryType === 'text') {
    return { suitable: false, warning: 'notAggregatable', primaryType };
  }

  return { suitable: true, primaryType };
}

export function suggestAggregationFieldList(
  aggType: AggregationBuilderType,
  catalog?: FieldCatalog,
): readonly string[] {
  if (!catalog || !catalog.fields) return [];

  const matched: string[] = [];
  const other: string[] = [];

  for (const field of catalog.fields) {
    const suitability = isFieldSuitableForAggregation(field.name, aggType, catalog);
    if (suitability.suitable) {
      matched.push(field.name);
    } else {
      other.push(field.name);
    }
  }

  return [...matched, ...other];
}

export function buildAggregationDslObject(clauses: readonly ChartAggregationClause[]): Record<string, unknown> {
  const aggsObj: Record<string, unknown> = {};

  for (const clause of clauses) {
    const clauseDef: Record<string, unknown> = {};

    if (['sum', 'avg', 'min', 'max', 'value_count', 'cardinality'].includes(clause.aggregationType)) {
      clauseDef[clause.aggregationType] = { field: clause.field };
    } else if (clause.aggregationType === 'terms') {
      const termsDef: Record<string, unknown> = {
        field: clause.field,
        size: clause.size ?? 10,
      };
      if (clause.orderMetric && clause.orderDirection) {
        termsDef.order = { [clause.orderMetric]: clause.orderDirection };
      }
      clauseDef.terms = termsDef;

      if (clause.subMetrics && clause.subMetrics.length > 0) {
        const subAggsObj: Record<string, unknown> = {};
        for (const sub of clause.subMetrics) {
          subAggsObj[sub.name] = {
            [sub.metricType]: { field: sub.field },
          };
        }
        clauseDef.aggs = subAggsObj;
      }
    } else if (clause.aggregationType === 'date_histogram') {
      const histDef: Record<string, unknown> = {
        field: clause.field,
      };
      const intervalKey = clause.intervalType === 'fixed' ? 'fixed_interval' : 'calendar_interval';
      histDef[intervalKey] = clause.interval || '1d';

      if (clause.minDocCount !== undefined) {
        histDef.min_doc_count = clause.minDocCount;
      }
      clauseDef.date_histogram = histDef;

      if (clause.subMetrics && clause.subMetrics.length > 0) {
        const subAggsObj: Record<string, unknown> = {};
        for (const sub of clause.subMetrics) {
          subAggsObj[sub.name] = {
            [sub.metricType]: { field: sub.field },
          };
        }
        clauseDef.aggs = subAggsObj;
      }
    }

    aggsObj[clause.name] = clauseDef;
  }

  return aggsObj;
}

export function parseAggregationClausesFromDsl(sourceDsl: string): {
  readonly ok: true;
  readonly clauses: readonly ChartAggregationClause[];
} | {
  readonly ok: false;
  readonly reason: string;
} {
  const root = parseTree(sourceDsl);
  if (!root || root.type !== 'object') {
    return { ok: false, reason: 'invalidDsl' };
  }

  const aggsNode = property(root, 'aggs') ?? property(root, 'aggregations');
  if (!aggsNode) {
    return { ok: true, clauses: [] };
  }

  if (aggsNode.type !== 'object' || !aggsNode.children) {
    return { ok: false, reason: 'aggsNotObject' };
  }

  const clauses: ChartAggregationClause[] = [];

  for (const childProp of aggsNode.children) {
    const keyNode = childProp.children?.[0];
    const valNode = childProp.children?.[1];
    if (!keyNode || !valNode || valNode.type !== 'object') continue;

    const aggName = String(keyNode.value);
    let recognized = false;

    // Check metric
    for (const metric of ['sum', 'avg', 'min', 'max', 'value_count', 'cardinality'] as const) {
      const metricNode = property(valNode, metric);
      if (metricNode && metricNode.type === 'object') {
        const fieldNode = property(metricNode, 'field');
        if (fieldNode && typeof fieldNode.value === 'string') {
          clauses.push({
            id: `clause_${clauses.length + 1}`,
            name: aggName,
            aggregationType: metric,
            field: fieldNode.value,
          });
          recognized = true;
          break;
        }
      }
    }

    if (recognized) continue;

    // Check terms
    const termsNode = property(valNode, 'terms');
    if (termsNode && termsNode.type === 'object') {
      const fieldNode = property(termsNode, 'field');
      const sizeNode = property(termsNode, 'size');
      const orderNode = property(termsNode, 'order');
      if (fieldNode && typeof fieldNode.value === 'string') {
        let orderMetric: string | undefined;
        let orderDirection: 'asc' | 'desc' | undefined;
        if (orderNode && orderNode.type === 'object' && orderNode.children?.[0]) {
          const orderProp = orderNode.children[0];
          orderMetric = String(orderProp.children?.[0]?.value);
          const dirVal = String(orderProp.children?.[1]?.value).toLowerCase();
          if (dirVal === 'asc' || dirVal === 'desc') {
            orderDirection = dirVal;
          }
        }

        const subMetrics: ChartSubMetric[] = [];
        const subAggsNode = property(valNode, 'aggs') ?? property(valNode, 'aggregations');
        if (subAggsNode && subAggsNode.type === 'object' && subAggsNode.children) {
          for (const subProp of subAggsNode.children) {
            const subKey = subProp.children?.[0]?.value;
            const subVal = subProp.children?.[1];
            if (typeof subKey !== 'string' || !subVal || subVal.type !== 'object') continue;
            for (const subMetric of ['sum', 'avg', 'min', 'max', 'value_count', 'cardinality'] as const) {
              const innerNode = property(subVal, subMetric);
              if (innerNode && innerNode.type === 'object') {
                const innerField = property(innerNode, 'field');
                if (innerField && typeof innerField.value === 'string') {
                  subMetrics.push({
                    id: `sub_${subMetrics.length + 1}`,
                    name: subKey,
                    metricType: subMetric,
                    field: innerField.value,
                  });
                }
              }
            }
          }
        }

        clauses.push({
          id: `clause_${clauses.length + 1}`,
          name: aggName,
          aggregationType: 'terms',
          field: fieldNode.value,
          size: typeof sizeNode?.value === 'number' ? sizeNode.value : 10,
          orderMetric,
          orderDirection,
          subMetrics: subMetrics.length > 0 ? subMetrics : undefined,
        });
        continue;
      }
    }

    // Check date_histogram
    const histNode = property(valNode, 'date_histogram');
    if (histNode && histNode.type === 'object') {
      const fieldNode = property(histNode, 'field');
      const calIntervalNode = property(histNode, 'calendar_interval');
      const fixedIntervalNode = property(histNode, 'fixed_interval');
      const minDocCountNode = property(histNode, 'min_doc_count');
      if (fieldNode && typeof fieldNode.value === 'string') {
        const intervalType: 'calendar' | 'fixed' = fixedIntervalNode ? 'fixed' : 'calendar';
        const interval = String(fixedIntervalNode?.value ?? calIntervalNode?.value ?? '1d');

        const subMetrics: ChartSubMetric[] = [];
        const subAggsNode = property(valNode, 'aggs') ?? property(valNode, 'aggregations');
        if (subAggsNode && subAggsNode.type === 'object' && subAggsNode.children) {
          for (const subProp of subAggsNode.children) {
            const subKey = subProp.children?.[0]?.value;
            const subVal = subProp.children?.[1];
            if (typeof subKey !== 'string' || !subVal || subVal.type !== 'object') continue;
            for (const subMetric of ['sum', 'avg', 'min', 'max', 'value_count', 'cardinality'] as const) {
              const innerNode = property(subVal, subMetric);
              if (innerNode && innerNode.type === 'object') {
                const innerField = property(innerNode, 'field');
                if (innerField && typeof innerField.value === 'string') {
                  subMetrics.push({
                    id: `sub_${subMetrics.length + 1}`,
                    name: subKey,
                    metricType: subMetric,
                    field: innerField.value,
                  });
                }
              }
            }
          }
        }

        clauses.push({
          id: `clause_${clauses.length + 1}`,
          name: aggName,
          aggregationType: 'date_histogram',
          field: fieldNode.value,
          intervalType,
          interval,
          minDocCount: typeof minDocCountNode?.value === 'number' ? minDocCountNode.value : undefined,
          subMetrics: subMetrics.length > 0 ? subMetrics : undefined,
        });
      }
    }
  }

  return { ok: true, clauses };
}

function aggsEdit(root: Node, aggsContent: string | null): Edit | null {
  const props = root.children ?? [];
  const index = props.findIndex((entry) => entry.children?.[0]?.value === 'aggs' || entry.children?.[0]?.value === 'aggregations');
  const target = props[index];

  if (aggsContent !== null) {
    const value = target?.children?.[1];
    if (value) {
      return { offset: value.offset, length: value.length, content: aggsContent };
    }
    const last = props.at(-1);
    return {
      offset: last ? last.offset + last.length : root.offset + 1,
      length: 0,
      content: `${last ? ',\n  ' : '\n  '}"aggs": ${aggsContent}`,
    };
  }

  // Remove aggs property
  if (!target) return null;
  if (props.length === 1) return { offset: target.offset, length: target.length, content: '' };
  if (index === 0) return { offset: target.offset, length: props[1]!.offset - target.offset, content: '' };
  const previous = props[index - 1]!;
  const offset = previous.offset + previous.length;
  return { offset, length: target.offset + target.length - offset, content: '' };
}

export type QueryAggregationPreview =
  | { readonly ok: true; readonly dsl: string; readonly changed: boolean }
  | { readonly ok: false; readonly code: 'invalidDsl' | 'tooLarge' | 'tooManyClauses' };

export function previewAggregationDsl(
  sourceDsl: string,
  clauses: readonly ChartAggregationClause[],
): QueryAggregationPreview {
  if (bytes(sourceDsl) > MAX_AGGREGATION_DSL_BYTES) {
    return { ok: false, code: 'tooLarge' };
  }

  const validation = validateQueryDsl(sourceDsl);
  if (!validation.ok) {
    return { ok: false, code: 'invalidDsl' };
  }

  if (clauses.length > MAX_AGGREGATION_CLAUSES) {
    return { ok: false, code: 'tooManyClauses' };
  }

  const root = parseTree(sourceDsl);
  if (!root || root.type !== 'object') {
    return { ok: false, code: 'invalidDsl' };
  }

  let formattedAggsContent: string | null = null;
  if (clauses.length > 0) {
    const aggsObj = buildAggregationDslObject(clauses);
    formattedAggsContent = JSON.stringify(aggsObj, null, 2);
  }

  const edit = aggsEdit(root, formattedAggsContent);
  const newDsl = edit ? applyEdits(sourceDsl, [edit]) : sourceDsl;

  if (bytes(newDsl) > MAX_AGGREGATION_DSL_BYTES) {
    return { ok: false, code: 'tooLarge' };
  }

  const newValidation = validateQueryDsl(newDsl);
  if (!newValidation.ok) {
    return { ok: false, code: 'invalidDsl' };
  }

  return {
    ok: true,
    dsl: newDsl,
    changed: newDsl !== sourceDsl,
  };
}
