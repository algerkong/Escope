import * as Dialog from '@radix-ui/react-dialog';
import { ArrowDownLeft, Search, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton } from '../components/controls';

export interface Command {
  id: string;
  title: string;
  keywords: string;
  run: () => void;
  disabledReason?: string;
}

export function CommandPalette({ kind, commands, onClose }:
  { kind: 'jump' | 'command'; commands: Command[]; onClose: () => void }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(0);
  const previousFocus = useRef<HTMLElement | null>(null);
  const executed = useRef(false);
  const normalized = search.trim().toLowerCase();
  const filtered = commands.filter((command) => `${command.title} ${command.keywords}`.toLowerCase().includes(normalized));
  const index = Math.min(active, Math.max(0, filtered.length - 1));
  const execute = (command: Command | undefined) => {
    if (!command || command.disabledReason) return;
    executed.current = true;
    onClose();
    requestAnimationFrame(() => {
      command.run();
      requestAnimationFrame(() => {
        if (document.activeElement !== document.body && document.activeElement !== null) return;
        if (previousFocus.current?.isConnected) previousFocus.current.focus();
        else document.querySelector<HTMLElement>('.query-tab [aria-selected="true"]')?.focus();
      });
    });
  };
  return <Dialog.Root open onOpenChange={(value) => { if (!value) onClose(); }}>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="palette dialog-content" aria-describedby={undefined}
        onOpenAutoFocus={() => { previousFocus.current = document.activeElement as HTMLElement | null; }}
        onCloseAutoFocus={(event) => { event.preventDefault(); if (!executed.current) previousFocus.current?.focus(); }}>
        <Dialog.Title className="sr-only">{t(kind)}</Dialog.Title>
        <div className="palette-input"><Search size={18} />
          <input aria-label={t(kind)} placeholder={t(kind)} role="combobox" aria-controls="command-options"
            aria-expanded="true" aria-autocomplete="list"
            aria-activedescendant={filtered[index] ? `command-${filtered[index].id}` : undefined}
            value={search} onChange={(event) => { setSearch(event.target.value); setActive(0); }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (!filtered.length) return;
                const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length;
                setActive(next);
                document.getElementById(`command-${filtered[next]?.id}`)?.scrollIntoView({ block: 'nearest' });
              }
              if (event.key === 'Enter') { event.preventDefault(); execute(filtered[index]); }
            }} />
          <Dialog.Close asChild><IconButton icon={X} label={t('close')} /></Dialog.Close>
        </div>
        <div className="palette-options" role="listbox" id="command-options" aria-label={t(kind)}>
          {filtered.length ? filtered.map((command, position) =>
            <div role="option" aria-selected={index === position} aria-disabled={Boolean(command.disabledReason)}
              id={`command-${command.id}`} key={command.id} className="palette-option"
              onPointerMove={() => setActive(position)} onClick={() => execute(command)}>
              <span>{command.title}{command.disabledReason ? <small>{command.disabledReason}</small> : null}</span>
              <ArrowDownLeft size={14} />
            </div>) : <div className="palette-empty">{t('noMatches')}</div>}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
