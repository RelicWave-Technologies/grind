import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, PictureInPicture2 } from 'lucide-react';
import type { AppTheme, Appearance, PillTheme } from '../../../shared/appearance';

const APP_THEMES: ReadonlyArray<{ value: AppTheme; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const PILL_THEMES: ReadonlyArray<{ value: PillTheme; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** Light, dark or system for the app, and a separate choice for the floating pill. */
export default function AppearanceSection() {
  const qc = useQueryClient();
  const appearance = useQuery({ queryKey: ['appearance'], queryFn: () => window.agent.settings.getAppearance() });
  const save = useMutation({
    mutationFn: (patch: Partial<Appearance>) => window.agent.settings.setAppearance(patch),
    onSuccess: (next) => {
      qc.setQueryData<Appearance>(['appearance'], next);
    },
  });

  useEffect(() => window.agent.settings.onAppearanceChange((next) => {
    qc.setQueryData<Appearance>(['appearance'], next);
  }), [qc]);

  const a = appearance.data;
  return (
    <div className="set-card">
      <div className="set-row">
        <span className="set-ic"><Monitor size={17} strokeWidth={2} /></span>
        <div className="set-main">
          <div className="set-title">App</div>
          <div className="set-sub secondary">System follows your {navigator.platform.startsWith('Mac') ? 'Mac' : 'computer'}’s light or dark setting.</div>
        </div>
        <Choice label="App theme" items={APP_THEMES} value={a?.app} onChange={(app) => save.mutate({ app })} />
      </div>
      <div className="set-row">
        <span className="set-ic"><PictureInPicture2 size={17} strokeWidth={2} /></span>
        <div className="set-main">
          <div className="set-title">Floating timer bar</div>
          <div className="set-sub secondary">Set on its own, so the bar stands out over whatever app is behind it.</div>
        </div>
        <Choice label="Floating bar theme" items={PILL_THEMES} value={a?.pill} onChange={(pill) => save.mutate({ pill })} />
      </div>
    </div>
  );
}

/** A segmented choice: a `sheet` track with the chosen item filled `ink` (DESIGN.md §9 Tabs). */
function Choice<V extends string>({
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  items: ReadonlyArray<{ value: V; label: string }>;
  value: V | undefined;
  onChange: (value: V) => void;
}) {
  return (
    <div className="choice no-drag" role="radiogroup" aria-label={label}>
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="radio"
          aria-checked={it.value === value}
          className={`choice-item${it.value === value ? ' on' : ''}`}
          onClick={() => onChange(it.value)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
