import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AiChatBackend, AiChatCancelRequest, AiChatDelta, AiChatRequest, AiChatResponse,
} from '../../src/domain/ai-chat';
import type { ModelInput, ModelsState } from '../../src/domain/models';
import type { QueryDocument } from '../../src/domain/query';
import { AiChatPanel } from '../../src/features/ai/AiChatPanel';
import { i18n } from '../../src/locales';
import { enAiChat, zhAiChat } from '../../src/locales/ai-chat';
import { enModels, zhModels } from '../../src/locales/models';
import { enLive, zhLive } from '../../src/locales/query-live';
import { createSessionModelService, type ModelService } from '../../src/services/models';

// The `aiChat` bundle is registered by `locales/index.ts`; the test registers it (plus `models`
// for protocol labels and `queryLive` for copy feedback) locally, like the models panel test does.
i18n.addResourceBundle('zh-CN', 'aiChat', zhAiChat);
i18n.addResourceBundle('en-US', 'aiChat', enAiChat);
i18n.addResourceBundle('zh-CN', 'models', zhModels);
i18n.addResourceBundle('en-US', 'models', enModels);
i18n.addResourceBundle('zh-CN', 'queryLive', zhLive);
i18n.addResourceBundle('en-US', 'queryLive', enLive);

const PROFILE_A: ModelInput = {
  displayName: '本地 Ollama', protocol: 'ollama', endpoint: 'http://127.0.0.1:11434', modelId: 'llama3.1:8b',
};
const PROFILE_B: ModelInput = {
  displayName: '网关', protocol: 'openaiCompatible', endpoint: 'https://b.test/v1', modelId: 'b-1',
};
const QUERY: QueryDocument = {
  id: 'query-1', connectionId: 'conn-7', name: '错误日志', index: 'logs-*',
  dsl: '{\n  "query": { "match_all": {} }\n}', revision: 4, resultView: 'table',
};

interface FakeStream {
  readonly request: AiChatRequest;
  readonly emit: (delta: AiChatDelta) => void;
  readonly finish: (response: AiChatResponse) => void;
  readonly fail: (failure: unknown) => void;
}

function streamBackend(available = true) {
  const streams: FakeStream[] = [];
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

function element(
  service: ModelService,
  backend: AiChatBackend,
  props: {
    open?: boolean; active?: boolean; query?: QueryDocument | null;
    onClose?: () => void; onSettings?: () => void;
  } = {},
): ReactElement {
  return <I18nextProvider i18n={i18n}>
    <AiChatPanel modelService={service} backend={backend} query={props.query} open={props.open ?? true}
      active={props.active ?? true} onClose={props.onClose ?? (() => {})} onSettings={props.onSettings ?? (() => {})} />
  </I18nextProvider>;
}

/** Session adapter plus a spy, so "loaded only while visible" and reload counts can be asserted. */
async function sessionSetup(options: { profiles?: ModelInput[]; available?: boolean } = {}) {
  const inner = createSessionModelService();
  for (const profile of options.profiles ?? [PROFILE_A]) await inner.save(profile);
  const load = vi.fn(inner.load);
  const service: ModelService = { ...inner, load };
  const make = streamBackend(options.available ?? true);
  return { inner, service, load, ...make };
}

/** Emits the text as streamed chunks and completes the stream, matching the channel convention. */
async function finishStream(
  stream: FakeStream, text: string,
  options: { chunks?: string[]; actualModelId?: string | null; outcome?: AiChatResponse['outcome'] } = {},
) {
  const chunks = options.chunks ?? [text];
  await act(async () => {
    chunks.forEach((chunk, index) => stream.emit({
      requestId: stream.request.requestId, modelProfileId: stream.request.modelProfileId,
      sequence: index + 1, text: chunk,
    }));
    stream.finish({
      requestId: stream.request.requestId,
      modelProfileId: stream.request.modelProfileId,
      protocol: stream.request.authorization.protocol,
      endpoint: stream.request.authorization.endpoint,
      modelId: stream.request.authorization.modelId,
      actualModelId: options.actualModelId === undefined
        ? stream.request.authorization.modelId : options.actualModelId,
      sequence: chunks.length,
      text,
      outcome: options.outcome ?? 'complete',
    });
  });
}

async function sendText(user: UserEvent, text: string) {
  const box = screen.getByLabelText('消息内容');
  await user.clear(box);
  if (text !== '') await user.type(box, text);
  await user.click(screen.getByRole('button', { name: '发送' }));
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
});

afterEach(() => {
  // Tests that exercise a copy tool set up their own clipboard mock; restore the jsdom default.
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
});

