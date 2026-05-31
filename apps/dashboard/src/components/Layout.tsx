import { Outlet, Link, useRouteContext, useNavigate, useLocation } from '@tanstack/react-router';
import { Home, Users, Clock4, Inbox, LayoutGrid, CalendarCheck, Building2, LogOut } from 'lucide-react';
import { isAdmin, isManagerOrAbove, useLogout } from '../lib/auth';

interface NavItem {
  to: string;
  label: string;
  Icon: typeof Home;
  /** Roles that may see this item. */
  show: 'all' | 'manager+' | 'admin';
}

const NAV: NavItem[] = [
  { to: '/', label: 'Home', Icon: Home, show: 'all' },
  { to: '/me-today', label: 'My Day', Icon: Clock4, show: 'all' },
  { to: '/team', label: 'Team', Icon: LayoutGrid, show: 'manager+' },
  { to: '/attendance', label: 'Attendance', Icon: CalendarCheck, show: 'manager+' },
  { to: '/approvals', label: 'Approvals', Icon: Inbox, show: 'manager+' },
  { to: '/users', label: 'People', Icon: Users, show: 'all' /* scope handles privilege */ },
  { to: '/teams', label: 'Teams', Icon: Building2, show: 'admin' },
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
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark" />
          <div className="brand-name">Grind</div>
        </div>

        <nav className="nav">
          {visible.map(({ to, label, Icon }) => {
            const active = to === '/'
              ? location.pathname === '/'
              : location.pathname.startsWith(to);
            return (
              <Link
                key={to}
                to={to}
                className={`nav-item${active ? ' is-active' : ''}`}
              >
                <Icon size={16} strokeWidth={1.8} />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <div className="me-row">
            <div className="me-avatar" aria-hidden>
              {initials(me.name)}
            </div>
            <div className="me-meta">
              <div className="me-name">{me.name}</div>
              <div className="me-role secondary">{me.role}</div>
            </div>
          </div>
          <button
            type="button"
            className="btn-ghost btn-logout"
            onClick={onLogout}
            disabled={logout.isPending}
          >
            <LogOut size={14} strokeWidth={1.8} />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
