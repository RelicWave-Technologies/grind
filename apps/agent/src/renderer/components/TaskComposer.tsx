import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CalendarClock, X } from 'lucide-react';

/**
 * Inline composer that creates a real Lark task. Calm, borderless card that
 * blends with task rows (see docs/design.md §3 Composer). Calls onCreated with
 * the new task's title so the parent can refresh + confirm.
 */
export default function TaskComposer({ onCreated }: { onCreated: (summary: string) => void }) {
  const [summary, setSummary] = useState('');
  const [due, setDue] = useState('');
  const [desc, setDesc] = useState('');

  const create = useMutation({
    mutationFn: (input: { summary: string; due?: number | null; description?: string | null }) =>
      window.agent.lark.createTask(input),
    onSuccess: (r, vars) => {
      if (r.ok) {
        setSummary('');
        setDue('');
        setDesc('');
        onCreated(vars.summary);
      }
    },
  });

  const errorText = create.data && !create.data.ok
    ? create.data.error === 'reauth_required'
      ? 'Reconnect Lark'
      : 'Failed'
    : null;

  const submit = () => {
    const s = summary.trim();
    if (!s) return;
    create.mutate({ summary: s, due: due ? new Date(`${due}T17:00:00`).getTime() : null, description: desc.trim() || null });
  };

  return (
    <div className="composer rise rise-1">
      <input
        className="composer-title no-drag"
        type="text"
        placeholder="New task…"
        value={summary}
        autoFocus
        onChange={(e) => setSummary(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || !desc)) submit(); }}
      />
      <textarea
        className="composer-note no-drag"
        placeholder="Add details (optional)"
        rows={2}
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
      />
      <div className="composer-foot">
        <label className="composer-due no-drag" title="Due date">
          <CalendarClock size={15} strokeWidth={2} />
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
        <span className="composer-spacer" />
        {errorText && (
          <span className="composer-error"><X size={13} strokeWidth={2.5} /> {errorText}</span>
        )}
        <button className="btn btn-prominent no-drag" onClick={submit} disabled={create.isPending || !summary.trim()}>
          {create.isPending ? 'Creating…' : 'Create in Lark'}
        </button>
      </div>
    </div>
  );
}
