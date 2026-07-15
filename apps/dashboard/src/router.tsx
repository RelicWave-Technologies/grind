import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  lazyRouteComponent,
  redirect,
} from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { api, ApiError } from './lib/api';
import { hasCapability } from './lib/auth';
import type { Me } from './lib/auth';
import { Layout } from './components/Layout';
import { LoginScreen } from './screens/Login';

const UsersScreen = lazyRouteComponent(() => import('./screens/Users'), 'UsersScreen');
const HomeScreen = lazyRouteComponent(() => import('./screens/Home'), 'HomeScreen');
const MeTodayScreen = lazyRouteComponent(() => import('./screens/MeToday'), 'MeTodayScreen');
const ApprovalsScreen = lazyRouteComponent(() => import('./screens/Approvals'), 'ApprovalsScreen');
const TeamScreen = lazyRouteComponent(() => import('./screens/Team'), 'TeamScreen');
const AttendanceScreen = lazyRouteComponent(() => import('./screens/Attendance'), 'AttendanceScreen');
const TeamsScreen = lazyRouteComponent(() => import('./screens/Teams'), 'TeamsScreen');
const FlagsScreen = lazyRouteComponent(() => import('./screens/Flags'), 'FlagsScreen');
const ShiftsScreen = lazyRouteComponent(() => import('./screens/Shifts'), 'ShiftsScreen');
const PolicyScreen = lazyRouteComponent(() => import('./screens/Policy'), 'PolicyScreen');
const PayrollScreen = lazyRouteComponent(() => import('./screens/Payroll'), 'PayrollScreen');
const OverviewScreen = lazyRouteComponent(() => import('./screens/Overview'), 'OverviewScreen');
const IntegrationsScreen = lazyRouteComponent(() => import('./screens/Integrations'), 'IntegrationsScreen');
const ReportsScreen = lazyRouteComponent(() => import('./screens/Reports'), 'ReportsScreen');
const ProfileScreen = lazyRouteComponent(() => import('./screens/Profile'), 'ProfileScreen');

interface RouterContext {
  queryClient: QueryClient;
}

const meQuery = {
  queryKey: ['me'],
  queryFn: async (): Promise<Me | null> => {
    try {
      const res = await api<{ user: Me }>('/v1/auth/me');
      return res.user;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }
  },
  staleTime: 5 * 60_000,
};

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
    const me = await context.queryClient.fetchQuery<Me | null>(meQuery);
    if (!me) {
      throw redirect({ to: '/login', search: { next: location.href } });
    }
    return { me };
  },
  component: Layout,
});

function fallbackRoute(me: Me | null | undefined): '/overview' | '/edit-time' {
  return hasCapability(me, 'overview.read') ? '/overview' : '/edit-time';
}

function requireAnyRouteCapability(me: Me | null | undefined, permissions: Array<Parameters<typeof hasCapability>[1]>): void {
  if (!permissions.some((permission) => hasCapability(me, permission))) {
    throw redirect({ to: fallbackRoute(me) });
  }
}

const homeRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/',
  component: HomeScreen,
});

const usersRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/users',
  beforeLoad: ({ context }) => {
    const me = (context as { me?: Me }).me;
    if (!hasCapability(me, 'people.read')) {
      throw redirect({ to: '/reports' });
    }
  },
  component: UsersScreen,
});

const editTimeRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/edit-time',
  // Optional ?date=YYYY-MM-DD&userId=&requestId=&focusStart=&focusEnd= so
  // approval rows can deep-link into a specific user-day and focus the matching
  // manual-time slot. Values stay as strings; the screen validates cheaply.
  validateSearch: (s: Record<string, unknown>): { date?: string; userId?: string; requestId?: string; focusStart?: string; focusEnd?: string } => ({
    date: typeof s.date === 'string' ? s.date : undefined,
    userId: typeof s.userId === 'string' ? s.userId : undefined,
    requestId: typeof s.requestId === 'string' ? s.requestId : undefined,
    focusStart: typeof s.focusStart === 'string' ? s.focusStart : undefined,
    focusEnd: typeof s.focusEnd === 'string' ? s.focusEnd : undefined,
  }),
  component: MeTodayScreen,
});

const meTodayLegacyRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/me-today',
  validateSearch: (s: Record<string, unknown>): { date?: string; userId?: string; requestId?: string; focusStart?: string; focusEnd?: string } => ({
    date: typeof s.date === 'string' ? s.date : undefined,
    userId: typeof s.userId === 'string' ? s.userId : undefined,
    requestId: typeof s.requestId === 'string' ? s.requestId : undefined,
    focusStart: typeof s.focusStart === 'string' ? s.focusStart : undefined,
    focusEnd: typeof s.focusEnd === 'string' ? s.focusEnd : undefined,
  }),
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/edit-time', search });
  },
});

const reportsRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/reports',
  beforeLoad: ({ context }) => {
    const me = (context as { me?: Me }).me;
    if (!hasCapability(me, 'reports.self.read')) {
      throw redirect({ to: '/edit-time' });
    }
  },
  component: ReportsScreen,
});

const approvalsRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/approvals',
  beforeLoad: ({ context }) => {
    const me = (context as { me?: Me }).me;
    const canReadSelf = hasCapability(me, 'approvals.self.read');
    const canReview =
      hasCapability(me, 'approvals.team.decide') ||
      hasCapability(me, 'approvals.workspace.decide');
    if (!canReadSelf && !canReview) {
      throw redirect({ to: '/edit-time' });
    }
  },
  component: ApprovalsScreen,
});

const profileRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/profile',
  beforeLoad: ({ context }) => {
    const me = (context as { me?: Me }).me;
    if (!hasCapability(me, 'profile.self.read')) {
      throw redirect({ to: '/edit-time' });
    }
  },
  component: ProfileScreen,
});

const teamRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/team',
  beforeLoad: ({ context }) => {
    const me = (context as { me?: Me }).me;
    if (!hasCapability(me, 'team.settings.manage')) {
      throw redirect({ to: '/' });
    }
  },
  component: TeamScreen,
});

const attendanceRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/attendance',
  beforeLoad: ({ context }) => {
    const me = (context as { me?: Me }).me;
    requireAnyRouteCapability(me, ['reports.team.read', 'reports.workspace.read']);
  },
  component: AttendanceScreen,
});

const teamsAdminRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/teams',
  beforeLoad: ({ context }) => {
    const me = (context as { me?: Me }).me;
    requireAnyRouteCapability(me, ['teams.manage']);
  },
  component: TeamsScreen,
});

const flagsRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/flags',
  beforeLoad: ({ context }) => {
    const me = (context as { me?: Me }).me;
    const canReview =
      hasCapability(me, 'flags.team.review') ||
      hasCapability(me, 'flags.workspace.review');
    if (!canReview) {
      throw redirect({ to: '/' });
    }
  },
  component: FlagsScreen,
});

const shiftsRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/shifts',
  beforeLoad: ({ context }) => {
    const me = (context as { me?: Me }).me;
    requireAnyRouteCapability(me, ['shifts.manage']);
  },
  component: ShiftsScreen,
});

const policyRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/policy',
  beforeLoad: ({ context }) => {
    const me = (context as { me?: Me }).me;
    requireAnyRouteCapability(me, ['policy.manage']);
  },
  component: PolicyScreen,
});

const integrationsRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/integrations',
  beforeLoad: ({ context }) => {
    const me = (context as { me?: Me }).me;
    requireAnyRouteCapability(me, ['api-tokens.manage']);
  },
  component: IntegrationsScreen,
});

const payrollRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/payroll',
  beforeLoad: ({ context }) => {
    const me = (context as { me?: Me }).me;
    requireAnyRouteCapability(me, ['payroll.manage']);
  },
  component: PayrollScreen,
});

const overviewRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/overview',
  beforeLoad: ({ context }) => {
    const me = (context as { me?: Me }).me;
    if (!hasCapability(me, 'overview.read')) {
      throw redirect({ to: '/edit-time' });
    }
  },
  component: OverviewScreen,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (s: Record<string, unknown>): { next?: string; status?: string; error?: string } => ({
    next: typeof s.next === 'string' ? s.next : undefined,
    status: typeof s.status === 'string' ? s.status : undefined,
    error: typeof s.error === 'string' ? s.error : undefined,
  }),
  beforeLoad: async ({ context, search }) => {
    if (search.status || search.error) return;
    const me = await context.queryClient.fetchQuery<Me | null>(meQuery);
    if (me) throw redirect({ to: '/' });
  },
  component: LoginScreen,
});

export const routeTree = rootRoute.addChildren([
  authedRoot.addChildren([homeRoute, overviewRoute, editTimeRoute, meTodayLegacyRoute, reportsRoute, approvalsRoute, profileRoute, teamRoute, attendanceRoute, flagsRoute, usersRoute, teamsAdminRoute, shiftsRoute, policyRoute, integrationsRoute, payrollRoute]),
  loginRoute,
]);
