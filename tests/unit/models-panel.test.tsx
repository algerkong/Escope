import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AiChatBackend, AiChatCancelRequest, AiChatDelta, AiChatRequest, AiChatResponse } from '../../src/domain/ai-chat';
import type { ModelCredentialChange } from '../../src/domain/model-access';
import type { ModelInput, ModelsState } from '../../src/domain/models';
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
/** Clearly fictitious token; never a real credential. */
const SAVED_KEY = 'fixture-panel-token';

function renderWithI18n(ui: ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

const dialog = () => within(screen.getByRole('dialog'));

/**
 * The real session adapter for metadata rules plus an injectable key store and failures, so the
 * panel is exercised against the actual validation, ordering and default-selection rules while
 * secret handling stays deterministic and contains only fictitious values.
 */
function controllable(kind: 'desktop' | 'session' = 'session') {
  const inner = createSessionModelService();
  const keys = new Set<string>();
  const control = {
    failLoad: null as string | null,
    failSave: null as string | null,
    failDelete: null as string | null,
    failSelect: null as string | null,
    failCleanup: null as string | null,
    cleanupPending: false,
    cleanupResult: true,
  };
  const saves: Array<{ input: ModelInput; id?: string; credential?: ModelCredentialChange }> = [];
  const cleanups: number[] = [];
  const fail = (code: string): never => { throw { code, requestId: null, retryable: false }; };
  const service: ModelService = {
    kind,
    load: async () => {
      if (control.failLoad) return fail(control.failLoad);
      const state = await inner.load();
      return {
        ...state,
        credentialCleanupPending: control.cleanupPending,
        profiles: state.profiles.map((profile) => ({ ...profile, hasApiKey: keys.has(profile.id) })),
      };
    },
    save: async (input, id, credential) => {
      if (control.failSave) return fail(control.failSave);
      saves.push({ input, id, credential });
      const change = credential ?? { kind: 'keep' };
      const saved = await inner.save(input, id);
      if (change.kind === 'replace') keys.add(saved.id);
      if (change.kind === 'clear') keys.delete(saved.id);
      return { ...saved, hasApiKey: keys.has(saved.id) };
    },
    delete: async (id) => {
      if (control.failDelete) return fail(control.failDelete);
      keys.delete(id);
      await inner.delete(id);
    },
    select: async (id) => {
      if (control.failSelect) return fail(control.failSelect);
      await inner.select(id);
    },
    discover: async () => fail('unsupported'),
    cancelDiscovery: async () => true,
    cleanupCredentials: async () => {
      if (control.failCleanup) return fail(control.failCleanup);
      cleanups.push(1);
      if (control.cleanupResult) control.cleanupPending = false;
      return control.cleanupResult;
    },
  };
  return { service, control, inner, saves, cleanups, keys };
}

/** Chat transport double for the generation test; every request is settled by the test itself. */
function fakeChatBackend(available = true) {
  const streams: Array<{
    readonly request: AiChatRequest;
    readonly emit: (delta: AiChatDelta) => void;
    readonly finish: (response: AiChatResponse) => void;
    readonly fail: (failure: unknown) => void;
  }> = [];
  const cancels: AiChatCancelRequest[] = [];
  const backend: AiChatBackend = {
    available,
    chat: (request, onDelta) => new Promise<AiChatResponse>((resolve, reject) => {
      streams.push({ request, emit: onDelta, finish: resolve, fail: reject });
    }),
    cancel: async (request) => { cancels.push(request); return true; },
  };
  return { backend, streams, cancels };
}

function completeOf(
  stream: { request: AiChatRequest }, text: string, extra: Partial<AiChatResponse> = {},
): AiChatResponse {
  return {
    requestId: stream.request.requestId,
    modelProfileId: stream.request.modelProfileId,
    protocol: stream.request.authorization.protocol,
    endpoint: stream.request.authorization.endpoint,
    modelId: stream.request.authorization.modelId,
    actualModelId: stream.request.authorization.modelId,
    sequence: text === '' ? 0 : 1,
    text,
    outcome: 'complete',
    ...extra,
  };
}

async function fillNewModel(user: UserEvent, key?: string) {
  await user.click(screen.getAllByRole('button', { name: '添加模型' })[0]!);
  await user.type(dialog().getByLabelText('名称'), '本地 Ollama');
  await user.selectOptions(dialog().getByLabelText('协议'), 'ollama');
  await user.type(dialog().getByLabelText('端点'), 'http://127.0.0.1:11434');
  await user.type(dialog().getByLabelText('模型 ID'), 'llama3.1:8b');
  if (key !== undefined) await user.type(dialog().getByLabelText('API 密钥'), key);
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
    expect(screen.getByText(/浏览器预览：模型配置仅保存在会话内存/)).toBeInTheDocument();

    await fillNewModel(user);
    expect(await screen.findByText('本地 Ollama')).toBeInTheDocument();
    expect(screen.getByText('http://127.0.0.1:11434')).toBeInTheDocument();
    expect(screen.getByText('llama3.1:8b')).toBeInTheDocument();
    expect(screen.getByText('Ollama')).toBeInTheDocument();
    // Every row is configuration that has not been verified, and nothing is reported as online.
    expect(screen.getByText('尚未验证')).toBeInTheDocument();
    expect(screen.getByText('未保存密钥')).toBeInTheDocument();
    expect(screen.queryByText(/在线/)).not.toBeInTheDocument();
    expect((await inner.load()).profiles).toHaveLength(1);
  });

  it('stores a replacement key with the profile and never renders the secret', async () => {
    const user = userEvent.setup();
    const { service, saves, keys, inner } = controllable('desktop');
    renderWithI18n(<ModelPanel service={service} />);
    await screen.findByText('尚未配置模型');

    await fillNewModel(user, SAVED_KEY);
    expect(await screen.findByText('本地 Ollama')).toBeInTheDocument();
    // Metadata and the credential travelled as separate arguments; the secret is nowhere else.
    expect(saves).toHaveLength(1);
    expect(saves[0]!.credential).toEqual({ kind: 'replace', apiKey: SAVED_KEY });
    expect(Object.keys(saves[0]!.input).sort()).toEqual(['displayName', 'endpoint', 'modelId', 'protocol']);
    expect(JSON.stringify(saves[0]!.input)).not.toContain(SAVED_KEY);

    expect(screen.getByText('已保存密钥')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SAVED_KEY);
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(keys.size).toBe(1);

    // Deleting the profile drops its stored key reference as well.
    await user.click(screen.getAllByRole('button', { name: '删除' })[0]!);
    await user.click(dialog().getByRole('button', { name: '删除' }));
    await waitFor(() => expect(screen.queryByText('本地 Ollama')).not.toBeInTheDocument());
    expect(keys.size).toBe(0);
    expect((await inner.load()).profiles).toHaveLength(0);
  });

  it('keeps a saved key when the edit dialog is confirmed unchanged', async () => {
    const user = userEvent.setup();
    const { service, saves, keys } = controllable('desktop');
    await service.save(PROFILE, undefined, { kind: 'replace', apiKey: SAVED_KEY });
    renderWithI18n(<ModelPanel service={service} />);
    await screen.findByText('A');
    expect(screen.getByText('已保存密钥')).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: '编辑模型' })[0]!);
    // The stored key is described, never rendered or prefilled.
    expect(dialog().getByText(/已保存密钥：留空保持不变/)).toBeInTheDocument();
    expect(dialog().getByLabelText('API 密钥')).toHaveValue('');
    // Renaming and picking another model id keep the endpoint+protocol binding intact.
    await user.clear(dialog().getByLabelText('名称'));
    await user.type(dialog().getByLabelText('名称'), 'A 改名');
    await user.clear(dialog().getByLabelText('模型 ID'));
    await user.type(dialog().getByLabelText('模型 ID'), 'a:2');
    expect(dialog().getByText(/已保存密钥：留空保持不变/)).toBeInTheDocument();
    await user.click(dialog().getByRole('button', { name: '保存' }));
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[1]!.credential).toEqual({ kind: 'keep' });
    expect(saves[1]!.input).toMatchObject({ displayName: 'A 改名', modelId: 'a:2' });
    expect(keys.has((await service.load()).profiles[0]!.id)).toBe(true);
    expect(document.querySelector('input[type="password"]')).toBeNull();
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
    const { service, control } = controllable('desktop');
    control.failSave = 'credentialUnavailable';
    renderWithI18n(<ModelPanel service={service} />);
    await screen.findByText('尚未配置模型');

    await fillNewModel(user, SAVED_KEY);
    expect(await screen.findByText(/配置未能保存，当前填写的值仍然保留/)).toBeInTheDocument();
    expect(dialog().getByText(/已保存的密钥不可用/)).toBeInTheDocument();
    expect(dialog().getByLabelText('名称')).toHaveValue('本地 Ollama');
    expect(dialog().getByLabelText('端点')).toHaveValue('http://127.0.0.1:11434');
    expect(dialog().getByLabelText('模型 ID')).toHaveValue('llama3.1:8b');
    // The typed key is retained for the deliberate retry and only then cleared.
    expect(dialog().getByLabelText('API 密钥')).toHaveValue(SAVED_KEY);

    control.failSave = null;
    await user.click(dialog().getByRole('button', { name: '重试' }));
    expect(await screen.findByText('本地 Ollama')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SAVED_KEY);
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

  it('warns about keys waiting for cleanup and retries the cleanup', async () => {
    const user = userEvent.setup();
    const { service, control, cleanups, inner } = controllable('desktop');
    await inner.save(PROFILE);
    control.cleanupPending = true;
    renderWithI18n(<ModelPanel service={service} />);

    expect(await screen.findByText(/有已移除的密钥等待安全清理；配置修改已保存/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重试清理' }));
    await waitFor(() => expect(cleanups).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText(/有已移除的密钥等待安全清理/)).not.toBeInTheDocument());
    // The profile itself was never reported as a failed save.
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.queryByText(/配置未能保存/)).not.toBeInTheDocument();
  });

  it('reports a failed cleanup and keeps the warning', async () => {
    const user = userEvent.setup();
    const { service, control, inner } = controllable('desktop');
    await inner.save(PROFILE);
    control.cleanupPending = true;
    control.failCleanup = 'credentialUnavailable';
    renderWithI18n(<ModelPanel service={service} />);
    await screen.findByText(/有已移除的密钥等待安全清理/);

    await user.click(screen.getByRole('button', { name: '重试清理' }));
    expect(await screen.findByText(/凭据清理未能完成/)).toBeInTheDocument();
    expect(screen.getByText(/已保存的密钥不可用/)).toBeInTheDocument();
    // The warning stays until the backend confirms the cleanup.
    expect(screen.getByText(/有已移除的密钥等待安全清理/)).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('runs the explicit generation test and records latency, actual model and time', async () => {
    const user = userEvent.setup();
    const { service, inner, saves } = controllable('desktop');
    await inner.save(PROFILE);
    const make = fakeChatBackend();
    renderWithI18n(<ModelPanel service={service} backend={make.backend} />);
    await screen.findByText('A');

    await user.click(screen.getByRole('button', { name: '测试模型' }));
    await waitFor(() => expect(make.streams).toHaveLength(1));
    const stream = make.streams[0]!;
    const saved = (await inner.load()).profiles[0]!;
    expect(stream.request.prompt).toBe('Reply with OK.');
    expect(stream.request.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(stream.request.modelProfileId).toBe(saved.id);
    expect(stream.request.authorization).toEqual({
      scope: 'conversation', protocol: 'ollama', endpoint: 'http://a.test:11434', modelId: 'a:1',
    });
    // No key override and no history: the backend resolves the saved credential for this target.
    expect(Object.keys(stream.request).sort()).toEqual(['authorization', 'modelProfileId', 'prompt', 'requestId']);
    expect(screen.getByText('正在等待模型响应…')).toBeInTheDocument();

    await act(async () => {
      stream.emit({
        requestId: stream.request.requestId, modelProfileId: stream.request.modelProfileId, sequence: 1, text: 'O',
      });
    });
    expect(await screen.findByText('正在接收回复…')).toBeInTheDocument();
    await act(async () => { stream.finish(completeOf(stream, 'OK', { actualModelId: 'a:1-q4' })); });

    expect(await screen.findByText('生成测试通过')).toBeInTheDocument();
    expect(screen.getByText(/实际模型：a:1-q4/)).toBeInTheDocument();
    const block = document.querySelector('.model-test')!;
    expect(block.textContent).toMatch(/毫秒/);
    expect(block.textContent).toMatch(/时间/);
    expect(document.querySelector('.model-test-reply')?.textContent).toBe('OK');
    // The test neither changes the stored profile or default selection nor appends to any conversation.
    const after = await inner.load();
    expect(after.profiles).toHaveLength(1);
    expect(after.defaultModelId).toBe(saved.id);
    expect(saves).toHaveLength(0);
  });

  it('does not record a success for an incomplete or blank reply', async () => {
    const user = userEvent.setup();
    const { service, inner } = controllable('desktop');
    await inner.save(PROFILE);
    const make = fakeChatBackend();
    renderWithI18n(<ModelPanel service={service} backend={make.backend} />);
    await screen.findByText('A');

    await user.click(screen.getByRole('button', { name: '测试模型' }));
    await waitFor(() => expect(make.streams).toHaveLength(1));
    await act(async () => { make.streams[0]!.finish(completeOf(make.streams[0]!, 'OK', { outcome: 'length' })); });
    expect(await screen.findByText(/模型回复未正常完成/)).toBeInTheDocument();
    expect(screen.queryByText('生成测试通过')).not.toBeInTheDocument();
    expect(screen.getByText('尚未验证')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '重试测试' }));
    await waitFor(() => expect(make.streams).toHaveLength(2));
    await act(async () => { make.streams[1]!.finish(completeOf(make.streams[1]!, '')); });
    expect(await screen.findByText(/模型未返回文本/)).toBeInTheDocument();
    expect(screen.queryByText('生成测试通过')).not.toBeInTheDocument();
  });

  it('maps generation failures without raw details and retries explicitly', async () => {
    const user = userEvent.setup();
    const { service, inner } = controllable('desktop');
    await inner.save(PROFILE);
    const make = fakeChatBackend();
    renderWithI18n(<ModelPanel service={service} backend={make.backend} />);
    await screen.findByText('A');

    await user.click(screen.getByRole('button', { name: '测试模型' }));
    await waitFor(() => expect(make.streams).toHaveLength(1));
    await act(async () => {
      make.streams[0]!.fail({
        code: 'authenticationFailed', requestId: make.streams[0]!.request.requestId,
        retryable: false, detail: 'raw provider text',
      });
    });
    expect(await screen.findByText(/服务需要认证，或认证已被拒绝/)).toBeInTheDocument();
    expect(screen.getByText(/测试失败/)).toBeInTheDocument();
    expect(screen.queryByText(/raw provider text/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '重试测试' }));
    await waitFor(() => expect(make.streams).toHaveLength(2));
    await act(async () => { make.streams[1]!.fail({ code: 'aiTargetChanged' }); });
    expect(await screen.findByText(/响应与请求的模型目标不一致/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '重试测试' }));
    await waitFor(() => expect(make.streams).toHaveLength(3));
    await act(async () => { make.streams[2]!.fail({ code: 'strangeInternalThing', detail: 'secret-ish' }); });
    expect(await screen.findByText(/模型请求失败且没有可读原因/)).toBeInTheDocument();
    expect(screen.queryByText(/secret-ish/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '重试测试' }));
    await waitFor(() => expect(make.streams).toHaveLength(4));
    await act(async () => { make.streams[3]!.fail({ code: 'timeout' }); });
    expect(await screen.findByText(/超时/)).toBeInTheDocument();
  });

  it('starts one request when the test command is clicked twice in the same frame', async () => {
    const { service, inner } = controllable('desktop');
    await inner.save(PROFILE);
    const make = fakeChatBackend();
    renderWithI18n(<ModelPanel service={service} backend={make.backend} />);
    await screen.findByText('A');

    const button = screen.getByRole('button', { name: '测试模型' });
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => expect(make.streams).toHaveLength(1));
  });

  it('cancels a running test and discards its late answer', async () => {
    const user = userEvent.setup();
    const { service, inner } = controllable('desktop');
    await inner.save(PROFILE);
    const make = fakeChatBackend();
    renderWithI18n(<ModelPanel service={service} backend={make.backend} />);
    await screen.findByText('A');

    await user.click(screen.getByRole('button', { name: '测试模型' }));
    await waitFor(() => expect(make.streams).toHaveLength(1));
    const stream = make.streams[0]!;
    await user.click(screen.getByRole('button', { name: '取消测试' }));
    expect(make.cancels).toEqual([{
      requestId: stream.request.requestId, modelProfileId: stream.request.modelProfileId,
    }]);
    expect(await screen.findByText('测试已取消')).toBeInTheDocument();

    await act(async () => { stream.finish(completeOf(stream, 'OK')); });
    expect(screen.queryByText('生成测试通过')).not.toBeInTheDocument();
    expect(screen.getByText('测试已取消')).toBeInTheDocument();
    expect(document.querySelector('.model-test-reply')).toBeNull();
  });

  it('invalidates and cancels the test when the editor opens for that profile', async () => {
    const user = userEvent.setup();
    const { service, inner } = controllable('desktop');
    await inner.save(PROFILE);
    const make = fakeChatBackend();
    renderWithI18n(<ModelPanel service={service} backend={make.backend} />);
    await screen.findByText('A');

    await user.click(screen.getByRole('button', { name: '测试模型' }));
    await waitFor(() => expect(make.streams).toHaveLength(1));
    const stream = make.streams[0]!;
    await user.click(screen.getByRole('button', { name: '编辑模型' }));
    expect(make.cancels).toHaveLength(1);
    expect(screen.queryByText('正在等待模型响应…')).not.toBeInTheDocument();

    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }));
    await act(async () => { stream.finish(completeOf(stream, 'OK')); });
    expect(screen.queryByText('生成测试通过')).not.toBeInTheDocument();
    expect(screen.getByText('尚未验证')).toBeInTheDocument();
  });

  it('keeps an identical re-read result but discards a changed profile test', async () => {
    const user = userEvent.setup();
    const { service, inner } = controllable('desktop');
    const saved = await inner.save(PROFILE);
    const make = fakeChatBackend();
    renderWithI18n(<ModelPanel service={service} backend={make.backend} />);
    await screen.findByText('A');

    // A finished result survives an identical re-read.
    await user.click(screen.getByRole('button', { name: '测试模型' }));
    await waitFor(() => expect(make.streams).toHaveLength(1));
    await act(async () => { make.streams[0]!.finish(completeOf(make.streams[0]!, 'OK')); });
    expect(await screen.findByText('生成测试通过')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '刷新' }));
    expect(await screen.findByText('生成测试通过')).toBeInTheDocument();

    // A re-read that shows a changed profile cancels the running test and drops its state.
    await inner.save({ ...PROFILE, modelId: 'a:2' }, saved.id);
    await user.click(screen.getByRole('button', { name: '测试模型' }));
    await waitFor(() => expect(make.streams).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(make.cancels).toHaveLength(1));
    expect(screen.queryByText('正在等待模型响应…')).not.toBeInTheDocument();
    expect(screen.queryByText('生成测试通过')).not.toBeInTheDocument();
    expect(screen.getByText('尚未验证')).toBeInTheDocument();

    await act(async () => { make.streams[1]!.finish(completeOf(make.streams[1]!, 'OK')); });
    expect(screen.queryByText('生成测试通过')).not.toBeInTheDocument();
  });

  it('cancels a running test on unmount', async () => {
    const user = userEvent.setup();
    const { service, inner } = controllable('desktop');
    await inner.save(PROFILE);
    const make = fakeChatBackend();
    const view = renderWithI18n(<ModelPanel service={service} backend={make.backend} />);
    await screen.findByText('A');

    await user.click(screen.getByRole('button', { name: '测试模型' }));
    await waitFor(() => expect(make.streams).toHaveLength(1));
    const stream = make.streams[0]!;
    view.unmount();
    expect(make.cancels).toEqual([{
      requestId: stream.request.requestId, modelProfileId: stream.request.modelProfileId,
    }]);
  });

  it('disables real generation tests when the backend is unavailable', async () => {
    const { service, inner } = controllable('desktop');
    await inner.save(PROFILE);
    const make = fakeChatBackend(false);
    renderWithI18n(<ModelPanel service={service} backend={make.backend} />);
    await screen.findByText('A');

    expect(screen.getByRole('button', { name: '模型测试需要桌面应用。' })).toBeDisabled();
    expect(make.streams).toHaveLength(0);
  });

  it('bounds the reply preview', async () => {
    const user = userEvent.setup();
    const { service, inner } = controllable('desktop');
    await inner.save(PROFILE);
    const make = fakeChatBackend();
    renderWithI18n(<ModelPanel service={service} backend={make.backend} />);
    await screen.findByText('A');

    await user.click(screen.getByRole('button', { name: '测试模型' }));
    await waitFor(() => expect(make.streams).toHaveLength(1));
    await act(async () => { make.streams[0]!.finish(completeOf(make.streams[0]!, 'x'.repeat(300))); });
    expect(await screen.findByText('生成测试通过')).toBeInTheDocument();
    expect(document.querySelector('.model-test-reply')?.textContent).toBe(`${'x'.repeat(240)}…`);
  });

  it('starts one request when a backend settles synchronously in the same frame', async () => {
    const { service, inner } = controllable('desktop');
    await inner.save(PROFILE);
    const calls: AiChatRequest[] = [];
    const backend: AiChatBackend = {
      available: true,
      chat: (request) => {
        calls.push(request);
        const response = completeOf({ request }, 'OK');
        // A thenable that resolves before `chat` returns: the settle path runs inside the click handler.
        return {
          then: (onOk: (value: AiChatResponse) => void) => { onOk(response); },
        } as unknown as Promise<AiChatResponse>;
      },
      cancel: async () => true,
    };
    renderWithI18n(<ModelPanel service={service} backend={backend} />);
    await screen.findByText('A');

    const button = screen.getByRole('button', { name: '测试模型' });
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(calls).toHaveLength(1);
    expect(await screen.findByText('生成测试通过')).toBeInTheDocument();
  });

  it('maps a synchronously thrown backend failure and releases the lock after the stack', async () => {
    const { service, inner } = controllable('desktop');
    await inner.save(PROFILE);
    let calls = 0;
    const backend: AiChatBackend = {
      available: true,
      chat: () => { calls += 1; throw { code: 'networkError', requestId: null, retryable: false }; },
      cancel: async () => true,
    };
    renderWithI18n(<ModelPanel service={service} backend={backend} />);
    await screen.findByText('A');

    const button = screen.getByRole('button', { name: '测试模型' });
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(calls).toBe(1);
    expect(await screen.findByText(/无法建立连接/)).toBeInTheDocument();

    // The lock only spans the click stack; a later retry is allowed.
    await userEvent.setup().click(screen.getByRole('button', { name: '重试测试' }));
    expect(calls).toBe(2);
  });

  it('shows a cancelled backend rejection as cancelled, not failed', async () => {
    const user = userEvent.setup();
    const { service, inner } = controllable('desktop');
    await inner.save(PROFILE);
    const make = fakeChatBackend();
    renderWithI18n(<ModelPanel service={service} backend={make.backend} />);
    await screen.findByText('A');

    await user.click(screen.getByRole('button', { name: '测试模型' }));
    await waitFor(() => expect(make.streams).toHaveLength(1));
    await act(async () => { make.streams[0]!.fail({ code: 'cancelled' }); });
    expect(await screen.findByText('测试已取消')).toBeInTheDocument();
    expect(screen.queryByText(/测试失败/)).not.toBeInTheDocument();
  });

  it('discards a final answer bound to another request or target', async () => {
    const user = userEvent.setup();
    const { service, inner } = controllable('desktop');
    await inner.save(PROFILE);
    const make = fakeChatBackend();
    renderWithI18n(<ModelPanel service={service} backend={make.backend} />);
    await screen.findByText('A');

    await user.click(screen.getByRole('button', { name: '测试模型' }));
    await waitFor(() => expect(make.streams).toHaveLength(1));
    const stream = make.streams[0]!;
    await act(async () => {
      stream.finish({ ...completeOf(stream, 'OK'), requestId: crypto.randomUUID() });
    });
    expect(await screen.findByText(/测试失败/)).toBeInTheDocument();
    expect(screen.getByText(/响应与请求的模型目标不一致/)).toBeInTheDocument();
    expect(screen.queryByText('生成测试通过')).not.toBeInTheDocument();
  });

  it('invalidates and cancels the test before a confirmed deletion', async () => {
    const user = userEvent.setup();
    const { service, inner } = controllable('desktop');
    await inner.save(PROFILE);
    const make = fakeChatBackend();
    renderWithI18n(<ModelPanel service={service} backend={make.backend} />);
    await screen.findByText('A');

    await user.click(screen.getByRole('button', { name: '测试模型' }));
    await waitFor(() => expect(make.streams).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: '删除' }));
    expect(make.cancels).toHaveLength(1);
    expect(screen.queryByText('正在等待模型响应…')).not.toBeInTheDocument();

    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(screen.queryByText('A')).not.toBeInTheDocument());
    expect(screen.queryByText('生成测试通过')).not.toBeInTheDocument();
    expect(document.querySelector('.model-test')).toBeNull();
  });

  it('cancels a running test before the list is refreshed', async () => {
    const user = userEvent.setup();
    const { service, inner } = controllable('desktop');
    await inner.save(PROFILE);
    const make = fakeChatBackend();
    renderWithI18n(<ModelPanel service={service} backend={make.backend} />);
    await screen.findByText('A');

    await user.click(screen.getByRole('button', { name: '测试模型' }));
    await waitFor(() => expect(make.streams).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: '刷新' }));
    expect(make.cancels).toHaveLength(1);
    expect(await screen.findByText('测试已取消')).toBeInTheDocument();
  });

  it('disables tests while a model list re-read is pending', async () => {
    const inner = createSessionModelService();
    await inner.save(PROFILE);
    const gates: Array<(value: ModelsState) => void> = [];
    let calls = 0;
    const service: ModelService = {
      ...inner,
      load: () => {
        calls += 1;
        return calls === 1 ? inner.load() : new Promise<ModelsState>((resolve) => { gates.push(resolve); });
      },
    };
    const make = fakeChatBackend();
    renderWithI18n(<ModelPanel service={service} backend={make.backend} />);
    await screen.findByText('A');

    await userEvent.setup().click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(gates).toHaveLength(1));
    expect(screen.getByRole('button', { name: '测试模型' })).toBeDisabled();

    await act(async () => { gates[0]!(await inner.load()); });
    expect(screen.getByRole('button', { name: '测试模型' })).toBeEnabled();
    expect(make.streams).toHaveLength(0);
  });

  it('never generates on load, save, refresh or default selection', async () => {
    const user = userEvent.setup();
    const { service } = controllable('desktop');
    const make = fakeChatBackend();
    renderWithI18n(<ModelPanel service={service} backend={make.backend} />);
    await screen.findByText('尚未配置模型');

    await fillNewModel(user);
    await screen.findByText('本地 Ollama');
    await user.click(screen.getByRole('radio', { name: '设为默认: 本地 Ollama' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: '设为默认: 本地 Ollama' })).toBeChecked());
    await user.click(screen.getByRole('button', { name: '刷新' }));
    await screen.findByText('本地 Ollama');

    expect(make.streams).toHaveLength(0);
    expect(make.cancels).toHaveLength(0);
    expect(document.querySelector('.model-test')).toBeNull();
  });

  it('does not keep an earlier success when the same target gets a replacement key', async () => {
    const user = userEvent.setup();
    const { service, saves } = controllable('desktop');
    await service.save(PROFILE, undefined, { kind: 'replace', apiKey: 'fixture-initial' });
    saves.length = 0;
    const make = fakeChatBackend();
    renderWithI18n(<ModelPanel service={service} backend={make.backend} />);
    await screen.findByText('A');

    await user.click(screen.getByRole('button', { name: '测试模型' }));
    await waitFor(() => expect(make.streams).toHaveLength(1));
    await act(async () => { make.streams[0]!.finish(completeOf(make.streams[0]!, 'OK')); });
    expect(await screen.findByText('生成测试通过')).toBeInTheDocument();

    // Replace the key: same endpoint, hasApiKey still true, so only the save path can invalidate it.
    await user.click(screen.getByRole('button', { name: '编辑模型' }));
    await user.type(dialog().getByLabelText('API 密钥'), 'fixture-replacement');
    await user.click(dialog().getByRole('button', { name: '保存' }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]!.credential).toEqual({ kind: 'replace', apiKey: 'fixture-replacement' });
    expect(await screen.findByText('已保存密钥')).toBeInTheDocument();
    expect(screen.queryByText('生成测试通过')).not.toBeInTheDocument();
    expect(screen.getByText('尚未验证')).toBeInTheDocument();

    // A re-read of the same metadata shape cannot resurrect the old result either.
    await user.click(screen.getByRole('button', { name: '刷新' }));
    expect(screen.queryByText('生成测试通过')).not.toBeInTheDocument();
  });

  it('shows the session-memory notice only for the browser adapter', async () => {
    const { service } = controllable('desktop');
    renderWithI18n(<ModelPanel service={service} />);
    await screen.findByText('尚未配置模型');
    expect(screen.queryByText(/会话内存/)).not.toBeInTheDocument();
  });
});
