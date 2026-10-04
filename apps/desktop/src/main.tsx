import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import FloatingBar from './screens/FloatingBar';
import Popover from './screens/Popover';
import ReadyToWork from './screens/ReadyToWork';
import AttentionPrompt from './screens/AttentionPrompt';
import { installTauriShell } from './bridge/install';
// The EMIAC design system (root DESIGN.md): fonts, generated tokens, element
// defaults. Loaded before the renderer's own stylesheet, which builds on it.
import '@grind/design';
import './styles.css';

// `window.agent` must exist before the first screen asks it for anything.
// Debug builds can swap in the lab's fake one (`?lab`, see lab/devWindow.ts).
async function installAgent(): Promise<void> {
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('lab')) {
    (await import('../lab/devWindow')).installLabBridge();
  } else {
    installTauriShell();
  }
}

async function start(): Promise<void> {
  await installAgent();
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
    : route === 'attention' ? AttentionPrompt
    : route === 'ready-to-work' ? ReadyToWork
    : App;

  // Transparent windows (floating bar, popover, idle/away prompt, ready-to-work)
  // need a transparent body so the rounded card corners don't sit on a gray fill.
  if (['floating', 'popover', 'attention', 'ready-to-work'].includes(route)) {
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
}

void start();
