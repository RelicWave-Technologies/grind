import { Outlet, Link, useRouteContext, useNavigate, useLocation } from '@tanstack/react-router';
import { Home, Users, Clock4, Inbox, LayoutGrid, CalendarCheck, ShieldAlert, Building2, Sunrise, LogOut, ShieldCheck, FileSpreadsheet, Compass } from 'lucide-react';
import { isAdmin, isManagerOrAbove, useLogout } from '../lib/auth';
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
  /** Roles that may see this item. */
  show: 'all' | 'manager+' | 'admin';
}

const NAV: NavEntry[] = [
  { to: '/', label: 'Home', Icon: Home, show: 'all' },
  { to: '/overview', label: 'Overview', Icon: Compass, show: 'manager+' },
  { to: '/me-today', label: 'My Day', Icon: Clock4, show: 'all' },
  { to: '/team', label: 'Team', Icon: LayoutGrid, show: 'manager+' },
  { to: '/attendance', label: 'Attendance', Icon: CalendarCheck, show: 'manager+' },
  { to: '/approvals', label: 'Approvals', Icon: Inbox, show: 'manager+' },
  { to: '/flags', label: 'Anti-cheat', Icon: ShieldAlert, show: 'manager+' },
  { to: '/users', label: 'People', Icon: Users, show: 'all' /* scope handles privilege */ },
  { to: '/teams', label: 'Teams', Icon: Building2, show: 'admin' },
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
              <Avatar name={me.name} size={32} />
              <div className="ui-sidebar__me-meta">
                <div className="ui-sidebar__me-name ui-t-strong">{me.name}</div>
                <div className="ui-t-small ui-ink-3">{me.role}</div>
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
