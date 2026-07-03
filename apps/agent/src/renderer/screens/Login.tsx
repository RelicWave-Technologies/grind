import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import timoMascot from '../assets/timo-mascot.png';

/** Friendly copy for non-success Lark outcomes pushed from the main process. */
const ERROR_COPY: Record<string, string> = {
  denied: 'Sign-in was cancelled.',
  temporary: 'Lark had a temporary hiccup. Please try again.',
  auth_failed: 'Sign-in failed. Please try again.',
  no_email: 'Timo couldn’t read an email from your Lark account. Ask your admin to grant the email permission.',
  deactivated: 'Your account is deactivated. Contact your workspace admin.',
  state_invalid: 'That sign-in link expired. Please try again.',
  invalid_request: 'Something went wrong starting sign-in. Please try again.',
  config: 'Single sign-on isn’t configured yet. Contact your admin.',
};

export default function Login() {
  const [phase, setPhase] = useState<'idle' | 'waiting' | 'pending' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  // The main process pushes pending/error outcomes back after the browser round-trip.
  useEffect(() => {
    return window.agent.auth.onLarkOutcome((o) => {
      if (o.kind === 'pending') {
        setPhase('pending');
        setMessage(null);
      } else {
        setPhase('error');
        setMessage(ERROR_COPY[o.reason] ?? 'Sign-in failed. Please try again.');
      }
    });
  }, []);

  async function signIn() {
    if (opening) return;
    setOpening(true);
    setPhase('waiting');
    setMessage(null);
    try {
      await window.agent.auth.loginWithLark();
    } catch {
      setPhase('error');
      setMessage('Could not open your browser for Lark sign-in. Please try again.');
    } finally {
      setOpening(false);
    }
  }

  return (
    <div className="login">
      <div className="login-card">
        <div className="login-logo">
          <img src={timoMascot} alt="Timo" width={82} height={82} />
        </div>
        <div className="login-title">
          <div className="h2">Sign in to Timo</div>
          <div className="callout secondary" style={{ marginTop: 4 }}>
            Continue with your Lark account
          </div>
        </div>

        {phase === 'pending' && (
          <div className="callout secondary" style={{ marginTop: 12, textAlign: 'center' }}>
            Your account is awaiting setup. An admin will assign your team and role — you’ll have
            access right after. Try signing in again once they’ve set you up.
          </div>
        )}
        {phase === 'error' && message && (
          <div className="error-text" style={{ marginTop: 12 }}>{message}</div>
        )}
        {phase === 'waiting' && (
          <div className="callout secondary" style={{ marginTop: 12, textAlign: 'center' }}>
            Continue in your browser, then return here.
          </div>
        )}

        <button
          className="btn btn-prominent btn-lg"
          type="button"
          onClick={signIn}
          disabled={opening}
          style={{ marginTop: 16, display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}
        >
          <ShieldCheck size={16} strokeWidth={2} />
          {opening ? 'Opening browser…' : phase === 'waiting' ? 'Open Lark again' : 'Continue with Lark'}
        </button>
      </div>
    </div>
  );
}
