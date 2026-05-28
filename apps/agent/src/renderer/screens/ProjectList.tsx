import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TimerStatus } from '../lib/agent.d';

function fmtDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

export default function ProjectList() {
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => window.agent.projects.list() });
  const [timer, setTimer] = useState<TimerStatus>({ state: 'IDLE' });

  // Seed initial status + subscribe to 1s ticks pushed from main.
  useEffect(() => {
    let alive = true;
    void window.agent.timer.status().then((s) => alive && setTimer(s));
    const off = window.agent.timer.onStatusChange((s) => setTimer(s));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const start = useMutation({
    mutationFn: (projectId: string) => window.agent.timer.start(projectId),
    onSuccess: (s) => setTimer(s),
  });
  const stop = useMutation({
    mutationFn: () => window.agent.timer.stop(),
    onSuccess: (s) => setTimer(s),
  });
  const logout = useMutation({
    mutationFn: () => window.agent.auth.logout(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['authStatus'] }),
  });

  const runningProject =
    timer.state === 'RUNNING' ? projects.data?.find((p) => p.id === timer.projectId) : undefined;

  return (
    <div className="app">
      <div className="header">
        <span>Grind</span>
        <span className="badge">{timer.state === 'RUNNING' ? '● tracking' : 'idle'}</span>
      </div>

      {timer.state === 'RUNNING' ? (
        <div className="list" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24 }}>
          <div className="muted">{runningProject?.name ?? timer.projectId}</div>
          <div style={{ fontSize: 34, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
            {fmtDuration(timer.workedMs)}
          </div>
          <button className="no-drag" style={{ maxWidth: 160 }} onClick={() => stop.mutate()} disabled={stop.isPending}>
            {stop.isPending ? 'Stopping…' : 'Stop'}
          </button>
        </div>
      ) : (
        <>
          <div className="muted">Pick a project to start tracking:</div>
          {projects.isLoading && <div className="muted">Loading projects…</div>}
          {projects.error && <div className="error">Failed: {(projects.error as Error).message}</div>}
          <div className="list">
            {projects.data?.map((p) => (
              <button
                key={p.id}
                className="list-item no-drag"
                style={{ width: '100%', textAlign: 'left', background: 'transparent', color: 'inherit', borderRadius: 0 }}
                onClick={() => start.mutate(p.id)}
                disabled={start.isPending}
              >
                <div className="name">{p.name}</div>
                <div className="sub">tap to start</div>
              </button>
            ))}
          </div>
          {start.error && <div className="error">{(start.error as Error).message}</div>}
        </>
      )}

      <button className="secondary no-drag" onClick={() => logout.mutate()} disabled={logout.isPending}>
        {logout.isPending ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  );
}
