import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Login from './screens/Login';
import MainLayout from './screens/MainLayout';
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
    return <div className="login" />;
  }

  return status.data === 'loggedIn' ? <MainLayout /> : <Login />;
}
