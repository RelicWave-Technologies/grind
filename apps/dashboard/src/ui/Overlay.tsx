import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

/* §5.16 Modal — the kit's one centered overlay.

   SYSTEM.md already specified the shape ("modals reuse the popover chrome
   centered over the scrim") but no component existed, so pages were solving it
   privately: Users renders its invite form inline. This is that component, so
   the next page does not invent another one. */
export interface ModalProps {
  /** 'lg' for forms with several fields side by side (640px). */
  size?: 'md' | 'lg';
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  /** Footer actions, right-aligned. Compose kit Buttons. */
  actions?: ReactNode;
  children?: ReactNode;
}

export function Modal({ open, onClose, title, description, actions, size, children }: ModalProps) {
  /**
   * Whether the press that is currently in flight began on the scrim.
   *
   * Closing on mousedown alone is too eager: a native control rendered over the
   * dialog — the date picker is the obvious one — can put a mousedown on the
   * scrim while the person is only picking a date, and the dialog vanishes
   * under them. A dismissal has to be a press AND a release on the scrim, with
   * nothing in between.
   */
  const pressedScrim = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  // onClose is often an inline arrow; keep the latest without re-running the
  // focus effect (which would steal focus back on every render).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  /**
   * Focus belongs to the dialog while it is open: it moves in on open (unless a
   * field inside already took it with autoFocus), Tab cycles inside, and it goes
   * back to whatever opened the dialog on close. Without this, keys typed after
   * opening still land in the page behind — a search box there filled up while
   * someone typed into the dialog.
   */
  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement as HTMLElement | null;
    const box = dialog.current;
    const focusables = () =>
      box
        ? Array.from(box.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          )).filter((el) => !el.hasAttribute('hidden') && el.offsetParent !== null)
        : [];
    if (box && !box.contains(document.activeElement)) {
      // Prefer the first field; a dialog of only buttons starts on the dialog itself
      // so Enter does not fire the destructive one by accident.
      const field = focusables().find((el) => /^(INPUT|SELECT|TEXTAREA)$/u.test(el.tagName) || el.getAttribute('role') === 'combobox');
      (field ?? box).focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !box) return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !box.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !box.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    // A dialog that leaves the page scrolling behind it reads as a card that
    // happens to float; locking makes it a mode.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  /**
   * Rendered into <body>, not in place.
   *
   * `.ui-page` animates a transform, and a transformed ancestor becomes the
   * containing block for `position: fixed` descendants — so a scrim with
   * `inset: 0` sized itself to the page column instead of the viewport and
   * covered only part of the screen. A portal is the fix that survives whatever
   * a page does to its own layout.
   */
  return createPortal(
    <div
      className="ui-modal-layer"
      onMouseDown={(e) => {
        pressedScrim.current = e.target === e.currentTarget;
      }}
      onMouseUp={(e) => {
        const dismiss = pressedScrim.current && e.target === e.currentTarget;
        pressedScrim.current = false;
        if (dismiss) onClose();
      }}
    >
      <div
        ref={dialog}
        tabIndex={-1}
        className={size === 'lg' ? 'ui-modal ui-modal--lg' : 'ui-modal'}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
      >
        <div className="ui-modal__head">
          <h2 className="ui-modal__title ui-t-title">{title}</h2>
          {description != null && <p className="ui-modal__desc ui-t-small">{description}</p>}
        </div>
        {children != null && children !== false && <div className="ui-modal__body">{children}</div>}
        {actions != null && <div className="ui-modal__foot">{actions}</div>}
      </div>
    </div>,
    document.body,
  );
}
