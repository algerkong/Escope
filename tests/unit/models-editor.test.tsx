import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelCredentialChange, ModelDiscoveryRequest, ModelDiscoveryResponse } from '../../src/domain/model-access';
import type { ModelInput, ModelProfile } from '../../src/domain/models';
import { ModelEditor } from '../../src/features/models/ModelEditor';
import { i18n } from '../../src/locales';
import { enModels, zhModels } from '../../src/locales/models';
import { createSessionModelService, type ModelService } from '../../src/services/models';

i18n.addResourceBundle('zh-CN', 'models', zhModels);
i18n.addResourceBundle('en-US', 'models', enModels);

/** Clearly fictitious tokens; never real credentials. */
const NEW_KEY = 'fixture-new-token';
const STORED_PROFILE: ModelInput = {
  displayName: '网关', protocol: 'openaiCompatible', endpoint: 'https://gateway.test/v1', modelId: 'gpt-4o-mini',
};

function profileOf(input: ModelInput, overrides: Partial<ModelProfile> = {}): ModelProfile {
  return { ...input, id: crypto.randomUUID(), sortOrder: 0, hasApiKey: false, ...overrides };
}

interface DiscoveryCall {
  readonly request: ModelDiscoveryRequest;
  readonly resolve: (response: ModelDiscoveryResponse) => void;
  readonly reject: (failure: unknown) => void;
}

function fakeService(profiles: ModelProfile[] = []) {
  const state = { profiles };
  const calls = {
    saves: [] as Array<{ input: ModelInput; id?: string; credential?: ModelCredentialChange }>,
    cancels: [] as string[],
  };
  const discoveries: DiscoveryCall[] = [];
  const service: ModelService = {
    kind: 'desktop',
    load: async () => ({
      profiles: state.profiles,
      defaultModelId: state.profiles[0]?.id ?? null,
      credentialCleanupPending: false,
    }),
    save: async (input, id, credential) => {
      calls.saves.push({ input, id, credential });
      const existing = state.profiles.find((profile) => profile.id === id);
      const hasApiKey = credential?.kind === 'replace' ? true
        : credential?.kind === 'clear' ? false : existing?.hasApiKey ?? false;
      const saved: ModelProfile = {
        ...input, id: existing?.id ?? crypto.randomUUID(), sortOrder: existing?.sortOrder ?? 0, hasApiKey,
      };
      state.profiles = existing
        ? state.profiles.map((profile) => profile.id === saved.id ? saved : profile)
        : [...state.profiles, saved];
      return saved;
    },
    delete: async () => undefined,
    select: async () => undefined,
    discover: (request) => new Promise<ModelDiscoveryResponse>((resolve, reject) => {
      discoveries.push({ request, resolve, reject });
    }),
    cancelDiscovery: async (requestId) => { calls.cancels.push(requestId); return true; },
    cleanupCredentials: async () => true,
  };
  return { service, calls, discoveries };
}

function responseFor(call: DiscoveryCall, modelIds: string[], truncated = false): ModelDiscoveryResponse {
  return {
    requestId: call.request.requestId,
    protocol: call.request.protocol,
    endpoint: call.request.endpoint,
    modelIds,
    truncated,
  };
}

const dialog = () => within(screen.getByRole('dialog'));
const keyField = () => dialog().getByLabelText('API 密钥') as HTMLInputElement;
const endpointField = () => dialog().getByLabelText('端点') as HTMLInputElement;
const modelIdField = () => dialog().getByLabelText('模型 ID') as HTMLInputElement;
const saveButton = () => dialog().getByRole('button', { name: /保存|重试/ });

function renderEditor(
  service: ModelService,
  value: ModelProfile | 'new' | null,
  onSave: (input: ModelInput, id?: string, credential?: ModelCredentialChange) => Promise<void> = async () => undefined,
  busy = false,
): ReactElement {
  return <I18nextProvider i18n={i18n}>
    <ModelEditor service={service} value={value} busy={busy} onClose={() => undefined} onSave={onSave} />
  </I18nextProvider>;
}

async function fillNewProfile(user: UserEvent) {
  await user.type(dialog().getByLabelText('名称'), '网关');
  await user.selectOptions(dialog().getByLabelText('协议'), 'openaiCompatible');
  await user.type(endpointField(), STORED_PROFILE.endpoint);
  await user.type(modelIdField(), STORED_PROFILE.modelId);
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
});