describe('ai chat panel', () => {
  it('stays hidden without loading, then loads on open and renders the compact empty state', async () => {
    const { service, backend, load } = await sessionSetup();
    const view = render(element(service, backend, { open: false }));
    const panel = screen.getByLabelText('AI 助手');
    expect(panel).toHaveAttribute('hidden');
    expect(load).not.toHaveBeenCalled();

    view.rerender(element(service, backend, { open: true }));
    expect(await screen.findByLabelText('模型')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByText('暂无消息。')).toBeInTheDocument();
    // Direct chat: no review dialog, no key field, no approval or privacy paragraphs.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(screen.queryByText(/只会发送|审核|批准/)).not.toBeInTheDocument();
  });

  it('shows the desktop-only state in the browser preview and never loads or sends', async () => {
    const inner = createSessionModelService();
    await inner.save(PROFILE_A);
    const load = vi.fn(inner.load);
    const make = streamBackend(false);
    const onSettings = vi.fn();
    render(element({ ...inner, load }, make.backend, { onSettings }));

    expect(await screen.findByText('AI 对话需要桌面应用。')).toBeInTheDocument();
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('模型')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: '模型设置' }));
    expect(onSettings).toHaveBeenCalledTimes(1);
  });

  it('reports an unreadable list and re-reads it on retry', async () => {
    const inner = createSessionModelService();
    await inner.save(PROFILE_A);
    let fail: string | null = 'storageUnavailable';
    const load = vi.fn(async () => {
      if (fail) throw { code: fail, requestId: null, retryable: false };
      return inner.load();
    });
    render(element({ ...inner, load }, streamBackend().backend));
    expect(await screen.findByText(/模型配置读取失败/)).toBeInTheDocument();

    fail = null;
    await userEvent.setup().click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByLabelText('模型')).toBeInTheDocument();
  });

  it('offers the settings route when no profile exists', async () => {
    const { service, backend } = await sessionSetup({ profiles: [] });
    const onSettings = vi.fn();
    render(element(service, backend, { onSettings }));
    expect(await screen.findByText('尚未选择模型')).toBeInTheDocument();
    expect(screen.getByText(/请先在设置中添加模型配置/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: '模型设置' }));
    expect(onSettings).toHaveBeenCalledTimes(1);
  });

  it('preselects the stored default, keeps an explicit selection across reloads and falls back when it is gone', async () => {
    const inner = createSessionModelService();
    const a = await inner.save(PROFILE_A);
    const b = await inner.save(PROFILE_B);
    await inner.select(b.id);
    const service: ModelService = { ...inner, load: vi.fn(inner.load) };
    const make = streamBackend();
    const view = render(element(service, make.backend));
    const select = await screen.findByLabelText('模型') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(b.id));

    await userEvent.setup().selectOptions(screen.getByLabelText('模型'), a.id);
    // Settings round trip: the reload keeps the session selection while the id still exists.
    view.rerender(element(service, make.backend, { active: false }));
    view.rerender(element(service, make.backend, { active: true }));
    await waitFor(() => expect((screen.getByLabelText('模型') as HTMLSelectElement).value).toBe(a.id));

    await inner.delete(a.id);
    view.rerender(element(service, make.backend, { active: false }));
    view.rerender(element(service, make.backend, { active: true }));
    await waitFor(() => expect((screen.getByLabelText('模型') as HTMLSelectElement).value).toBe(b.id));
  });

  it('sends immediately from the button: exact request, consumed draft, kept focus, no dialog', async () => {
    const { service, backend, streams } = await sessionSetup();
    render(element(service, backend));
    await screen.findByLabelText('模型');
    const user = userEvent.setup();
    const box = screen.getByLabelText('消息内容');
    await user.type(box, '  解释 term query  ');
    await user.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(streams).toHaveLength(1));
    const sent = streams[0]!.request;
    expect(sent.prompt).toBe('  解释 term query  ');
    expect(sent.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(sent.authorization).toEqual({
      scope: 'conversation', protocol: 'ollama', endpoint: 'http://127.0.0.1:11434', modelId: 'llama3.1:8b',
    });
    // The saved key is the backend's concern: a direct send never carries or shows a key.
    expect(Object.keys(sent).sort()).toEqual(['authorization', 'modelProfileId', 'prompt', 'requestId']);
    expect(sent.history).toBeUndefined();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.querySelector('input[type="password"]')).toBeNull();

    // The turn renders the sent text, the draft is consumed and focus stays in the composer.
    expect(document.querySelector('.ai-turn-prompt')?.textContent).toBe('  解释 term query  ');
    expect(box).toHaveValue('');
    expect(box).toHaveFocus();
    expect(screen.getByText('等待响应…')).toBeInTheDocument();
    // The composer stays editable so the next draft can be written while streaming.
    await user.type(box, '下一草稿');
    expect(box).toHaveValue('下一草稿');

    await finishStream(streams[0]!, '答复');
    expect(await screen.findByText('已完成')).toBeInTheDocument();
    // Settling never clears what the user typed during streaming.
    expect(box).toHaveValue('下一草稿');
  });

  it('sends on Enter and Ctrl/Meta+Enter, keeps Shift+Enter as a newline and protects IME and repeats', async () => {
    const { service, backend, streams } = await sessionSetup();
    render(element(service, backend));
    await screen.findByLabelText('模型');
    const user = userEvent.setup();
    const box = screen.getByLabelText('消息内容');

    await user.type(box, '行一');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.type(box, '行二');
    expect(box).toHaveValue('行一\n行二');
    expect(streams).toHaveLength(0);

    // IME composition, the legacy 229 marker and held repeats never send.
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(box, { key: 'Enter', repeat: true });
    expect(streams).toHaveLength(0);

    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(streams).toHaveLength(1));
    expect(streams[0]!.request.prompt).toBe('行一\n行二');
    expect(box).toHaveValue('');
    await finishStream(streams[0]!, '答');

    await user.type(box, '第二');
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(streams).toHaveLength(2));
    await finishStream(streams[1]!, '答2');

    await user.type(box, '第三');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(streams).toHaveLength(3));
  });

  it('starts one request when send is clicked twice in the same frame, even with a synchronous settlement', async () => {
    const inner = createSessionModelService();
    await inner.save(PROFILE_A);
    const service: ModelService = { ...inner, load: vi.fn(inner.load) };
    const sent: AiChatRequest[] = [];
    const backend: AiChatBackend = {
      available: true,
      chat: (request) => {
        sent.push(request);
        const immediate: AiChatResponse = {
          requestId: request.requestId, modelProfileId: request.modelProfileId,
          protocol: request.authorization.protocol, endpoint: request.authorization.endpoint,
          modelId: request.authorization.modelId, actualModelId: request.authorization.modelId,
          sequence: 0, text: 'done', outcome: 'complete',
        };
        // A thenable that resolves before `chat` returns: the settle path runs inside the click.
        return {
          then: (onFulfilled: (value: AiChatResponse) => void) => { onFulfilled(immediate); },
        } as unknown as Promise<AiChatResponse>;
      },
      cancel: async () => true,
    };
    render(element(service, backend));
    await screen.findByLabelText('模型');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('消息内容'), '同步完成');
    const send = screen.getByRole('button', { name: '发送' });
    act(() => {
      send.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      send.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(sent).toHaveLength(1);
    expect(screen.getByText('已完成')).toBeInTheDocument();
    // The consumed draft cannot be sent again by a later Enter either.
    fireEvent.keyDown(screen.getByLabelText('消息内容'), { key: 'Enter' });
    expect(sent).toHaveLength(1);
    expect(document.querySelectorAll('.ai-turn')).toHaveLength(1);
  });

  it('sends multi-turn wire history byte-exact and only from complete exchanges', async () => {
    const { service, backend, streams } = await sessionSetup();
    render(element(service, backend));
    await screen.findByLabelText('模型');
    const user = userEvent.setup();

    await sendText(user, '  第一问  ');
    await finishStream(streams[0]!, '第一答');
    await sendText(user, '第二问');
    await finishStream(streams[1]!, '第二答');
    await sendText(user, '第三问');

    expect(streams[2]!.request.history).toEqual([
      { role: 'user', content: '  第一问  ' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '第二问' },
      { role: 'assistant', content: '第二答' },
    ]);
    await finishStream(streams[2]!, '第三答');

    // A failed exchange is not replayed and the visible prompt of each turn remains plain text.
    await sendText(user, '第四问');
    await act(async () => {
      streams[3]!.emit({
        requestId: streams[3]!.request.requestId, modelProfileId: streams[3]!.request.modelProfileId,
        sequence: 1, text: '半句',
      });
      streams[3]!.fail({ code: 'aiProviderError', requestId: streams[3]!.request.requestId, retryable: false });
    });
    await screen.findByText('失败');
    await sendText(user, '第五问');
    expect(streams[4]!.request.history).toEqual([
      { role: 'user', content: '  第一问  ' }, { role: 'assistant', content: '第一答' },
      { role: 'user', content: '第二问' }, { role: 'assistant', content: '第二答' },
      { role: 'user', content: '第三问' }, { role: 'assistant', content: '第三答' },
    ]);

    // Length-limited and provider-filtered replies are incomplete answers: never history either.
    await finishStream(streams[4]!, '截断答', { outcome: 'length' });
    await sendText(user, '第六问');
    const sent = streams[5]!.request;
    expect(sent.history?.some((message) => message.content === '截断答')).toBe(false);
    expect(sent.history).toHaveLength(6);
  });

  it('bounds history to the newest message and byte budgets, marking that earlier exchanges were omitted', async () => {
    // Message cap: 11 complete exchanges, then the next send may only replay the newest ten.
    const first = await sessionSetup();
    const firstView = render(element(first.service, first.backend));
    await screen.findByLabelText('模型');
    const user = userEvent.setup();
    const submit = async (text: string) => {
      fireEvent.change(screen.getByLabelText('消息内容'), { target: { value: text } });
      await user.click(screen.getByRole('button', { name: '发送' }));
    };
    for (let index = 1; index <= 11; index += 1) {
      await submit(`消息 ${index}`);
      await finishStream(first.streams[index - 1]!, `答 ${index}`);
    }
    await submit('第十二');
    const capped = first.streams[11]!.request.history!;
    expect(capped).toHaveLength(20);
    expect(capped[0]).toEqual({ role: 'user', content: '消息 2' });
    expect(capped[19]).toEqual({ role: 'assistant', content: '答 11' });
    // The omitted exchanges are stated on the turn, not silently implied to have been sent.
    expect(screen.getByText('已省略较早历史')).toBeInTheDocument();
    await finishStream(first.streams[11]!, '答 12');
    firstView.unmount();

    // Byte cap: 200 KiB replies; only the newest pairs that fit 512 KiB combined are replayed.
    const big = 'y'.repeat(200 * 1024);
    const second = await sessionSetup();
    render(element(second.service, second.backend));
    await screen.findByLabelText('模型');
    for (let index = 1; index <= 3; index += 1) {
      await submit(`q${index}`);
      await finishStream(second.streams[index - 1]!, big);
    }
    await submit('q4');
    const trimmed = second.streams[3]!.request.history!;
    expect(trimmed).toHaveLength(4);
    expect(trimmed[0]).toEqual({ role: 'user', content: 'q2' });
    expect(trimmed[1]).toEqual({ role: 'assistant', content: big });
  }, 15_000);

  it('isolates drafts, attachments and transcripts per target and restores them on return', async () => {
    const inner = createSessionModelService();
    const a = await inner.save(PROFILE_A);
    const b = await inner.save(PROFILE_B);
    const service: ModelService = { ...inner, load: vi.fn(inner.load) };
    const make = streamBackend();
    render(element(service, make.backend, { query: QUERY }));
    await screen.findByLabelText('模型');
    const user = userEvent.setup();

    await sendText(user, '来自 A');
    await finishStream(make.streams[0]!, 'A 答');
    await user.type(screen.getByLabelText('消息内容'), 'A 草稿');
    await user.click(screen.getByRole('button', { name: '附带当前查询' }));
    expect(screen.getByText('错误日志')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('模型'), b.id);
    // Nothing moves across: B starts with its own empty draft, no attachment and no history.
    expect(screen.getByLabelText('消息内容')).toHaveValue('');
    expect(screen.queryByText('错误日志')).not.toBeInTheDocument();
    expect(screen.queryByText('来自 A')).not.toBeInTheDocument();
    await sendText(user, 'B 问题');
    expect(make.streams[1]!.request.prompt).toBe('B 问题');
    expect(make.streams[1]!.request.modelProfileId).toBe(b.id);
    await finishStream(make.streams[1]!, 'B 答');

    await user.selectOptions(screen.getByLabelText('模型'), a.id);
    expect(screen.getByLabelText('消息内容')).toHaveValue('A 草稿');
    expect(screen.getByText('来自 A')).toBeInTheDocument();
    expect(screen.queryByText('B 问题')).not.toBeInTheDocument();
    expect(screen.getByText('错误日志')).toBeInTheDocument();
  });

  it('cancels the running request on a target switch and ignores its late chunks and answer', async () => {
    const inner = createSessionModelService();
    const a = await inner.save(PROFILE_A);
    const b = await inner.save(PROFILE_B);
    const service: ModelService = { ...inner, load: vi.fn(inner.load) };
    const make = streamBackend();
    render(element(service, make.backend));
    await screen.findByLabelText('模型');
    const user = userEvent.setup();

    await sendText(user, '问题');
    const stream = make.streams[0]!;
    await act(async () => {
      stream.emit({
        requestId: stream.request.requestId, modelProfileId: stream.request.modelProfileId, sequence: 1, text: '片段',
      });
    });
    await screen.findByText('片段');

    await user.selectOptions(screen.getByLabelText('模型'), b.id);
    expect(make.cancels).toEqual([{ requestId: stream.request.requestId, modelProfileId: stream.request.modelProfileId }]);
    expect(screen.queryByText('片段')).not.toBeInTheDocument();

    await act(async () => {
      stream.emit({
        requestId: stream.request.requestId, modelProfileId: stream.request.modelProfileId, sequence: 2, text: '迟到',
      });
      stream.finish({
        requestId: stream.request.requestId, modelProfileId: stream.request.modelProfileId,
        protocol: 'ollama', endpoint: 'http://127.0.0.1:11434', modelId: 'llama3.1:8b',
        actualModelId: 'llama3.1:8b', sequence: 2, text: '片段迟到', outcome: 'complete',
      });
    });
    await user.selectOptions(screen.getByLabelText('模型'), a.id);
    expect(screen.getByText('片段')).toBeInTheDocument();
    expect(screen.getByText('已停止')).toBeInTheDocument();
    expect(screen.queryByText('迟到')).not.toBeInTheDocument();
    expect(screen.queryByText('片段迟到')).not.toBeInTheDocument();
    expect(make.streams).toHaveLength(1);
  });

  it('treats a changed saved-key state as another target', async () => {
    const inner = createSessionModelService();
    await inner.save(PROFILE_A);
    let withKey = false;
    const service: ModelService = {
      ...inner,
      load: vi.fn(async () => {
        const state = await inner.load();
        return {
          ...state,
          profiles: state.profiles.map((profile) => ({ ...profile, hasApiKey: withKey })),
        } satisfies ModelsState;
      }),
    };
    const make = streamBackend();
    const view = render(element(service, make.backend));
    await screen.findByLabelText('模型');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('消息内容'), '草稿');

    withKey = true;
    view.rerender(element(service, make.backend, { active: false }));
    view.rerender(element(service, make.backend, { active: true }));
    await waitFor(() => expect(screen.queryByText('正在刷新…')).not.toBeInTheDocument());
    // The conversation identity includes the key state, so the old draft is not carried over.
    await waitFor(() => expect(screen.getByLabelText('消息内容')).toHaveValue(''));
  });

  it('keeps drafts across hide and settings, cancels a running request, and never generates from an effect', async () => {
    const { service, backend, streams, cancels, load } = await sessionSetup();
    const view = render(element(service, backend));
    await screen.findByLabelText('模型');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('消息内容'), '未发送草稿');

    view.rerender(element(service, backend, { open: false }));
    view.rerender(element(service, backend, { open: true }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('消息内容')).toHaveValue('未发送草稿');
    expect(streams).toHaveLength(0);

    // A running request is cancelled when leaving and never resumes on return; partial stays marked.
    await sendText(user, '问题');
    const stream = streams[0]!;
    await act(async () => {
      stream.emit({
        requestId: stream.request.requestId, modelProfileId: stream.request.modelProfileId, sequence: 1, text: '半句',
      });
    });
    view.rerender(element(service, backend, { active: false }));
    expect(cancels).toHaveLength(1);
    view.rerender(element(service, backend, { active: true }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    expect(screen.getByText('半句')).toBeInTheDocument();
    expect(screen.getByText('已停止')).toBeInTheDocument();
    expect(streams).toHaveLength(1);
  });

  it('fails closed for sending while the profile list cannot be re-read or is refreshing', async () => {
    const inner = createSessionModelService();
    await inner.save(PROFILE_A);
    let fail: string | null = null;
    const load = vi.fn(async () => {
      if (fail) throw { code: fail, requestId: null, retryable: false };
      return inner.load();
    });
    const service: ModelService = { ...inner, load };
    const make = streamBackend();
    const view = render(element(service, make.backend));
    await screen.findByLabelText('模型');

    fail = 'storageUnavailable';
    view.rerender(element(service, make.backend, { active: false }));
    view.rerender(element(service, make.backend, { active: true }));
    expect(await screen.findByText(/模型列表未能重新读取/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('消息内容'), '暂不发送');
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText('消息内容'), { key: 'Enter' });
    expect(make.streams).toHaveLength(0);

    fail = null;
    await user.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled());
    expect(screen.queryByText(/模型列表未能重新读取/)).not.toBeInTheDocument();
  });

  it('cancels an in-flight request when a re-read moves the selected target', async () => {
    const inner = createSessionModelService();
    await inner.save(PROFILE_A);
    let reloads = 0;
    const service: ModelService = {
      ...inner,
      load: vi.fn(async () => {
        reloads += 1;
        const state = await inner.load();
        if (reloads >= 2) {
          return {
            ...state,
            profiles: state.profiles.map((profile) => ({ ...profile, endpoint: 'http://127.0.0.1:11435' })),
          };
        }
        return state;
      }),
    };
    const make = streamBackend();
    render(element(service, make.backend));
    await screen.findByLabelText('模型');
    const user = userEvent.setup();

    await sendText(user, '问题');
    const stream = make.streams[0]!;
    expect(screen.getByRole('button', { name: '停止' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '刷新模型列表' }));
    await waitFor(() => expect(make.cancels).toHaveLength(1));
    // The re-read moved the identity (endpoint), so the panel is bound to the new target's empty
    // conversation; the cancelled turn stays in the old record and is never shown or resumed here.
    expect(screen.getByText('暂无消息。')).toBeInTheDocument();
    expect(screen.queryByText('已停止')).not.toBeInTheDocument();
    expect(screen.queryByText('正在返回…')).not.toBeInTheDocument();
    expect(screen.queryByText('等待响应…')).not.toBeInTheDocument();
    // The late answer never lands on the request bound to the old identity.
    await act(async () => {
      stream.finish({
        requestId: stream.request.requestId, modelProfileId: stream.request.modelProfileId,
        protocol: 'ollama', endpoint: 'http://127.0.0.1:11434', modelId: 'llama3.1:8b',
        actualModelId: 'llama3.1:8b', sequence: 0, text: '迟到', outcome: 'complete',
      });
    });
    expect(screen.queryByText('迟到')).not.toBeInTheDocument();
  });

  it('closes the clear dialog when the selected target changes', async () => {
    const { service, backend, streams } = await sessionSetup();
    const view = render(element(service, backend));
    await screen.findByLabelText('模型');
    const user = userEvent.setup();
    await sendText(user, '第一条');
    await finishStream(streams[0]!, '答一');
    await user.click(screen.getByRole('button', { name: '清空对话' }));
    expect(within(screen.getByRole('dialog')).getByText('清空对话？')).toBeInTheDocument();

    // A re-read that replaces the profile identity closes the destructive dialog instead of
    // letting it apply to a target the user is no longer looking at.
    const other = createSessionModelService();
    await other.save(PROFILE_B);
    const replacement: ModelService = { ...other, load: vi.fn(other.load) };
    view.rerender(element(replacement, backend));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('cancels the running request on unmount through the backend it started with', async () => {
    const { service, backend, streams, cancels } = await sessionSetup();
    const replacement = streamBackend();
    const view = render(element(service, backend));
    await screen.findByLabelText('模型');
    const user = userEvent.setup();
    await sendText(user, '问题');
    expect(streams).toHaveLength(1);
    view.rerender(element(service, replacement.backend));
    view.unmount();
    expect(cancels).toEqual([{ requestId: streams[0]!.request.requestId, modelProfileId: streams[0]!.request.modelProfileId }]);
    expect(replacement.cancels).toHaveLength(0);
  });

  it('stops locally: partial text stays marked, no retry is offered, late answers are ignored', async () => {
    const { service, backend, streams, cancels } = await sessionSetup();
    render(element(service, backend));
    await screen.findByLabelText('模型');
    const user = userEvent.setup();
    await sendText(user, '问题');
    const stream = streams[0]!;
    await act(async () => {
      stream.emit({
        requestId: stream.request.requestId, modelProfileId: stream.request.modelProfileId, sequence: 1, text: '半句',
      });
    });
    await screen.findByText('半句');

    await user.click(screen.getByRole('button', { name: '停止' }));
    expect(cancels).toEqual([{ requestId: stream.request.requestId, modelProfileId: stream.request.modelProfileId }]);
    expect(await screen.findByText('已停止')).toBeInTheDocument();
    expect(screen.getByText('半句')).toBeInTheDocument();
    expect(screen.getByText(/已停止，内容不完整/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试回答' })).not.toBeInTheDocument();

    await act(async () => {
      stream.finish({
        requestId: stream.request.requestId, modelProfileId: stream.request.modelProfileId,
        protocol: 'ollama', endpoint: 'http://127.0.0.1:11434', modelId: 'llama3.1:8b',
        actualModelId: 'llama3.1:8b', sequence: 1, text: '半句答案', outcome: 'complete',
      });
    });
    expect(screen.queryByText('已完成')).not.toBeInTheDocument();
    expect(screen.queryByText('半句答案')).not.toBeInTheDocument();
    expect(streams).toHaveLength(1);
  });

  it('retries the failed last turn with its exact history, a fresh request id and no duplicate user turn', async () => {
    const { service, backend, streams } = await sessionSetup();
    render(element(service, backend));
    await screen.findByLabelText('模型');
    const user = userEvent.setup();

    await sendText(user, '问题一');
    await finishStream(streams[0]!, '答一');
    await sendText(user, '问题二');
    const failed = streams[1]!;
    await act(async () => {
      failed.emit({
        requestId: failed.request.requestId, modelProfileId: failed.request.modelProfileId, sequence: 1, text: '半句',
      });
      failed.fail({ code: 'aiProviderError', requestId: failed.request.requestId, retryable: false });
    });
    expect(await screen.findByText('失败')).toBeInTheDocument();
    expect(screen.getByText('半句')).toBeInTheDocument();

    // A draft typed before retrying is neither consumed by the retry nor by its settlement.
    await user.type(screen.getByLabelText('消息内容'), '重试期间草稿');
    await user.click(screen.getByRole('button', { name: '重试回答' }));
    await waitFor(() => expect(streams).toHaveLength(3));
    const retried = streams[2]!.request;
    expect(retried.requestId).not.toBe(failed.request.requestId);
    expect(retried.prompt).toBe('问题二');
    expect(retried.history).toEqual([
      { role: 'user', content: '问题一' }, { role: 'assistant', content: '答一' },
    ]);
    // In place: one user turn for 问题二, no duplicate exchange was appended.
    expect(document.querySelectorAll('.ai-turn')).toHaveLength(2);
    expect(screen.getAllByText('问题二')).toHaveLength(1);

    await finishStream(streams[2]!, '答二');
    const settledTurns = document.querySelectorAll('.ai-turn');
    expect(settledTurns).toHaveLength(2);
    // Both exchanges are complete now; the retried last turn settled in place.
    expect(within(settledTurns[1] as HTMLElement).getByText('已完成')).toBeInTheDocument();
    expect(screen.getByLabelText('消息内容')).toHaveValue('重试期间草稿');
  });

  it('offers retry only on the failed last turn; an earlier failed turn cannot be retried later', async () => {
    const { service, backend, streams } = await sessionSetup();
    render(element(service, backend));
    await screen.findByLabelText('模型');
    const user = userEvent.setup();

    await sendText(user, '一');
    await act(async () => {
      streams[0]!.fail({ code: 'aiProviderError', requestId: streams[0]!.request.requestId, retryable: false });
    });
    expect(await screen.findByRole('button', { name: '重试回答' })).toBeInTheDocument();

    await sendText(user, '二');
    await finishStream(streams[1]!, '答二');
    await screen.findByText('已完成');
    expect(screen.queryByRole('button', { name: '重试回答' })).not.toBeInTheDocument();

    // Later history ignores the failed exchange: only complete pairs replay.
    await sendText(user, '三');
    expect(streams[2]!.request.history).toEqual([
      { role: 'user', content: '二' }, { role: 'assistant', content: '答二' },
    ]);
  });

  it('marks an empty completed reply as failed instead of a blank Completed turn', async () => {
    const { service, backend, streams } = await sessionSetup();
    render(element(service, backend));
    await screen.findByLabelText('模型');
    const user = userEvent.setup();
    await sendText(user, '问题');
    await act(async () => {
      streams[0]!.finish({
        requestId: streams[0]!.request.requestId, modelProfileId: streams[0]!.request.modelProfileId,
        protocol: 'ollama', endpoint: 'http://127.0.0.1:11434', modelId: 'llama3.1:8b',
        actualModelId: 'llama3.1:8b', sequence: 0, text: '', outcome: 'complete',
      });
    });
    expect(await screen.findByText('失败')).toBeInTheDocument();
    expect(screen.getByText(/模型返回了空回答/)).toBeInTheDocument();
    expect(screen.queryByText('已完成')).not.toBeInTheDocument();
  });

  it('discards a response whose identity or target does not match the request', async () => {
    const { service, backend, streams } = await sessionSetup();
    render(element(service, backend));
    await screen.findByLabelText('模型');
    const user = userEvent.setup();
    await sendText(user, '问题');
    await act(async () => {
      streams[0]!.finish({
        requestId: streams[0]!.request.requestId, modelProfileId: streams[0]!.request.modelProfileId,
        protocol: 'ollama', endpoint: 'https://not-approved.test', modelId: 'llama3.1:8b',
        actualModelId: 'llama3.1:8b', sequence: 0, text: '可疑回答', outcome: 'complete',
      });
    });
    expect(await screen.findByText('失败')).toBeInTheDocument();
    expect(screen.getByText(/无法解析，已丢弃/)).toBeInTheDocument();
    expect(screen.queryByText('可疑回答')).not.toBeInTheDocument();
  });

  it('ignores a delta with a foreign request id while accepting the real stream', async () => {
    const { service, backend, streams } = await sessionSetup();
    render(element(service, backend));
    await screen.findByLabelText('模型');
    const user = userEvent.setup();
    await sendText(user, '问题');
    const stream = streams[0]!;
    await act(async () => {
      stream.emit({
        requestId: '00000000-0000-4000-8000-000000000000',
        modelProfileId: stream.request.modelProfileId, sequence: 1, text: '混入',
      });
    });
    expect(screen.queryByText('混入')).not.toBeInTheDocument();
    await act(async () => {
      stream.emit({
        requestId: stream.request.requestId, modelProfileId: stream.request.modelProfileId, sequence: 1, text: '真实',
      });
    });
    expect(await screen.findByText('真实')).toBeInTheDocument();
  });

  it('freezes the attached query at click time, keeps it removable and sends it as plain text', async () => {
    const { service, backend, streams } = await sessionSetup();
    const view = render(element(service, backend, { query: QUERY }));
    await screen.findByLabelText('模型');
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: '附带当前查询' }));
    expect(screen.getByText('错误日志')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '查询快照' }));
    expect(screen.getByText('conn-7')).toBeInTheDocument();
    expect(screen.getByText(/match_all/)).toBeInTheDocument();

    // Editing the current query afterwards must not alter the frozen snapshot.
    view.rerender(element(service, backend, {
      query: { ...QUERY, dsl: '{"query":{"match_none":{}}}', revision: 5 },
    }));
    expect(screen.getByText(/match_all/)).toBeInTheDocument();
    expect(screen.queryByText(/match_none/)).not.toBeInTheDocument();
    expect(screen.getByText('conn-7')).toBeInTheDocument();

    await user.type(screen.getByLabelText('消息内容'), '看看这个');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(streams).toHaveLength(1));
    expect(streams[0]!.request.prompt).toBe(
      '看看这个\n\nAttached query draft\nName: 错误日志\nIndex: logs-*\nDSL:\n{\n  "query": { "match_all": {} }\n}',
    );
    // Name and index only: frozen ids never travel to the model.
    expect(streams[0]!.request.prompt).not.toContain('conn-7');
    expect(streams[0]!.request.prompt).not.toContain('query-1');
    // The turn renders the typed text and the attachment separately.
    const turn = document.querySelector('.ai-turn')!;
    expect(turn.querySelector('.ai-turn-prompt')?.textContent).toBe('看看这个');
    expect(turn.querySelector('.ai-attachment-name')?.textContent).toBe('错误日志');
  });

  it('removes the attachment cleanly and can send it without any text', async () => {
    const { service, backend, streams } = await sessionSetup();
    render(element(service, backend, { query: QUERY }));
    await screen.findByLabelText('模型');
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: '附带当前查询' }));
    await user.click(screen.getByRole('button', { name: '移除附件' }));
    expect(document.querySelector('.ai-attachment-row')).toBeNull();
    expect(screen.getByRole('button', { name: '附带当前查询' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '附带当前查询' }));
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(streams).toHaveLength(1));
    expect(streams[0]!.request.prompt.startsWith('Attached query draft')).toBe(true);
    expect(document.querySelector('.ai-turn .ai-attachment-name')?.textContent).toBe('错误日志');
    // The composer attachment was consumed by the send: it is no longer a removable draft part.
    expect(document.querySelector('.ai-attachment-row')).toBeNull();
  });

  it('blocks an oversize message and an attachment that pushes the prompt past 64 KiB', async () => {
    const { service, backend, streams } = await sessionSetup();
    render(element(service, backend, { query: { ...QUERY, dsl: 'y'.repeat(64 * 1024 + 1) } }));
    await screen.findByLabelText('模型');
    const user = userEvent.setup();
    const box = screen.getByLabelText('消息内容');

    fireEvent.change(box, { target: { value: 'x'.repeat(64 * 1024 + 1) } });
    expect(screen.getByText(/超过 64 KiB 上限/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(streams).toHaveLength(0);

    fireEvent.change(box, { target: { value: '小问题' } });
    await user.click(screen.getByRole('button', { name: '附带当前查询' }));
    expect(screen.getByText(/超过 64 KiB 上限/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    expect(streams).toHaveLength(0);

    // Removing the attachment makes the same draft sendable again.
    await user.click(screen.getByRole('button', { name: '移除附件' }));
    expect(screen.queryByText(/超过 64 KiB 上限/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
  });

  it('clears the conversation after confirmation, cancelling first and keeping the draft', async () => {
    const { service, backend, streams, cancels } = await sessionSetup();
    render(element(service, backend));
    await screen.findByLabelText('模型');
    const user = userEvent.setup();
    await sendText(user, '第一条');
    await finishStream(streams[0]!, '答一');
    await user.type(screen.getByLabelText('消息内容'), '下一步草稿');

    await user.click(screen.getByRole('button', { name: '清空对话' }));
    expect(within(screen.getByRole('dialog')).getByText('清空对话？')).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '清除' }));
    expect(document.querySelectorAll('.ai-turn')).toHaveLength(0);
    expect(screen.getByText('暂无消息。')).toBeInTheDocument();
    expect(screen.getByLabelText('消息内容')).toHaveValue('下一步草稿');
    expect(cancels).toHaveLength(0);

    // A running request is cancelled by the same action.
    await sendText(user, '第二条');
    await user.click(screen.getByRole('button', { name: '清空对话' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '清除' }));
    expect(cancels).toHaveLength(1);
    expect(document.querySelectorAll('.ai-turn')).toHaveLength(0);
  });

  it('shows a non-blocking unencrypted-HTTP chip and never asks for a key', async () => {
    const { service, backend, streams } = await sessionSetup();
    render(element(service, backend));
    await screen.findByLabelText('模型');
    expect(screen.getByTitle('HTTP 未加密：消息不会经过传输加密。')).toBeInTheDocument();
    expect(document.querySelector('input[type="password"]')).toBeNull();

    const user = userEvent.setup();
    await sendText(user, '明文端点');
    await waitFor(() => expect(streams).toHaveLength(1));
    expect(streams[0]!.request.authorization.endpoint).toBe('http://127.0.0.1:11434');
  });

  it('renders safe Markdown in replies without scripts, images or extra network calls', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { service, backend, streams } = await sessionSetup();
    const view = render(element(service, backend));
    await screen.findByLabelText('模型');
    const user = userEvent.setup();
    await sendText(user, '问题');
    await finishStream(streams[0]!, '# 标题\n\n**加粗**\n\n<script>window.__pwned=1</script>\n\n![图](https://img.test/x.png)\n\n| a | b |\n| - | - |\n| 1 | 2 |');
    expect(await screen.findByRole('heading', { name: '标题' })).toBeInTheDocument();
    expect(screen.getByText('加粗').tagName).toBe('STRONG');
    expect(view.container.querySelector('table')).toBeTruthy();
    expect(view.container.querySelector('script')).toBeNull();
    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.querySelector('iframe')).toBeNull();
    expect(screen.getByText(/图片未加载/)).toBeInTheDocument();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('copies a reply with the shared copy tool', async () => {
    // userEvent.setup() installs its own clipboard stub, so the mock must replace it afterwards.
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { service, backend, streams } = await sessionSetup();
    render(element(service, backend));
    await screen.findByLabelText('模型');
    await sendText(user, '问题');
    await finishStream(streams[0]!, '可复制的回答');
    await screen.findByText('已完成');
    await user.click(screen.getByRole('button', { name: '复制回答' }));
    expect(writeText).toHaveBeenCalledWith('可复制的回答');
    expect(await screen.findByText('已复制')).toBeInTheDocument();
  });

  it('follows the transcript only while near the bottom and offers a scroll-to-latest tool', async () => {
    const { service, backend, streams } = await sessionSetup();
    render(element(service, backend));
    await screen.findByLabelText('模型');
    const user = userEvent.setup();
    await sendText(user, '问题');

    const body = document.querySelector('.ai-body') as HTMLDivElement;
    let top = 0;
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 200 });
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(body, 'scrollTop', {
      configurable: true, get: () => top, set: (value: number) => { top = value; },
    });

    top = 800;
    fireEvent.scroll(body);
    await finishStream(streams[0]!, '答复');
    expect(top).toBe(1000);

    await sendText(user, '追问');
    const second = streams[1]!;
    top = 100;
    fireEvent.scroll(body);
    expect(await screen.findByRole('button', { name: '回到最新' })).toBeInTheDocument();
    await act(async () => {
      second.emit({
        requestId: second.request.requestId, modelProfileId: second.request.modelProfileId, sequence: 1, text: '第一段',
      });
    });
    expect(top).toBe(100);

    await user.click(screen.getByRole('button', { name: '回到最新' }));
    expect(top).toBe(1000);
  });

  it('discards a model list read that was in flight when the panel was hidden', async () => {
    const inner = createSessionModelService();
    const a = await inner.save(PROFILE_A);
    const b = await inner.save(PROFILE_B);
    const gates: Array<(value: ModelsState) => void> = [];
    const service: ModelService = {
      ...inner,
      load: () => new Promise<ModelsState>((resolve) => { gates.push(resolve); }),
    };
    const make = streamBackend();
    const view = render(element(service, make.backend));
    await waitFor(() => expect(gates).toHaveLength(1));

    view.rerender(element(service, make.backend, { open: false }));
    await act(async () => { gates[0]!({ profiles: [a], defaultModelId: a.id, credentialCleanupPending: false }); });
    expect(screen.queryByText('本地 Ollama')).not.toBeInTheDocument();

    view.rerender(element(service, make.backend, { open: true }));
    await waitFor(() => expect(gates).toHaveLength(2));
    await act(async () => { gates[1]!({ profiles: [b], defaultModelId: b.id, credentialCleanupPending: false }); });
    expect(await screen.findByText('网关')).toBeInTheDocument();
    expect(screen.queryByText('本地 Ollama')).not.toBeInTheDocument();
  });

  it('uses the compact English copy when the language is English', async () => {
    await i18n.changeLanguage('en-US');
    const { service, backend } = await sessionSetup();
    render(element(service, backend));
    expect(await screen.findByText('No messages yet.')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Message text'), 'hello');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Waiting for response…')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTitle('Unencrypted HTTP: this message is sent without transport encryption.')).toBeInTheDocument();
  });

  it('keeps the header to conversation tools and the model selector with the composer', async () => {
    const { service, backend, streams } = await sessionSetup();
    render(element(service, backend));
    const select = await screen.findByLabelText('模型') as HTMLSelectElement;
    const panel = screen.getByLabelText('AI 助手');
    // The workspace splitter points its aria-controls at this id.
    expect(panel).toHaveAttribute('id', 'workspace-ai');

    const user = userEvent.setup();
    await sendText(user, '一条消息');
    await finishStream(streams[0]!, '答');

    const header = panel.querySelector('.sidebar-heading') as HTMLElement;
    // Title plus conversation tools only — clear and close — never the model target or refresh.
    expect(within(header).getAllByRole('button')).toHaveLength(2);
    expect(within(header).getByRole('button', { name: '清空对话' })).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: '关闭' })).toBeInTheDocument();
    expect(header.querySelector('select')).toBeNull();

    const composer = panel.querySelector('.ai-composer') as HTMLElement;
    expect(composer.querySelector('select')).toBe(select);
    expect(within(composer).getByRole('button', { name: '发送' })).toBeInTheDocument();
    expect(within(composer).getByRole('button', { name: '刷新模型列表' })).toBeInTheDocument();
    expect(within(composer).getByRole('button', { name: '模型设置' })).toBeInTheDocument();
    // The model id is on-demand metadata (title), not a wrapping text stack at 280px.
    expect(select).toHaveAttribute('title', 'llama3.1:8b');
    expect(within(composer).getByRole('option', { name: '本地 Ollama' })).toHaveAttribute('title', 'llama3.1:8b');
  });

  it('binds to the first profile when the saved default is missing, so send is never empty', async () => {
    const inner = createSessionModelService();
    const a = await inner.save(PROFILE_A);
    const service: ModelService = {
      ...inner,
      load: vi.fn(async () => ({ profiles: [a], defaultModelId: null, credentialCleanupPending: false })),
    };
    const make = streamBackend();
    render(element(service, make.backend));
    const select = await screen.findByLabelText('模型') as HTMLSelectElement;
    // Same fallback the domain uses: a missing stored default selects the first profile, so the
    // visible selector and the actual request target cannot diverge.
    expect(select).toHaveValue(a.id);

    const user = userEvent.setup();
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText('消息内容'), { key: 'Enter' });
    expect(make.streams).toHaveLength(0);

    await user.type(screen.getByLabelText('消息内容'), '未选默认也不能空发');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(make.streams).toHaveLength(1));
    expect(make.streams[0]!.request.modelProfileId).toBe(a.id);
  });

  it('never erases text typed or a snapshot attached while a request is running', async () => {
    const { service, backend, streams } = await sessionSetup();
    render(element(service, backend, { query: QUERY }));
    await screen.findByLabelText('模型');
    const user = userEvent.setup();
    const box = screen.getByLabelText('消息内容');

    await user.type(box, '发出');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(streams).toHaveLength(1));
    expect(box).toHaveValue('');
    // Draft and attachment made while the first request streams survive its completion.
    await user.type(box, '运行中写字');
    await user.click(screen.getByRole('button', { name: '附带当前查询' }));
    await finishStream(streams[0]!, '答');
    await screen.findByText('已完成');
    expect(box).toHaveValue('运行中写字');
    expect(screen.getByText('错误日志')).toBeInTheDocument();

    // The failure path keeps the new text too.
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(streams).toHaveLength(2));
    await user.type(box, '，失败也不丢');
    await act(async () => {
      streams[1]!.fail({ code: 'aiProviderError', requestId: streams[1]!.request.requestId, retryable: false });
    });
    expect(await screen.findByText('失败')).toBeInTheDocument();
    expect(box).toHaveValue('，失败也不丢');

    // And the stop path.
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(streams).toHaveLength(3));
    await user.type(box, '，停止也不丢');
    await user.click(screen.getByRole('button', { name: '停止' }));
    expect(await screen.findByText('已停止')).toBeInTheDocument();
    expect(box).toHaveValue('，停止也不丢');
  });

  it('never starts a send from Enter while the clear dialog is open', async () => {
    const { service, backend, streams } = await sessionSetup();
    render(element(service, backend));
    await screen.findByLabelText('模型');
    const user = userEvent.setup();
    await sendText(user, '第一条');
    await finishStream(streams[0]!, '答一');
    await screen.findByText('已完成');

    await user.type(screen.getByLabelText('消息内容'), '弹窗里的草稿');
    await user.click(screen.getByRole('button', { name: '清空对话' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText('消息内容'), { key: 'Enter' });
    expect(streams).toHaveLength(1);
    expect(screen.getByLabelText('消息内容')).toHaveValue('弹窗里的草稿');
  });

  it('ignores deltas that arrive after a successful or failed attempt settled', async () => {
    const { service, backend, streams } = await sessionSetup();
    render(element(service, backend));
    await screen.findByLabelText('模型');
    const user = userEvent.setup();

    await sendText(user, '问题');
    const done = streams[0]!;
    await finishStream(done, '完整答');
    await screen.findByText('已完成');
    await act(async () => {
      done.emit({
        requestId: done.request.requestId, modelProfileId: done.request.modelProfileId, sequence: 9, text: '迟到片段',
      });
    });
    expect(screen.queryByText('迟到片段')).not.toBeInTheDocument();

    await sendText(user, '第二问');
    const failed = streams[1]!;
    await act(async () => {
      failed.emit({
        requestId: failed.request.requestId, modelProfileId: failed.request.modelProfileId, sequence: 1, text: '半句',
      });
      failed.fail({ code: 'aiProviderError', requestId: failed.request.requestId, retryable: false });
    });
    await screen.findByText('失败');
    await act(async () => {
      failed.emit({
        requestId: failed.request.requestId, modelProfileId: failed.request.modelProfileId, sequence: 2, text: '越界',
      });
    });
    expect(screen.queryByText('越界')).not.toBeInTheDocument();
    expect(screen.getByText('半句')).toBeInTheDocument();
  });

  it('follows the transcript tail on every new send even after the reader scrolled up', async () => {
    const { service, backend, streams } = await sessionSetup();
    render(element(service, backend));
    await screen.findByLabelText('模型');
    const user = userEvent.setup();

    await sendText(user, '第一问');
    await finishStream(streams[0]!, '答一');
    await screen.findByText('已完成');

    const body = document.querySelector('.ai-body') as HTMLDivElement;
    let top = 0;
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 200 });
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(body, 'scrollTop', {
      configurable: true, get: () => top, set: (value: number) => { top = value; },
    });

    top = 100;
    fireEvent.scroll(body);
    expect(await screen.findByRole('button', { name: '回到最新' })).toBeInTheDocument();

    await sendText(user, '第二问');
    // A deliberate send returns to the tail; later streamed deltas then keep following it.
    expect(top).toBe(1000);
    expect(screen.queryByRole('button', { name: '回到最新' })).not.toBeInTheDocument();
    await finishStream(streams[1]!, '答二');
    expect(top).toBe(1000);
  });
});

