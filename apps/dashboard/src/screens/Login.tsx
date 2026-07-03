import './login.css';
import { useEffect } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMe, larkLoginUrl } from '../lib/auth';
import { Card, SidebarBrand, Button, Banner } from '../ui';

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
              <SidebarBrand name="Timo" className="lgn-brand" />
              <h1 className="lgn-title">Sign in</h1>
            </div>

            {outcome && <Banner status={outcome.status}>{outcome.text}</Banner>}

            <Button
              type="button"
              variant="primary"
              size="lg"
              block
              onClick={signIn}
              disabled={me.isFetching}
              icon={<LarkIcon />}
            >
              {me.isFetching ? 'Checking...' : 'Continue with Lark'}
            </Button>
          </div>
        </Card>
      </main>
    </div>
  );
}

function LarkIcon() {
  return (
    <svg className="lgn-lark-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path fill="#00B96B" d="M10 2.2c2.6 0 4.8 2.1 4.8 4.8v1.1h-3.9V7c0-.5-.4-.9-.9-.9s-.9.4-.9.9v3.9H7.9C5.3 10.9 3.2 8.7 3.2 6.1S5.3 2.2 7.9 2.2H10Z" />
      <path fill="#3370FF" d="M2.2 10c0-2.6 2.1-4.8 4.8-4.8h1.1v3.9H7c-.5 0-.9.4-.9.9s.4.9.9.9h3.9v1.2c0 2.6-2.1 4.7-4.8 4.7S2.2 14.7 2.2 12.1V10Z" />
      <path fill="#FF6B4A" d="M10 17.8c-2.6 0-4.8-2.1-4.8-4.8v-1.1h3.9V13c0 .5.4.9.9.9s.9-.4.9-.9V9.1h1.2c2.6 0 4.7 2.1 4.7 4.8s-2.1 3.9-4.7 3.9H10Z" />
      <path fill="#FFC60A" d="M17.8 10c0 2.6-2.1 4.8-4.8 4.8h-1.1v-3.9H13c.5 0 .9-.4.9-.9s-.4-.9-.9-.9H9.1V7.9c0-2.6 2.1-4.7 4.8-4.7s3.9 2.1 3.9 4.7V10Z" />
    </svg>
  );
}
