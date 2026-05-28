import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

export default function Login() {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const mut = useMutation({
    mutationFn: () => window.agent.auth.login(email, password),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['authStatus'] });
    },
  });

  const error = mut.error instanceof Error ? mut.error.message : null;

  return (
    <div className="app">
      <div className="header">
        <span>Grind</span>
        <span className="badge">sign in</span>
      </div>

      <form
        className="no-drag"
        onSubmit={(e) => {
          e.preventDefault();
          if (!mut.isPending) mut.mutate();
        }}
      >
        <div style={{ marginBottom: 10 }}>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div style={{ marginBottom: 10 }}>
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button type="submit" disabled={mut.isPending || !email || !password}>
          {mut.isPending ? 'Signing in…' : 'Sign in'}
        </button>
        <div className="error" style={{ marginTop: 8 }}>{error ?? ' '}</div>
      </form>

      <div className="spacer" />
      <div className="footer">
        <span>internal • dogfood</span>
        <span>v0.0.1</span>
      </div>
    </div>
  );
}
