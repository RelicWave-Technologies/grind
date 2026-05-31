import { useState, useEffect } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useLogin, useMe } from '../lib/auth';
import { ApiError } from '../lib/api';

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
    <div className="login-wrap">
      <form className="login-card" onSubmit={onSubmit}>
        <div className="login-brand">
          <div className="login-mark" />
          <div className="login-name">Grind</div>
        </div>
        <h1 className="h1 login-title">Sign in</h1>
        <p className="login-sub secondary">
          Use the same credentials as the Grind tracker.
        </p>

        <label className="field">
          <span className="field-label">Email</span>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </label>

        <label className="field">
          <span className="field-label">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        {err && <div className="login-error" role="alert">{err}</div>}

        <button type="submit" className="btn-primary" disabled={login.isPending}>
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="login-foot small secondary">
          Trouble signing in? Ping IT — accounts are provisioned per workspace.
        </p>
      </form>
    </div>
  );
}
