import { Outlet, Link, useRouteContext, useNavigate, useLocation } from '@tanstack/react-router';
import { Home, Clock4, Inbox, CalendarCheck, ShieldAlert, LogOut, ShieldCheck, FileText, User, Users, CalendarDays, Compass } from 'lucide-react';
import { hasCapability, useLogout, type Permission } from '../lib/auth';
import { AGENT_DOWNLOADS, agentDownloadUrl } from '../lib/downloads';
import {
  AppShell,
  Sidebar,
  SidebarBrand,
  NavItem,
  NavSection,
  Tabs,
  Avatar,
  Button,
  Page,
  PageHeader,
  Skeleton,
  SkeletonStat,
  SkeletonTable,
} from '../ui';

type Show = 'all' | { permission: Permission } | { anyPermission: Permission[] };

/** One page inside a sidebar item. Items with several pages get a tab bar. */
interface NavTab {
  to: string;
  label: string;
  show: Show;
}

interface NavEntry {
  label: string;
  Icon: typeof Home;
  tabs: NavTab[];
}

/**
 * Three groups, nine places. Pages that answer the same question share one
 * sidebar item and a tab bar — every old address still works, it just lives
 * under the item it belongs to.
 */
const NAV: Array<{ section: string; items: NavEntry[] }> = [
  {
    section: 'My work',
    items: [
      { label: 'Today', Icon: Home, tabs: [{ to: '/home', label: 'Today', show: 'all' }] },
      { label: 'Edit time', Icon: Clock4, tabs: [{ to: '/edit-time', label: 'Edit time', show: 'all' }] },
      { label: 'Leave', Icon: CalendarDays, tabs: [{ to: '/calendar', label: 'Leave', show: 'all' }] },
      { label: 'Profile', Icon: User, tabs: [{ to: '/profile', label: 'Profile', show: { permission: 'profile.self.read' } }] },
    ],
  },
  {
    section: 'Team',
    items: [
      { label: 'Team today', Icon: Compass, tabs: [
        { to: '/overview', label: 'Team today', show: { permission: 'overview.read' } },
      ] },
      { label: 'Attendance', Icon: CalendarCheck, tabs: [
        { to: '/attendance', label: 'Attendance', show: { anyPermission: ['reports.team.read', 'reports.workspace.read'] } },
      ] },
      { label: 'Reports', Icon: FileText, tabs: [
        { to: '/reports', label: 'Reports', show: { permission: 'reports.self.read' } },
      ] },
      { label: 'Approvals', Icon: Inbox, tabs: [{ to: '/approvals', label: 'Approvals', show: { permission: 'approvals.self.read' } }] },
      { label: 'Anti-cheat', Icon: ShieldAlert, tabs: [
        { to: '/flags', label: 'Anti-cheat', show: { anyPermission: ['flags.team.review', 'flags.workspace.review'] } },
      ] },
    ],
  },
  {
    section: 'Admin',
    items: [
      { label: 'People', Icon: Users, tabs: [
        { to: '/users', label: 'People', show: { permission: 'people.read' } },
        { to: '/team', label: 'Team settings', show: { permission: 'team.settings.manage' } },
        { to: '/teams', label: 'Teams', show: { permission: 'teams.manage' } },
      ] },
      { label: 'Settings', Icon: ShieldCheck, tabs: [
        { to: '/policy', label: 'Policy & rules', show: { permission: 'policy.manage' } },
        { to: '/shifts', label: 'Shifts', show: { permission: 'shifts.manage' } },
        { to: '/integrations', label: 'Integrations', show: { permission: 'api-tokens.manage' } },
      ] },
    ],
  },
];

