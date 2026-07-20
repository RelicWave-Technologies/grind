import './login.css';
import { useEffect, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMe, larkLoginUrl } from '../lib/auth';
import { api, ApiError } from '../lib/api';
import { AGENT_DOWNLOADS, agentDownloadUrl } from '../lib/downloads';

/**
 * /login — DESIGN.md-strict sign-in: white canvas, one compact lilac color
 * block, the black pill CTA, mono taxonomy, and a circular back button to
 * the landing page. Lark OAuth is the only real door; the password form is
 * a dev-only shim that never ships enabled.
 */

/** Friendly copy for each terminal outcome the API hands back via ?status/?error. */
const OUTCOME_COPY: Record<string, { kind: 'info' | 'warn' | 'danger'; label: string; text: string }> = {
  pending: { kind: 'info', label: 'ALMOST', text: "You're in the door — an admin still has to hand you a desk. Team, shift and access are being set up." },
  denied: { kind: 'warn', label: 'NO WORRIES', text: 'Sign-in cancelled. The clock respects your decision.' },
  temporary: { kind: 'warn', label: 'ONE SEC', text: 'Lark hiccuped. Give it a moment and try again.' },
  auth_failed: { kind: 'danger', label: 'TRY AGAIN', text: "That didn't work. The clock isn't going anywhere." },
  no_email: { kind: 'danger', label: 'MISSING EMAIL', text: "Lark wouldn't share your email. Ask your admin to grant the email permission." },
  deactivated: { kind: 'danger', label: 'LOCKED', text: 'This account is deactivated. Your workspace admin holds the keys.' },
  state_invalid: { kind: 'warn', label: 'EXPIRED', text: "That sign-in link expired. A fresh one is a click away." },
  invalid_request: { kind: 'warn', label: 'HMM', text: 'Something went sideways starting sign-in. Try again.' },
  config: { kind: 'danger', label: 'NOT WIRED', text: "Single sign-on isn't configured yet. Poke your admin." },
};

const DEV_PASSWORD_LOGIN = import.meta.env.DEV && import.meta.env.VITE_ENABLE_PASSWORD_LOGIN === 'true';

export function LoginScreen() {
  const navigate = useNavigate();
  const search = useSearch({ from: '/login' });
  const me = useMe();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [devError, setDevError] = useState<string | null>(null);
  const [devLoading, setDevLoading] = useState(false);

  // Already logged in? Bounce straight to the dashboard.
  useEffect(() => {
    if (me.data) {
      navigate({ to: '/home' });
    }
  }, [me.data, navigate]);

  const outcome = search.status === 'pending'
    ? OUTCOME_COPY.pending
    : search.error
      ? OUTCOME_COPY[search.error] ?? OUTCOME_COPY.auth_failed
      : null;

  async function signIn() {
    const current = await me.refetch();
    if (current.data) {
      navigate({ to: '/home' });
      return;
    }
    // Top-level navigation (not a fetch) so the OAuth redirect chain works.
    window.location.assign(larkLoginUrl());
  }

  async function signInWithPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDevError(null);
    setDevLoading(true);
    try {
      await api('/v1/auth/login', {
        method: 'POST',
        json: { email, password, deviceName: 'Local dashboard' },
      });
      await me.refetch();
      navigate({ to: '/home' });
    } catch (error) {
      setDevError(error instanceof ApiError ? error.message : 'login_failed');
    } finally {
      setDevLoading(false);
    }
  }

  return (
    <div className="lgn-page">
      {/* Chrome: circular back button + wordmark, both roads home. */}
      <header className="lgn-top">
        <a className="lgn-back" href="/" aria-label="Back to the landing page">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M10 3 5 8l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </a>
        <a className="lgn-brand" href="/">
          <img src="/brand/timo-mascot.svg" alt="" width={26} height={26} />
          <span>Timo</span>
        </a>
      </header>

      <main className="lgn-shell rise" aria-label="Sign in to Timo">
        {/* The one color block on this page: a compact lilac panel. */}
        <section className="lgn-panel">
          <img className="lgn-mascot" src="/brand/timo-mascot.svg" alt="" width={56} height={56} />
          <p className="lgn-eyebrow">TIMO — SIGN IN</p>
          <h1 className="lgn-title">Back on the clock.</h1>
          <p className="lgn-sub">
            Sign in with Lark and Timo picks up counting right where you left
            off. It missed you — quietly, in numbers.
          </p>

          {outcome && (
            <div className={`lgn-note lgn-note--${outcome.kind}`} role={outcome.kind === 'danger' ? 'alert' : 'status'}>
              <span className="lgn-note-label">{outcome.label}</span>
              <span>{outcome.text}</span>
            </div>
          )}

          <button type="button" className="lgn-pill lgn-pill--primary" onClick={signIn} disabled={me.isFetching}>
            <img className="lgn-lark" src="/brand/lark.svg" alt="" width={18} height={18} />
            {me.isFetching ? 'Checking…' : 'Continue with Lark'}
          </button>

          {DEV_PASSWORD_LOGIN && (
            <form className="lgn-dev" onSubmit={signInWithPassword}>
              <p className="lgn-cap lgn-dev-cap">DEV DOOR — LOCALS ONLY</p>
              {devError && (
                <div className="lgn-note lgn-note--danger" role="alert">
                  <span className="lgn-note-label">NOPE</span>
                  <span>{devError}</span>
                </div>
              )}
              <input
                className="lgn-input"
                type="email"
                value={email}
                placeholder="you@dev.local"
                autoComplete="username"
                onChange={(event) => setEmail(event.target.value)}
                aria-label="Email"
              />
              <input
                className="lgn-input"
                type="password"
                value={password}
                placeholder="password"
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
                aria-label="Password"
              />
              <button type="submit" className="lgn-pill lgn-pill--secondary" disabled={devLoading}>
                {devLoading ? 'Signing in…' : 'Sign in with password'}
              </button>
            </form>
          )}
        </section>

        {/* Below the panel: quiet exits. */}
        <div className="lgn-foot">
          <p className="lgn-cap">NO APP YET?</p>
          <div className="lgn-downloads" aria-label="Download Timo">
            {AGENT_DOWNLOADS.map((option) => (
              <a key={option.platform} className="lgn-pill lgn-pill--ghost" href={agentDownloadUrl(option.platform)}>
                <img src={option.iconSrc} alt="" width={15} height={15} />
                {option.label}
              </a>
            ))}
          </div>
          <a className="lgn-tour" href="/">← Take the tour first</a>
        </div>
      </main>
    </div>
  );
}
