import './pages.css';
import { SiteShell } from './SiteShell';
import { AUGUST, FOUNDATION, JULY, JUNE, LATEST, PLATFORM, TAG_LABEL } from './releases';
import type { Release, Tag } from './releases';

/**
 * /changelog — every Timo release in plain words, newest first, in the
 * layout of the Crux changelog: the version and date on the left, what
 * changed on the right, grouped by kind. Public, outside the auth gate: it
 * carries no workspace data.
 */

const ORDER: Tag[] = ['new', 'improved', 'fixed', 'internal'];

function title(name: string) {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** "AUG 19, 2026 · MAC + WINDOWS" → "Aug 19, 2026" and "Mac and Windows". */
function when(meta: string) {
  const [date = '', where = ''] = meta.split(' · ');
  const words = (s: string) => s.toLowerCase().replace(/(^|\s)\w/g, (c) => c.toUpperCase());
  const sentence = where.toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
  const place = sentence.replace(' + ', ' and ').replace(/\bmac\b/i, 'Mac').replace(/\bwindows\b/i, 'Windows');
  return { date: words(date), where: place };
}

function Entry({ release, latest = false }: { release: Release; latest?: boolean }) {
  const { date, where } = when(release.meta);
  return (
    <article className="pg-entry reveal" id={release.id}>
      <div className="pg-entry-side">
        <h3>{release.version}</h3>
        <p>{date}</p>
        {where && <p className="pg-entry-where">{where}</p>}
        {latest && <span className="pg-latest">Latest</span>}
      </div>
      <div className="pg-entry-body">
        <h2>{title(release.name)}</h2>
        {release.lead && <p className="pg-entry-lead">{release.lead}</p>}
        {ORDER.map((tag) => {
          const items = release.changes.filter((c) => c.tag === tag);
          if (items.length === 0) return null;
          return (
            <div key={tag} className="pg-group">
              <h4>{TAG_LABEL[tag]}</h4>
              <ul>{items.map((c, i) => <li key={i}>{c.text}</li>)}</ul>
            </div>
          );
        })}
        {release.extra}
      </div>
    </article>
  );
}

export function ChangelogScreen() {
  return (
    <SiteShell page="changelog" title="Changelog · Timo">
      <header className="site-wrap pg-hero">
        <p className="pg-eyebrow rise">Changelog</p>
        <h1 className="rise">What's new in Timo.</h1>
        <p className="pg-lede rise">
          Every release, in plain words. Timo updates itself, so each one reaches you the next time you restart it.
          Some added things, some fixed what the last one broke. All of it is here.
        </p>
        <div className="pg-actions rise">
          <a className="site-btn site-btn--primary" href="#latest">Read the latest</a>
          <a className="site-btn site-btn--quiet" href="https://github.com/RelicWave-Technologies/grind/releases" target="_blank" rel="noreferrer">Releases on GitHub</a>
        </div>
      </header>

      <div className="site-wrap pg-entries" id="latest">
        <Entry release={LATEST} latest />
        {[...AUGUST, ...JULY, ...JUNE].map((r) => <Entry key={r.id} release={r} />)}
      </div>

      <section className="site-wrap pg-section" id="platform">
        <div className="pg-entry reveal">
          <div className="pg-entry-side">
            <h3>Platform</h3>
            <p>Dashboard, API, Lark</p>
          </div>
          <div className="pg-entry-body">
            <h2>The other half just ships.</h2>
            <p className="pg-entry-lead">
              The desktop app gets version numbers. The dashboard, API and Lark bot deploy quietly behind them:
              additive migrations, no drama.
            </p>
            <dl className="pg-rows">
              {PLATFORM.map((p, i) => (
                <div key={i}>
                  <dt>{p.date.toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</dt>
                  <dd>{p.text}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      <section className="site-wrap pg-section" id="foundation">
        <div className="pg-entry reveal">
          <div className="pg-entry-side">
            <h3>Foundation</h3>
            <p>Before the betas</p>
          </div>
          <div className="pg-entry-body">
            <h2>Five months of milestones.</h2>
            <p className="pg-entry-lead">
              The betas were the last mile. Under them, milestones built in order and actually launched at the end of
              each one. No vibes, gates.
            </p>
            <dl className="pg-rows">
              {FOUNDATION.map(([m, what]) => (
                <div key={m}><dt>{m}</dt><dd>{what}</dd></div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      <section className="site-wrap pg-section" id="shipping">
        <div className="pg-entry reveal">
          <div className="pg-entry-side">
            <h3>Shipping</h3>
            <p>How a release reaches you</p>
          </div>
          <div className="pg-entry-body">
            <h2>Small, often, and never twice under the same number.</h2>
            <dl className="pg-rows">
              <div><dt>Channel</dt><dd>GitHub Releases feeds the built-in updater. You click “Restart to update”. That's your whole job.</dd></div>
              <div><dt>macOS</dt><dd>Signed with a Developer ID and notarised by Apple since beta.11. A DMG to install, a ZIP to update.</dd></div>
              <div><dt>Windows</dt><dd>An NSIS installer, unsigned for v1 and installed by our IT team.</dd></div>
              <div><dt>Versions</dt><dd>Never reused. A number that touches a machine is spent. Ask beta.26.</dd></div>
            </dl>
          </div>
        </div>
      </section>
    </SiteShell>
  );
}
