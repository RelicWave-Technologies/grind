import type {
  LaunchAtLoginState as WireLaunchAtLoginState,
  LaunchOrigin as WireLaunchOrigin,
} from '@grind/types';

export type LaunchAtLoginState = WireLaunchAtLoginState;

export type LaunchAtLoginRemediation =
  | 'NONE'
  | 'MOVE_TO_APPLICATIONS'
  | 'REGISTER'
  | 'ENABLE_STARTUP'
  | 'OPEN_LOGIN_ITEMS'
  | 'OPEN_STARTUP_APPS';

export type LaunchOrigin = WireLaunchOrigin;

export interface LaunchAtLoginHealth {
  required: boolean;
  ready: boolean;
  state: LaunchAtLoginState;
  canRepair: boolean;
  remediation: LaunchAtLoginRemediation;
  openedAtLogin: boolean;
  checkedAt: string;
}

export type MoveToApplicationsResult =
  | { ok: true }
  | { ok: false; reason: 'TRACKING_ACTIVE' | 'CANCELLED' | 'MOVE_FAILED' };