const aiChatCss = readFileSync(resolve(process.cwd(), 'src/styles/ai-chat.css'), 'utf8');

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (match === null) throw new Error(`missing CSS rule ${selector}`);
  return match[1]!;
}

describe('ai chat panel stylesheet contract', () => {
  // Text-level checks only: jsdom cannot prove pixels. They pin the scroll chain that keeps the
  // transcript inside the panel and the wrapping rules the 280–640px workspace width relies on.
  it('scrolls the transcript inside the panel and never assigns its own width', () => {
    const sidebar = cssRule(aiChatCss, '.ai-sidebar');
    expect(sidebar).toMatch(/min-height:\s*0/);
    expect(sidebar).toMatch(/overflow:\s*hidden/);
    expect(sidebar).not.toMatch(/(^|[^-])width:/);

    const wrap = cssRule(aiChatCss, '.ai-body-wrap');
    expect(wrap).toMatch(/flex:\s*1\s+1\s+auto/);
    expect(wrap).toMatch(/min-height:\s*0/);
    expect(wrap).toMatch(/overflow:\s*hidden/);
    expect(cssRule(aiChatCss, '.ai-body')).toMatch(/overflow-y:\s*auto/);

    const composer = cssRule(aiChatCss, '.ai-composer');
    expect(composer).toMatch(/flex-shrink:\s*0/);
    expect(composer).toMatch(/max-height:/);
  });

  it('wraps the composer target row instead of stacking the selector vertically', () => {
    const target = cssRule(aiChatCss, '.ai-composer-target');
    expect(target).toMatch(/flex-wrap:\s*wrap/);
    expect(target).toMatch(/min-width:\s*0/);
    expect(cssRule(aiChatCss, '.ai-composer-model')).toMatch(/min-width:\s*0/);

    // Long replies stay inside the turn: tables scroll sideways, code blocks scroll internally.
    const table = cssRule(aiChatCss, '.ai-md table');
    expect(table).toMatch(/overflow-x:\s*auto/);
    expect(table).toMatch(/max-width:\s*100%/);
    const pre = cssRule(aiChatCss, '.ai-code pre');
    expect(pre).toMatch(/overflow:\s*auto/);
    expect(pre).toMatch(/max-height:/);

    // The old top-of-panel target bar is gone; its selector must not come back.
    expect(aiChatCss).not.toMatch(/\.ai-target\b/);
  });
});
