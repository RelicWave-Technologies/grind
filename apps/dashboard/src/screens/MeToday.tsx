import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouteContext } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, Calendar } from 'lucide-react';
import { api } from '../lib/api';
import { isManagerOrAbove } from '../lib/auth';
import type { DayInsight } from '../lib/types';
import { fmtDayLabel, todayKey, addDays } from '../lib/format';
import { DayRibbon } from '../components/DayRibbon';
import { EntriesTable } from '../components/EntriesTable';

interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER';
}

/**
 * Browser-side My Day timesheet. Calls /v1/insights/day, renders the
 * day ribbon + entries table. For MANAGER+, includes a user picker so
 * the same view is reused for "Mira's Tuesday".
 */
export function MeTodayScreen() {
  const { me } = useRouteContext({ from: '/authed' });
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  const [date, setDate] = useState<string>(todayKey());
  const [targetUserId, setTargetUserId] = useState<string>(me.id);
  const showPicker = isManagerOrAbove(me.role);

  // For the picker — only fetch when we'll show the picker.
  const usersQ = useQuery({
    queryKey: ['admin', 'users'],
    enabled: showPicker,
    queryFn: () => api<{ users: AdminUser[] }>('/v1/admin/users'),
  });

  const dayQ = useQuery({
    queryKey: ['insights', 'day', date, tz, targetUserId],
    queryFn: () => {
      const params = new URLSearchParams({ date, tz });
      // Only ship userId when we're viewing someone else — keeps the
      // self path identical to the agent's call.
      if (targetUserId !== me.id) params.set('userId', targetUserId);
      return api<DayInsight>(`/v1/insights/day?${params.toString()}`);
    },
  });

  const now = Date.now();
  const targetUser: AdminUser | undefined = useMemo(() => {
    if (targetUserId === me.id) {
      return { id: me.id, name: me.name, email: me.email, role: me.role };
    }
    return usersQ.data?.users.find((u) => u.id === targetUserId);
  }, [targetUserId, usersQ.data, me]);

  return (
    <div className="page page-wide">
      <header className="page-head">
        <div>
          <h1 className="h1">
            {targetUser ? (targetUser.id === me.id ? 'My Day' : `${targetUser.name.split(' ')[0]}'s Day`) : 'Day'}
          </h1>
          <p className="secondary page-sub">
            {fmtDayLabel(date)} ·{' '}
            <span className="tabular">{date}</span> · {tz}
          </p>
        </div>

        <div className="day-controls">
          {showPicker && usersQ.data && (
            <select
              className="select"
              value={targetUserId}
              onChange={(e) => setTargetUserId(e.target.value)}
              aria-label="View someone's day"
            >
              {[...usersQ.data.users]
                .sort((a, b) => {
                  if (a.id === me.id) return -1;
                  if (b.id === me.id) return 1;
                  return a.name.localeCompare(b.name);
                })
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.id === me.id ? `${u.name} (you)` : `${u.name} · ${u.role.toLowerCase()}`}
                  </option>
                ))}
            </select>
          )}

          <div className="date-nav">
            <button
              type="button"
              className="btn-icon"
              onClick={() => setDate((d) => addDays(d, -1))}
              aria-label="Previous day"
            >
              <ChevronLeft size={16} strokeWidth={2} />
            </button>
            <button
              type="button"
              className={`btn-ghost date-pill${date === todayKey() ? ' is-today' : ''}`}
              onClick={() => setDate(todayKey())}
            >
              <Calendar size={13} strokeWidth={1.8} />
              <span>{date === todayKey() ? 'Today' : fmtDayLabel(date)}</span>
            </button>
            <button
              type="button"
              className="btn-icon"
              onClick={() => setDate((d) => addDays(d, 1))}
              aria-label="Next day"
              disabled={date === todayKey()}
            >
              <ChevronRight size={16} strokeWidth={2} />
            </button>
          </div>
        </div>
      </header>

      {dayQ.isLoading && <div className="card empty">Loading…</div>}
      {dayQ.isError && (
        <div className="card empty empty-error">
          Couldn&apos;t load this day: {(dayQ.error as Error).message}
        </div>
      )}

      {dayQ.data && (
        <>
          <section className="card ribbon-card">
            <DayRibbon day={dayQ.data} now={now} />
            <div className="ribbon-legend">
              <Legend className="dot-work" label="Tracked" />
              <Legend className="dot-meeting" label="Meeting" />
              <Legend className="dot-manual" label="Manual" />
              <Legend className="dot-pending" label="Pending" />
              <Legend className="dot-idle" label="Idle (trimmed)" />
            </div>
          </section>

          <EntriesTable day={dayQ.data} />
        </>
      )}
    </div>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="legend-item">
      <span className={`legend-dot ${className}`} />
      <span className="callout secondary">{label}</span>
    </span>
  );
}
