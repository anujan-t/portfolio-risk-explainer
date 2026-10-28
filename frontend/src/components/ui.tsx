import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { DASH, amount, currencyDigits, isNum, num, percent, roundsToZero } from '../lib/format';

export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');

// ---- Panels ------------------------------------------------------------------------

export function Panel({
  title,
  meta,
  actions,
  children,
  className,
  id,
  headingLevel = 2,
  flush,
}: {
  title?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
  headingLevel?: 2 | 3;
  flush?: boolean;
}) {
  const headingId = useId();
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section className={cx('panel', flush && 'panel--flush', className)} id={id} aria-labelledby={title ? headingId : undefined}>
      {(title || actions || meta) && (
        <header className="panel__head">
          <div className="panel__titles">
            {title && (
              <Heading className="panel__title" id={headingId}>
                {title}
              </Heading>
            )}
            {meta && <p className="panel__meta">{meta}</p>}
          </div>
          {actions && <div className="panel__actions">{actions}</div>}
        </header>
      )}
      <div className="panel__body">{children}</div>
    </section>
  );
}

/** Horizontal scroller for wide tables; becomes a focusable, labelled region only while it overflows. */
export function ScrollRegion({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    if (!node) return undefined;
    const check = () => setOverflowing(node.scrollWidth > node.clientWidth + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => observer.disconnect();
  }, [node]);
  return (
    <div
      ref={setNode}
      className={cx('table-scroll', className)}
      role={overflowing ? 'region' : undefined}
      aria-label={overflowing ? label : undefined}
      tabIndex={overflowing ? 0 : undefined}
    >
      {children}
    </div>
  );
}

// ---- Status --------------------------------------------------------------------------

type Tone = 'info' | 'warn' | 'error' | 'success';
const TONE_ICON = { info: Info, warn: TriangleAlert, error: CircleAlert, success: CircleCheck } as const;

