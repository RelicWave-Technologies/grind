import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { routeTree } from './router';
import './styles.css';
// Shared "Quiet Datasheet" UI kit — tokens + component classes (src/ui/SYSTEM.md).
// Loaded AFTER styles.css so the ui-* namespaced kit wins where it overlaps.
import './ui/system.css';

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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
