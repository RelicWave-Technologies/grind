import type { ReactNode } from 'react';
import { cx } from './util';

/* §5.17 AppShell + Sidebar + NavItem — the persistent frame around all 13 pages.
   (Login renders WITHOUT the shell: a centered Card on --ui-surface-sunken.)

   NavItem is router-agnostic: it renders an <a>-compatible element. The app's
   Layout passes TanStack Router's <Link> via the `as` prop so navigation and
   `to`/`active` semantics stay with the app, not the kit. */

export interface AppShellProps extends React.HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function AppShell({ children, className, ...rest }: AppShellProps) {
  return (
    <div className={cx('ui-app-shell', className)} {...rest}>
      {children}
    </div>
  );
}

export interface SidebarProps extends React.HTMLAttributes<HTMLElement> {
  brand?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}

export function Sidebar({ brand, footer, className, children, ...rest }: SidebarProps) {
  return (
    <aside className={cx('ui-sidebar', className)} {...rest}>
      {brand}
      <nav className="ui-nav">{children}</nav>
      {footer != null && <div className="ui-sidebar__foot">{footer}</div>}
    </aside>
  );
}

/** Brand block: mascot mark + wordmark. */
export interface SidebarBrandProps extends React.HTMLAttributes<HTMLDivElement> {
  name: ReactNode;
  markSrc?: string;
}
export function SidebarBrand({ name, markSrc = '/brand/timo-mascot.svg', className, ...rest }: SidebarBrandProps) {
  return (
    <div className={cx('ui-sidebar__brand', className)} {...rest}>
      <span className="ui-sidebar__mark" aria-hidden>
        <img src={markSrc} alt="" />
      </span>
      <span className="ui-sidebar__wordmark">{name}</span>
    </div>
  );
}

/** Eyebrow group head inside the nav. */
export function NavSection({ label, className, ...rest }: { label: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx('ui-nav-section ui-t-eyebrow', className)} {...rest}>
      {label}
    </div>
  );
}

/* NavItem — one nav link. `as` lets the app supply a router Link component;
   it defaults to a plain anchor. `active` drives the accent treatment (one
   active item only). Extra props (e.g. `to`) forward to the rendered element. */
export interface NavItemProps {
  label: ReactNode;
  icon?: ReactNode;
  active?: boolean;
  /** Element/component to render as (e.g. router Link). Defaults to <a>. */
  as?: React.ElementType;
  className?: string;
  // Allow router-specific props (to, params, …) to pass through.
  [key: string]: unknown;
}

export function NavItem({ label, icon, active, as, className, ...rest }: NavItemProps) {
  const Comp = (as ?? 'a') as React.ElementType;
  return (
    <Comp
      className={cx('ui-nav-item', active && 'is-active', className)}
      aria-current={active ? 'page' : undefined}
      {...rest}
    >
      {icon}
      <span>{label}</span>
    </Comp>
  );
}
