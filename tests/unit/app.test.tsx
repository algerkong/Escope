import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { App } from '../../src/app/App';
import { i18n } from '../../src/locales';
import { createSessionStorage, type StorageService } from '../../src/services/storage';

beforeEach(async () => { await i18n.changeLanguage('zh-CN'); });

async function mount(service: StorageService = createSessionStorage()) {
  const initial = await service.load();
  initial.preferences.locale = 'zh-CN';
  render(<I18nextProvider i18n={i18n}><App service={service} initial={initial} /></I18nextProvider>);
  return userEvent.setup();
}
async function settings(user: ReturnType<typeof userEvent.setup>, name = '常规') {
  await user.click(screen.getAllByRole('button', { name: '设置' })[0]!);
  await user.click(screen.getByRole('button', { name }));
}

describe('workbench', () => {
  it('starts empty, keeps AI closed and never sends a request', async () => {
    await mount();
    expect(screen.getByRole('tab', { name: '数据预览' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('textbox', { name: '查询 DSL' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开索引' })).toBeDisabled();
    expect(screen.queryByRole('complementary', { name: 'AI 助手' })).not.toBeInTheDocument();
    expect(screen.getByText('浏览器预览 · 仅本次会话', { selector: '.session-banner' })).toBeInTheDocument();
    expect(screen.queryByLabelText('当前连接')).not.toBeInTheDocument();
  });
  it('retains query text, target, result view and AI state across settings', async () => {
    const user = await mount();
    await user.click(screen.getAllByRole('tab')[1]!);
    const editor = screen.getByLabelText('查询 DSL');
    fireEvent.change(editor, { target: { value: '{"id":9007199254740993}' } });
    await user.type(screen.getByLabelText('索引或匹配模式'), 'orders-*');
    await user.click(screen.getByRole('button', { name: 'JSON' }));
    await user.click(screen.getByRole('button', { name: '显示或隐藏 AI 面板' }));
    await settings(user);
    for (const name of ['连接中心', 'AI 模型', '集群概览', '节点', '分片', '索引']) {
      await user.click(screen.getByRole('button', { name }));
      expect(screen.getByRole('navigation', { name: '设置' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1, name })).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    }
    await user.click(screen.getByRole('button', { name: '返回查询' }));
    expect(screen.getByLabelText('查询 DSL')).toHaveValue('{"id":9007199254740993}');
    expect(screen.getByLabelText('索引或匹配模式')).toHaveValue('orders-*');
    expect(screen.getByRole('button', { name: 'JSON' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('complementary', { name: 'AI 助手' })).toBeInTheDocument();
  });
  it('adds, renames and switches connection metadata without rebinding queries', async () => {
    const service = createSessionStorage();
    const user = await mount(service);
    await settings(user, '连接中心');
    await user.click(screen.getByRole('button', { name: '添加连接' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('名称'), 'First');
    fireEvent.change(within(dialog).getByLabelText('Elasticsearch 地址'), { target: { value: 'https://first.example.test' } });
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByLabelText('当前连接')).not.toBeInTheDocument();
    const id = (await service.load()).connections[0]!.id;
    await user.click(screen.getByRole('button', { name: '编辑 First' }));
    const name = within(screen.getByRole('dialog')).getByLabelText('名称');
    await user.clear(name); await user.type(name, 'Renamed');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect((await service.load()).connections[0]!.id).toBe(id);
    await user.click(screen.getByRole('button', { name: '添加连接' }));
    await user.type(within(screen.getByRole('dialog')).getByLabelText('名称'), 'Second');
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Elasticsearch 地址'), { target: { value: 'https://second.example.test' } });
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByLabelText('当前连接')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '返回查询' }));
    await user.click(screen.getByRole('button', { name: '新建查询' }));
    fireEvent.change(screen.getByLabelText('查询 DSL'), { target: { value: '{"first":true}' } });
    const secondId = (await service.load()).connections[1]!.id;
    await user.selectOptions(screen.getByLabelText('当前连接'), secondId);
    expect(screen.queryByLabelText('查询 DSL')).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('当前连接'), id);
    expect(screen.getByLabelText('查询 DSL')).toHaveValue('{"first":true}');
  });
  it('scopes preference reset and reports failed persistence', async () => {
    const service = createSessionStorage();
    const user = await mount(service);
    await settings(user, '字体与密度');
    fireEvent.change(screen.getByLabelText('界面'), { target: { value: '20' } });
    expect(document.documentElement.style.getPropertyValue('--ui-size')).toBe('20px');
    await user.click(screen.getByRole('button', { name: '外观' }));
    await user.click(screen.getByRole('button', { name: '夜间' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    await user.click(screen.getByRole('button', { name: '字体与密度' }));
    await user.click(screen.getByRole('button', { name: '恢复默认' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(document.documentElement.style.getPropertyValue('--ui-size')).toBe('14px');
    service.savePreferences = vi.fn().mockRejectedValue({ code: 'storageUnavailable' });
    fireEvent.change(screen.getByLabelText('代码'), { target: { value: '18' } });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('更改未能保存'));
    expect(document.documentElement.style.getPropertyValue('--code-size')).toBe('18px');
  });
  it('handles palette search, IME, modal priority and focus restoration', async () => {
    const user = await mount();
    const button = screen.getByRole('button', { name: '快速跳转' });
    button.focus();
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true, isComposing: true });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(button);
    expect(screen.getByRole('combobox', { name: '快速跳转' })).toHaveFocus();
    await user.type(screen.getByRole('combobox', { name: '快速跳转' }), 'not-a-page');
    expect(screen.getByText('没有匹配项')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: ',', ctrlKey: true });
    expect(screen.queryByRole('heading', { level: 1, name: '常规' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(button).toHaveFocus();
  });
  it('retains the selected connection and draft after a failed selection, then retries the same action', async () => {
    const service = createSessionStorage();
    const a = await service.saveConnection({ displayName: 'A', endpoint: 'https://a.test', environment: 'development' });
    const b = await service.saveConnection({ displayName: 'B', endpoint: 'https://b.test', environment: 'development' });
    const user = await mount(service);
    await user.click(screen.getAllByRole('tab')[1]!);
    fireEvent.change(screen.getByLabelText('查询 DSL'), { target: { value: '{"retained":true}' } });
    const realSelect = service.selectConnection;
    service.selectConnection = vi.fn().mockRejectedValue({ code: 'storageUnavailable' });
    const savePreferences = vi.spyOn(service, 'savePreferences');
    await user.selectOptions(screen.getByLabelText('当前连接'), b.id);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByLabelText('当前连接')).toHaveValue(a.id);
    expect(screen.getByLabelText('查询 DSL')).toHaveValue('{"retained":true}');
    service.selectConnection = realSelect;
    await user.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByLabelText('当前连接')).toHaveValue(b.id));
    expect(savePreferences).not.toHaveBeenCalled();
  });
  it('confirms deletion, falls back and retains the deleted connection draft', async () => {
    const service = createSessionStorage();
    const a = await service.saveConnection({ displayName: 'A', endpoint: 'https://a.test', environment: 'development' });
    await service.saveConnection({ displayName: 'B', endpoint: 'https://b.test', environment: 'development' });
    const user = await mount(service);
    await user.click(screen.getAllByRole('tab')[1]!);
    fireEvent.change(screen.getByLabelText('查询 DSL'), { target: { value: '{"beforeDelete":true}' } });
    await settings(user, '连接中心');
    await user.click(screen.getByRole('button', { name: '删除 A' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }));
    expect((await service.load()).connections.some((item) => item.id === a.id)).toBe(true);
    await user.click(screen.getByRole('button', { name: '删除 A' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '返回查询' }));
    await user.click(screen.getAllByRole('tab')[1]!);
    expect(screen.getByLabelText('查询 DSL')).toHaveValue('{"beforeDelete":true}');
    expect(screen.getByText('原连接已移除，此草稿未被重新绑定。')).toBeInTheDocument();
    expect(screen.queryByLabelText('当前连接')).not.toBeInTheDocument();
  });
  it('renders the model settings panel and keeps a stored profile across settings round trips', async () => {
    const user = await mount();
    await settings(user, 'AI 模型');
    expect(await screen.findByText('尚未配置模型')).toBeInTheDocument();
    expect(screen.queryByText('当前构建尚未接入模型服务。')).not.toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: '添加模型' })[0]!);
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('名称'), '本地模型');
    await user.selectOptions(within(dialog).getByLabelText('协议'), 'ollama');
    await user.type(within(dialog).getByLabelText('端点'), 'http://127.0.0.1:11434');
    await user.type(within(dialog).getByLabelText('模型 ID'), 'llama3');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(await screen.findByText('本地模型')).toBeInTheDocument();
    expect(screen.getByText('尚未验证')).toBeInTheDocument();
    // The app owns one model service, so the profile survives a settings round trip.
    await user.click(screen.getByRole('button', { name: '返回查询' }));
    await settings(user, 'AI 模型');
    expect(await screen.findByText('本地模型')).toBeInTheDocument();
  });

  it('keeps startup defaults unchanged until next launch and supports keyboard tabs', async () => {
    const user = await mount();
    await settings(user);
    await user.selectOptions(screen.getByLabelText('下次启动时的结果视图'), 'json');
    await user.click(screen.getByRole('switch', { name: '下次启动时展开 AI' }));
    await user.click(screen.getByRole('button', { name: '返回查询' }));
    await user.click(screen.getByRole('button', { name: '新建查询' }));
    expect(screen.getByRole('button', { name: '表格' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('complementary', { name: 'AI 助手' })).not.toBeInTheDocument();
    const tabs = screen.getAllByRole('tab');
    tabs[1]!.focus();
    await user.keyboard('{ArrowLeft}');
    expect(tabs[0]).toHaveFocus();
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  });
});
