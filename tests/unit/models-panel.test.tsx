import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ModelInput } from '../../src/domain/models';
import { ModelPanel } from '../../src/features/models/ModelPanel';
import { i18n } from '../../src/locales';
import { enModels, zhModels } from '../../src/locales/models';
import { createSessionModelService, type ModelService } from '../../src/services/models';

// The models bundle is registered by `locales/index.ts`; the test registers it locally so no public
// setup or shared locale file has to change for this feature.
i18n.addResourceBundle('zh-CN', 'models', zhModels);
i18n.addResourceBundle('en-US', 'models', enModels);

const PROFILE: ModelInput = {
  displayName: 'A', protocol: 'ollama', endpoint: 'http://a.test:11434', modelId: 'a:1',
};

function renderWithI18n(ui: ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

const dialog = () => within(screen.getByRole('dialog'));

/**
 * The real session adapter plus injectable failures, so the panel is exercised against the actual
 * validation, ordering and default-selection rules while failures stay deterministic.
 */
function controllable(kind: 'desktop' | 'session' = 'session') {
  const inner = createSessionModelService();
  const control: Record<'failLoad' | 'failSave' | 'failDelete' | 'failSelect', string | null> = {
    failLoad: null, failSave: null, failDelete: null, failSelect: null,
  };
  const fail = (code: string): never => { throw { code, requestId: null, retryable: false }; };
  const service: ModelService = {
    kind,
    load: async () => { if (control.failLoad) return fail(control.failLoad); return inner.load(); },
    save: async (input, id) => { if (control.failSave) return fail(control.failSave); return inner.save(input, id); },
    delete: async (id) => { if (control.failDelete) return fail(control.failDelete); return inner.delete(id); },
    select: async (id) => { if (control.failSelect) return fail(control.failSelect); return inner.select(id); },
  };
  return { service, control, inner };
}

async function fillNewModel(user: UserEvent) {
  await user.click(screen.getAllByRole('button', { name: '添加模型' })[0]!);
  await user.type(dialog().getByLabelText('名称'), '本地 Ollama');
  await user.selectOptions(dialog().getByLabelText('协议'), 'ollama');
  await user.type(dialog().getByLabelText('端点'), 'http://127.0.0.1:11434');
  await user.type(dialog().getByLabelText('模型 ID'), 'llama3.1:8b');
  await user.click(dialog().getByRole('button', { name: '保存' }));
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
});

