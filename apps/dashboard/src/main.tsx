import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { loadRouteData, routeTree } from './router';
import { PagePending } from './components/Layout';
import { meQuery } from './lib/auth';
import './styles.css';
// Shared "Quiet Datasheet" UI kit — tokens + component classes (src/ui/SYSTEM.md).
// Loaded AFTER styles.css so the ui-* namespaced kit wins where it overlaps.
import './ui/system.css';

// Single QueryClient for the whole SPA. Stale-while-revalidate is the
// default — we refetch on window focus so toggling back from Lark/agent
// shows fresh approval queues without manual reload. Per-query policy
// (reference lists, range placeholders) lives in lib/queries.ts.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Keep a page's data for 10 min after leaving it, so going back paints
      // from cache (revalidating behind it) instead of from a skeleton.
      gcTime: 10 * 60_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

const router = createRouter({
  routeTree,
  context: { queryClient },
  // Hovering/focusing a nav link runs the route's loader, which prefetches its
  // data (router.tsx). Loader freshness is React Query's job, so the router's
  // own preload cache is off — staleTime on each query decides what refetches.
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  defaultPendingComponent: PagePending,
});

// Cold load: the router only fetches a page's code (and runs its data
// prefetch) after the auth gate's /me resolves. Send /me first, then start
// the landing page's chunk and the prefetch module so they download alongside
// it; the gate's ensureQueryData joins the in-flight /me.
const coldMatches = router.matchRoutes(router.latestLocation).filter((m) => m.routeId.startsWith('/authed/'));
if (coldMatches.length > 0) {
  void queryClient.prefetchQuery(meQuery);
  void loadRouteData();
  for (const match of coldMatches) {
    void router.looseRoutesById[match.routeId]?.options.component?.preload?.();
  }
}

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
