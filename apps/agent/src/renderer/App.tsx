import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Login from './screens/Login';
import ProjectList from './screens/ProjectList';
import './lib/agent.d';

export default function App() {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['authStatus'],
    queryFn: () => window.agent.auth.status(),
  });

  useEffect(() => {
    const off = window.agent.auth.onStatusChange(() => {
      void qc.invalidateQueries({ queryKey: ['authStatus'] });
      void qc.invalidateQueries({ queryKey: ['projects'] });
    });
    return off;
  }, [qc]);

  if (status.isLoading || status.data === undefined) {
    return (
      <div className="app">
        <div className="header">
          <span>Grind</span>
          <span className="badge">…</span>
        </div>
        <div className="muted">Loading…</div>
      </div>
    );
  }

  return status.data === 'loggedIn' ? <ProjectList /> : <Login />;
}
