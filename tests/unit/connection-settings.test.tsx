import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionProfile } from '../../src/domain/connection';
import { ConnectionPanel, type ConnectionPanelProps } from '../../src/features/connections/ConnectionPanel';
import { i18n } from '../../src/locales';
import { enConnectionSettings, zhConnectionSettings } from '../../src/locales/connection-settings';

// The bundle is registered by `locales/index.ts`; the test registers it locally so no shared locale
// file has to change for this feature. All credential values below are fictitious fixtures.
i18n.addResourceBundle('zh-CN', 'connectionSettings', zhConnectionSettings);
i18n.addResourceBundle('en-US', 'connectionSettings', enConnectionSettings);

beforeEach(async () => { await i18n.changeLanguage('zh-CN'); });

type Save = NonNullable<ConnectionPanelProps['onSave']>;

const label = (key: string) => i18n.t(key);
const dialog = () => within(screen.getByRole('dialog'));

const plain: ConnectionProfile = {
  id: 'plain', displayName: 'Plain', endpoint: 'https://plain.test',
  environment: 'development', sortOrder: 0, auth: 'none', hasCredential: false, hasCustomCa: false,
};
/** A profile with stored credential and custom CA; values are metadata only, never secrets. */
function secured(kind: 'basic' | 'apiKey' | 'bearer'): ConnectionProfile {
  return {
    id: kind, displayName: kind, endpoint: 'https://secured.test',
    environment: 'production', sortOrder: 1, auth: kind, hasCredential: true, hasCustomCa: true,
  };
}

function setup(overrides: Partial<ConnectionPanelProps> = {}) {
  const onSave = vi.fn<Save>(async () => undefined);
  const onTest = vi.fn();
  const onSelect = vi.fn(async () => undefined);
  const onDelete = vi.fn(async () => undefined);
  const props: ConnectionPanelProps = {
    connections: [plain, secured('basic')], activeId: plain.id, busy: false, canTest: true,
    testResults: {}, timeZone: 'system', onTest, onSelect, onSave, onDelete, ...overrides,
  };
  render(<I18nextProvider i18n={i18n}><ConnectionPanel {...props} /></I18nextProvider>);
  return { onSave, onTest, onSelect, onDelete };
}

async function open(user: UserEvent, key: string) {
  await user.click(screen.getByRole('button', { name: label(key) }));
}

/** Opens the editor for a row (the edit button is the only control with that exact name). */
async function edit(user: UserEvent, name: string) {
  await user.click(screen.getByRole('button', { name: `${label('edit')} ${name}` }));
}

async function fillBase(user: UserEvent, endpoint = 'https://new.test', name = 'New') {
  await user.type(dialog().getByLabelText(label('connections:name')), name);
  const endpointInput = dialog().getByLabelText(label('connections:endpoint'));
  await user.clear(endpointInput);
  await user.type(endpointInput, endpoint);
}

async function save(user: UserEvent) {
  await user.click(dialog().getByRole('button', { name: label('save') }));
}