describe('model editor', () => {
  it('shows protocol-specific endpoint placeholders without overwriting the typed value', async () => {
    const { service } = fakeService();
    render(renderEditor(service, 'new'));
    const user = userEvent.setup();

    expect(endpointField()).toHaveAttribute('placeholder', 'http://127.0.0.1:8000/v1');
    await user.type(endpointField(), 'http://192.168.1.10:8788/team/v1');
    await user.selectOptions(dialog().getByLabelText('协议'), 'ollama');
    expect(endpointField()).toHaveAttribute('placeholder', 'http://127.0.0.1:11434');
    expect(endpointField()).toHaveValue('http://192.168.1.10:8788/team/v1');
  });

  it('saves metadata together with a replacement key and clears the field afterwards', async () => {
    const { service, calls } = fakeService();
    const onSave = vi.fn(async () => undefined);
    const view = render(renderEditor(service, 'new', onSave));
    const user = userEvent.setup();

    await fillNewProfile(user);
    await user.type(keyField(), NEW_KEY);
    await user.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledExactlyOnceWith(
      { ...STORED_PROFILE }, undefined, { kind: 'replace', apiKey: NEW_KEY },
    ));
    expect(calls.saves).toHaveLength(0);
    expect(keyField()).toHaveValue('');
    // The secret is gone from the DOM once the field is cleared and the dialog unmounts.
    view.rerender(renderEditor(service, null, onSave));
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(document.body.textContent).not.toContain(NEW_KEY);
  });

  it('keeps the saved key when the target is unchanged and never reads it back', async () => {
    const profile = profileOf(STORED_PROFILE, { hasApiKey: true });
    const { service } = fakeService([profile]);
    const onSave = vi.fn(async () => undefined);
    render(renderEditor(service, profile, onSave));
    const user = userEvent.setup();

    // The stored value is never rendered; only its state is described.
    expect(keyField()).toHaveValue('');
    expect(dialog().getByText(/已保存密钥：留空保持不变/)).toBeInTheDocument();
    await user.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledExactlyOnceWith(
      { ...STORED_PROFILE }, profile.id, { kind: 'keep' },
    ));
  });

  it('treats a changed endpoint or protocol as a new target that must not reuse the old key', async () => {
    const profile = profileOf(STORED_PROFILE, { hasApiKey: true });
    const { service } = fakeService([profile]);
    const onSave = vi.fn(async () => undefined);
    render(renderEditor(service, profile, onSave));
    const user = userEvent.setup();

    await user.clear(endpointField());
    await user.type(endpointField(), 'http://192.168.1.10:8788/team/v1');
    expect(dialog().getByText(/不会沿用已保存的密钥/)).toBeInTheDocument();
    await user.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'http://192.168.1.10:8788/team/v1' }), profile.id, { kind: 'clear' },
    ));

    // Reverting the target keeps the saved key again.
    onSave.mockClear();
    await user.clear(endpointField());
    await user.type(endpointField(), STORED_PROFILE.endpoint);
    expect(screen.queryByText(/不会沿用已保存的密钥/)).not.toBeInTheDocument();
    await user.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.anything(), profile.id, { kind: 'keep' }));
  });

  it('replaces the saved key by typing and removes it with the explicit checkbox', async () => {
    const profile = profileOf(STORED_PROFILE, { hasApiKey: true });
    const { service } = fakeService([profile]);
    const onSave = vi.fn(async () => undefined);
    render(renderEditor(service, profile, onSave));
    const user = userEvent.setup();

    await user.type(keyField(), NEW_KEY);
    await user.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(
      expect.anything(), profile.id, { kind: 'replace', apiKey: NEW_KEY },
    ));

    // Explicit removal clears the field, disables it and sends `clear`.
    onSave.mockClear();
    const clearBox = dialog().getByLabelText('保存时移除已保存的密钥');
    await user.click(clearBox);
    expect(keyField()).toBeDisabled();
    expect(keyField()).toHaveValue('');
    await user.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(expect.anything(), profile.id, { kind: 'clear' }));

    // Unchecking before saving keeps the existing reference again.
    onSave.mockClear();
    await user.click(clearBox);
    expect(keyField()).toBeEnabled();
    await user.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(expect.anything(), profile.id, { kind: 'keep' }));
  });

  it('retains the draft and the typed key when the backend rejects the save, and retries deliberately', async () => {
    const { service } = fakeService();
    const onSave = vi.fn<(input: ModelInput, id?: string, credential?: ModelCredentialChange) => Promise<void>>(
      async () => { throw { code: 'credentialUnavailable', requestId: null, retryable: false }; },
    );
    render(renderEditor(service, 'new', onSave));
    const user = userEvent.setup();

    await fillNewProfile(user);
    await user.type(keyField(), NEW_KEY);
    await user.click(saveButton());

    expect(await screen.findByText(/配置未能保存，当前填写的值仍然保留/)).toBeInTheDocument();
    expect(dialog().getByText(/已保存的密钥不可用/)).toBeInTheDocument();
    expect(dialog().getByLabelText('名称')).toHaveValue('网关');
    expect(endpointField()).toHaveValue(STORED_PROFILE.endpoint);
    expect(modelIdField()).toHaveValue(STORED_PROFILE.modelId);
    expect(keyField()).toHaveValue(NEW_KEY);

    onSave.mockResolvedValueOnce(undefined);
    await user.click(dialog().getByRole('button', { name: '重试' }));
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(
      { ...STORED_PROFILE }, undefined, { kind: 'replace', apiKey: NEW_KEY },
    ));
    expect(keyField()).toHaveValue('');
  });

  it('refuses a malformed key before saving and keeps it for correction', async () => {
    const { service } = fakeService();
    const onSave = vi.fn(async () => undefined);
    render(renderEditor(service, 'new', onSave));
    const user = userEvent.setup();

    await fillNewProfile(user);
    await user.type(keyField(), 'bad key');
    await user.click(saveButton());
    expect(dialog().getByText(/只能包含可打印 ASCII 字符/)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    expect(keyField()).toHaveValue('bad key');
  });

  it('fetches models with a provided key before any profile or model id exists', async () => {
    const { service, discoveries } = fakeService();
    render(renderEditor(service, 'new'));
    const user = userEvent.setup();

    await user.type(endpointField(), 'http://192.168.1.10:8788/team/v1/');
    await user.type(keyField(), NEW_KEY);
    await user.click(dialog().getByRole('button', { name: '获取模型' }));
    await waitFor(() => expect(discoveries).toHaveLength(1));
    const call = discoveries[0]!;
    expect(call.request.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(call.request.endpoint).toBe('http://192.168.1.10:8788/team/v1');
    expect(call.request.credential).toEqual({ kind: 'provided', apiKey: NEW_KEY });

    await act(async () => { call.resolve(responseFor(call, ['alpha', 'beta'])); });
    const select = await dialog().findByLabelText('已获取的模型');
    expect(select).toHaveValue('');
    await user.selectOptions(select, 'beta');
    expect(modelIdField()).toHaveValue('beta');

    // A manual value that is not in the fetched list stays intact.
    await user.clear(modelIdField());
    await user.type(modelIdField(), 'manual-id');
    expect(select).toHaveValue('');
    expect(modelIdField()).toHaveValue('manual-id');
  });

  it('uses the stored key only for the unchanged saved target', async () => {
    const profile = profileOf(STORED_PROFILE, { hasApiKey: true });
    const { service, discoveries } = fakeService([profile]);
    render(renderEditor(service, profile));
    const user = userEvent.setup();

    await user.click(dialog().getByRole('button', { name: '获取模型' }));
    await waitFor(() => expect(discoveries).toHaveLength(1));
    expect(discoveries[0]!.request.credential).toEqual({ kind: 'stored', modelProfileId: profile.id });
    await act(async () => { discoveries[0]!.resolve(responseFor(discoveries[0]!, [])); });
    expect(await dialog().findByText(/端点未返回任何模型 ID/)).toBeInTheDocument();

    // A changed endpoint must not send the stored key to the new host.
    await user.clear(endpointField());
    await user.type(endpointField(), 'http://192.168.1.10:8788/team/v1');
    await user.click(dialog().getByRole('button', { name: '获取模型' }));
    await waitFor(() => expect(discoveries).toHaveLength(2));
    expect(discoveries[1]!.request.credential).toEqual({ kind: 'none' });
    expect(discoveries[1]!.request.endpoint).toBe('http://192.168.1.10:8788/team/v1');

    // Checking the removal explicitly also stops the stored key from being used.
    await act(async () => { discoveries[1]!.resolve(responseFor(discoveries[1]!, ['gamma'])); });
    await dialog().findByLabelText('已获取的模型');
    await user.click(dialog().getByLabelText('保存时移除已保存的密钥'));
    await user.click(dialog().getByRole('button', { name: '获取模型' }));
    await waitFor(() => expect(discoveries).toHaveLength(3));
    expect(discoveries[2]!.request.credential).toEqual({ kind: 'none' });
  });

  it('cancels an in-flight fetch and ignores its late answer when the target changes or the dialog closes', async () => {
    const { service, calls, discoveries } = fakeService();
    const view = render(renderEditor(service, 'new'));
    const user = userEvent.setup();

    await user.type(endpointField(), 'https://gateway.test/v1');
    await user.click(dialog().getByRole('button', { name: '获取模型' }));
    await waitFor(() => expect(discoveries).toHaveLength(1));
    const first = discoveries[0]!;

    await user.type(keyField(), 'x');
    await waitFor(() => expect(calls.cancels).toEqual([first.request.requestId]));
    await act(async () => { first.resolve(responseFor(first, ['late-model'])); });
    expect(dialog().queryByLabelText('已获取的模型')).not.toBeInTheDocument();
    expect(dialog().queryByText('late-model')).not.toBeInTheDocument();

    // Closing the dialog also cancels and keeps late answers out.
    await user.click(dialog().getByRole('button', { name: '获取模型' }));
    await waitFor(() => expect(discoveries).toHaveLength(2));
    view.rerender(renderEditor(service, null));
    await waitFor(() => expect(calls.cancels).toContain(discoveries[1]!.request.requestId));
    await act(async () => { discoveries[1]!.resolve(responseFor(discoveries[1]!, ['late-model'])); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('reports a failed fetch and still saves a manual model id', async () => {
    const { service, discoveries } = fakeService();
    const onSave = vi.fn(async () => undefined);
    render(renderEditor(service, 'new', onSave));
    const user = userEvent.setup();

    await fillNewProfile(user);
    await user.click(dialog().getByRole('button', { name: '获取模型' }));
    await waitFor(() => expect(discoveries).toHaveLength(1));
    await act(async () => {
      discoveries[0]!.reject({ code: 'credentialFailure', requestId: discoveries[0]!.request.requestId, retryable: false });
    });
    expect(await dialog().findByText(/凭据存储拒绝了上次密钥操作/)).toBeInTheDocument();

    // Retry is offered, and a manual id can still be saved without any list.
    await user.click(dialog().getByRole('button', { name: '重试' }));
    await waitFor(() => expect(discoveries).toHaveLength(2));
    await user.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ ...STORED_PROFILE }, undefined, { kind: 'keep' }));
  });

  it('shows a truncated list notice and keeps the fetched ids selectable', async () => {
    const { service, discoveries } = fakeService();
    render(renderEditor(service, 'new'));
    const user = userEvent.setup();
    await user.type(endpointField(), 'https://gateway.test/v1');
    await user.click(dialog().getByRole('button', { name: '获取模型' }));
    await waitFor(() => expect(discoveries).toHaveLength(1));
    await act(async () => { discoveries[0]!.resolve(responseFor(discoveries[0]!, ['alpha', 'beta'], true)); });
    expect(await dialog().findByText(/列表可能已被截断/)).toBeInTheDocument();
    expect(dialog().getByLabelText('已获取的模型')).toBeInTheDocument();
  });

  it('states that the browser preview neither stores keys nor fetches models', async () => {
    const service = createSessionModelService();
    const onSave = vi.fn(async () => undefined);
    render(renderEditor(service, 'new', onSave));
    const user = userEvent.setup();

    expect(dialog().getByText(/浏览器预览不会保存密钥/)).toBeInTheDocument();
    expect(keyField()).toBeDisabled();
    expect(dialog().getByRole('button', { name: '获取模型' })).toBeDisabled();

    // Metadata-only saving still works and never asks for a credential change.
    await fillNewProfile(user);
    await user.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ ...STORED_PROFILE }, undefined, { kind: 'keep' }));
  });

  it('starts one save when the submit button is clicked twice in the same frame', async () => {
    const { service } = fakeService();
    const onSave = vi.fn(async () => undefined);
    render(renderEditor(service, 'new', onSave));
    const user = userEvent.setup();
    await fillNewProfile(user);

    const button = dialog().getByRole('button', { name: '保存' });
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  });

  it('starts one fetch when the fetch button is clicked twice in the same frame', async () => {
    const { service, discoveries } = fakeService();
    render(renderEditor(service, 'new'));
    const user = userEvent.setup();
    await user.type(endpointField(), 'https://gateway.test/v1');

    const button = dialog().getByRole('button', { name: '获取模型' });
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(discoveries).toHaveLength(1);
  });

  it('clears the key field when the dialog closes and never reopens it with a value', async () => {
    const { service } = fakeService();
    const view = render(renderEditor(service, 'new'));
    const user = userEvent.setup();
    await user.type(endpointField(), 'https://gateway.test/v1');
    await user.type(keyField(), NEW_KEY);

    view.rerender(renderEditor(service, null));
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(document.body.textContent).not.toContain(NEW_KEY);

    view.rerender(renderEditor(service, 'new'));
    expect(keyField()).toHaveValue('');
  });

  it('renders the English key and fetch copy', async () => {
    await i18n.changeLanguage('en-US');
    const profile = profileOf(STORED_PROFILE, { hasApiKey: true });
    const { service } = fakeService([profile]);
    render(renderEditor(service, profile));

    expect(dialog().getByText('Fetch models')).toBeInTheDocument();
    expect(dialog().getByLabelText('API key')).toHaveValue('');
    expect(dialog().getByText(/A key is saved for this target/)).toBeInTheDocument();
    expect(dialog().getByText(/Remove the saved key when saving/)).toBeInTheDocument();
  });

  it('places the fetch action after the key input and the model id after the fetch action', () => {
    const { service } = fakeService();
    render(renderEditor(service, 'new'));
    const following = (first: Element, second: Element) =>
      (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

    const key = keyField();
    const fetch = dialog().getByRole('button', { name: '获取模型' });
    const modelId = modelIdField();
    expect(following(key, fetch)).toBe(true);
    expect(following(fetch, modelId)).toBe(true);
  });

  it('warns about unencrypted HTTP without blocking the save', async () => {
    const { service } = fakeService();
    render(renderEditor(service, 'new'));
    const user = userEvent.setup();

    expect(dialog().queryByText(/HTTP 未加密/)).not.toBeInTheDocument();
    await user.type(endpointField(), 'http://192.168.1.10:8788/team/v1');
    expect(dialog().getByText(/HTTP 未加密/)).toBeInTheDocument();
    expect(dialog().getByRole('button', { name: '保存' })).toBeEnabled();

    await user.clear(endpointField());
    await user.type(endpointField(), 'https://gateway.test/v1');
    expect(dialog().queryByText(/HTTP 未加密/)).not.toBeInTheDocument();
  });

  it('can reveal the typed key without keeping its value in component state', async () => {
    const { service } = fakeService();
    render(renderEditor(service, 'new'));
    const user = userEvent.setup();

    expect(keyField()).toHaveAttribute('type', 'password');
    await user.type(keyField(), NEW_KEY);
    await user.click(dialog().getByRole('button', { name: '显示密钥' }));
    expect(keyField()).toHaveAttribute('type', 'text');
    expect(keyField()).toHaveValue(NEW_KEY);
    await user.click(dialog().getByRole('button', { name: '隐藏密钥' }));
    expect(keyField()).toHaveAttribute('type', 'password');
    expect(keyField()).toHaveValue(NEW_KEY);
  });

  it('disables the fetch button and shows a loader while fetching', async () => {
    const { service, discoveries } = fakeService();
    render(renderEditor(service, 'new'));
    const user = userEvent.setup();
    await user.type(endpointField(), 'https://gateway.test/v1');

    await user.click(dialog().getByRole('button', { name: '获取模型' }));
    await waitFor(() => expect(discoveries).toHaveLength(1));
    const fetching = dialog().getByRole('button', { name: '获取模型' });
    expect(fetching).toBeDisabled();
    expect(fetching.querySelector('.spin')).not.toBeNull();

    await act(async () => { discoveries[0]!.resolve(responseFor(discoveries[0]!, ['alpha'])); });
    const fetched = dialog().getByRole('button', { name: '获取模型' });
    expect(fetched).toBeEnabled();
    expect(fetched.querySelector('.spin')).toBeNull();
  });

  it('keeps the fetch lock for the whole stack when the service throws synchronously', async () => {
    let attempts = 0;
    const service: ModelService = {
      kind: 'desktop',
      load: async () => ({ profiles: [], defaultModelId: null, credentialCleanupPending: false }),
      save: async () => { throw new Error('unexpected'); },
      delete: async () => undefined,
      select: async () => undefined,
      discover: () => { attempts += 1; throw { code: 'networkError', requestId: null, retryable: false }; },
      cancelDiscovery: async () => true,
      cleanupCredentials: async () => true,
    };
    render(renderEditor(service, 'new'));
    const user = userEvent.setup();
    await user.type(endpointField(), 'https://gateway.test/v1');

    const button = dialog().getByRole('button', { name: '获取模型' });
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(attempts).toBe(1);
    expect(await dialog().findByText(/无法建立连接/)).toBeInTheDocument();

    // The lock only spans the click stack; the explicit retry is allowed.
    await user.click(dialog().getByRole('button', { name: '重试' }));
    expect(attempts).toBe(2);
  });

  it('maps a target-mismatch discovery failure with the model copy', async () => {
    const { service, discoveries } = fakeService();
    render(renderEditor(service, 'new'));
    const user = userEvent.setup();
    await user.type(endpointField(), 'https://gateway.test/v1');
    await user.click(dialog().getByRole('button', { name: '获取模型' }));
    await waitFor(() => expect(discoveries).toHaveLength(1));
    await act(async () => {
      discoveries[0]!.reject({
        code: 'aiTargetChanged', requestId: discoveries[0]!.request.requestId, retryable: false,
      });
    });
    expect(await dialog().findByText(/响应与请求的模型目标不一致/)).toBeInTheDocument();
    expect(dialog().queryByText(/重新审核/)).not.toBeInTheDocument();
  });

  it('uses DOM caps above the domain code-point limits and enforces the limits on submit', async () => {
    const { service } = fakeService();
    const onSave = vi.fn(async () => undefined);
    render(renderEditor(service, 'new', onSave));
    const user = userEvent.setup();

    expect(dialog().getByLabelText('名称')).toHaveAttribute('maxlength', '160');
    expect(modelIdField()).toHaveAttribute('maxlength', '400');

    // 81 ASCII code points fit the DOM cap but fail the domain check on submit.
    fireEvent.change(dialog().getByLabelText('名称'), { target: { value: 'a'.repeat(81) } });
    await user.type(endpointField(), 'https://gateway.test/v1');
    await user.type(modelIdField(), 'gpt-4o-mini');
    await user.click(saveButton());
    expect(await dialog().findByText(/请输入 1 至 80 个字符的名称/)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.change(dialog().getByLabelText('名称'), { target: { value: '网关' } });
    fireEvent.change(modelIdField(), { target: { value: 'x'.repeat(201) } });
    await user.click(saveButton());
    expect(await dialog().findByText(/部分值无效/)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('respects busy for the key toggle and the save action', () => {
    const { service } = fakeService();
    render(renderEditor(service, 'new', async () => undefined, true));
    expect(dialog().getByRole('button', { name: '显示密钥' })).toBeDisabled();
    expect(saveButton()).toBeDisabled();
    expect(keyField()).toBeDisabled();
  });

  it('refuses to fetch with an invalid endpoint without calling the service', async () => {
    const { service, discoveries } = fakeService();
    render(renderEditor(service, 'new'));
    const user = userEvent.setup();
    await user.type(endpointField(), 'not a url');
    await user.click(dialog().getByRole('button', { name: '获取模型' }));
    expect(dialog().getByText(/不含凭证、查询参数或片段/)).toBeInTheDocument();
    expect(discoveries).toHaveLength(0);
  });
});
