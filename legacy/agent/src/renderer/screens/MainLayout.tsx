import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, ExternalLink, ListTodo, LogOut, Plus, Settings as SettingsIcon, X } from 'lucide-react';
import Now from './Now';
import Tasks from './Tasks';
import MyDay from './MyDay';
import Settings from './Settings';
import Sheet from '../components/Sheet';
import SyncButton from '../components/SyncButton';
import TimoMark from '../components/TimoMark';
import { introTarget } from '../components/AppIntro';
import { ToastProvider, type Toast } from '../components/ToastDock';
import { timerRecoveryNoticeText } from '../lib/recoveryNotice';
import { formatWorkspaceRecoveryTime, useWorkspaceTime, workspaceTimeReady } from '../lib/workspaceTime';
import { updateReadyBannerText } from '../lib/updateUi';

type Panel = 'none' | 'tasks' | 'day' | 'settings';

/**
 * The main window, Focus (DESIGN.md §5 The desktop window): one screen that
 * changes with what you are doing, the mark in the title bar, and a corner
 * that opens the task list, your day and settings as sheets.
 */
export default function MainLayout() {
  const qc = useQueryClient();
  const [panel, setPanel] = useState<Panel>('none');
  const [creating, setCreating] = useState(false);
  const close = () => setPanel('none');

  const installUpdate = useMutation({
    mutationFn: () => window.agent.updates.installNow(),
    onSuccess: (s) => qc.setQueryData(['updates'], s),
  });
  const updates = useQuery({ queryKey: ['updates'], queryFn: () => window.agent.updates.status(), refetchInterval: 60_000 });
  const larkStatus = useQuery({ queryKey: ['larkStatus'], queryFn: () => window.agent.lark.status(), refetchInterval: 10_000 });
  const updateReady = updates.data?.phase === 'ready' || updates.data?.phase === 'installing' ? updates.data : null;
  const recoveryNotice = useQuery({ queryKey: ['timerRecoveryNotice'], queryFn: () => window.agent.timer.recoveryNotice() });
  const dismissRecovery = useMutation({
    mutationFn: () => window.agent.timer.dismissRecoveryNotice(),
    onSuccess: () => qc.setQueryData(['timerRecoveryNotice'], null),
  });
  const workspaceTime = useWorkspaceTime();
  const timeZone = workspaceTimeReady(workspaceTime.data) ? workspaceTime.data.timeZone : null;

  // The window's standing notices: they stay in the toast dock until what they
  // describe resolves (DESIGN.md §9 Toasts). Never banners across the page.
  const standing: Toast[] = [];
  if (!workspaceTimeReady(workspaceTime.data)) standing.push({ id: 'workspace-time', tone: 'busy', text: 'Syncing workspace time…' });
  if (recoveryNotice.data) {
    standing.push({
      id: 'recovery',
      tone: 'wait',
      text: timerRecoveryNoticeText(recoveryNotice.data, (value) => formatWorkspaceRecoveryTime(value, timeZone)),
      onDismiss: () => dismissRecovery.mutate(),
    });
  }
  if (updateReady) {
    standing.push({
      id: 'update',
      tone: 'info',
      text: updateReadyBannerText(updateReady),
      action:
        updateReady.phase === 'ready' && updateReady.canInstallNow
          ? { label: 'Restart', onClick: () => installUpdate.mutate(), disabled: installUpdate.isPending }
          : undefined,
    });
  }

  useEffect(() => {
    const offStatus = window.agent.updates.onStatusChange((s) => {
      qc.setQueryData(['updates'], s);
    });
    const offOpenSettings = window.agent.updates.onOpenSettings(() => setPanel('settings'));
    const offStartupSettings = window.agent.settings.onOpen(() => setPanel('settings'));
    return () => {
      offStatus();
      offOpenSettings();
      offStartupSettings();
    };
  }, [qc]);

  return (
    <ToastProvider standing={standing}>
      <div className="shell">
        <header className="shell-bar">
          <span className="shell-brand">
            <TimoMark size={22} {...introTarget} />
            <span className="shell-brand-name">Timo</span>
          </span>
          <nav className="shell-corner no-drag" aria-label="Timo">
            <button className={`btn btn-ghost btn-sm${panel === 'tasks' ? ' on' : ''}`} onClick={() => setPanel('tasks')}>
              <ListTodo size={15} strokeWidth={2} /> Tasks
            </button>
            <button className={`btn btn-ghost btn-sm${panel === 'day' ? ' on' : ''}`} onClick={() => setPanel('day')}>
              <CalendarDays size={15} strokeWidth={2} /> My day
            </button>
            <button className={`icon-btn${panel === 'settings' ? ' on' : ''}`} onClick={() => setPanel('settings')} aria-label="Settings" title="Settings">
              <SettingsIcon size={17} strokeWidth={2} />
            </button>
            <AccountMenu />
          </nav>
        </header>

        <Now onOpenTasks={() => setPanel('tasks')} />

        <Sheet
          open={panel === 'tasks'}
          onClose={close}
          side="bottom"
          title="Tasks"
          actions={
            larkStatus.data?.connected && (
              <>
                <SyncButton />
                <button className="btn btn-soft btn-sm no-drag" onClick={() => setCreating((s) => !s)}>
                  {creating ? <><X size={14} strokeWidth={2.5} /> Cancel</> : <><Plus size={14} strokeWidth={2.5} /> New task</>}
                </button>
              </>
            )
          }
        >
          <Tasks creating={creating} onCreatingChange={setCreating} onStarted={close} />
        </Sheet>
        <Sheet open={panel === 'day'} onClose={close} side="right" title="My day">
          <MyDay />
        </Sheet>
        <Sheet open={panel === 'settings'} onClose={close} title="Settings">
          <Settings />
        </Sheet>
      </div>
    </ToastProvider>
  );
}

/** The account: who is signed in, the web dashboard, sign out. */
function AccountMenu() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const me = useQuery({ queryKey: ['me'], queryFn: () => window.agent.auth.me(), staleTime: 5 * 60_000 });
  const openDashboard = useMutation({ mutationFn: () => window.agent.app.openDashboard() });
  const logout = useMutation({
    mutationFn: () => window.agent.auth.logout(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['authStatus'] }),
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const name = me.data?.name ?? 'Account';
  const initial = name.trim().slice(0, 1).toUpperCase() || 'A';
  const showAvatar = !!me.data?.avatarUrl && !avatarFailed;
  const dashboardUnavailable = openDashboard.data && !openDashboard.data.ok;

  return (
    <span className="account" ref={ref}>
      <button className="account-btn" onClick={() => setOpen((v) => !v)} aria-label="Account" aria-expanded={open}>
        <span className="avatar">{showAvatar ? <img src={me.data!.avatarUrl!} alt="" onError={() => setAvatarFailed(true)} /> : initial}</span>
      </button>
      {open && (
        <div className="account-menu" role="menu">
          <div className="account-who">
            <span className="account-name">{name}</span>
            <span className="account-mail">Signed in with Lark</span>
          </div>
          <button className="account-item" role="menuitem" onClick={() => openDashboard.mutate()} disabled={openDashboard.isPending}>
            <ExternalLink size={15} strokeWidth={2} />
            {openDashboard.isPending ? 'Opening…' : dashboardUnavailable ? 'Dashboard not available yet' : 'Open web dashboard'}
          </button>
          <button className="account-item" role="menuitem" onClick={() => logout.mutate()} disabled={logout.isPending}>
            <LogOut size={15} strokeWidth={2} /> Sign out
          </button>
        </div>
      )}
    </span>
  );
}