describe('connection credential editing', () => {
  it('adds a connection without authentication and sends an explicit keep decision', async () => {
    const user = userEvent.setup();
    const { onSave } = setup();
    await open(user, 'connections:add');
    await fillBase(user);
    expect(dialog().queryByLabelText(label('connectionSettings:fieldUsername'))).not.toBeInTheDocument();
    await save(user);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(
      { displayName: 'New', endpoint: 'https://new.test', environment: 'development' },
      undefined,
      { credential: { kind: 'keep' }, ca: { kind: 'keep' } },
    );
  });

  it.each([
    {
      kind: 'basic', expected: { kind: 'basic', username: 'fixture-user', password: 'fixture-pass' },
      fields: [['connectionSettings:fieldUsername', 'fixture-user'], ['connectionSettings:fieldPassword', 'fixture-pass']],
    },
    {
      kind: 'apiKey', expected: { kind: 'apiKey', id: 'fixture-id', key: 'fixture-key' },
      fields: [['connectionSettings:fieldApiId', 'fixture-id'], ['connectionSettings:fieldApiKey', 'fixture-key']],
    },
    {
      kind: 'bearer', expected: { kind: 'bearer', token: 'fixture-token' },
      fields: [['connectionSettings:fieldToken', 'fixture-token']],
    },
  ] as const)('stores new $kind credentials explicitly', async ({ kind, fields, expected }) => {
    const user = userEvent.setup();
    const { onSave } = setup();
    await open(user, 'connections:add');
    await fillBase(user);
    await user.selectOptions(dialog().getByLabelText(label('connections:authentication')), kind);
    for (const [fieldLabel, value] of fields) await user.type(dialog().getByLabelText(label(fieldLabel)), value);
    await save(user);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'https://new.test' }), undefined,
      { credential: expected, ca: { kind: 'keep' } });
  });

  it.each([
    ['basic', 'connectionSettings:fieldUsername'],
    ['apiKey', 'connectionSettings:fieldApiId'],
    ['bearer', 'connectionSettings:fieldToken'],
  ] as const)('never prefills a stored %s credential and keeps it by default', async (kind, emptyField) => {
    const user = userEvent.setup();
    const { onSave } = setup({ connections: [secured(kind)], activeId: kind });
    await edit(user, kind);
    expect(dialog().getByLabelText(label(emptyField))).toHaveValue('');
    expect(dialog().getByText(label('connectionSettings:credentialKeepHint'))).toBeInTheDocument();
    await save(user);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ displayName: kind }), kind,
      { credential: { kind: 'keep' }, ca: { kind: 'keep' } });
  });

  it('unbinds the stored credential when switched to none and says so', async () => {
    const user = userEvent.setup();
    const { onSave } = setup({ connections: [secured('basic')], activeId: 'basic' });
    await edit(user, 'basic');
    await user.selectOptions(dialog().getByLabelText(label('connections:authentication')), 'none');
    expect(dialog().getByText(label('connectionSettings:credentialNoneHint'))).toBeInTheDocument();
    await save(user);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![2]).toEqual({ credential: { kind: 'clear' }, ca: { kind: 'keep' } });
  });

  it('does not report a credential or CA removal when nothing is stored', async () => {
    const user = userEvent.setup();
    const { onSave } = setup({ connections: [plain], activeId: 'plain' });
    await edit(user, 'Plain');
    await save(user);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![2]).toEqual({ credential: { kind: 'keep' }, ca: { kind: 'keep' } });
  });

  it('clears typed material on close and on authentication type switches', async () => {
    const user = userEvent.setup();
    setup();
    await open(user, 'connections:add');
    await fillBase(user);
    await user.selectOptions(dialog().getByLabelText(label('connections:authentication')), 'basic');
    await user.type(dialog().getByLabelText(label('connectionSettings:fieldUsername')), 'fixture-user');
    await user.type(dialog().getByLabelText(label('connectionSettings:fieldPassword')), 'fixture-pass');
    await user.selectOptions(dialog().getByLabelText(label('connections:authentication')), 'bearer');
    await user.selectOptions(dialog().getByLabelText(label('connections:authentication')), 'basic');
    expect(dialog().getByLabelText(label('connectionSettings:fieldUsername'))).toHaveValue('');
    expect(dialog().getByLabelText(label('connectionSettings:fieldPassword'))).toHaveValue('');
    await user.type(dialog().getByLabelText(label('connectionSettings:fieldUsername')), 'fixture-user');
    await user.click(dialog().getByRole('button', { name: label('cancel') }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await open(user, 'connections:add');
    await user.selectOptions(dialog().getByLabelText(label('connections:authentication')), 'basic');
    expect(dialog().getByLabelText(label('connectionSettings:fieldUsername'))).toHaveValue('');
  });

  it('never submits a blank or half-filled replacement secret', async () => {
    const user = userEvent.setup();
    const { onSave } = setup();
    await open(user, 'connections:add');
    await fillBase(user);
    await user.selectOptions(dialog().getByLabelText(label('connections:authentication')), 'basic');
    await save(user);
    expect(onSave).not.toHaveBeenCalled();
    expect(dialog().getByRole('alert')).toHaveTextContent(label('connectionSettings:credentialRequiredBasic'));
    await user.type(dialog().getByLabelText(label('connectionSettings:fieldUsername')), 'fixture-user');
    await save(user);
    expect(onSave).not.toHaveBeenCalled();
    expect(dialog().getByRole('alert')).toHaveTextContent(label('connectionSettings:credentialIncompleteBasic'));
    await user.type(dialog().getByLabelText(label('connectionSettings:fieldPassword')), 'fixture-pass');
    await save(user);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![2]!.credential)
      .toEqual({ kind: 'basic', username: 'fixture-user', password: 'fixture-pass' });
  });

  it('submits once per save and blocks closing while the save is pending', async () => {
    const user = userEvent.setup();
    const { onSave } = setup();
    let release!: () => void;
    onSave.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    await open(user, 'connections:add');
    await fillBase(user);
    const saveButton = dialog().getByRole('button', { name: label('save') });
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(dialog().getByRole('button', { name: label('cancel') })).toBeDisabled();
    expect(dialog().getByRole('button', { name: label('save') })).toBeDisabled();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    release();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('connection transport and capability notices', () => {
  it('keeps the unencrypted HTTP warning visible for an authenticated connection', async () => {
    const user = userEvent.setup();
    setup();
    await open(user, 'connections:add');
    await user.type(dialog().getByLabelText(label('connections:name')), 'Http');
    const endpoint = dialog().getByLabelText(label('connections:endpoint'));
    await user.clear(endpoint);
    await user.type(endpoint, 'http://plain.test');
    expect(dialog().getByText(label('connections:httpWarning'))).toBeInTheDocument();
    await user.selectOptions(dialog().getByLabelText(label('connections:authentication')), 'basic');
    expect(dialog().getByText(label('connectionSettings:httpAuthWarning'))).toBeInTheDocument();
  });

  it('saves browser metadata but rejects credentials and a custom CA with a clear reason', async () => {
    const user = userEvent.setup();
    const { onSave } = setup({ canTest: false });
    await open(user, 'connections:add');
    await fillBase(user);
    expect(dialog().getByText(label('connectionSettings:browserNotice'))).toBeInTheDocument();
    await save(user);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![2]).toEqual({ credential: { kind: 'keep' }, ca: { kind: 'keep' } });

    await open(user, 'connections:add');
    await fillBase(user);
    await user.selectOptions(dialog().getByLabelText(label('connections:authentication')), 'basic');
    expect(dialog().getByLabelText(label('connectionSettings:fieldUsername'))).toBeDisabled();
    expect(dialog().getByLabelText(label('connectionSettings:fieldPassword'))).toBeDisabled();
    await save(user);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(dialog().getByRole('alert')).toHaveTextContent(label('connectionSettings:browserSaveBlocked'));

    await user.selectOptions(dialog().getByLabelText(label('connections:authentication')), 'none');
    await user.selectOptions(dialog().getByLabelText(label('connectionSettings:caLabel')), 'replace');
    expect(dialog().getByLabelText(label('connectionSettings:caPemLabel'))).toBeDisabled();
    await save(user);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(dialog().getByRole('alert')).toHaveTextContent(label('connectionSettings:browserSaveBlocked'));
  });
});

describe('custom CA and endpoint changes', () => {
  it('shows the stored CA status without its contents and keeps, clears or replaces it', async () => {
    const user = userEvent.setup();
    const { onSave } = setup({ connections: [secured('basic')], activeId: 'basic' });
    await edit(user, 'basic');
    expect(dialog().getByText(label('connectionSettings:caConfigured'))).toBeInTheDocument();
    const caSelect = dialog().getByLabelText(label('connectionSettings:caLabel'));
    expect(within(caSelect).getByRole('option', { name: label('connectionSettings:caKeep') })).toBeInTheDocument();
    await save(user);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![2]!.ca).toEqual({ kind: 'keep' });

    await edit(user, 'basic');
    await user.selectOptions(dialog().getByLabelText(label('connectionSettings:caLabel')), 'default');
    await save(user);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]![2]!.ca).toEqual({ kind: 'clear' });

    await edit(user, 'basic');
    await user.selectOptions(dialog().getByLabelText(label('connectionSettings:caLabel')), 'replace');
    await save(user);
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(dialog().getByRole('alert')).toHaveTextContent(label('connectionSettings:caPemRequired'));
    await user.type(dialog().getByLabelText(label('connectionSettings:caPemLabel')), 'fixture-pem-certificate');
    await save(user);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(3));
    expect(onSave.mock.calls[2]![2]!.ca).toEqual({ kind: 'replace', pem: 'fixture-pem-certificate' });
  });

  it('offers no keep option for a new connection and keeps the default validation', async () => {
    const user = userEvent.setup();
    const { onSave } = setup();
    await open(user, 'connections:add');
    await fillBase(user);
    expect(dialog().queryByRole('option', { name: label('connectionSettings:caKeep') })).not.toBeInTheDocument();
    await save(user);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![2]!.ca).toEqual({ kind: 'keep' });
  });

  it('warns that a changed endpoint detaches stored material and never carries it over', async () => {
    const user = userEvent.setup();
    const { onSave } = setup({ connections: [secured('basic')], activeId: 'basic' });
    await edit(user, 'basic');
    const endpoint = dialog().getByLabelText(label('connections:endpoint'));
    await user.clear(endpoint);
    await user.type(endpoint, 'https://moved.test');
    expect(dialog().getByText(label('connectionSettings:endpointChangeWarning'))).toBeInTheDocument();
    await save(user);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![2]).toEqual({ credential: { kind: 'clear' }, ca: { kind: 'clear' } });

    await edit(user, 'basic');
    const moved = dialog().getByLabelText(label('connections:endpoint'));
    await user.clear(moved);
    await user.type(moved, 'https://moved.test');
    await user.type(dialog().getByLabelText(label('connectionSettings:fieldUsername')), 'fixture-user');
    await user.type(dialog().getByLabelText(label('connectionSettings:fieldPassword')), 'fixture-pass');
    await save(user);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]![2]).toEqual({
      credential: { kind: 'basic', username: 'fixture-user', password: 'fixture-pass' },
      ca: { kind: 'clear' },
    });
  });
});

