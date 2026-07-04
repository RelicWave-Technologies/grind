import { API_BASE } from './api';

export type AgentDownloadPlatform = 'mac' | 'windows';

export interface AgentDownloadOption {
  platform: AgentDownloadPlatform;
  label: string;
  iconSrc: string;
}

export const AGENT_DOWNLOADS: AgentDownloadOption[] = [
  { platform: 'mac', label: 'macOS', iconSrc: '/brand/apple.svg' },
  { platform: 'windows', label: 'Windows', iconSrc: '/brand/windows.svg' },
];

export function agentDownloadUrl(platform: AgentDownloadPlatform): string {
  return `${API_BASE}/v1/downloads/agent/${platform}`;
}
