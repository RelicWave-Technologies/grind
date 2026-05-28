import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export default function ProjectList() {
  const qc = useQueryClient();
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => window.agent.projects.list(),
  });

  const [status, setStatus] = useState<{ state: string; lastHeartbeatAt: string | null }>({
    state: 'IDLE',
    lastHeartbeatAt: null,
  });

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const s = await window.agent.agent.status();
      if (alive) setStatus(s);
    };
    void tick();
    const id = setInterval(tick, 5_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const logout = useMutation({
    mutationFn: () => window.agent.auth.logout(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['authStatus'] });
    },
  });

  return (
    <div className="app">
      <div className="header">
        <span>Grind</span>
        <span className="badge">{status.state}</span>
      </div>

      {projects.isLoading && <div className="muted">Loading projects…</div>}
      {projects.error && (
        <div className="error">Failed to load: {(projects.error as Error).message}</div>
      )}

      {projects.data && (
        <div className="list">
          {projects.data.length === 0 ? (
            <div className="list-item">
              <div className="muted">No projects yet.</div>
            </div>
          ) : (
            projects.data.map((p) => (
              <div key={p.id} className="list-item">
                <div className="name">{p.name}</div>
                <div className="sub">{p.id}</div>
              </div>
            ))
          )}
        </div>
      )}

      <div className="footer">
        <span>
          {status.lastHeartbeatAt
            ? `last heartbeat: ${new Date(status.lastHeartbeatAt).toLocaleTimeString()}`
            : 'no heartbeat yet'}
        </span>
      </div>

      <button className="secondary no-drag" onClick={() => logout.mutate()} disabled={logout.isPending}>
        {logout.isPending ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  );
}
