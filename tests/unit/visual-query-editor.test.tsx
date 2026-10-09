import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VisualQueryEditor } from '../../src/features/query/VisualQueryEditor';
import { createQuery } from '../../src/domain/query';
import type { FieldCapability } from '../../src/domain/resource';
import { i18n } from '../../src/locales';
import { enVisualQuery, zhVisualQuery } from '../../src/locales/visual-query';

// The app registers this namespace; the component test registers it locally, like the other features.
i18n.addResourceBundle('zh-CN', 'visualQuery', zhVisualQuery);
i18n.addResourceBundle('en-US', 'visualQuery', enVisualQuery);

const FIELDS: FieldCapability[] = [
  { name: 'id', types: [{ type: 'long', searchable: true, aggregatable: true, metadata: false }], conflict: false },
  { name: 'name', types: [{ type: 'text', searchable: true, aggregatable: false, metadata: false }], conflict: false },
  { name: 'bad', types: [
    { type: 'long', searchable: true, aggregatable: true, metadata: false },
    { type: 'text', searchable: true, aggregatable: false, metadata: false },
  ], conflict: true },
];

function setup(rawDsl: string, fields: FieldCapability[] = FIELDS) {
  const onChange = vi.fn();
  const view = render(
    <I18nextProvider i18n={i18n}>
      <VisualQueryEditor rawDsl={rawDsl} fields={fields} onChange={onChange} />
    </I18nextProvider>,
  );
  const rerender = (next: string) => view.rerender(
    <I18nextProvider i18n={i18n}>
      <VisualQueryEditor rawDsl={next} fields={fields} onChange={onChange} />
    </I18nextProvider>,
  );
  return { user: userEvent.setup(), onChange, rerender };
}

beforeEach(async () => { await i18n.changeLanguage('zh-CN'); });

describe('VisualQueryEditor: reverse state', () => {
  it('renders the reversed form without emitting anything on mount', () => {
    const { onChange } = setup('{"query":{"term":{"id":9007199254740993}},"size":25}');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText('字段 1')).toHaveValue('id');
    expect(screen.getByLabelText('值 1')).toHaveValue('9007199254740993');
    expect(screen.getByLabelText('数量')).toHaveValue('25');
    expect(screen.getByRole('button', { name: '添加条件' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '移除条件 1' })).toBeInTheDocument();
  });

  it('keeps unsupported DSL untouched and swaps to the form only on a supported draft', async () => {
    const { user, onChange, rerender } = setup('{"query":{"match_all":{"boost":2}}}');
    expect(screen.getByRole('status')).toHaveTextContent('可视化子集之外的 DSL');
    expect(screen.queryByLabelText('字段 1')).not.toBeInTheDocument();
    rerender('{"query":{"term":{"id":1}}}');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText('字段 1')).toHaveValue('id');
    await user.click(screen.getByLabelText('值 1'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('resyncs from an external draft change without emitting', () => {
    const { onChange, rerender } = setup('{"query":{"term":{"id":1}}}');
    rerender('{"query":{"term":{"name":"renamed"}}}');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText('字段 1')).toHaveValue('name');
    expect(screen.getByLabelText('值 1')).toHaveValue('renamed');
  });
});

describe('VisualQueryEditor: createQuery default draft', () => {
  it('renders an empty condition list for the seeded match_all draft without emitting', () => {
    const { onChange } = setup(createQuery(null).dsl);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('字段 1')).not.toBeInTheDocument();
    expect(screen.getByLabelText('数量')).toHaveValue('25');
    expect(screen.getByRole('button', { name: '添加条件' })).toBeInTheDocument();
  });

  it('replaces match_all with the first completed condition and keeps size', async () => {
    const { user, onChange } = setup(createQuery(null).dsl);
    await user.click(screen.getByRole('button', { name: '添加条件' }));
    await user.type(screen.getByLabelText('字段 1'), 'id');
    expect(onChange).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByLabelText('值类型 1'), 'number');
    await user.type(screen.getByLabelText('值 1'), '1');
    expect(onChange).toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith('{\n  "query": {"bool":{"filter":[{"term":{"id":1}}]}},\n  "size": 25\n}');
  });

  it('keeps a filter row non-scoring when switching to OR', async () => {
    const { user, onChange } = setup('{"query":{"bool":{"filter":[{"term":{"id":1}}]}}}');
    await user.selectOptions(screen.getByLabelText('条件组合'), 'any');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('{"query":{"bool":{"should":[{"bool":{"filter":[{"term":{"id":1}}]}}],"minimum_should_match":1}}}');
  });
});

