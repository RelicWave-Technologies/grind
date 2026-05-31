import { useRouteContext } from '@tanstack/react-router';

const ROLE_BLURB: Record<string, string> = {
  OWNER: 'You can see every user, every team, every screenshot in this workspace.',
  ADMIN: 'You can see every user, every team, every screenshot in this workspace.',
  MANAGER: 'You can see yourself plus everyone in the teams you manage.',
  MEMBER: 'You can see your own time, screenshots, and approvals.',
};

/**
 * Placeholder home. Subsequent phases replace this with the "My Day"
 * timesheet (M11/2) and the Approvals queue (M11/2). For now it just
 * confirms the cookie flow worked end-to-end and shows the scope the
 * user will see across the rest of the app.
 */
export function HomeScreen() {
  const { me } = useRouteContext({ from: '/authed' });

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="h1">Good to see you, {me.name.split(' ')[0]}.</h1>
          <p className="secondary page-sub">
            Signed in as {me.email} · <span className="role-chip">{me.role}</span>
          </p>
        </div>
      </header>

      <section className="card welcome-card">
        <h2 className="h2">Dashboard scaffold</h2>
        <p className="body" style={{ marginTop: 8 }}>{ROLE_BLURB[me.role]}</p>
        <p className="callout secondary" style={{ marginTop: 16 }}>
          The real screens land in the next phases:
        </p>
        <ul className="welcome-list">
          <li>My Day — your daily segment ribbon + tracked entries</li>
          <li>Approvals — manager review of manual-time requests</li>
          <li>Team timesheets — virtualized by user × day</li>
          <li>Screenshot gallery — with anti-cheat flags</li>
          <li>Heatmap, attendance, monthly reports</li>
        </ul>
      </section>
    </div>
  );
}
