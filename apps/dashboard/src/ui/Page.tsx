import { createContext, useContext, type ReactNode } from 'react';
import { cx } from './util';

/* §5.1 Page — the centered column every page lives in. Sets max-width, gutter,
   and the mount animation. Every page's root. */
export interface PageProps extends React.HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function Page({ children, className, ...rest }: PageProps) {
  return (
    <div className={cx('ui-page', className)} {...rest}>
      {children}
    </div>
  );
}

/* The tab bar for pages that share one sidebar item (People · Team settings ·
   Teams). The app layout provides it; the page's own header draws it under the
   title, where every other tab row sits, so the title stays the first thing in
   the content column (DESIGN.md §5). */
export const SectionTabsContext = createContext<ReactNode>(null);

/* §5.2 PageHeader — the single header construct for all 13 pages.
   Eyebrow → Title → optional subtitle on the left; an `actions` slot (a Toolbar)
   on the right; an optional `tabs` row docks onto the bottom hairline. */
export interface PageHeaderProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode;
  eyebrow?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
}

export function PageHeader({
  title,
  eyebrow,
  subtitle,
  actions,
  tabs,
  className,
  ...rest
}: PageHeaderProps) {
  const sectionTabs = useContext(SectionTabsContext);
  const tabRow =
    sectionTabs != null && tabs != null ? (
      <>
        {sectionTabs}
        {tabs}
      </>
    ) : (
      sectionTabs ?? tabs
    );
  return (
    <header
      className={cx('ui-page-head', tabRow != null && 'ui-page-head--with-tabs', className)}
      {...rest}
    >
      <div className="ui-page-head__text">
        {eyebrow != null && (
          <span className="ui-page-head__eyebrow ui-t-eyebrow">{eyebrow}</span>
        )}
        <h1 className="ui-page-head__title ui-t-title">{title}</h1>
        {subtitle != null && (
          <p className="ui-page-head__sub ui-t-small">{subtitle}</p>
        )}
      </div>
      {actions != null && <div className="ui-page-head__actions">{actions}</div>}
      {tabRow != null && <div className="ui-page-head__tabs">{tabRow}</div>}
    </header>
  );
}
