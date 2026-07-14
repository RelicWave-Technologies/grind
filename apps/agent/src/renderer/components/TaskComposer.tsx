import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CalendarClock, X } from 'lucide-react';
import { localDateAtHour } from '../lib/workspaceTime';

function createErrorText(error: string | undefined): string | null {
  if (!error) return null;
  if (error === 'reauth_required') return 'Reconnect Lark';
  return error.replace(/^lark create task error:\s*/i, '') || 'Could not create task';
}

/**
 * Inline composer that creates a real Lark task. Calm, borderless card that
 * blends with task rows (see docs/design.md §3 Composer). Calls onCreated with
 * the new task's title so the parent can refresh + confirm.
 */
export default function TaskComposer({
  onCreated,
  timeZone,
}: {
  onCreated: (summary: string) => void;
  timeZone: string | null;
}) {
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

  const errorText = create.data && !create.data.ok ? createErrorText(create.data.error) : null;

  const submit = () => {
    const s = summary.trim();
    if (!s) return;
    if (due && !timeZone) return;
    create.mutate({
      summary: s,
      due: due && timeZone ? localDateAtHour(due, 17, timeZone) : null,
      description: desc.trim() || null,
    });
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
        <button className="btn btn-prominent no-drag" onClick={submit} disabled={create.isPending || !summary.trim() || Boolean(due && !timeZone)}>
          {create.isPending ? 'Creating…' : 'Create in Lark'}
        </button>
      </div>
      {errorText && (
        <div className="composer-error" title={create.data?.error}>
          <X size={13} strokeWidth={2.5} /> <span>{errorText}</span>
        </div>
      )}
    </div>
  );
}