export function Notice({
  tone = 'info',
  title,
  children,
  actions,
  onDismiss,
  live,
  className,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  onDismiss?: () => void;
  live?: boolean;
  className?: string;
}) {
  const Icon = TONE_ICON[tone];
  return (
    <div className={cx('notice', `notice--${tone}`, className)} role={live ? (tone === 'error' ? 'alert' : 'status') : undefined}>
      <Icon className="notice__icon" size={16} aria-hidden="true" />
      <div className="notice__content">
        {title && <p className="notice__title">{title}</p>}
        {children && <div className="notice__text">{children}</div>}
        {actions && <div className="notice__actions">{actions}</div>}
      </div>
      {onDismiss && (
        <button type="button" className="icon-button icon-button--small notice__dismiss" onClick={onDismiss} aria-label="Dismiss">
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function Badge({ tone = 'neutral', children, title }: { tone?: 'neutral' | 'brass' | 'up' | 'down' | 'warn'; children: ReactNode; title?: string }) {
  return (
    <span className={cx('badge', `badge--${tone}`)} title={title}>
      {children}
    </span>
  );
}

export function ExampleBadge() {
  return <Badge tone="warn">Example portfolio — hypothetical</Badge>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner" role={label ? 'status' : undefined}>
      <span className="spinner__ring" aria-hidden="true" />
      {label && <span className="sr-only">{label}</span>}
    </span>
  );
}

export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      {children && <div className="empty__text">{children}</div>}
      {action && <div className="empty__action">{action}</div>}
    </div>
  );
}

// ---- Figures -------------------------------------------------------------------------

type DeltaKind = 'percent' | 'money' | 'number' | 'points';

/** Signed change shown with ▲/▼ (never colour alone). Market tone colours gains/losses; neutral tone only shows direction. */
export function Delta({
  value,
  kind = 'percent',
  digits,
  currency = 'USD',
  tone = 'market',
  className,
  suffix,
}: {
  value: number | null | undefined;
  kind?: DeltaKind;
  digits?: number;
  currency?: string;
  tone?: 'market' | 'neutral';
  className?: string;
  suffix?: ReactNode;
}) {
  if (!isNum(value)) {
    return (
      <span className={cx('delta', 'delta--na', className)} title="Not available">
        {DASH}
        <span className="sr-only">not available</span>
      </span>
    );
  }
  const places = digits ?? (kind === 'percent' ? 2 : kind === 'money' ? currencyDigits(currency) : kind === 'points' ? 1 : 2);
  const zero = roundsToZero(value, places, kind === 'percent' || kind === 'points');
  const direction = zero ? 'flat' : value > 0 ? 'up' : 'down';
  const magnitude = Math.abs(value);
  const text =
    kind === 'percent'
      ? percent(magnitude, places)
      : kind === 'money'
        ? amount(magnitude, currency, places)
        : kind === 'points'
          ? `${num(magnitude * 100, places)} pp`
          : num(magnitude, places);
  const arrow = direction === 'up' ? '▲' : direction === 'down' ? '▼' : '';
  const spoken = direction === 'up' ? (tone === 'market' ? 'up' : 'increase') : direction === 'down' ? (tone === 'market' ? 'down' : 'decrease') : 'no change';
  return (
    <span className={cx('delta', tone === 'market' ? `delta--${direction}` : 'delta--neutral', className)}>
      {arrow && (
        <span className="delta__arrow" aria-hidden="true">
          {arrow}
        </span>
      )}
      <span className="sr-only">{spoken} </span>
      {text}
      {suffix}
    </span>
  );
}

export function TickerChip({ ticker, detail, title }: { ticker: string; detail?: ReactNode; title?: string }) {
  return (
    <span className="chip" title={title}>
      <span className="chip__ticker">{ticker}</span>
      {detail && <span className="chip__detail">{detail}</span>}
    </span>
  );
}

// ---- Tooltip ---------------------------------------------------------------------------

export function Tip({
  text,
  children,
  align = 'center',
  placement = 'above',
}: {
  text: ReactNode;
  children: (describedBy: string) => ReactNode;
  align?: 'start' | 'center' | 'end';
  placement?: 'above' | 'below';
}) {
  const id = useId();
  const host = useRef<HTMLSpanElement>(null);
  const hide = useCallback((event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === 'Escape') host.current?.classList.add('tip--dismissed');
  }, []);
  return (
    <span
      ref={host}
      className={cx('tip', `tip--${align}`, `tip--${placement}`)}
      onKeyDown={hide}
      onMouseLeave={() => host.current?.classList.remove('tip--dismissed')}
      onBlur={() => host.current?.classList.remove('tip--dismissed')}
    >
      {children(id)}
      <span role="tooltip" id={id} className="tip__bubble">
        {text}
      </span>
    </span>
  );
}

// ---- Tabs (arrow-key navigation, roving tabindex) -----------------------------------------

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  disabled?: boolean;
}

export const tabId = (base: string, id: string) => `${base}-tab-${id}`;
export const panelId = (base: string, id: string) => `${base}-panel-${id}`;

function moveFocus<T extends string>(items: { id: T; disabled?: boolean }[], current: T, key: string): T | null {
  const enabled = items.filter(item => !item.disabled);
  if (!enabled.length) return null;
  const index = enabled.findIndex(item => item.id === current);
  if (key === 'ArrowRight' || key === 'ArrowDown') return enabled[(index + 1 + enabled.length) % enabled.length].id;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return enabled[(index - 1 + enabled.length) % enabled.length].id;
  if (key === 'Home') return enabled[0].id;
  if (key === 'End') return enabled[enabled.length - 1].id;
  return null;
}

