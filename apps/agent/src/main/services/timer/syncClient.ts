import type { TimeEntry, Segment } from '@grind/core';
import { api } from '../apiClient';
import { AGENT_VERSION } from '../../env';
import type { SyncClient } from './types';

function segIso(s: Segment) {
  return {
    id: s.id,
    kind: s.kind,
    startedAt: new Date(s.startedAt).toISOString(),
    endedAt: s.endedAt === null ? null : new Date(s.endedAt).toISOString(),
  };
}

function platform(): 'darwin' | 'win32' | 'linux' {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win32';
  return 'linux';
}

function lifecycle(entry: TimeEntry) {
  return {
    trackingProtocolVersion: 2 as const,
    revision: Math.max(1, entry.revision),
    observedAt: new Date(entry.endedAt ?? Date.now()).toISOString(),
    closeReason: entry.closeReason,
  };
}

/** SyncClient implemented over the authenticated HTTP api() helper. */
export class HttpSyncClient implements SyncClient {
  async create(entry: TimeEntry): Promise<void> {
    await api('/v1/time-entries', {
      method: 'POST',
      body: {
        ...lifecycle(entry),
        id: entry.id,
        clientUuid: entry.clientUuid,
        larkTaskGuid: entry.larkTaskGuid ?? null,
        source: entry.source,
        startedAt: new Date(entry.startedAt).toISOString(),
        endedAt: entry.endedAt === null ? null : new Date(entry.endedAt).toISOString(),
        agentVersion: AGENT_VERSION,
        platform: platform(),
        segments: entry.segments.map(segIso),
      },
    });
  }

  async sync(entry: TimeEntry): Promise<void> {
    await api(`/v1/time-entries/${entry.id}/sync`, {
      method: 'PUT',
      body: {
        ...lifecycle(entry),
        endedAt: entry.endedAt === null ? null : new Date(entry.endedAt).toISOString(),
        segments: entry.segments.map(segIso),
      },
    });
  }
}