export function Layout() {
  const { me } = useRouteContext({ from: '/authed' });
  const navigate = useNavigate();
  const location = useLocation();
  const logout = useLogout();

  const allowed = (show: Show) => {
    if (show === 'all') return true;
    if ('permission' in show) return hasCapability(me, show.permission);
    return show.anyPermission.some((permission) => hasCapability(me, permission));
  };
  const onPath = (to: string) => location.pathname === to || location.pathname.startsWith(`${to}/`);
  const groups = NAV.map((g) => ({
    section: g.section,
    items: g.items
      .map((item) => ({ ...item, tabs: item.tabs.filter((t) => allowed(t.show)) }))
      .filter((item) => item.tabs.length > 0),
  })).filter((g) => g.items.length > 0);
  // The item the current page belongs to, for the tab bar above the page.
  const current = groups.flatMap((g) => g.items).find((item) => item.tabs.some((t) => onPath(t.to)));

  async function onLogout() {
    try {
      await logout.mutateAsync();
    } finally {
      navigate({ to: '/login' });
    }
  }

  return (
    <AppShell>
      <Sidebar
        brand={<SidebarBrand name="Timo" />}
        footer={
          <>
            <div className="ui-sidebar__downloads" aria-label="Download Timo app">
              {AGENT_DOWNLOADS.map((option) => (
                <a
                  key={option.platform}
                  className="ui-sidebar__download ui-btn ui-btn--secondary ui-btn--sm"
                  href={agentDownloadUrl(option.platform)}
                  title={`Download Timo for ${option.label}`}
                  aria-label={`Download Timo for ${option.label}`}
                >
                  <span className="ui-btn__icon" aria-hidden="true">
                    <img src={option.iconSrc} alt="" />
                  </span>
                  <span className="ui-btn__label">{option.label}</span>
                </a>
              ))}
            </div>
            <div className="ui-sidebar__me">
              <Avatar name={me.name} src={me.avatarUrl ?? undefined} size={32} />
              <div className="ui-sidebar__me-meta">
                <div className="ui-sidebar__me-name ui-t-strong">{me.name}</div>
                <div className="ui-t-small ui-ink-3">{me.displayRole}</div>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              block
              icon={<LogOut size={14} strokeWidth={1.8} />}
              onClick={onLogout}
              disabled={logout.isPending}
            >
              Sign out
            </Button>
          </>
        }
      >
        {groups.map((g) => (
          <div key={g.section}>
            <NavSection label={g.section} />
            {g.items.map(({ label, Icon, tabs }) => (
              <NavItem
                key={label}
                as={Link}
                to={tabs[0]!.to}
                label={label}
                icon={<Icon size={18} strokeWidth={1.8} />}
                active={tabs.some((t) => onPath(t.to))}
              />
            ))}
          </div>
        ))}
      </Sidebar>

      <main className="ui-main">
        <div className="ui-rise">
          {current && current.tabs.length > 1 && (
            <div className="ui-section-tabs">
              <Tabs
                items={current.tabs.map((t) => ({ value: t.to, label: t.label }))}
                value={current.tabs.find((t) => onPath(t.to))?.to ?? current.tabs[0]!.to}
                onChange={(to) => navigate({ to })}
              />
            </div>
          )}
          <Outlet />
        </div>
      </main>
    </AppShell>
  );
}

/** Page-body placeholder while a route's code or session check is slow
 *  (the router shows it only after `pendingMs`). Kit skeletons sized like a
 *  PageHeader + one table, never a full-page spinner. */
export function PagePending() {
  return (
    <Page aria-busy="true">
      <PageHeader eyebrow={<Skeleton w={160} h={11} />} title={<Skeleton w={280} h={22} />} />
      <SkeletonStat />
      <SkeletonTable rows={6} />
    </Page>
  );
}

/** The app frame before `/me` resolves on a cold load: the shell renders at
 *  once so the page doesn't sit blank, and the real Layout swaps in place. */
export function LayoutPending() {
  return (
    <AppShell>
      <Sidebar brand={<SidebarBrand name="Timo" />}>
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} h={28} />
        ))}
      </Sidebar>
      <main className="ui-main">
        <PagePending />
      </main>
    </AppShell>
  );
}
