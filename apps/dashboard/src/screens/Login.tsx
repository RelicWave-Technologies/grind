import './login.css';
import { useEffect } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Camera, ShieldCheck, Timer } from 'lucide-react';
import { useMe, larkLoginUrl } from '../lib/auth';
import { Card, SidebarBrand, Button, Banner } from '../ui';

/** Friendly copy for each terminal outcome the API hands back via ?status/?error. */
const OUTCOME_COPY: Record<string, { status: 'danger' | 'warn' | 'info'; text: string }> = {
  pending: { status: 'info', text: 'Your account is awaiting setup. An admin will assign your team and role — you’ll have access right after.' },
  denied: { status: 'warn', text: 'Sign-in was cancelled.' },
  temporary: { status: 'warn', text: 'Lark had a temporary hiccup. Please try again.' },
  auth_failed: { status: 'danger', text: 'Sign-in failed. Please try again.' },
  no_email: { status: 'danger', text: 'Grind couldn’t read an email from your Lark account. Ask your admin to grant the email permission.' },
  deactivated: { status: 'danger', text: 'Your account is deactivated. Contact your workspace admin.' },
  state_invalid: { status: 'warn', text: 'That sign-in link expired. Please try again.' },
  invalid_request: { status: 'warn', text: 'Something went wrong starting sign-in. Please try again.' },
  config: { status: 'danger', text: 'Single sign-on isn’t configured yet. Contact your admin.' },
};

export function LoginScreen() {
  const navigate = useNavigate();
  const search = useSearch({ from: '/login' });
  const me = useMe();

  // Already logged in? Bounce straight to the dashboard.
  useEffect(() => {
    if (me.data) {
      navigate({ to: '/' });
    }
  }, [me.data, navigate]);

  const outcome = search.status === 'pending'
    ? OUTCOME_COPY.pending
    : search.error
      ? OUTCOME_COPY[search.error] ?? OUTCOME_COPY.auth_failed
      : null;

  function signIn() {
    // Top-level navigation (not a fetch) so the OAuth redirect chain works.
    window.location.assign(larkLoginUrl());
  }

  return (
    <div className="lgn-page">
      <main className="lgn-shell" aria-label="Grind workspace access">
        <section className="lgn-story ui-rise" aria-label="Grind overview">
          <div className="lgn-story-copy">
            <SidebarBrand name="Grind" className="lgn-story-brand" />
            <span className="ui-t-eyebrow">Workspace time tracker</span>
            <h2 className="lgn-story-title">Transparent time tracking for focused teams.</h2>
            <p className="lgn-story-sub">
              Time, screenshots, approvals, and policy stay visible to the people who need them.
              Nothing more.
            </p>
          </div>

          <div className="lgn-proof-list" aria-label="Product guarantees">
            <div className="lgn-proof-row">
              <span className="lgn-proof-icon"><Timer size={18} /></span>
              <div>
                <span className="ui-t-strong">Honest time</span>
                <span className="ui-t-small">Tracked, meeting, idle-trimmed, and manual time stay separate.</span>
              </div>
            </div>
            <div className="lgn-proof-row">
              <span className="lgn-proof-icon"><Camera size={18} /></span>
              <div>
                <span className="ui-t-strong">Bounded capture</span>
                <span className="ui-t-small">Screenshot retention and capture rules are workspace policy.</span>
              </div>
            </div>
            <div className="lgn-proof-row">
              <span className="lgn-proof-icon"><ShieldCheck size={18} /></span>
              <div>
                <span className="ui-t-strong">Private activity</span>
                <span className="ui-t-small">Activity uses counts and timing signals, never typed content.</span>
              </div>
            </div>
          </div>
        </section>

        <Card className="lgn-card ui-rise-1">
        <div className="lgn-form">
          <div className="lgn-head">
            <SidebarBrand name="Grind" className="lgn-form-brand" />
            <div className="lgn-heading">
              <span className="ui-t-eyebrow">Workspace access</span>
              <h1 className="lgn-title">Sign in to Grind</h1>
              <p className="lgn-sub">Continue with your Lark account to open the dashboard.</p>
            </div>
          </div>

          {outcome && <Banner status={outcome.status}>{outcome.text}</Banner>}

          <Button
            type="button"
            variant="primary"
            size="lg"
            block
            onClick={signIn}
            icon={<ShieldCheck size={15} />}
          >
            Continue with Lark
          </Button>

          <div className="lgn-access-note">
            <span className="ui-t-eyebrow">New account</span>
            <p className="ui-t-small">Sign in once with Lark; an admin assigns your team and role.</p>
          </div>
        </div>
        </Card>
      </main>
    </div>
  );
}
