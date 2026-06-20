import { Outlet, Link, useRouteContext, useNavigate, useLocation } from '@tanstack/react-router';
import { Home, Clock4, Inbox, LayoutGrid, CalendarCheck, ShieldAlert, Building2, Sunrise, LogOut, ShieldCheck, FileSpreadsheet, Compass, FileText, User, Users } from 'lucide-react';
import { hasCapability, isAdmin, isManagerOrAbove, useLogout, type Permission } from '../lib/auth';
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
  show: 'all' | 'manager+' | 'admin' | { permission: Permission } | { anyPermission: Permission[] };
}

const NAV: NavEntry[] = [
  { to: '/', label: 'Home', Icon: Home, show: 'all' },
  { to: '/overview', label: 'Overview', Icon: Compass, show: 'manager+' },
  { to: '/users', label: 'People', Icon: Users, show: 'admin' },
  { to: '/edit-time', label: 'Edit Time', Icon: Clock4, show: 'all' },
  { to: '/reports', label: 'Reports', Icon: FileText, show: { permission: 'reports.self.read' } },
  { to: '/approvals', label: 'Approvals', Icon: Inbox, show: { permission: 'approvals.self.read' } },
  { to: '/profile', label: 'Profile', Icon: User, show: { permission: 'profile.self.read' } },
  { to: '/team', label: 'Team Settings', Icon: LayoutGrid, show: 'manager+' },
  { to: '/attendance', label: 'Attendance', Icon: CalendarCheck, show: 'manager+' },
  { to: '/flags', label: 'Anti-cheat', Icon: ShieldAlert, show: { anyPermission: ['flags.team.review', 'flags.workspace.review'] } },
  { to: '/teams', label: 'Org Teams', Icon: Building2, show: 'admin' },
  { to: '/shifts', label: 'Shifts', Icon: Sunrise, show: 'admin' },
  { to: '/policy', label: 'Policy', Icon: ShieldCheck, show: 'admin' },
  { to: '/payroll', label: 'Payroll', Icon: FileSpreadsheet, show: 'admin' },
];

export function Layout() {
  const { me } = useRouteContext({ from: '/authed' });
  const navigate = useNavigate();
  const location = useLocation();
  const logout = useLogout();

  const visible = NAV.filter((n) => {
    if (n.show === 'all') return true;
    if (n.show === 'manager+') return isManagerOrAbove(me.role);
    if (n.show === 'admin') return isAdmin(me.role);
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
        brand={<SidebarBrand name="Grind" />}
        footer={
          <>
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
