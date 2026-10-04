/**
 * Parts every layout option is built from, so the options differ in structure
 * and not in how a task tile or the day ribbon is drawn.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Check, ExternalLink, LogOut, Pause, Play, RefreshCw, Search, Square, X } from 'lucide-react';
import { projectStyle } from '../../src/renderer/lib/projectStyle';
import { screenshotDataUrl } from '../bridge/screenshots';
import {
  KIND_LABEL,
  ME,
  SHIFT,
  due,
  fmtDur,
  fmtHour,
  fmtTime,
  sortedOpen,
  taskById,
  useDay,
  type Block,
  type Kind,
  type Task,
} from './model';
import './kit.css';

/* ---------- window ---------- */

export function Window({ width, height, className = '', children }: { width: number; height: number; className?: string; children: ReactNode }) {
  return (
    <div className={`lx-window ${className}`} style={{ width, height }}>
      {children}
    </div>
  );
}

export function Lights({ style }: { style?: CSSProperties }) {
  return (
    <span className="lx-lights" style={style} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

/* ---------- small pieces ---------- */

export function TaskMark({ task, size = 32 }: { task: Task; size?: number }) {
  const st = projectStyle(task.guid);
  const Icon = st.icon;
  return (
    <span className="lx-mark" style={{ width: size, height: size, background: st.color, borderRadius: Math.round(size * 0.3) }}>
      <Icon size={Math.round(size * 0.5)} strokeWidth={1.9} />
    </span>
  );
}

export function Swatch({ task }: { task: Task }) {
  return <span className="lx-swatch" style={{ background: projectStyle(task.guid).color }} />;
}

export function DueChip({ task, quiet = false }: { task: Task; quiet?: boolean }) {
  const d = due(task);
  if (!d) return null;
  return <span className={`lx-due lx-due--${d.tone}${quiet ? ' lx-due--quiet' : ''}`}>{d.label}</span>;
}

export function Avatar({ size = 28 }: { size?: number }) {
  return (
    <span className="lx-avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}>
      {ME.initials}
    </span>
  );
}

export function LiveDot({ paused = false }: { paused?: boolean }) {
  return <span className={`lx-live${paused ? ' lx-live--paused' : ''}`} />;
}

/* ---------- the day ribbon ---------- */

export function Ribbon({
  from = 8 * 60,
  to = 19 * 60,
  height = 24,
  labels = true,
  every = 1,
  shift = true,
  bare = false,
}: {
  from?: number;
  to?: number;
  height?: number;
  labels?: boolean;
  every?: number;
  shift?: boolean;
  /** No track, no radius: a thin strip, e.g. the top edge of a dock. */
  bare?: boolean;
}) {
  const day = useDay();
  const span = to - from;
  const pct = (m: number) => `${((Math.min(Math.max(m, from), to) - from) / span) * 100}%`;
  const width = (b: Block) => `${(Math.max(0, Math.min(b.end ?? day.now, to) - Math.max(b.start, from)) / span) * 100}%`;
  const hours: number[] = [];
  for (let hr = Math.ceil(from / 60); hr * 60 <= to; hr += every) hours.push(hr);

  return (
    <div className={`lx-ribbon${bare ? ' lx-ribbon--bare' : ''}`}>
      {shift && !bare && (
        <div className="lx-ribbon-shift" style={{ left: pct(SHIFT.start), width: `calc(${pct(SHIFT.end)} - ${pct(SHIFT.start)})` }}>
          <span>{SHIFT.label}</span>
        </div>
      )}
      <div className="lx-ribbon-track" style={{ height }}>
        {day.blocks.map((b, i) => (
          <span
            key={`${b.entry}-${i}`}
            className={`lx-rb lx-rb--${b.kind}${b.end === null ? ' lx-rb--live' : ''}`}
            style={{ left: pct(b.start), width: width(b) }}
            title={`${KIND_LABEL[b.kind]} · ${taskById(b.task).summary} · ${fmtTime(b.start)}–${fmtTime(b.end ?? day.now)}`}
          />
        ))}
        <span className="lx-ribbon-now" style={{ left: pct(day.now) }} />
      </div>
      {labels && (
        <div className="lx-ribbon-hours">
          {hours.map((hr) => (
            <span key={hr} style={{ left: pct(hr * 60) }}>
              {fmtHour(hr)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function Legend({ kinds = ['work', 'meeting', 'manual', 'pending', 'idle'] }: { kinds?: Kind[] }) {
  return (
    <span className="lx-legend">
      {kinds.map((k) => (
        <span key={k}>
          <i className={`lx-rb--${k}`} />
          {KIND_LABEL[k]}
        </span>
      ))}
    </span>
  );
}

/** Tracked share of each hour, on the same axis as a Ribbon with the same from/to. */
export function HourBars({ from = 8, to = 19, height = 64, labels = false }: { from?: number; to?: number; height?: number; labels?: boolean }) {
  const day = useDay();
  const hours = Array.from({ length: to - from }, (_, i) => from + i);
  const nowHour = Math.floor(day.now / 60);
  return (
    <div className="lx-bars">
      <div className="lx-bars-plot" style={{ height }}>
        {hours.map((hr) => {
          const v = day.activityByHour[hr] ?? 0;
          return (
            <span key={hr} className="lx-bar-slot" title={`${fmtHour(hr)} · ${Math.round(v * 100)}% active`}>
              <span className={`lx-bar${hr === nowHour ? ' lx-bar--now' : ''}${v === 0 ? ' lx-bar--empty' : ''}`} style={{ height: `${Math.max(v * 100, 3)}%` }} />
            </span>
          );
        })}
      </div>
      {labels && (
        <div className="lx-bars-labels">
          {hours.map((hr) => (
            <span key={hr}>{hr % 2 === 0 ? fmtHour(hr) : ''}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- the day as a list ---------- */

/** Today's entries, newest first, idle folded into the entry it trimmed. */
export function useEntries() {
  const day = useDay();
  const byEntry = new Map<string, { task: Task; kind: Kind; start: number; end: number | null; idle: number }>();
  for (const b of day.blocks) {
    const cur = byEntry.get(b.entry);
    const end = b.end;
    if (!cur) {
      byEntry.set(b.entry, { task: taskById(b.task), kind: b.kind === 'idle' ? 'work' : b.kind, start: b.start, end, idle: b.kind === 'idle' ? (end ?? day.now) - b.start : 0 });
    } else {
      cur.end = end;
      if (b.kind === 'idle') cur.idle += (end ?? day.now) - b.start;
    }
  }
  return [...byEntry.values()]
    .map((e) => ({ ...e, minutes: (e.end ?? day.now) - e.start - e.idle }))
    .sort((a, b) => b.start - a.start);
}

export function EntryLog({ limit }: { limit?: number }) {
  const day = useDay();
  const entries = useEntries();
  const shown = limit ? entries.slice(0, limit) : entries;
  return (
    <div className="lx-log">
      {shown.map((e) => (
        <div key={`${e.start}`} className="lx-log-row">
          <span className="lx-log-time">
            {fmtTime(e.start, false)}–{e.end === null ? 'now' : fmtTime(e.end, false)}
          </span>
          <i className={`lx-log-kind lx-rb--${e.kind}`} />
          <span className="lx-log-task">
            <span className="lx-log-title">{e.task.summary}</span>
            <span className="lx-log-sub">
              {e.end === null && day.mode === 'running' ? 'Tracking now' : KIND_LABEL[e.kind]}
              {e.idle > 0 ? ` · ${fmtDur(e.idle)} idle trimmed` : ''}
              {e.kind === 'pending' ? ' · waiting for approval' : ''}
            </span>
          </span>
          <span className="lx-log-dur">{fmtDur(e.minutes)}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------- screenshots ---------- */

export function useShots(count: number) {
  const day = useDay();
  const latest = Math.floor(day.now / 3) * 3;
  return Array.from({ length: count }, (_, i) => {
    const at = latest - i * 3 - (i > 5 ? 17 : 0);
    return { id: `shot-${Math.round(at)}`, at, src: screenshotDataUrl(`lx-${Math.round(at)}`) };
  });
}

export function ShotGrid({ count, columns }: { count: number; columns: number }) {
  const shots = useShots(count);
  return (
    <div className="lx-shots" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {shots.map((s) => (
        <figure key={s.id} className="lx-shot">
          <img src={s.src} alt="" />
          <figcaption>{fmtTime(s.at)}</figcaption>
        </figure>
      ))}
    </div>
  );
}

/* ---------- settings ---------- */

function Toggle({ on: initial }: { on: boolean }) {
  const [on, setOn] = useState(initial);
  return <button type="button" className={`lx-toggle${on ? ' on' : ''}`} onClick={() => setOn((v) => !v)} aria-pressed={on} />;
}

export function SettingsBody() {
  return (
    <div className="lx-settings">
      <SettingsGroup title="Permissions">
        <SettingsRow title="Screen Recording" note="Needed for screenshots" end={<span className="lx-ok"><Check size={13} strokeWidth={2.4} /> Allowed</span>} />
        <SettingsRow title="Accessibility" note="Counts keys and clicks, never what you type" end={<span className="lx-ok"><Check size={13} strokeWidth={2.4} /> Allowed</span>} />
      </SettingsGroup>
      <SettingsGroup title="Lark">
        <SettingsRow title="Connected as Aarav Mehta" note="Tasks, meetings and approvals come from Lark" end={<button className="lx-btn lx-btn--sm">Disconnect</button>} />
      </SettingsGroup>
      <SettingsGroup title="General">
        <SettingsRow title="Open Timo at login" end={<Toggle on />} />
        <SettingsRow title="Show the floating bar while tracking" end={<Toggle on />} />
      </SettingsGroup>
      <SettingsGroup title="About">
        <SettingsRow title="Timo 0.0.2-beta.38" note="Up to date" end={<button className="lx-btn lx-btn--sm"><RefreshCw size={13} /> Check</button>} />
      </SettingsGroup>
    </div>
  );
}

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="lx-set-group">
      <h4>{title}</h4>
      <div className="lx-set-card">{children}</div>
    </section>
  );
}

function SettingsRow({ title, note, end }: { title: string; note?: string; end: ReactNode }) {
  return (
    <div className="lx-set-row">
      <span>
        <span className="lx-set-title">{title}</span>
        {note && <span className="lx-set-note">{note}</span>}
      </span>
      {end}
    </div>
  );
}

/* ---------- overlays inside a window ---------- */

export function Sheet({
  open,
  onClose,
  side = 'center',
  title,
  children,
  width,
}: {
  open: boolean;
  onClose: () => void;
  side?: 'center' | 'bottom' | 'right';
  title: string;
  children: ReactNode;
  width?: number;
}) {
  return (
    <div className={`lx-sheet-wrap lx-sheet-wrap--${side}${open ? ' open' : ''}`} aria-hidden={!open}>
      <div className="lx-sheet-dim" onClick={onClose} />
      <div className={`lx-sheet lx-sheet--${side}`} style={width ? { width } : undefined} role="dialog" aria-label={title}>
        <div className="lx-sheet-head">
          <span className="lx-sheet-title">{title}</span>
          <button className="lx-icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="lx-sheet-body">{children}</div>
      </div>
    </div>
  );
}

/** The account button and its menu: web dashboard and sign out live here in every option. */
export function AccountMenu({ size = 28, align = 'right' }: { size?: number; align?: 'right' | 'left' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <span className="lx-account" ref={ref}>
      <button className="lx-account-btn" onClick={() => setOpen((v) => !v)} aria-label="Account">
        <Avatar size={size} />
      </button>
      {open && (
        <div className={`lx-menu lx-menu--${align}`}>
          <div className="lx-menu-who">
            <span className="lx-menu-name">{ME.name}</span>
            <span className="lx-menu-mail">{ME.email}</span>
          </div>
          <button className="lx-menu-item"><ExternalLink size={14} /> Open web dashboard</button>
          <button className="lx-menu-item"><LogOut size={14} /> Sign out</button>
        </div>
      )}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="lx-kbd">{children}</kbd>;
}

/* ---------- timer controls ---------- */

export function useStatus(): { text: string; tone: 'live' | 'paused' | 'off' } {
  const day = useDay();
  const last = Math.max(...day.blocks.map((b) => b.end ?? day.now));
  if (day.mode === 'running') return { text: `Tracking since ${fmtTime(day.since ?? day.now)}`, tone: 'live' };
  if (day.mode === 'paused') return { text: `Paused at ${fmtTime(last)}`, tone: 'paused' };
  return { text: `Stopped at ${fmtTime(last)}`, tone: 'off' };
}

/** Pause + stop while tracking, resume + stop while paused, start when stopped. */
export function Transport({ size = 44, labels = false }: { size?: number; labels?: boolean }) {
  const day = useDay();
  const icon = Math.round(size * 0.36);
  const btn = (kind: 'pause' | 'resume' | 'stop' | 'start') => {
    const cls = kind === 'stop' ? 'lx-round--ink' : kind === 'pause' ? '' : 'lx-round--primary';
    const label = kind === 'pause' ? 'Pause' : kind === 'resume' ? 'Resume' : kind === 'stop' ? 'Stop' : 'Start';
    const onClick = kind === 'pause' ? day.pause : kind === 'resume' ? day.resume : kind === 'stop' ? day.stop : () => day.start(day.task.guid);
    const glyph = kind === 'pause' ? <Pause size={icon} fill="currentColor" strokeWidth={0} /> : kind === 'stop' ? <Square size={icon - 2} fill="currentColor" strokeWidth={0} /> : <Play size={icon} fill="currentColor" strokeWidth={0} style={{ marginLeft: 2 }} />;
    if (labels) {
      return (
        <button key={kind} className={`lx-btn lx-btn--lg lx-transport-btn ${kind === 'stop' ? 'lx-btn--ink' : kind === 'pause' ? '' : 'lx-btn--primary'}`} onClick={onClick}>
          {glyph} {label}
        </button>
      );
    }
    return (
      <button key={kind} className={`lx-round ${cls}`} style={{ width: size, height: size }} onClick={onClick} aria-label={label} title={label}>
        {glyph}
      </button>
    );
  };
  const kinds: ('pause' | 'resume' | 'stop' | 'start')[] = day.mode === 'running' ? ['pause', 'stop'] : day.mode === 'paused' ? ['resume', 'stop'] : ['start'];
  return <span className="lx-transport">{kinds.map(btn)}</span>;
}

/** The current task as a button that opens a searchable list; picking one starts it. */
export function TaskPicker({ children, align = 'left', width = 380, up = false }: { children: ReactNode; align?: 'left' | 'right' | 'center'; width?: number; up?: boolean }) {
  const day = useDay();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  const q = query.trim().toLowerCase();
  const tasks = sortedOpen(day.task.guid).filter((t) => q === '' || t.summary.toLowerCase().includes(q));
  return (
    <span className="lx-picker" ref={ref}>
      <button className="lx-picker-trigger" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {children}
      </button>
      {open && (
        <div className={`lx-picker-menu lx-picker-menu--${align}${up ? ' lx-picker-menu--up' : ''}`} style={{ width }}>
          <div className="lx-search lx-picker-search">
            <Search size={14} />
            <input autoFocus placeholder="Switch to…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="lx-picker-list lx-scroll">
            {tasks.map((t) => (
              <button
                key={t.guid}
                className={`lx-picker-item${t.guid === day.task.guid ? ' on' : ''}`}
                onClick={() => {
                  if (t.guid !== day.task.guid || day.mode === 'idle') day.start(t.guid);
                  setOpen(false);
                  setQuery('');
                }}
              >
                <Swatch task={t} />
                <span className="lx-picker-name">{t.summary}</span>
                {t.guid === day.task.guid && day.mode !== 'idle' ? <Check size={14} /> : <DueChip task={t} quiet />}
              </button>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}

export function Eq({ still = false }: { still?: boolean }) {
  return (
    <span className={`lx-eq${still ? ' lx-eq--still' : ''}`} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
