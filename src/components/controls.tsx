import * as Dialog from '@radix-ui/react-dialog';
import { X, type LucideIcon } from 'lucide-react';
import { useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export function IconButton({ icon: Icon, label, className = '', ...props }:
  { icon: LucideIcon; label: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} {...props}><Icon size={16} /></button>;
}

export function EmptyState({ icon: Icon, title, description, children }:
  { icon: LucideIcon; title: string; description?: string; children?: ReactNode }) {
  return <div className="empty-state">
    <Icon className="empty-icon" size={32} strokeWidth={1.25} />
    <h2>{title}</h2>
    {description ? <p>{description}</p> : null}
    {children}
  </div>;
}

export function Modal({ open, onClose, title, description, children }:
  { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode }) {
  const { t } = useTranslation();
  const previousFocus = useRef<HTMLElement | null>(null);
  return <Dialog.Root open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog-content"
        {...(description ? {} : { 'aria-describedby': undefined })}
        onOpenAutoFocus={() => { previousFocus.current = document.activeElement as HTMLElement | null; }}
        onCloseAutoFocus={(event) => { event.preventDefault(); previousFocus.current?.focus(); }}>
        <div className="dialog-heading"><Dialog.Title>{title}</Dialog.Title>
          <Dialog.Close asChild><IconButton icon={X} label={t('close')} /></Dialog.Close>
        </div>
        {description ? <Dialog.Description className="muted dialog-description">{description}</Dialog.Description> : null}
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

export function SettingRow({ label, children, htmlFor }: { label: string; children: ReactNode; htmlFor?: string }) {
  return <div className="setting-row"><label htmlFor={htmlFor}>{label}</label><div className="setting-control">{children}</div></div>;
}

export function Toggle({ id, checked, onChange, label }:
  { id: string; checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return <input className="toggle" type="checkbox" role="switch" id={id} checked={checked}
    aria-label={label} onChange={(event) => onChange(event.target.checked)} />;
}
