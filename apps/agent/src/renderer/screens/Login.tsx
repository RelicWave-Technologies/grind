import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Timer } from 'lucide-react';

export default function Login() {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const mut = useMutation({
    mutationFn: () => window.agent.auth.login(email, password),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['authStatus'] }),
  });

  const error = mut.error instanceof Error ? 'Invalid email or password' : null;

  return (
    <div className="login">
      <form
        className="login-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (!mut.isPending) mut.mutate();
        }}
      >
        <div className="login-logo">
          <Timer size={24} strokeWidth={2} />
        </div>
        <div className="login-title">
          <div className="h2">Sign in to Grind</div>
          <div className="callout secondary" style={{ marginTop: 4 }}>
            Track your time across projects
          </div>
        </div>

        <div className="stack" style={{ marginTop: 8 }}>
          <div>
            <label className="field-label" htmlFor="email">Email</label>
            <input
              id="email"
              className="field selectable"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="field-label" htmlFor="password">Password</label>
            <input
              id="password"
              className="field selectable"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
        </div>

        <div className="error-text">{error ?? ' '}</div>

        <button className="btn btn-prominent btn-lg" type="submit" disabled={mut.isPending || !email || !password}>
          {mut.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
