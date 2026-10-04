import { useEffect, useState, type ComponentType } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Info, Plug, ShieldCheck, SlidersHorizontal, X, type LucideIcon } from 'lucide-react';
import GeneralSection from './settings/General';
import PermissionsSection from './settings/Permissions';
import IntegrationsSection from './settings/Integrations';
import AboutSection from './settings/About';

type SectionId = 'general' | 'permissions' | 'integrations' | 'about';

const SECTIONS: ReadonlyArray<{
  id: SectionId;
  label: string;
  description: string;
  Icon: LucideIcon;
  Body: ComponentType;
}> = [
  { id: 'general', label: 'General', description: 'How Timo starts, and the floating timer bar.', Icon: SlidersHorizontal, Body: GeneralSection },
  { id: 'permissions', label: 'Permissions', description: 'What your Mac lets Timo see while the timer runs.', Icon: ShieldCheck, Body: PermissionsSection },
  { id: 'integrations', label: 'Integrations', description: 'Where the tasks you track come from.', Icon: Plug, Body: IntegrationsSection },
  { id: 'about', label: 'About', description: 'Updates and the version you are running.', Icon: Info, Body: AboutSection },
];

/**
 * Settings as a modal with a section list on the left and one section at a
 * time on the right. A small dot on a section says it needs you (a missing
 * permission, Lark to reconnect, an update waiting, startup not set up).
 */
export default function Settings({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [section, setSection] = useState<SectionId>('general');
  const needs = useSectionNeeds();
  const info = useQuery({ queryKey: ['settings'], queryFn: () => window.agent.settings.get(), refetchInterval: 4000 });

  useEffect(() => {
    return window.agent.updates.onStatusChange((s) => {
      qc.setQueryData(['updates'], s);
    });
  }, [qc]);

  useEffect(() => {
    let alive = true;
    void window.agent.updates.checkQuietly()
      .then((s) => {
        if (alive) qc.setQueryData(['updates'], s);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [qc]);

  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]!;
  const Body = current.Body;

  return (
    <div className="set-modal">
      <nav className="set-nav" aria-label="Settings sections">
        <span className="set-nav-eyebrow">Settings</span>
        {SECTIONS.map(({ id, label, Icon }) => (
          <button
            key={id}
            className={`set-nav-item no-drag${id === section ? ' on' : ''}`}
            onClick={() => setSection(id)}
            aria-current={id === section ? 'page' : undefined}
          >
            <Icon size={16} strokeWidth={2} />
            <span className="set-nav-label">{label}</span>
            {needs[id] && <i className="set-nav-dot" aria-label="Needs attention" />}
          </button>
        ))}
        <span className="set-nav-foot">Timo {info.data?.version ? `v${info.data.version}` : ''}</span>
      </nav>
      <section className="set-pane" aria-labelledby="set-pane-title">
        <header className="set-pane-head">
          <div className="set-pane-copy">
            <h2 id="set-pane-title">{current.label}</h2>
            <p>{current.description}</p>
          </div>
          <button className="icon-btn no-drag" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <X size={16} strokeWidth={2} />
          </button>
        </header>
        <div className="set-pane-body">
          <Body />
        </div>
      </section>
    </div>
  );
}

/** Which sections have something for you to do, from the same queries the sections use. */
function useSectionNeeds(): Record<SectionId, boolean> {
  const info = useQuery({ queryKey: ['settings'], queryFn: () => window.agent.settings.get(), refetchInterval: 4000 });
  const permissions = useQuery({ queryKey: ['trackingReadiness'], queryFn: () => window.agent.permissions.readiness(), refetchInterval: 4000 });
  const lark = useQuery({ queryKey: ['larkStatus'], queryFn: () => window.agent.lark.status(), refetchInterval: 4000 });
  const updates = useQuery({ queryKey: ['updates'], queryFn: () => window.agent.updates.status(), refetchInterval: 60_000 });

  const ready = (s: string | undefined) => s === undefined || s === 'READY' || s === 'NOT_REQUIRED';
  const launch = info.data?.launchAtLogin;
  return {
    general: !!launch && !launch.ready && launch.state !== 'UNAVAILABLE',
    permissions: !ready(permissions.data?.screenRecording) || !ready(permissions.data?.accessibility),
    integrations: lark.data?.configured === true && (!lark.data.connected || lark.data.reauthRequired),
    about: updates.data?.phase === 'ready',
  };
}
