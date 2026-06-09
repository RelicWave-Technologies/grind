import './login.css';
import { useState, useEffect } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Camera, KeyRound, ShieldCheck, Timer } from 'lucide-react';
import { useLogin, useMe } from '../lib/auth';
import { ApiError } from '../lib/api';
import { Card, SidebarBrand, Field, Input, Button, Banner } from '../ui';

export function LoginScreen() {
  const navigate = useNavigate();
  const search = useSearch({ from: '/login' });
  const me = useMe();
  const login = useLogin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);

  // Already logged in? Bounce straight to /next.
  useEffect(() => {
    if (me.data) {
      navigate({ to: '/' });
    }
  }, [me.data, navigate]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await login.mutateAsync({ email: email.trim(), password });
      const next = search.next && search.next.startsWith('/') ? search.next : '/';
      navigate({ to: next });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setErr('Invalid email or password.');
      } else {
        setErr(e instanceof Error ? e.message : 'Sign-in failed.');
      }
    }
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
        <form className="lgn-form" onSubmit={onSubmit}>
          <div className="lgn-head">
            <SidebarBrand name="Grind" className="lgn-form-brand" />
            <div className="lgn-heading">
              <span className="ui-t-eyebrow">Workspace access</span>
              <h1 className="lgn-title">Sign in to Grind</h1>
              <p className="lgn-sub">Use your workspace credentials to open the dashboard.</p>
            </div>
          </div>

          <div className="lgn-fields">
            <Field label="Email">
              <Input
                type="email"
                autoComplete="username"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                error={!!err}
              />
            </Field>

            <Field label="Password">
              <Input
                type="password"
                autoComplete="current-password"
                placeholder="••••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                error={!!err}
              />
            </Field>
          </div>

          {err && <Banner status="danger">{err}</Banner>}

          <Button
            type="submit"
            variant="primary"
            size="lg"
            block
            loading={login.isPending}
            icon={<KeyRound size={15} />}
          >
            {login.isPending ? 'Signing in…' : 'Sign in'}
          </Button>

          <div className="lgn-access-note">
            <span className="ui-t-eyebrow">New account</span>
            <p className="ui-t-small">Ask your manager or admin to add you to the workspace.</p>
          </div>
        </form>
        </Card>
      </main>
    </div>
  );
}
