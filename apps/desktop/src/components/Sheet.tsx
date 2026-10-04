import { useEffect, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * A panel that slides over the main window: from the bottom (the task list),
 * from the right (My day) or dropped from the top (Settings). Escape and the
 * dimmed window behind it close it. Its contents mount the first time it
 * opens and then stay, so they keep their state and the slide out is never blank.
 */
export default function Sheet({
  open,
  onClose,
  side = 'center',
  title,
  actions,
  children,
}: {
  open: boolean;
  onClose: () => void;
  side?: 'center' | 'bottom' | 'right';
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <div className={`sheet-wrap sheet-wrap--${side}${open ? ' open' : ''}`} aria-hidden={!open}>
      <div className="sheet-dim" onClick={onClose} />
      <section className={`sheet sheet--${side}`} role="dialog" aria-label={title} aria-modal="true">
        <header className="sheet-head">
          <span className="sheet-title">{title}</span>
          <span className="sheet-actions">
            {actions}
            <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">
              <X size={16} strokeWidth={2} />
            </button>
          </span>
        </header>
        <div className="sheet-body">{opened && children}</div>
      </section>
    </div>
  );
}
