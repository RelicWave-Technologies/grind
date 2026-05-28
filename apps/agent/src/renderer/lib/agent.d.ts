import type { UserDto, ProjectDto } from '@grind/types';

type AuthStatus = 'loggedIn' | 'loggedOut';
type AgentStatus = { state: 'IDLE' | 'OFFLINE'; lastHeartbeatAt: string | null };
type TimerStatus =
  | { state: 'IDLE' }
  | { state: 'RUNNING'; entryId: string; projectId: string; taskId: string | null; startedAt: number; workedMs: number };

declare global {
  interface Window {
    agent: {
      auth: {
        login: (email: string, password: string) => Promise<UserDto>;
        logout: () => Promise<{ ok: true }>;
        status: () => Promise<AuthStatus>;
        onStatusChange: (cb: (s: AuthStatus) => void) => () => void;
      };
      projects: {
        list: () => Promise<ProjectDto[]>;
      };
      agent: {
        status: () => Promise<AgentStatus>;
      };
      timer: {
        start: (projectId: string, taskId?: string | null) => Promise<TimerStatus>;
        stop: () => Promise<TimerStatus>;
        status: () => Promise<TimerStatus>;
        onStatusChange: (cb: (s: TimerStatus) => void) => () => void;
      };
    };
  }
}

export { TimerStatus };
