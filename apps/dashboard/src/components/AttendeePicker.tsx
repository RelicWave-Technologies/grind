import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Search, X, Users } from 'lucide-react';
import { usePopover } from '../lib/popover';

/**
 * Multi-select picker for tagging meeting attendees from the workspace.
 * Trigger renders the count + initials of the first 3 selected users
 * (or "+ Attendees" when empty). Popover is searchable; Enter selects;
 * clicking a selected row deselects.
 *
 * Mirrors TaskCombo's chrome (et-pop, tc-*) so the gap composer's row of
 * chips reads as one coherent picker family with Time + Task.
 */

export interface WorkspaceUser {
  id: string;
  name: string;
  email: string;
}

interface Props {
  users: WorkspaceUser[];
  selected: string[]; // user-ids
  disabled?: boolean;
  /** User-ids to exclude from the picker (typically the current user). */
  excludeIds?: string[];
  onChange: (next: string[]) => void;
  ariaLabel?: string;
}

const MAX_RESULTS = 100;

export default function AttendeePicker({
  users,
  selected,
  disabled,
  excludeIds,
  onChange,
  ariaLabel,
}: Props) {
  const pop = usePopover({ estimatedHeight: 360, onOpen: () => searchRef.current?.focus() });
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const excluded = useMemo(() => new Set(excludeIds ?? []), [excludeIds]);
  const visibleUsers = useMemo(() => users.filter((u) => !excluded.has(u.id)), [users, excluded]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q === ''
      ? visibleUsers
      : visibleUsers.filter((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
    return base.slice(0, MAX_RESULTS);
  }, [visibleUsers, query]);

  useEffect(() => {
    if (!pop.open) return;
    setQuery('');
    setActiveIdx(0);
  }, [pop.open]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  function toggle(uid: string) {
    if (selected.includes(uid)) onChange(selected.filter((x) => x !== uid));
    else onChange([...selected, uid]);
  }

  function clearAll() {
    onChange([]);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const t = results[activeIdx];
      if (t) toggle(t.id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      pop.setOpen(false);
    }
  }

  const selectedUsers = useMemo(() => {
    const byId = new Map(users.map((u) => [u.id, u]));
    return selected.map((id) => byId.get(id)).filter((u): u is WorkspaceUser => !!u);
  }, [users, selected]);

  const triggerLabel =
    selected.length === 0
      ? '+ Attendees'
      : selected.length === 1
        ? selectedUsers[0]?.name ?? '1 attendee'
        : `${selected.length} attendees`;

  if (disabled) {
    return (
      <span className="et-chip-trigger et-chip-trigger-attendees" aria-disabled="true">
        <Users size={11} strokeWidth={2.2} />
        <span className={selected.length ? 'et-chip-label' : 'et-chip-label et-chip-untracked'}>{triggerLabel}</span>
      </span>
    );
  }

  return (
    <>
      <button
        ref={pop.triggerRef as React.RefObject<HTMLButtonElement>}
        type="button"
        className="et-chip-trigger et-chip-trigger-attendees no-drag"
        aria-haspopup="listbox"
        aria-expanded={pop.open}
        aria-label={ariaLabel ?? 'Attendees'}
        title={selected.length ? selectedUsers.map((u) => u.name).join(', ') : 'Tag attendees'}
        onClick={(e) => {
          e.stopPropagation();
          pop.setOpen(!pop.open);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
            e.preventDefault();
            pop.setOpen(true);
          }
        }}
      >
        <Users size={11} strokeWidth={2.2} />
        <span className={'et-chip-label' + (selected.length === 0 ? ' et-chip-untracked' : '')}>{triggerLabel}</span>
        <ChevronDown size={11} strokeWidth={2.5} className="et-chip-caret" />
      </button>
      {pop.open &&
        createPortal(
          <div
            ref={pop.popoverRef}
            className="et-pop ap-pop"
            data-open={pop.open}
            data-flip={pop.flip}
            style={{ ...pop.popoverStyle, width: 320 }}
            role="dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '0 10px 0 6px',
                color: 'var(--label-tertiary)',
              }}
            >
              <Search size={13} strokeWidth={2} />
              <input
                ref={searchRef}
                className="tc-search"
                placeholder="Search workspace…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveIdx(0);
                }}
                onKeyDown={onKey}
                style={{ borderBottom: 'none', padding: '8px 0', margin: 0 }}
              />
              {selected.length > 0 && (
                <button type="button" className="ap-clear" onClick={clearAll} aria-label="Clear all">
                  <X size={12} strokeWidth={2.2} />
                </button>
              )}
            </div>
            <div ref={listRef} className="tc-list" role="listbox">
              {results.length === 0 ? (
                <div className="tc-empty">No matches</div>
              ) : (
                results.map((u, i) => {
                  const isSelected = selected.includes(u.id);
                  return (
                    <button
                      key={u.id}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      data-idx={i}
                      data-active={i === activeIdx ? 'true' : undefined}
                      className={'tc-item ap-row' + (isSelected ? ' is-selected' : '')}
                      onMouseEnter={() => setActiveIdx(i)}
                      onClick={() => toggle(u.id)}
                      title={u.email}
                    >
                      <span className="ap-avatar" aria-hidden>
                        {initials(u.name)}
                      </span>
                      <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: 1 }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {u.name}
                        </span>
                        <span className="ap-email small tertiary">{u.email}</span>
                      </span>
                      {isSelected && <span className="ap-check" aria-hidden>✓</span>}
                    </button>
                  );
                })
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
