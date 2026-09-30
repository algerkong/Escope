import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { App } from '../../src/app/App';
import { i18n } from '../../src/locales';
import { parsePreferences, type Preferences } from '../../src/domain/preferences';
import { createSessionStorage, type StorageService } from '../../src/services/storage';

beforeEach(async () => { await i18n.changeLanguage('zh-CN'); });

async function mount(service: StorageService) {
  const initial = await service.load();
  initial.preferences.locale = 'zh-CN';
  render(<I18nextProvider i18n={i18n}><App service={service} initial={initial} /></I18nextProvider>);
  return userEvent.setup();
}

async function openTypography(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getAllByRole('button', { name: '设置' })[0]!);
  await user.click(screen.getByRole('button', { name: '字体与密度' }));
}

describe('preference save failures', () => {
  it('reports the failure in a dialog that keeps the draft and retries the newest value', async () => {
    const service = createSessionStorage();
    const user = await mount(service);
    await openTypography(user);
    const save = vi.fn<StorageService['savePreferences']>()
      .mockRejectedValueOnce({ code: 'storageUnavailable' })
      .mockResolvedValue(undefined);
    service.savePreferences = save;
    const code = screen.getByLabelText('代码');
    code.focus();
    fireEvent.change(code, { target: { value: '18' } });

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('更改未能保存');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('本地存储不可用');
    // The failure is modal: no banner is inserted into the shell, so the header and the query area
    // keep their position.
    expect(document.querySelector('.app-shell .global-error')).toBeNull();
    expect(document.documentElement.style.getPropertyValue('--code-size')).toBe('18px');

    await user.click(within(dialog).getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![0]).toMatchObject({ codeSize: 18 });
    expect(document.documentElement.style.getPropertyValue('--code-size')).toBe('18px');
    expect(code).toHaveFocus();
  });

  it('closes on Escape, keeps the rejected draft and does not resend it', async () => {
    const service = createSessionStorage();
    const user = await mount(service);
    await openTypography(user);
    const save = vi.fn<StorageService['savePreferences']>().mockRejectedValue({ code: 'storageUnavailable' });
    service.savePreferences = save;
    fireEvent.change(screen.getByLabelText('界面'), { target: { value: '20' } });

    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(save).toHaveBeenCalledTimes(1);
    expect(document.documentElement.style.getPropertyValue('--ui-size')).toBe('20px');
    // The draft is still unsaved, so a later edit retries the whole value and can recover.
    save.mockResolvedValue(undefined);
    fireEvent.change(screen.getByLabelText('代码'), { target: { value: '18' } });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]![0]).toMatchObject({ uiSize: 20, codeSize: 18 });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('queues rapid edits and persists the newest merged draft', async () => {
    const service = createSessionStorage();
    const user = await mount(service);
    await openTypography(user);
    const written: Preferences[] = [];
    const save = vi.fn(async (preferences: Preferences) => { written.push(preferences); });
    service.savePreferences = save;
    fireEvent.change(screen.getByLabelText('界面'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('代码'), { target: { value: '18' } });

    await waitFor(() => expect(written.at(-1)).toMatchObject({ uiSize: 20, codeSize: 18 }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(written.at(-1)).toEqual({ ...parsePreferences(null), locale: 'zh-CN', uiSize: 20, codeSize: 18 });
  });
});