export function Tabs<T extends string>({
  label,
  items,
  value,
  onChange,
  idBase,
  className,
  size = 'normal',
}: {
  label: string;
  items: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  idBase: string;
  className?: string;
  size?: 'normal' | 'small';
}) {
  const list = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = moveFocus(items, value, event.key);
    if (next === null) return;
    event.preventDefault();
    onChange(next);
    window.requestAnimationFrame(() => list.current?.querySelector<HTMLButtonElement>(`#${CSS.escape(tabId(idBase, next))}`)?.focus());
  };
  return (
    <div ref={list} role="tablist" aria-label={label} className={cx('tabs', size === 'small' && 'tabs--small', className)} onKeyDown={onKeyDown}>
      {items.map(item => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={tabId(idBase, item.id)}
            aria-selected={selected}
            aria-controls={panelId(idBase, item.id)}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            className={cx('tabs__tab', selected && 'is-selected')}
            onClick={() => onChange(item.id)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

// ---- Segmented control (radio group semantics) ---------------------------------------------

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  describedBy,
  labelledBy,
}: {
  label?: string;
  labelledBy?: string;
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  describedBy?: string;
}) {
  const group = useRef<HTMLDivElement>(null);
  const idBase = useId();
  const items = options.map(option => ({ id: option.value, disabled: option.disabled }));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = moveFocus(items, value, event.key);
    if (next === null) return;
    event.preventDefault();
    onChange(next);
    const index = options.findIndex(option => option.value === next);
    window.requestAnimationFrame(() => group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[index]?.focus());
  };
  const focusable = options.some(option => option.value === value && !option.disabled) ? value : options.find(option => !option.disabled)?.value;
  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className="segmented"
      onKeyDown={onKeyDown}
    >
      {options.map(option => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            id={`${idBase}-${option.value}`}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={option.value === focusable ? 0 : -1}
            disabled={option.disabled}
            title={option.title}
            className={cx('segmented__option', checked && 'is-selected')}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// ---- Dialogs ---------------------------------------------------------------------------------

const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** The element that had focus plus its ancestors, so focus can land nearby if the element itself is gone. */
function focusPath(): HTMLElement[] {
  const path: HTMLElement[] = [];
  for (let node = document.activeElement; node instanceof HTMLElement && node !== document.body; node = node.parentElement) path.push(node);
  return path;
}

function restoreFocus(path: HTMLElement[]) {
  const [target] = path;
  if (!target) return;
  if (target.isConnected) {
    target.focus({ preventScroll: true });
    return;
  }
  const anchor = path.find(node => node.isConnected);
  const next = anchor?.querySelector<HTMLElement>(FOCUSABLE) ?? document.querySelector<HTMLElement>('h1[tabindex="-1"]');
  next?.focus({ preventScroll: true });
}

function useModal(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement[]>([]);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocus.current = focusPath();
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
      restoreFocus(returnFocus.current);
    }
  }, [open]);
  useEffect(() => {
    // React clears ref.current before passive cleanups run, so keep the node for unmount.
    const dialog = ref.current;
    return () => {
      if (dialog?.open) {
        dialog.close();
        restoreFocus(returnFocus.current);
      }
    };
  }, []);
  return ref;
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useModal(open);
  const titleId = useId();
  const bodyId = useId();
  return (
    <dialog
      ref={ref}
      className="dialog"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onCancel={event => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      onClick={event => {
        if (event.target === ref.current && !busy) onCancel();
      }}
    >
      {open && (
        <div className="dialog__surface">
          <h2 className="dialog__title" id={titleId}>
            {title}
          </h2>
          <div className="dialog__body" id={bodyId}>
            {children}
          </div>
          {error && (
            <Notice tone="error" live>
              {error}
            </Notice>
          )}
          <div className="dialog__actions">
            <button type="button" className="button" onClick={onCancel} disabled={busy} autoFocus>
              {cancelLabel}
            </button>
            <button type="button" className={cx('button', danger ? 'button--danger' : 'button--primary')} onClick={onConfirm} disabled={busy}>
              {busy ? <Spinner /> : null}
              {confirmLabel}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}

export function Drawer({
  open,
  onClose,
  labelledBy,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  children: ReactNode;
  className?: string;
}) {
  const ref = useModal(open);
  return (
    <dialog
      ref={ref}
      className={cx('drawer', className)}
      aria-labelledby={labelledBy}
      onCancel={event => {
        event.preventDefault();
        onClose();
      }}
      onClick={event => {
        if (event.target === ref.current) onClose();
      }}
    >
      {open && <div className="drawer__surface">{children}</div>}
    </dialog>
  );
}

// ---- Form helpers ----------------------------------------------------------------------------

export function FieldMessage({ id, tone = 'error', children }: { id?: string; tone?: 'error' | 'hint'; children: ReactNode }) {
  return (
    <p id={id} className={cx('field-message', `field-message--${tone}`)}>
      {children}
    </p>
  );
}

export function KeyValue({ items, className }: { items: { label: ReactNode; value: ReactNode }[]; className?: string }) {
  return (
    <dl className={cx('facts', className)}>
      {items.map((item, index) => (
        <div className="facts__row" key={index}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
