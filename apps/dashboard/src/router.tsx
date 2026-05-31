import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  redirect,
} from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { api, ApiError } from './lib/api';
import type { Me } from './lib/auth';
import { Layout } from './components/Layout';
import { LoginScreen } from './screens/Login';
import { UsersScreen } from './screens/Users';
import { HomeScreen } from './screens/Home';
import { MeTodayScreen } from './screens/MeToday';
import { ApprovalsScreen } from './screens/Approvals';
import { TeamScreen } from './screens/Team';

interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
});

// Auth gate. Any route under this calls /me first and bounces to /login
// on 401. Other failures throw — we'd rather show an error boundary than
// silently redirect away from a transient API blip.
const authedRoot = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authed',
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.fetchQuery<Me | null>({
      queryKey: ['me'],
      queryFn: async () => {
        try {
          const res = await api<{ user: Me }>('/v1/auth/me');
          return res.user;
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) return null;
          throw e;
        }
      },
      staleTime: 5 * 60_000,
    });
    if (!me) {
      throw redirect({ to: '/login', search: { next: location.href } });
    }
    return { me };
  },
  component: Layout,
});

const homeRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/',
  component: HomeScreen,
});

const usersRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/users',
  component: UsersScreen,
});

const meTodayRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/me-today',
  // Optional ?date=YYYY-MM-DD&userId= so the Team page can deep-link
  // into a specific user-day. Both are pure strings; validation happens
  // in the screen (the date format check is cheap).
  validateSearch: (s: Record<string, unknown>): { date?: string; userId?: string } => ({
    date: typeof s.date === 'string' ? s.date : undefined,
    userId: typeof s.userId === 'string' ? s.userId : undefined,
  }),
  component: MeTodayScreen,
});

const approvalsRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/approvals',
  component: ApprovalsScreen,
});

const teamRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/team',
  component: TeamScreen,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (s: Record<string, unknown>): { next?: string } => ({
    next: typeof s.next === 'string' ? s.next : undefined,
  }),
  component: LoginScreen,
});

export const routeTree = rootRoute.addChildren([
  authedRoot.addChildren([homeRoute, meTodayRoute, approvalsRoute, teamRoute, usersRoute]),
  loginRoute,
]);