describe('connection metadata rows and cleanup', () => {
  it('shows real authentication and CA metadata per row and renders the reserved access slot', () => {
    const noKey: ConnectionProfile = { ...secured('apiKey'), id: 'nokey', displayName: 'nokey', hasCredential: false, hasCustomCa: false };
    setup({
      connections: [plain, secured('basic'), noKey], activeId: 'plain',
      renderAccess: (profile) => <span data-testid={`access-${profile.id}`}>{profile.displayName}</span>,
    });
    const plainRow = within(screen.getByRole('article', { name: 'Plain' }));
    expect(plainRow.getByText(label('connectionSettings:authNone'))).toBeInTheDocument();
    expect(plainRow.getByText(label('connectionSettings:caBadgeDefault'))).toBeInTheDocument();
    const basicRow = within(screen.getByRole('article', { name: 'basic' }));
    expect(basicRow.getByText(`${label('connectionSettings:authBasic')} · ${label('connectionSettings:authCredentialSaved')}`))
      .toBeInTheDocument();
    expect(basicRow.getByText(label('connectionSettings:caBadgeCustom'))).toBeInTheDocument();
    const noKeyRow = within(screen.getByRole('article', { name: 'nokey' }));
    expect(noKeyRow.getByText(`${label('connectionSettings:authApiKey')} · ${label('connectionSettings:authCredentialMissing')}`))
      .toBeInTheDocument();
    expect(screen.getByTestId('access-plain')).toBeInTheDocument();
    expect(screen.getByTestId('access-basic')).toBeInTheDocument();
    expect(screen.getByTestId('access-nokey')).toBeInTheDocument();
  });

  it('shows pending cleanup, retries it and never claims the removed material is gone', async () => {
    const user = userEvent.setup();
    const onCleanup = vi.fn(async () => undefined);
    setup({ cleanupPending: true, onCleanup });
    const pending = screen.getByRole('alert');
    expect(pending).toHaveTextContent(label('connectionSettings:cleanupPending'));
    await user.click(screen.getByRole('button', { name: label('connectionSettings:cleanupRetry') }));
    await waitFor(() => expect(onCleanup).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('alert')).toHaveTextContent(label('connectionSettings:cleanupPending'));

    onCleanup.mockRejectedValueOnce({ code: 'credentialFailure', body: 'fixture-secret' });
    await user.click(screen.getByRole('button', { name: label('connectionSettings:cleanupRetry') }));
    await waitFor(() => expect(onCleanup).toHaveBeenCalledTimes(2));
    const alerts = screen.getAllByRole('alert').map((node) => node.textContent ?? '');
    expect(alerts.some((text) => text.includes(label('connectionSettings:cleanupFailed')))).toBe(true);
    expect(alerts.some((text) => text.includes(label('errors:credentialFailure')))).toBe(true);
    expect(screen.queryByText(/fixture-secret/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: label('connectionSettings:cleanupRetry') })).toBeEnabled();
  });

  it('disables the cleanup retry while the parent request is in flight', () => {
    setup({ cleanupPending: true, cleanupBusy: true, onCleanup: vi.fn(async () => undefined) });
    expect(screen.getByRole('button', { name: label('connectionSettings:cleanupRetry') })).toBeDisabled();
  });

  it('shows sanitized save failures, keeps the draft and allows a deliberate retry', async () => {
    const user = userEvent.setup();
    const { onSave } = setup();
    onSave.mockRejectedValueOnce({ code: 'credentialUnavailable', body: 'fixture-secret', retryable: false });
    await open(user, 'connections:add');
    await fillBase(user);
    await save(user);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const alert = dialog().getByRole('alert');
    expect(alert).toHaveTextContent(label('connectionSettings:saveFailed'));
    expect(alert).toHaveTextContent(label('errors:credentialUnavailable'));
    expect(screen.queryByText(/fixture-secret/)).not.toBeInTheDocument();
    expect(dialog().getByLabelText(label('connections:name'))).toHaveValue('New');

    onSave.mockRejectedValueOnce(new Error('ECONNREFUSED fixture-secret 10.0.0.1'));
    await save(user);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(dialog().getByRole('alert')).not.toHaveTextContent('ECONNREFUSED');
    await save(user);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onSave).toHaveBeenCalledTimes(3);
  });
});
