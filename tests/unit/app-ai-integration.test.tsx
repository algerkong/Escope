import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import type { AiChatBackend, AiChatDelta, AiChatRequest, AiChatResponse } from '../../src/domain/ai-chat';
import { i18n } from '../../src/locales';
import { zhAiChat } from '../../src/locales/ai-chat';
import { zhModels } from '../../src/locales/models';
import { createSessionModelService } from '../../src/services/models';
import { createSessionStorage } from '../../src/services/storage';

beforeEach(async () => { await i18n.changeLanguage('zh-CN'); });

async function mount(desktopModels = false) {
  const service = createSessionStorage();
  const initial = await service.load();
  initial.preferences.locale = 'zh-CN';
  const innerModels = createSessionModelService();
  const modelService = desktopModels ? { ...innerModels, kind: 'desktop' as const } : innerModels;
  const model = await modelService.save({
    displayName: 'Local fixture', protocol: 'ollama',
    endpoint: 'http://127.0.0.1:11434', modelId: 'fixture-model',
  });
  const load = vi.spyOn(modelService, 'load');
  const aiBackend: AiChatBackend = {
    available: true, chat: vi.fn(), cancel: vi.fn().mockResolvedValue(true),
  };
  render(<I18nextProvider i18n={i18n}>
    <App service={service} initial={initial} modelService={modelService} aiBackend={aiBackend} />
  </I18nextProvider>);
  const user = userEvent.setup();
  await user.click(screen.getAllByRole('tab')[1]!);
  return { user, model, load, aiBackend };
}

