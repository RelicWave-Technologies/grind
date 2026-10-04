import './pages.css';
import type { ReactNode } from 'react';
import { SiteShell } from './SiteShell';

/**
 * /privacy — what Timo records, why, who else handles it and for how long.
 * Every sentence here is checked against the code (2026-10-04); keep it that
 * way. When the code changes what it collects, keeps or shares, change this
 * page in the same commit and move the date.
 */

const UPDATED = 'October 4, 2026';

const SECTIONS: Array<{ id: string; title: string; body: ReactNode }> = [
  {
    id: 'short',
    title: 'In short',
    body: (
      <>
        <table className="pg-table">
          <thead><tr><th>What</th><th>Why</th><th>Who else handles it</th></tr></thead>
          <tbody>
            <tr><td>Your name, email and Lark profile</td><td>Your account and signing in</td><td>Lark, our database host</td></tr>
            <tr><td>Your working time</td><td>Your day, your team's reports, attendance</td><td>Our database host</td></tr>
            <tr><td>How many keys, clicks and scrolls per minute</td><td>Activity, and spotting automated input</td><td>Our database host</td></tr>
            <tr><td>Screenshots, every few minutes while tracking</td><td>Showing the work behind the time</td><td>Google Drive (or Cloudinary)</td></tr>
            <tr><td>Apps, window titles and page addresses</td><td>Only if your admin turns them on</td><td>Our database host</td></tr>
          </tbody>
        </table>
        <p>
          Timo never records what you type, what is on your clipboard, your microphone, your camera or where you are.
          We do not sell data, we do not show advertising, and there is no analytics or advertising tracking in Timo or
          on this website.
        </p>
      </>
    ),
  },
  {
    id: 'who',
    title: 'Who this is for',
    body: (
      <>
        <p>
          Timo is a time tracker made by EMIAC Technologies for EMIAC's own teams. It has two parts: a desktop app for
          Mac and Windows that counts working time, and a dashboard in the browser, at this address.
        </p>
        <p>
          If you use Timo, it is because your workspace, run by your employer, has given you an account. Your employer
          decides how Timo is set up for you: how often screenshots are taken, whether apps and titles are recorded,
          who your manager is. This page describes what the software does with each of those settings.
        </p>
      </>
    ),
  },
  {
    id: 'account',
    title: 'Your account',
    body: (
      <ul>
        <li>
          You sign in with Lark. From Lark we keep your name, email address, profile picture address and your Lark
          user identifiers, so we know which Timo account is yours.
        </li>
        <li>
          A first sign-in creates an account that can do nothing until an admin in your workspace switches it on.
        </li>
        <li>
          Signing in starts a session. The short-lived part lasts 15 minutes; the part that renews it lasts 90 days
          and renews each time you use Timo. We store only a scrambled (hashed) copy of it. On the desktop, your
          session is kept in your computer's own secure storage (Keychain on Mac).
        </li>
        <li>
          Lark gives Timo a token to act for you, which we keep encrypted. We record your device's name for each
          sign-in, so you can tell your sessions apart.
        </li>
      </ul>
    ),
  },
  {
    id: 'desktop',
    title: 'What the desktop app records',
    body: (
      <>
        <p>Only while the timer is running:</p>
        <ul>
          <li>
            <strong>Time.</strong> When you start and stop, which task the time was for, and whether a stretch was
            work, a meeting or idle.
          </li>
          <li>
            <strong>Activity, as counts.</strong> For each minute, how many keys were pressed, how many clicks and
            scrolls, and how far the mouse travelled. Timo never records which keys. It also keeps three timing
            measures with no content in them (how even your typing rhythm and mouse movements are), used only to spot
            automated input such as mouse jigglers.
          </li>
          <li>
            <strong>Screenshots.</strong> One of every screen, every 3 minutes unless your workspace sets 1 or 2. An
            admin or manager can set a different cadence for a member. A copy stays on your computer for up to 60 days.
            Timo does not blur screenshots, and there is no way to delete one yourself; they are deleted when the
            retention period ends (see <a href="#retention">How long we keep it</a>).
          </li>
          <li>
            <strong>Apps, window titles and page addresses.</strong> Three separate settings, all off unless an admin
            turns them on. When on, Timo looks at the window in front every 10 seconds, and the server drops anything
            your workspace has not turned on. With apps on, the app's icon is stored too.
          </li>
          <li>
            <strong>Idle.</strong> When there has been no input for a while (5 minutes unless your workspace sets
            otherwise), that time is marked idle and does not count. Admins can turn on a "still working?" countdown for
            chosen people.
          </li>
          <li>
            <strong>The app's health.</strong> Its version, your operating system, whether it is tracking, and whether
            it has the permissions it needs, so a problem shows up instead of time going missing.
          </li>
        </ul>
        <p>
          Timo never reads what you type, never reads your clipboard, and never uses your microphone, camera or
          location.
        </p>
      </>
    ),
  },
  {
    id: 'see',
    title: 'Who can see what',
    body: (
      <ul>
        <li><strong>You</strong> see your own time, reports, screenshots, activity and any flags raised about your activity.</li>
        <li>
          <strong>Your manager</strong> sees the same for their team: time, screenshots, apps and activity. They can
          correct the team's time, approve or reject requests for manual time, review flags, and change a team
          member's screenshot and idle settings.
        </li>
        <li>
          <strong>Admins</strong> see everything in the workspace and set its capture policy, teams, shifts and the
          payroll worksheet.
        </li>
        <li>
          <strong>Manual time</strong> you ask for is visible to whoever approves it, in the dashboard and in Lark. It
          does not count unless it is approved.
        </li>
      </ul>
    ),
  },
  {
    id: 'lark',
    title: 'Lark',
    body: (
      <>
        <p>
          Timo is a Lark app. When you sign in, Lark asks you to let Timo read your basic profile and email, read and
          update your tasks and task lists, send and update messages from the Timo bot, and read messages, chats and
          your calendar and meetings. Timo uses this to sign you in, show your tasks, and send approval cards, digests
          and reminders.
        </p>
        <p>
          The calendar and meeting permissions are asked for, but Timo does not read your calendar or meetings today.
        </p>
      </>
    ),
  },
  {
    id: 'others',
    title: 'Who else handles data',
    body: (
      <>
        <p>Timo uses a few services to do its work. Each receives only what that work needs.</p>
        <table className="pg-table">
          <thead><tr><th>Service</th><th>What it receives</th><th>Why</th></tr></thead>
          <tbody>
            <tr><td>Neon</td><td>Everything in your account except screenshot files</td><td>Our database</td></tr>
            <tr><td>Render</td><td>Every request to Timo's server, in the United States (Oregon)</td><td>Runs Timo's server</td></tr>
            <tr><td>Vercel</td><td>Your browser's requests for this website and the dashboard</td><td>Serves this website</td></tr>
            <tr><td>Google Drive</td><td>Screenshot files</td><td>Stores screenshots, in monthly folders</td></tr>
            <tr><td>Cloudinary</td><td>Screenshot files, only where Google Drive is not set up</td><td>Stores screenshots</td></tr>
            <tr><td>Lark</td><td>Approval cards, digests and reminders sent by the bot</td><td>Sign-in, tasks and approvals</td></tr>
            <tr><td>GitHub</td><td>The desktop app's requests for updates</td><td>Hosts the installers and updates</td></tr>
            <tr><td>Sentry</td><td>When switched on: an error, with the page, the request and your account ID</td><td>Finding and fixing errors</td></tr>
          </tbody>
        </table>
        <p>
          Profile pictures load from Lark's servers. This website's fonts are served by us, not by a font service.
        </p>
      </>
    ),
  },
  {
    id: 'retention',
    title: 'How long we keep it',
    body: (
      <ul>
        <li>
          <strong>Screenshots</strong> are kept for 60 days unless your workspace sets a different period. Every six
          hours, Timo removes the ones past it from your account and moves their files to the storage's bin.
        </li>
        <li>
          <strong>Time, activity, approvals and flags</strong> are kept for as long as the workspace exists, because
          they are the record your hours are paid on. There is no automatic deletion of them.
        </li>
        <li>
          <strong>A deactivated account</strong> is kept with its history. An admin can delete a member permanently,
          which deletes their records.
        </li>
        <li>
          <strong>Server logs</strong> of requests, including the address they came from and the browser's headers,
          are kept by Render under its own retention.
        </li>
      </ul>
    ),
  },
  {
    id: 'cookies',
    title: 'Cookies',
    body: (
      <>
        <p>
          Timo sets two cookies when you sign in to the dashboard: one keeps you signed in for 15 minutes at a time,
          the other renews it for up to 90 days. Neither can be read by scripts on the page, and neither is used for
          anything else.
        </p>
        <p>
          This website sets no cookies. It remembers, in your browser tab only, that you have already seen its opening
          animation, so it does not play twice.
        </p>
      </>
    ),
  },
  {
    id: 'api',
    title: "Timo's API",
    body: (
      <p>
        An admin can create a read-only key for tools such as Timo's MCP server. A key can read people (names, emails,
        roles, teams), the health of their desktop apps, time totals, manual-time requests, break summaries and flag
        counts. It cannot read screenshots, apps, titles, page addresses or raw activity. Keys are stored scrambled and
        can be revoked at any time.
      </p>
    ),
  },
  {
    id: 'choices',
    title: 'Your choices',
    body: (
      <ul>
        <li>Pause or stop the timer at any time; nothing is recorded while it is stopped.</li>
        <li>See your own time, screenshots and activity in the dashboard whenever you like.</li>
        <li>
          Ask your workspace's admin to correct your time, to change how Timo is set up for you, or to delete your
          account. For anything else, write to us.
        </li>
      </ul>
    ),
  },
  {
    id: 'contact',
    title: 'Changes and contact',
    body: (
      <p>
        When Timo changes what it records, keeps or shares, this page changes with it and the date at the top moves.
        Questions about this policy go to <a href="mailto:inc@emiac.us?subject=Timo%20privacy">inc@emiac.us</a>.
      </p>
    ),
  },
];

export function PrivacyScreen() {
  return (
    <SiteShell page="privacy" title="Privacy policy · Timo">
      <header className="site-wrap pg-hero">
        <p className="pg-eyebrow rise">Privacy policy</p>
        <h1 className="rise">Your hours, your screen,<br />and where they go.</h1>
        <p className="pg-lede rise">
          Timo counts working time and takes screenshots, so it should say plainly what that involves. This page does:
          what Timo records, why, who can see it, who else handles it, and how long it is kept.
        </p>
        <p className="pg-meta rise"><span>Last updated {UPDATED}</span><span>Applies to Timo and this website</span></p>
      </header>

      <div className="site-wrap pg-doc">
        <nav className="pg-toc" aria-label="On this page">
          <p>On this page</p>
          {SECTIONS.map((s) => <a key={s.id} href={`#${s.id}`}>{s.title}</a>)}
        </nav>
        <div className="pg-prose">
          {SECTIONS.map((s) => (
            <section key={s.id} id={s.id}>
              <h2>{s.title}</h2>
              {s.body}
            </section>
          ))}
        </div>
      </div>
    </SiteShell>
  );
}
