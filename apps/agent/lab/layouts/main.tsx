/**
 * /lab/layouts/ — the chosen structure for the desktop app's main window
 * (Focus), on one made-up day, clickable. Dev-only, like the rest of lab/.
 */
import '@grind/design';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DayProvider, type Mode } from './model';
import OptionFocus from './o5-focus';
import './page.css';

const MODES: { id: Mode; label: string }[] = [
  { id: 'running', label: 'Tracking' },
  { id: 'paused', label: 'Paused' },
  { id: 'idle', label: 'Not tracking' },
];

function Page() {
  const [mode, setMode] = useState<Mode>('running');
  return (
    <>
      <header className="pg-bar">
        <span className="pg-title">Timo desktop <span>· Focus</span></span>
        <span className="pg-note">Clickable: Tasks, My day, settings, the task name, pause and stop all work.</span>
        <span className="pg-modes" role="radiogroup" aria-label="State">
          {MODES.map((m) => (
            <button key={m.id} role="radio" aria-checked={mode === m.id} className={mode === m.id ? 'on' : ''} onClick={() => setMode(m.id)}>
              {m.label}
            </button>
          ))}
        </span>
      </header>
      <main className="pg-main">
        <div id="focus" className="pg-stage">
          <DayProvider mode={mode}>
            <OptionFocus />
          </DayProvider>
        </div>
      </main>
    </>
  );
}

createRoot(document.getElementById('layouts-root')!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
