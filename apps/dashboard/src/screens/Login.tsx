import './login.css';
import { useState, useEffect } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
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
      <Card className="lgn-card">
        <form className="lgn-form" onSubmit={onSubmit}>
          <div className="lgn-head">
            <SidebarBrand name="Grind" />
            <div className="lgn-heading">
              <span className="ui-t-eyebrow">Workspace access</span>
              <h1 className="ui-t-title">Sign in</h1>
              <p className="ui-t-small">Use the same credentials as the Grind tracker.</p>
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

          <Button type="submit" variant="primary" block loading={login.isPending}>
            {login.isPending ? 'Signing in…' : 'Sign in'}
          </Button>

          <p className="ui-t-small">
            Trouble signing in? Ping IT — accounts are provisioned per workspace.
          </p>
        </form>
      </Card>
    </div>
  );
}
