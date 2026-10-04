import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Login from './screens/Login';
import MainLayout from './screens/MainLayout';
import { IntroProvider, useIntroHold } from './components/AppIntro';
import './lib/agent.d';

/** The main window: the app-load intro over whichever screen the session calls for. */
export default function App() {
  return (
    <IntroProvider>
      <Session />
    </IntroProvider>
  );
}

function Session() {
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

  useEffect(() => window.agent.screenshots.onChange(() => {
    void qc.invalidateQueries({ queryKey: ['screenshots'] });
    void qc.invalidateQueries({ queryKey: ['shotsAll'] });
    void qc.invalidateQueries({ queryKey: ['screenshotsUploadSummary'] });
  }), [qc]);

  const checking = status.isLoading || status.data === undefined;
  useIntroHold(checking);

  if (checking) {
    return <div className="login" />;
  }

  return status.data === 'loggedIn' ? <MainLayout /> : <Login />;
}
