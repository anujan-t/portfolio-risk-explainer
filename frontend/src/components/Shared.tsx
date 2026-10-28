import { AlertCircle, ArrowUpRight, Check, LoaderCircle, X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';

export function Notice({ children, tone = 'info', onDismiss }: { children: ReactNode; tone?: 'info' | 'error' | 'success'; onDismiss?: () => void }) {
  return <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
    {tone === 'success' ? <Check size={17} /> : <AlertCircle size={17} />}
    <div>{children}</div>
    {onDismiss && <button className="icon-button" aria-label="Dismiss message" onClick={onDismiss}><X size={16} /></button>}
  </div>;
}

export function Spinner({ children }: { children?: ReactNode }) {
  return <span className="loading-inline"><LoaderCircle size={17} className="spin" />{children}</span>;
}

export function PanelHeading({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: ReactNode }) {
  return <div className="panel-heading"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2></div>{action}</div>;
}

export function EmptyState({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-orbit"><ArrowUpRight size={26} /></div><h2>{title}</h2><p>{text}</p>{action}</div>;
}

export function ConfirmDialog({ title, children, confirmLabel, busy, onConfirm, onClose }: {
  title: string; children: ReactNode; confirmLabel: string; busy: boolean; onConfirm: () => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const latestClose = useRef(onClose);
  latestClose.current = onClose;
  useEffect(() => {
    const el = dialog.current;
    const prior = document.activeElement as HTMLElement | null;
    el?.showModal();
    return () => { el?.close(); prior?.focus(); };
  }, []);
  return <dialog className="confirm-dialog" ref={dialog} aria-labelledby={id} onCancel={event => { event.preventDefault(); if (!busy) latestClose.current(); }}>
    <div className="dialog-icon"><AlertCircle size={24} /></div>
    <h2 id={id}>{title}</h2><div className="dialog-copy">{children}</div>
    <div className="button-row"><button className="button secondary" onClick={onClose} disabled={busy} autoFocus>Cancel</button>
      <button className="button danger" onClick={onConfirm} disabled={busy}>{busy ? <Spinner>Deleting…</Spinner> : confirmLabel}</button></div>
  </dialog>;
}
