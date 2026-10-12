import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  lazyRouteComponent,
  redirect,
} from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { hasCapability, landingPath, meQuery } from './lib/auth';
import type { Me } from './lib/auth';
import type { PrefetchPage, RouteSearch } from './lib/routeData';
import { parseSyncFilter, type SyncFilter } from './lib/syncHealth';
import { Layout, LayoutPending } from './components/Layout';
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
const OverviewScreen = lazyRouteComponent(() => import('./screens/Overview'), 'OverviewScreen');
const IntegrationsScreen = lazyRouteComponent(() => import('./screens/Integrations'), 'IntegrationsScreen');
const ReportsScreen = lazyRouteComponent(() => import('./screens/Reports'), 'ReportsScreen');
const ProfileScreen = lazyRouteComponent(() => import('./screens/Profile'), 'ProfileScreen');
const ChangelogScreen = lazyRouteComponent(() => import('./screens/Changelog'), 'ChangelogScreen');
const CalendarScreen = lazyRouteComponent(() => import('./screens/Calendar'), 'CalendarScreen');
const WelcomeScreen = lazyRouteComponent(() => import('./screens/Welcome'), 'WelcomeScreen');
const DevResyncScreen = lazyRouteComponent(() => import('./screens/DevResync'), 'DevResyncScreen');

interface RouterContext {
  queryClient: QueryClient;
}

/*
 * Data loading: every page route's `loader` prefetches the queries its screen
 * reads on first paint (lib/routeData.ts, built on the factories in
 * lib/queries.ts — the same keys the screen uses). Loaders never await, so
 * navigation is gated only by the page's code chunk; the request runs in
 * parallel with it, and with `defaultPreload: 'intent'` (main.tsx) it already
 * starts on nav-link hover. routeData is imported lazily to keep the shared
 * date helpers (and zod, via @grind/types) out of the entry chunk; main.tsx
 * warms it at boot.
 */
export const loadRouteData = () => import('./lib/routeData');

function prefetchPage(page: PrefetchPage) {
  return ({ context, deps }: { context: { queryClient: QueryClient; me: Me }; deps?: RouteSearch }) => {
    loadRouteData()
      .then(({ pagePrefetch }) => pagePrefetch[page](context.queryClient, context.me, deps ?? {}))
      // Best effort: if the prefetch can't run, the screen's own useQuery fetches.
      .catch(() => undefined);
  };
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
    // A cached session answers at once — a stale one is revalidated in the
    // background rather than holding every navigation on a /me round-trip
    // (plus a cookie refresh) after five idle minutes. If that revalidation
    // finds the session gone, the next navigation lands on /login.
    const me = await context.queryClient.ensureQueryData({ ...meQuery, revalidateIfStale: true });
    if (!me) {
      throw redirect({ to: '/login', search: { next: location.href } });
    }
    return { me };
  },
  // Cold load only: shown if /me takes longer than the router's pendingMs.
  pendingComponent: LayoutPending,
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
  path: '/home',
  loader: prefetchPage('home'),
  component: HomeScreen,
});

const usersRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/users',
  // Optional ?sync=stuck|behind|unknown — the Overview "sync stuck" card links here.
  validateSearch: (s: Record<string, unknown>): { sync?: SyncFilter } => ({
    sync: parseSyncFilter(s.sync),
  }),
  beforeLoad: ({ context }) => {
    const me = (context as { me?: Me }).me;
    if (!hasCapability(me, 'people.read')) {
      throw redirect({ to: '/reports' });
    }
  },
  loader: prefetchPage('users'),
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
  loaderDeps: ({ search }) => ({ date: search.date, userId: search.userId }),
  loader: prefetchPage('editTime'),
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
  loader: prefetchPage('reports'),
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
  loader: prefetchPage('approvals'),
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
  loader: prefetchPage('profile'),
  component: ProfileScreen,
});

const teamRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/team',
  beforeLoad: ({ context }) => {
    const me = (context as { me?: Me }).me;
    if (!hasCapability(me, 'team.settings.manage')) {
      throw redirect({ to: '/home' });
    }
  },
  loader: prefetchPage('team'),
  component: TeamScreen,
});

const attendanceRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/attendance',
  beforeLoad: ({ context }) => {
    const me = (context as { me?: Me }).me;
    requireAnyRouteCapability(me, ['reports.team.read', 'reports.workspace.read']);
  },
  loader: prefetchPage('attendance'),
  component: AttendanceScreen,
});

// Open to anybody signed in. Every read behind it is scoped by the caller's
// own `req.scope.userIds` — a member's month grid and balance row are their
// own, a manager's are their team's — and every write on the page is
// `requireAdmin` on the server. There is nothing here to gate a second time.
const calendarRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/calendar',
  loader: prefetchPage('calendar'),
  component: CalendarScreen,
});

const teamsAdminRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/teams',
  beforeLoad: ({ context }) => {
    const me = (context as { me?: Me }).me;
    requireAnyRouteCapability(me, ['teams.manage']);
  },
  loader: prefetchPage('teams'),
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
      throw redirect({ to: '/home' });
    }
  },
  loader: prefetchPage('flags'),
  component: FlagsScreen,
});

const shiftsRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/shifts',
  beforeLoad: ({ context }) => {
    const me = (context as { me?: Me }).me;
    requireAnyRouteCapability(me, ['shifts.manage']);
  },
  loader: prefetchPage('shifts'),
  component: ShiftsScreen,
});

const policyRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/policy',
  beforeLoad: ({ context }) => {
    const me = (context as { me?: Me }).me;
    requireAnyRouteCapability(me, ['policy.manage']);
  },
  loader: prefetchPage('policy'),
  component: PolicyScreen,
});

const integrationsRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/integrations',
  beforeLoad: ({ context }) => {
    const me = (context as { me?: Me }).me;
    requireAnyRouteCapability(me, ['api-tokens.manage']);
  },
  loader: prefetchPage('integrations'),
  component: IntegrationsScreen,
});

// Hidden developer tool (DEVELOPER_EMAILS on the API). Reached by URL only —
// no nav entry — and anyone else lands where they normally would.
const devResyncRoute = createRoute({
  getParentRoute: () => authedRoot,
  path: '/dev/resync',
  beforeLoad: ({ context }) => {
    const me = (context as { me?: Me }).me;
    if (!me?.isDeveloper) throw redirect({ to: landingPath(me) });
  },
  component: DevResyncScreen,
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
  loader: prefetchPage('overview'),
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
    const me = await context.queryClient.fetchQuery(meQuery);
    if (me) throw redirect({ to: landingPath(me) });
  },
  component: LoginScreen,
});

// Public release history — intentionally outside the auth gate: it carries
// no workspace data, and employees should be able to read it pre-login.
const changelogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/changelog',
  component: ChangelogScreen,
});

// Public landing page — static marketing surface, no workspace data.
const welcomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/welcome',
  component: WelcomeScreen,
});

// The front door. Logged-out visitors get the marketing page at the bare
// domain; anyone with a session is sent straight into the app. Keeping the
// landing ON '/' (rather than redirecting) is what makes timo.emiactech.com
// behave like a normal product site.
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: async ({ context }) => {
    // Fail open: the landing page needs no data, so an unreachable API must
    // still render marketing rather than an error boundary. Only a confirmed
    // session sends you into the app.
    let me: Me | null = null;
    try {
      me = await context.queryClient.fetchQuery(meQuery);
    } catch {
      me = null;
    }
    if (me) throw redirect({ to: landingPath(me) });
  },
  component: WelcomeScreen,
});

export const routeTree = rootRoute.addChildren([
  authedRoot.addChildren([homeRoute, overviewRoute, editTimeRoute, meTodayLegacyRoute, reportsRoute, approvalsRoute, profileRoute, teamRoute, attendanceRoute, calendarRoute, flagsRoute, usersRoute, teamsAdminRoute, shiftsRoute, policyRoute, integrationsRoute, devResyncRoute]),
  loginRoute,
  changelogRoute,
  welcomeRoute,
  indexRoute,
]);
