import './login.css';
import { useEffect } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMe, larkLoginUrl } from '../lib/auth';
import { AGENT_DOWNLOADS, agentDownloadUrl } from '../lib/downloads';
import { Card, Button, Banner } from '../ui';

/** Friendly copy for each terminal outcome the API hands back via ?status/?error. */
const OUTCOME_COPY: Record<string, { status: 'danger' | 'warn' | 'info'; text: string }> = {
  pending: { status: 'info', text: 'Your account is awaiting setup. An admin will finish your team, shift, and access activation.' },
  denied: { status: 'warn', text: 'Sign-in was cancelled.' },
  temporary: { status: 'warn', text: 'Lark had a temporary hiccup. Please try again.' },
  auth_failed: { status: 'danger', text: 'Sign-in failed. Please try again.' },
  no_email: { status: 'danger', text: 'Timo couldn’t read an email from your Lark account. Ask your admin to grant the email permission.' },
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

  async function signIn() {
    const current = await me.refetch();
    if (current.data) {
      navigate({ to: '/' });
      return;
    }
    // Top-level navigation (not a fetch) so the OAuth redirect chain works.
    window.location.assign(larkLoginUrl());
  }

  return (
    <div className="lgn-page">
      <main className="lgn-shell ui-rise" aria-label="Timo workspace access">
        <Card className="lgn-card">
          <div className="lgn-form">
            <div className="lgn-head">
              <img className="lgn-mascot" src="/brand/timo-mascot.svg" alt="" />
              <div className="lgn-copy">
                <h1 className="lgn-title">Sign in to Timo</h1>
                <p className="lgn-sub">Continue with your Lark account</p>
              </div>
            </div>

            {outcome && <Banner status={outcome.status}>{outcome.text}</Banner>}

            <Button
              type="button"
              variant="primary"
              size="lg"
              block
              onClick={signIn}
              disabled={me.isFetching}
              icon={<img className="lgn-lark-icon" src="/brand/lark.svg" alt="" />}
              className="lgn-submit"
            >
              {me.isFetching ? 'Checking...' : 'Continue with Lark'}
            </Button>

            <div className="lgn-downloads" aria-label="Download Timo app">
              {AGENT_DOWNLOADS.map((option) => (
                <a
                  key={option.platform}
                  className="ui-btn ui-btn--secondary ui-btn--md lgn-download"
                  href={agentDownloadUrl(option.platform)}
                >
                  <span className="ui-btn__icon" aria-hidden="true">
                    <img className="lgn-platform-logo" src={option.iconSrc} alt="" />
                  </span>
                  <span className="ui-btn__label">{option.label}</span>
                </a>
              ))}
            </div>
          </div>
        </Card>
      </main>
    </div>
  );
}