describe('model settings panel', () => {
  it('stores a profile and never claims the endpoint is reachable', async () => {
    const user = userEvent.setup();
    const { service, inner } = controllable();
    renderWithI18n(<ModelPanel service={service} />);

    expect(await screen.findByText('尚未配置模型')).toBeInTheDocument();
    expect(screen.getByText(/仅配置：不会向该端点发送请求/)).toBeInTheDocument();
    expect(screen.getByText(/协议调用尚未实现/)).toBeInTheDocument();
    expect(screen.getByText(/浏览器预览：模型配置仅保存在会话内存/)).toBeInTheDocument();

    await fillNewModel(user);
    expect(await screen.findByText('本地 Ollama')).toBeInTheDocument();
    expect(screen.getByText('http://127.0.0.1:11434')).toBeInTheDocument();
    expect(screen.getByText('llama3.1:8b')).toBeInTheDocument();
    expect(screen.getByText('Ollama')).toBeInTheDocument();
    // Every row is configuration that has not been verified, and nothing is reported as online.
    expect(screen.getByText('尚未验证')).toBeInTheDocument();
    expect(screen.queryByText(/在线/)).not.toBeInTheDocument();
    expect(screen.queryByText(/可用/)).not.toBeInTheDocument();
    expect((await inner.load()).profiles).toHaveLength(1);
  });

  it('selects the default, edits in place and deletes after confirmation', async () => {
    const user = userEvent.setup();
    const { service, inner } = controllable();
    await inner.save(PROFILE);
    await inner.save({ displayName: 'B', protocol: 'openaiCompatible', endpoint: 'https://b.test/v1', modelId: 'b-1' });
    renderWithI18n(<ModelPanel service={service} />);

    expect(await screen.findByText('A')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '设为默认: A' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: '设为默认: B' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: '设为默认: B' })).toBeChecked());
    const selected = await inner.load();
    expect(selected.defaultModelId).toBe(selected.profiles[1]!.id);

    // Editing keeps the identity and the selection.
    await user.click(screen.getAllByRole('button', { name: '编辑模型' })[1]!);
    await user.clear(dialog().getByLabelText('名称'));
    await user.type(dialog().getByLabelText('名称'), '网关');
    await user.click(dialog().getByRole('button', { name: '保存' }));
    expect(await screen.findByText('网关')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '设为默认: 网关' })).toBeChecked();

    await user.click(screen.getAllByRole('button', { name: '删除' })[1]!);
    expect(await screen.findByText('删除模型')).toBeInTheDocument();
    await user.click(dialog().getByRole('button', { name: '删除' }));
    await waitFor(() => expect(screen.queryByText('网关')).not.toBeInTheDocument());
    const remaining = await inner.load();
    expect(remaining.profiles.map((profile) => profile.displayName)).toEqual(['A']);
    expect(remaining.defaultModelId).toBe(remaining.profiles[0]!.id);
  });

  it('keeps the draft and reports the code when a save is rejected', async () => {
    const user = userEvent.setup();
    const { service, control } = controllable();
    control.failSave = 'storageUnavailable';
    renderWithI18n(<ModelPanel service={service} />);
    await screen.findByText('尚未配置模型');

    await fillNewModel(user);
    expect(await screen.findByText(/配置未能保存，当前填写的值仍然保留/)).toBeInTheDocument();
    expect(dialog().getByLabelText('名称')).toHaveValue('本地 Ollama');
    expect(dialog().getByLabelText('端点')).toHaveValue('http://127.0.0.1:11434');
    expect(dialog().getByLabelText('模型 ID')).toHaveValue('llama3.1:8b');

    // Retrying sends the same draft again and closes the dialog on success.
    control.failSave = null;
    await user.click(dialog().getByRole('button', { name: '重试' }));
    expect(await screen.findByText('本地 Ollama')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('reports an unreadable list and re-reads it on retry', async () => {
    const user = userEvent.setup();
    const { service, control } = controllable();
    control.failLoad = 'storageUnavailable';
    renderWithI18n(<ModelPanel service={service} />);

    expect(await screen.findByText(/模型配置读取失败/)).toBeInTheDocument();
    expect(screen.queryByText('尚未配置模型')).not.toBeInTheDocument();
    control.failLoad = null;
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('尚未配置模型')).toBeInTheDocument();
  });

  it('keeps the loaded list when the re-read after a change fails', async () => {
    const user = userEvent.setup();
    const { service, control, inner } = controllable();
    await inner.save(PROFILE);
    renderWithI18n(<ModelPanel service={service} />);
    expect(await screen.findByText('A')).toBeInTheDocument();

    control.failLoad = 'storageUnavailable';
    await user.click(screen.getByRole('button', { name: '刷新' }));
    expect(await screen.findByText(/上次修改后列表未能重新读取/)).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('reports a rejected change without hiding the stored rows', async () => {
    const user = userEvent.setup();
    const { service, control, inner } = controllable();
    await inner.save(PROFILE);
    await inner.save({ displayName: 'B', protocol: 'openaiCompatible', endpoint: 'https://b.test/v1', modelId: 'b-1' });
    control.failSelect = 'storageUnavailable';
    control.failDelete = 'notFound';
    renderWithI18n(<ModelPanel service={service} />);
    await screen.findByText('A');

    await user.click(screen.getByRole('radio', { name: '设为默认: B' }));
    expect(await screen.findByText(/默认模型未能修改/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '设为默认: A' })).toBeChecked();

    await user.click(screen.getAllByRole('button', { name: '删除' })[0]!);
    await user.click(dialog().getByRole('button', { name: '删除' }));
    expect(await screen.findByText('该模型配置已不存在。')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('shows the session-memory notice only for the browser adapter', async () => {
    const { service } = controllable('desktop');
    renderWithI18n(<ModelPanel service={service} />);
    await screen.findByText('尚未配置模型');
    expect(screen.queryByText(/会话内存/)).not.toBeInTheDocument();
  });
});
