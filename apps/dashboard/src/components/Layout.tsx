import { Outlet, Link, useRouteContext, useNavigate, useLocation } from '@tanstack/react-router';
import { Home, Users, LogOut } from 'lucide-react';
import { isAdmin, useLogout } from '../lib/auth';

interface NavItem {
  to: string;
  label: string;
  Icon: typeof Home;
  /** Roles that may see this item. */
  show: 'all' | 'admin';
}

const NAV: NavItem[] = [
  { to: '/', label: 'Home', Icon: Home, show: 'all' },
  { to: '/users', label: 'People', Icon: Users, show: 'all' /* scope handles privilege */ },
];

export function Layout() {
  const { me } = useRouteContext({ from: '/authed' });
  const navigate = useNavigate();
  const location = useLocation();
  const logout = useLogout();

  const visible = NAV.filter((n) => n.show === 'all' || (n.show === 'admin' && isAdmin(me.role)));

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
