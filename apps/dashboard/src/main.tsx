import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { routeTree } from './router';
import { IntroProvider, useIntroHold } from './ui';
// The EMIAC design system (root DESIGN.md): fonts, generated tokens, element
// defaults. Everything below builds on it.
import '@grind/design';
import './styles.css';
// The ui/ kit's component classes, restyled onto the EMIAC tokens. Loaded
// after styles.css so the ui-* kit wins where the two overlap.
import './ui/system.css';

// Mock mode (`pnpm --filter @grind/dashboard dev:mock`): every /v1 request is
// answered in the browser with dummy data, before anything renders. The flag
// is a build-time constant, so a normal build drops the import entirely.
if (import.meta.env.VITE_MOCK === '1') await import('./mock');

// Single QueryClient for the whole SPA. Stale-while-revalidate is the
// default — we refetch on window focus so toggling back from Lark/agent
// shows fresh approval queues without manual reload.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// The app-load intro plays when the app itself is opened, never on the public
// pages (landing, changelog, privacy) or sign-in, which have their own looks.
const PUBLIC_PATHS = ['/', '/welcome', '/changelog', '/privacy', '/login'];
const opensApp = !PUBLIC_PATHS.includes(window.location.pathname.replace(/\/+$/, '') || '/');

/** Holds the intro until the router has resolved the first route (session check included). */
function FirstRoute() {
  const [resolved, setResolved] = useState(false);
  useEffect(() => router.subscribe('onResolved', () => setResolved(true)), []);
  useIntroHold(!resolved);
  return null;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <IntroProvider enabled={opensApp}>
        <FirstRoute />
        <RouterProvider router={router} />
      </IntroProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
