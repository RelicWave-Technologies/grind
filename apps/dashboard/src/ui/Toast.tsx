import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AlertTriangle, Check, RefreshCw, X } from 'lucide-react';
import { TimoMark } from './Mark';

/**
 * Notices are toasts in a dock at the bottom centre of the viewport, never
 * banners across the page (DESIGN.md §9 Toasts). Any screen raises one with
 * `useToast()`: a save that failed, a decision recorded, a download that broke.
 * Passing toasts leave by themselves; `standing` ones (from app state) stay
 * until it resolves. The dock's height is published as `--dock-h` so a page
 * can keep its last row clear of it.
 */
export type ToastTone = 'info' | 'wait' | 'done' | 'busy' | 'bad';

export interface Toast {
  id: string;
  tone: ToastTone;
  text: ReactNode;
  action?: { label: string; onClick: () => void; disabled?: boolean };
  onDismiss?: () => void;
}

type Raise = (toast: Omit<Toast, 'id' | 'onDismiss'> & { id?: string; ttlMs?: number }) => void;

const ToastContext = createContext<Raise>(() => {});

/** Raise a passing toast: `toast({ tone: 'done', text: 'Created in Lark' })`. */
export function useToast(): Raise {
  return useContext(ToastContext);
}

export function ToastProvider({ standing = [], children }: { standing?: Toast[]; children: ReactNode }) {
  const [passing, setPassing] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setPassing((list) => list.filter((t) => t.id !== id));
  }, []);

  const raise = useCallback<Raise>(
    ({ id, ttlMs, ...toast }) => {
      const key = id ?? `toast-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
      clearTimeout(timers.current.get(key));
      setPassing((list) => [...list.filter((t) => t.id !== key), { ...toast, id: key, onDismiss: () => dismiss(key) }]);
      // A confirmation leaves by itself; an error stays until it is dismissed.
      const ttl = ttlMs ?? (toast.tone === 'bad' ? null : 4500);
      if (ttl !== null) timers.current.set(key, setTimeout(() => dismiss(key), ttl));
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => map.forEach((t) => clearTimeout(t));
  }, []);

  const dock = useRef<HTMLDivElement>(null);
  const [dockHeight, setDockHeight] = useState(0);
  useLayoutEffect(() => {
    const el = dock.current;
    if (!el) return;
    const measure = () => setDockHeight(el.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const toasts = [...standing, ...passing];
  return (
    <ToastContext.Provider value={raise}>
      <div className="toast-host" style={{ '--dock-h': `${dockHeight}px` } as CSSProperties}>
        {children}
        <div className="toast-dock toast-dock--page" ref={dock} aria-live="polite">
          {toasts.map((t) => (
            <ToastPill key={t.id} toast={t} />
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function ToastPill({ toast }: { toast: Toast }) {
  return (
    <div className={`toast toast--${toast.tone}`} role="status">
      <span className="toast-icon" aria-hidden="true">
        {toast.tone === 'busy' ? (
          <TimoMark size={16} motion="write" tone="night" />
        ) : toast.tone === 'wait' || toast.tone === 'bad' ? (
          <AlertTriangle size={16} strokeWidth={2.2} />
        ) : toast.tone === 'done' ? (
          <Check size={16} strokeWidth={2.4} />
        ) : (
          <RefreshCw size={15} strokeWidth={2.2} />
        )}
      </span>
      <span className="toast-text">{toast.text}</span>
      {toast.action && (
        <button className="toast-action" onClick={toast.action.onClick} disabled={toast.action.disabled}>
          {toast.action.label}
        </button>
      )}
      {toast.onDismiss && (
        <button className="toast-close" onClick={toast.onDismiss} aria-label="Dismiss" title="Dismiss">
          <X size={14} strokeWidth={2.4} />
        </button>
      )}
    </div>
  );
}
