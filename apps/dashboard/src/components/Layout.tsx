import { Outlet, Link, useRouteContext, useNavigate, useLocation } from '@tanstack/react-router';
import { Home, Clock4, Inbox, LayoutGrid, CalendarCheck, ShieldAlert, Building2, Sunrise, LogOut, ShieldCheck, FileSpreadsheet, Compass, FileText, User, Users, Bot } from 'lucide-react';
import { hasCapability, useLogout, type Permission } from '../lib/auth';
import { AGENT_DOWNLOADS, agentDownloadUrl } from '../lib/downloads';
import {
  AppShell,
  Sidebar,
  SidebarBrand,
  NavItem,
  Avatar,
  Button,
} from '../ui';

interface NavEntry {
  to: string;
  label: string;
  Icon: typeof Home;
  show: 'all' | { permission: Permission } | { anyPermission: Permission[] };
}

const NAV: NavEntry[] = [
  { to: '/', label: 'Home', Icon: Home, show: 'all' },
  { to: '/overview', label: 'Overview', Icon: Compass, show: { permission: 'overview.read' } },
  { to: '/tester-ops', label: 'Tester Ops', Icon: Bot, show: { permission: 'tester-ops.manage' } },
  { to: '/users', label: 'People', Icon: Users, show: { permission: 'people.read' } },
  { to: '/edit-time', label: 'Edit Time', Icon: Clock4, show: 'all' },
  { to: '/reports', label: 'Reports', Icon: FileText, show: { permission: 'reports.self.read' } },
  { to: '/approvals', label: 'Approvals', Icon: Inbox, show: { permission: 'approvals.self.read' } },
  { to: '/profile', label: 'Profile', Icon: User, show: { permission: 'profile.self.read' } },
  { to: '/team', label: 'Team Settings', Icon: LayoutGrid, show: { permission: 'team.settings.manage' } },
  { to: '/attendance', label: 'Attendance', Icon: CalendarCheck, show: { anyPermission: ['reports.team.read', 'reports.workspace.read'] } },
  { to: '/flags', label: 'Anti-cheat', Icon: ShieldAlert, show: { anyPermission: ['flags.team.review', 'flags.workspace.review'] } },
  { to: '/teams', label: 'Org Teams', Icon: Building2, show: { permission: 'teams.manage' } },
  { to: '/shifts', label: 'Shifts', Icon: Sunrise, show: { permission: 'shifts.manage' } },
  { to: '/policy', label: 'Policy', Icon: ShieldCheck, show: { permission: 'policy.manage' } },
  { to: '/payroll', label: 'Payroll', Icon: FileSpreadsheet, show: { permission: 'payroll.manage' } },
];

export function Layout() {
  const { me } = useRouteContext({ from: '/authed' });
  const navigate = useNavigate();
  const location = useLocation();
  const logout = useLogout();

  const visible = NAV.filter((n) => {
    if (n.show === 'all') return true;
    if ('permission' in n.show) return hasCapability(me, n.show.permission);
    if ('anyPermission' in n.show) return n.show.anyPermission.some((permission) => hasCapability(me, permission));
    return false;
  });

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
        {visible.map(({ to, label, Icon }) => {
          const active = to === '/'
            ? location.pathname === '/'
            : location.pathname.startsWith(to);
          return (
            <NavItem
              key={to}
              as={Link}
              to={to}
              label={label}
              icon={<Icon size={18} strokeWidth={1.8} />}
              active={active}
            />
          );
        })}
      </Sidebar>

      <main className="ui-main">
        <div className="ui-rise">
          <Outlet />
        </div>
      </main>
    </AppShell>
  );
}
