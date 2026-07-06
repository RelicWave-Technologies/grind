import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import FloatingBar from './screens/FloatingBar';
import Popover from './screens/Popover';
import IdlePrompt from './screens/IdlePrompt';
import AwayPrompt from './screens/AwayPrompt';
import ReadyToWork from './screens/ReadyToWork';
import './styles.css';

const qc = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
});

// One renderer build; the main process loads each window with a hash.
const route = window.location.hash.replace('#', '');
const Root =
  route === 'floating' ? FloatingBar
  : route === 'popover' ? Popover
  : route === 'idle' ? IdlePrompt
  : route === 'away' ? AwayPrompt
  : route === 'ready-to-work' ? ReadyToWork
  : App;

// Transparent windows (floating bar, popover, idle/away prompt, ready-to-work)
// need a transparent body so the rounded card corners don't sit on a gray fill.
if (['floating', 'popover', 'idle', 'away', 'ready-to-work'].includes(route)) {
  document.body.classList.add('chrome-window');
}

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <Root />
    </QueryClientProvider>
  </React.StrictMode>,
);
