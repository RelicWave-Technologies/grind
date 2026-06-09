import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Search } from 'lucide-react';
import { usePopover } from '../lib/popover';

/**
 * Searchable Lark task picker. Trigger is an on-brand chip showing the
 * selected task (or "— Untracked —"). Click opens a floating popover with
 * an auto-focused search input + a filtered list. Up arrow / Down arrow
 * navigate; Enter selects; Esc dismisses.
 *
 * The "— Untracked —" sentinel is always at the top so users can clear an
 * attribution with one keypress (Esc + open + Enter). Results are capped
 * at 50 to keep rendering snappy even when a user has hundreds of tasks.
 */

export interface TaskOption {
  guid: string;
  summary: string;
}

interface Props {
  tasks: TaskOption[];
  value: string; // guid or ''
  disabled?: boolean;
  onChange: (guid: string) => void;
  ariaLabel?: string;
}

const UNTRACKED: TaskOption = { guid: '', summary: '— Untracked —' };
const MAX_RESULTS = 50;

export default function TaskCombo({ tasks, value, disabled, onChange, ariaLabel }: Props) {
  const pop = usePopover({ estimatedHeight: 320, onOpen: () => searchRef.current?.focus() });
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => tasks.find((t) => t.guid === value), [tasks, value]);
  const selectedLabel = selected?.summary ?? null;

  // Filtered + capped results, with the Untracked sentinel pinned to the top.
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q === '' ? tasks : tasks.filter((t) => t.summary.toLowerCase().includes(q));
    const capped = base.slice(0, MAX_RESULTS);
    return [UNTRACKED, ...capped];
  }, [tasks, query]);

  // Reset state every time we open (clean slate).
  useEffect(() => {
    if (!pop.open) return;
    setQuery('');
    setActiveIdx(0);
  }, [pop.open]);

  // Keep the active item visible.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  function pick(t: TaskOption): void {
    onChange(t.guid);
    pop.setOpen(false);
  }

  function onKey(e: React.KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const t = results[activeIdx];
      if (t) pick(t);
    }
  }

  if (disabled) {
    return (
      <span className="et-chip-trigger et-chip-trigger-task" aria-disabled="true">
        <span className={'et-chip-label' + (selectedLabel ? '' : ' et-chip-untracked')}>
          {selectedLabel ?? UNTRACKED.summary}
        </span>
      </span>
    );
  }

  return (
    <>
      <button
        ref={pop.triggerRef as React.RefObject<HTMLButtonElement>}
        type="button"
        className="et-chip-trigger et-chip-trigger-task no-drag"
        aria-haspopup="listbox"
        aria-expanded={pop.open}
        aria-label={ariaLabel ?? 'Task'}
        title={selectedLabel ?? undefined}
        onClick={(e) => { e.stopPropagation(); pop.setOpen(!pop.open); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
            e.preventDefault();
            pop.setOpen(true);
          }
        }}
      >
        <span className={'et-chip-label' + (selectedLabel ? '' : ' et-chip-untracked')}>
          {selectedLabel ?? UNTRACKED.summary}
        </span>
        <ChevronDown size={11} strokeWidth={2.5} className="et-chip-caret" />
      </button>
      {pop.open && createPortal(
        <div
          ref={pop.popoverRef}
          className="et-pop"
          data-open={pop.open}
          data-flip={pop.flip}
          style={pop.popoverStyle}
          role="dialog"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="tc-search-row">
            <Search size={13} strokeWidth={2} />
            <input
              ref={searchRef}
              className="tc-search"
              placeholder="Search tasks…"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
              onKeyDown={onKey}
              aria-controls="task-combo-listbox"
              aria-activedescendant={`task-combo-opt-${activeIdx}`}
            />
          </div>
          <div id="task-combo-listbox" ref={listRef} className="tc-list" role="listbox">
            {results.length === 0 ? (
              <div className="tc-empty">No matching tasks</div>
            ) : results.map((t, i) => (
              <button
                key={t.guid || '__untracked__'}
                id={`task-combo-opt-${i}`}
                type="button"
                role="option"
                data-idx={i}
                aria-selected={t.guid === value}
                data-active={i === activeIdx ? 'true' : undefined}
                className={'tc-item' + (t === UNTRACKED ? ' tc-item-untracked' : '')}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => pick(t)}
                title={t.summary}
              >
                <span className="tc-item-label">{t.summary}</span>
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