describe('AI app integration', () => {
  it('loads the shared model selection only when opened and never generates on navigation', async () => {
    const { user, model, load, aiBackend } = await mount();
    expect(load).not.toHaveBeenCalled();
    expect(aiBackend.chat).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '显示或隐藏 AI 面板' }));
    const panel = within(screen.getByRole('complementary', { name: 'AI 助手' }));
    await waitFor(() => expect(panel.getByRole('combobox')).toHaveValue(model.id));
    expect(load).toHaveBeenCalledTimes(1);

    await user.click(screen.getAllByRole('button', { name: '设置' })[0]!);
    await user.click(screen.getByRole('button', { name: 'AI 模型' }));
    expect(await screen.findByRole('radio', { name: '设为默认: Local fixture' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: '返回查询' }));
    await waitFor(() => expect(panel.getByRole('combobox')).toHaveValue(model.id));
    expect(aiBackend.chat).not.toHaveBeenCalled();
  });

  it('retains the independent AI input and query draft across settings and panel toggles', async () => {
    const { user, model, aiBackend } = await mount();
    fireEvent.change(screen.getByLabelText('查询 DSL'), {
      target: { value: '{"query":{"term":{"id":9007199254740993}}}' },
    });
    await user.click(screen.getByRole('button', { name: '显示或隐藏 AI 面板' }));
    const panel = within(screen.getByRole('complementary', { name: 'AI 助手' }));
    await waitFor(() => expect(panel.getByRole('combobox')).toHaveValue(model.id));
    fireEvent.change(panel.getByRole('textbox'), { target: { value: 'Explain a term query.' } });

    await user.click(screen.getByRole('button', { name: '显示或隐藏 AI 面板' }));
    expect(screen.queryByRole('complementary', { name: 'AI 助手' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '显示或隐藏 AI 面板' }));
    expect(panel.getByRole('textbox')).toHaveValue('Explain a term query.');

    await user.click(screen.getAllByRole('button', { name: '设置' })[0]!);
    await user.click(screen.getByRole('button', { name: '外观' }));
    await user.click(screen.getByRole('button', { name: '夜间' }));
    await user.click(screen.getByRole('button', { name: '返回查询' }));
    expect(panel.getByRole('textbox')).toHaveValue('Explain a term query.');
    expect(screen.getByLabelText('查询 DSL')).toHaveValue('{"query":{"term":{"id":9007199254740993}}}');
    expect(aiBackend.chat).not.toHaveBeenCalled();
  });

  it('sends directly without implicit query context and cancels on entering settings', async () => {
    const { user, model, aiBackend } = await mount();
    const streams: {
      request: AiChatRequest;
      emit: (delta: AiChatDelta) => void;
      finish: (response: AiChatResponse) => void;
    }[] = [];
    vi.mocked(aiBackend.chat).mockImplementation((request, emit) => new Promise((finish) => {
      streams.push({ request, emit, finish });
    }));
    const dsl = '{"query":{"term":{"private_field":"local-only"}}}';
    fireEvent.change(screen.getByLabelText('查询 DSL'), { target: { value: dsl } });
    await user.click(screen.getByRole('button', { name: '显示或隐藏 AI 面板' }));
    await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue(model.id));
    fireEvent.change(screen.getByLabelText('消息内容'), { target: { value: 'Explain a term query.' } });
    fireEvent.keyDown(screen.getByLabelText('消息内容'), { key: 'Enter' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('消息内容')).toHaveValue('');
    expect(streams).toHaveLength(1);
    const stream = streams[0]!;
    expect(stream.request.prompt).toBe('Explain a term query.');
    expect(stream.request.authorization.scope).toBe('conversation');
    expect(stream.request.history ?? []).toEqual([]);
    expect(JSON.stringify(stream.request)).not.toContain('private_field');
    await act(async () => {
      stream.emit({
        requestId: stream.request.requestId, modelProfileId: model.id,
        sequence: 1, text: '{"query":{"match_all":{}}}',
      });
    });
    expect(screen.getByLabelText('查询 DSL')).toHaveValue(dsl);

    await user.click(screen.getAllByRole('button', { name: '设置' })[0]!);
    await waitFor(() => expect(aiBackend.cancel).toHaveBeenCalledExactlyOnceWith({
      requestId: stream.request.requestId, modelProfileId: model.id,
    }));
    await act(async () => {
      stream.finish({
        requestId: stream.request.requestId, modelProfileId: model.id,
        protocol: model.protocol, endpoint: model.endpoint, modelId: model.modelId,
        actualModelId: model.modelId, sequence: 1, text: 'Late completed response.', outcome: 'complete',
      });
    });
    await user.click(screen.getByRole('button', { name: '返回查询' }));
    expect(screen.getByLabelText('查询 DSL')).toHaveValue(dsl);
    expect(screen.getByText(zhAiChat.cancelled)).toBeInTheDocument();
    expect(screen.queryByText('Late completed response.')).not.toBeInTheDocument();
    expect(aiBackend.chat).toHaveBeenCalledTimes(1);
  });

  it('attaches a frozen query only on request and preserves the newer query draft', async () => {
    const { user, model, aiBackend } = await mount();
    vi.mocked(aiBackend.chat).mockImplementation(() => new Promise(() => {}));
    const original = '{"query":{"term":{"id":9007199254740993}},"size":10}';
    const newer = '{"query":{"match_all":{}},"size":20}';
    fireEvent.change(screen.getByLabelText('查询 DSL'), { target: { value: original } });
    await user.click(screen.getByRole('button', { name: '显示或隐藏 AI 面板' }));
    await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue(model.id));
    await user.click(screen.getByRole('button', { name: zhAiChat.attach }));
    expect(aiBackend.chat).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('查询 DSL'), { target: { value: newer } });
    fireEvent.change(screen.getByLabelText('消息内容'), { target: { value: 'Explain the attached query.' } });
    fireEvent.keyDown(screen.getByLabelText('消息内容'), { key: 'Enter' });
    const sent = vi.mocked(aiBackend.chat).mock.calls[0]![0];
    expect(sent.prompt).toContain(original);
    expect(sent.prompt).not.toContain(newer);
    expect(sent.prompt).not.toContain(model.endpoint);
    expect(screen.getByLabelText('消息内容')).toHaveValue('');
    expect(screen.queryByRole('button', { name: zhAiChat.attachmentRemove })).not.toBeInTheDocument();
    expect(screen.getByLabelText('查询 DSL')).toHaveValue(newer);
  });

  it('shares the real test transport with settings without adding a chat turn', async () => {
    const { user, model, aiBackend } = await mount(true);
    vi.mocked(aiBackend.chat).mockImplementation(async (request) => ({
      requestId: request.requestId, modelProfileId: model.id, protocol: model.protocol,
      endpoint: model.endpoint, modelId: model.modelId, actualModelId: model.modelId,
      sequence: 1, text: 'OK', outcome: 'complete',
    }));
    await user.click(screen.getAllByRole('button', { name: '设置' })[0]!);
    await user.click(screen.getByRole('button', { name: 'AI 模型' }));
    await user.click(await screen.findByRole('button', { name: zhModels.test }));
    expect(await screen.findByText(zhModels.testPassed)).toBeInTheDocument();
    expect(aiBackend.chat).toHaveBeenCalledTimes(1);
    expect(vi.mocked(aiBackend.chat).mock.calls[0]![0]).toMatchObject({
      modelProfileId: model.id, prompt: 'Reply with OK.', authorization: { scope: 'conversation' },
    });
    await user.click(screen.getByRole('button', { name: '返回查询' }));
    await user.click(screen.getByRole('button', { name: '显示或隐藏 AI 面板' }));
    expect(await screen.findByText(zhAiChat.emptyTranscript)).toBeInTheDocument();
    expect(aiBackend.chat).toHaveBeenCalledTimes(1);
  });

  it('keeps both panel widths across settings and leaves query data untouched', async () => {
    const { user, model, aiBackend } = await mount();
    const dsl = '{"query":{"match_all":{}},"size":0}';
    fireEvent.change(screen.getByLabelText('查询 DSL'), { target: { value: dsl } });
    const left = screen.getByRole('separator', { name: '调整资源面板宽度' });
    fireEvent.keyDown(left, { key: 'ArrowRight' });
    expect(left).toHaveAttribute('aria-valuenow', '232');
    await user.click(screen.getByRole('button', { name: '显示或隐藏 AI 面板' }));
    await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue(model.id));
    const right = screen.getByRole('separator', { name: '调整 AI 面板宽度' });
    fireEvent.keyDown(right, { key: 'ArrowLeft' });
    expect(right).toHaveAttribute('aria-valuenow', '376');
    await user.click(screen.getAllByRole('button', { name: '设置' })[0]!);
    await user.click(screen.getByRole('button', { name: '返回查询' }));
    expect(screen.getByRole('separator', { name: '调整资源面板宽度' })).toHaveAttribute('aria-valuenow', '232');
    expect(screen.getByRole('separator', { name: '调整 AI 面板宽度' })).toHaveAttribute('aria-valuenow', '376');
    expect(screen.getByLabelText('查询 DSL')).toHaveValue(dsl);
    expect(aiBackend.chat).not.toHaveBeenCalled();
  });
});
