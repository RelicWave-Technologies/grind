import { useEffect, useId, useRef, useState } from 'react';
import { cloneElement, isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { cx } from './util';
import type { Status } from './util';

/* §5.16 Popover / Menu / Toast — the only components that use --ui-shadow-pop.
   Dropdowns, action menus, select menus, transient toasts. */

export interface PopoverProps {
  /** The trigger element; receives onClick + aria wiring. */
  trigger: ReactElement;
  children: ReactNode;
  className?: string;
}

export function Popover({ trigger, children, className }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const triggerNode = isValidElement(trigger)
    ? cloneElement(trigger as ReactElement<Record<string, unknown>>, {
        onClick: (e: React.MouseEvent) => {
          (trigger.props as { onClick?: (e: React.MouseEvent) => void }).onClick?.(e);
          setOpen((v) => !v);
        },
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': open ? panelId : undefined,
      })
    : trigger;

  return (
    <div className="ui-popover-wrap" ref={wrapRef}>
      {triggerNode}
      {open && (
        <div id={panelId} className={cx('ui-popover', className)} role="menu">
          {children}
        </div>
      )}
    </div>
  );
}

export interface MenuItemSpec {
  label: ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
}

export interface MenuProps {
  items: ReadonlyArray<MenuItemSpec>;
  className?: string;
}

export function Menu({ items, className }: MenuProps) {
  return (
    <div className={cx('ui-menu', className)}>
      {items.map((it, i) => (
        <button
          key={i}
          type="button"
          role="menuitem"
          className={cx('ui-menu-item', it.danger && 'ui-menu-item--danger')}
          disabled={it.disabled}
          onClick={it.onSelect}
        >
          {it.icon != null && <span className="ui-btn__icon" aria-hidden>{it.icon}</span>}
          {it.label}
        </button>
      ))}
    </div>
  );
}

/* §5.16 Modal — the kit's one centered overlay.

   SYSTEM.md already specified the shape ("modals reuse the popover chrome
   centered over the scrim") but no component existed, so pages were solving it
   privately: Users renders its invite form inline, Payroll built a bespoke
   drawer in payroll.css. This is that component, so the next page does not
   invent a third one. */
export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  /** Footer actions, right-aligned. Compose kit Buttons. */
  actions?: ReactNode;
  children?: ReactNode;
}

export function Modal({ open, onClose, title, description, actions, children }: ModalProps) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // A dialog that leaves the page scrolling behind it reads as a card that
    // happens to float; locking makes it a mode.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="ui-modal-layer"
      onMouseDown={(e) => {
        // Only a press that both starts AND ends on the scrim dismisses, so a
        // drag that happens to finish outside the panel does not close it.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="ui-modal"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
      >
        <div className="ui-modal__head">
          <h2 className="ui-modal__title ui-t-title">{title}</h2>
          {description != null && <p className="ui-modal__desc ui-t-small">{description}</p>}
        </div>
        <div className="ui-modal__body">{children}</div>
        {actions != null && <div className="ui-modal__foot">{actions}</div>}
      </div>
    </div>
  );
}

export interface ToastProps extends React.HTMLAttributes<HTMLDivElement> {
  status?: Status;
  children: ReactNode;
}

export function Toast({ status = 'neutral', className, children, ...rest }: ToastProps) {
  return (
    <div className={cx('ui-toast', `ui-toast--${status}`, className)} role="status" {...rest}>
      {children}
    </div>
  );
}