describe('VisualQueryEditor: editing', () => {
  it('adds a condition and emits only once the row is complete', async () => {
    const { user, onChange } = setup('{}');
    await user.click(screen.getByRole('button', { name: '添加条件' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请输入字段名。');
    expect(onChange).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('字段 1'), 'name');
    expect(onChange).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByLabelText('运算符 1'), 'match');
    expect(onChange).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('值 1'), 'hello');
    expect(onChange).toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith('{\n  "query": {"bool":{"filter":[{"match":{"name":"hello"}}]}}\n}');
  });

  it('removes a condition and rewrites only the query property', async () => {
    const { user, onChange } = setup('{"query":{"bool":{"filter":[{"term":{"id":1}},{"term":{"id":2}}]}},"size":3}');
    await user.click(screen.getByRole('button', { name: '移除条件 1' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('{"query":{"bool":{"filter":[{"term":{"id":2}}]}},"size":3}');
    expect(screen.queryByLabelText('字段 2')).not.toBeInTheDocument();
  });

  it('preserves a long integer and unrelated properties while another value is edited', async () => {
    const raw = '{"query":{"term":{"id":9007199254740993}},"size":25,"aggs":{"x":{"terms":{"field":"id"}}}}';
    const { user, onChange } = setup(raw);
    const value = screen.getByLabelText('值 1');
    await user.clear(value);
    expect(onChange).not.toHaveBeenCalled();
    await user.type(value, '7');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('{"query":{"term":{"id":7}},"size":25,"aggs":{"x":{"terms":{"field":"id"}}}}');
  });

  it('emits an explicit minimum_should_match when switching to OR', async () => {
    const { user, onChange } = setup('{"query":{"term":{"id":1}}}');
    await user.selectOptions(screen.getByLabelText('条件组合'), 'any');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('{"query":{"bool":{"should":[{"term":{"id":1}}],"minimum_should_match":1}}}');
    expect(screen.queryByLabelText('上下文 1')).not.toBeInTheDocument();
  });

  it('rejects an OR mode with a negative condition instead of changing semantics', async () => {
    const { user, onChange } = setup('{"query":{"term":{"id":1}}}');
    await user.selectOptions(screen.getByLabelText('运算符 1'), 'neq');
    expect(onChange).toHaveBeenLastCalledWith('{"query":{"bool":{"must_not":[{"term":{"id":1}}]}}}');
    await user.selectOptions(screen.getByLabelText('条件组合'), 'any');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent('只支持正向条件');
  });
});

describe('VisualQueryEditor: validation drafts', () => {
  it('keeps an invalid number draft local and applies the corrected value', async () => {
    const { user, onChange } = setup('{}');
    await user.click(screen.getByRole('button', { name: '添加条件' }));
    await user.type(screen.getByLabelText('字段 1'), 'id');
    await user.selectOptions(screen.getByLabelText('值类型 1'), 'number');
    await user.type(screen.getByLabelText('值 1'), 'abc');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('合法的 JSON 数字');
    const value = screen.getByLabelText('值 1');
    await user.clear(value);
    await user.type(value, '5');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('{\n  "query": {"bool":{"filter":[{"term":{"id":5}}]}}\n}');
  });

  it('keeps an invalid size draft local and does not touch the last valid DSL', async () => {
    const { user, onChange } = setup('{"size":25}');
    const size = screen.getByLabelText('数量');
    await user.tripleClick(size);
    await user.keyboard('abc');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('0 到 10000 之间的整数');
    await user.tripleClick(size);
    await user.keyboard('5');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('{"size":5}');
  });

  it('flags a conflicting field and never emits an unsafe query for it', async () => {
    const { onChange } = setup('{"query":{"term":{"name":"x"}}}');
    fireEvent.change(screen.getByLabelText('字段 1'), { target: { value: 'bad' } });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('类型冲突');
  });

  it('keeps an invalid sort draft local and does not touch the last valid DSL', async () => {
    const { onChange } = setup('{"query":{"term":{"id":1}},"sort":[{"id":{"order":"asc"}}]}');
    const sort = screen.getByLabelText('排序字段');
    fireEvent.change(sort, { target: { value: 'name' } });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('不能在此排序');
    expect(sort).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(sort, { target: { value: '_doc' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('{"query":{"term":{"id":1}},"sort":[{"_doc":{"order":"asc"}}]}');
  });

  it('suggests discovered fields while still allowing manual entry', async () => {
    const { user, onChange } = setup('{}');
    await user.click(screen.getByRole('button', { name: '添加条件' }));
    const options = Array.from(document.querySelectorAll('datalist option')).map((option) => option.getAttribute('value'));
    expect(options).toEqual(['id', 'name', 'bad']);
    const field = screen.getByLabelText('字段 1');
    await user.type(field, 'custom');
    await user.type(screen.getByLabelText('值 1'), 'v');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('{\n  "query": {"bool":{"filter":[{"term":{"custom":"v"}}]}}\n}');
  });
});

describe('visualQuery locale bundle', () => {
  it('defines the same non-empty, distinct keys in both languages', () => {
    const enKeys = Object.keys(enVisualQuery).sort();
    expect(Object.keys(zhVisualQuery).sort()).toEqual(enKeys);
    for (const key of enKeys) {
      const en = enVisualQuery[key as keyof typeof enVisualQuery];
      const zh = zhVisualQuery[key as keyof typeof zhVisualQuery];
      expect(en.trim(), key).not.toBe('');
      expect(zh.trim(), key).not.toBe('');
      // A copied English string would leave Chinese users with untranslated controls.
      expect(zh, key).not.toBe(en);
    }
  });
});

describe('VisualQueryEditor: localized states and isolation', () => {
  it('localizes the unsupported state', async () => {
    await i18n.changeLanguage('en-US');
    const { onChange } = setup('{"sort":[{"a":"asc"},{"b":"desc"}]}');
    expect(screen.getByRole('status')).toHaveTextContent('existing sort cannot be represented');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows the invalid-draft state with a position and no form', () => {
    const { onChange } = setup('{"query":{"term":@}}');
    expect(screen.getByRole('status')).toHaveTextContent('还不是 JSON 对象');
    expect(screen.getByRole('status')).toHaveTextContent('第 1 行');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('performs no external requests while editing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { user, onChange } = setup('{"query":{"term":{"id":1}}}');
    await user.type(screen.getByLabelText('值 1'), '2');
    expect(onChange).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('keeps problem text inside the editor region and labels every row control', async () => {
    const { user } = setup('{}');
    await user.click(screen.getByRole('button', { name: '添加条件' }));
    const row = screen.getByLabelText('字段 1').closest('.vq-row');
    expect(row).not.toBeNull();
    if (row) {
      expect(within(row as HTMLElement).getByLabelText('运算符 1')).toBeInTheDocument();
      expect(within(row as HTMLElement).getByLabelText('值类型 1')).toBeInTheDocument();
      expect(within(row as HTMLElement).getByLabelText('值 1')).toBeInTheDocument();
      expect(within(row as HTMLElement).getByLabelText('上下文 1')).toBeInTheDocument();
      expect(within(row as HTMLElement).getByRole('button', { name: '移除条件 1' })).toHaveAttribute('title', '移除条件 1');
    }
  });
});
