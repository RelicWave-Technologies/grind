import { TimeZoneSchema } from '@grind/types';
import type { FnSpec } from '../fixture';
import type { Rng } from '../prng';
import { plain } from './seq';

const module = 'store';

/**
 * ORACLE BY COPY. `legacy/agent/src/main/services/workspaceTime.ts` imports `electron`,
 * the logger and the token store, and `parsePersisted` is module-private, so it cannot
 * be imported. The body below is copied VERBATIM from `workspaceTime.ts:parsePersisted`
 * (lines 38-46), with the real `TimeZoneSchema` from `@grind/types` doing the validation,
 * and the written text is the `JSON.stringify({ workspaceId, timeZone })` of
 * `applyServerWorkspaceTimeZone`.
 */
interface PersistedWorkspaceTime {
  workspaceId: string;
  timeZone: string;
}

function parsePersisted(raw: unknown): PersistedWorkspaceTime | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as { workspaceId?: unknown; timeZone?: unknown };
  const parsed = TimeZoneSchema.safeParse(candidate.timeZone);
  if (!parsed.success || typeof candidate.workspaceId !== 'string' || candidate.workspaceId.length === 0) {
    return null;
  }
  return { workspaceId: candidate.workspaceId, timeZone: parsed.data };
}

/**
 * `raw` is the file text (`null` = no file). `valid` lists every candidate zone string
 * the schema's refinement accepts, so the Rust closure answers `isValidTimeZone` from
 * V8's own verdict instead of from a second opinion.
 */
type Input = { raw: string | null; valid: string[] };

const ZONES = [
  'UTC', 'Asia/Kolkata', 'America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Pacific/Apia', 'Etc/GMT+5', 'Asia/Calcutta', 'utc', 'asia/kolkata', 'America/Argentina/Buenos_Aires',
  '+05:30', '-08:00', 'GMT', 'EST5EDT', 'Invalid/Zone', 'Mars/Olympus', '', ' ', 'a b', 'UTC\u0000', 'Asia/Kolkata\n', 'Z', 'Europe/Kyiv', 'Asia/Kathmandu',
];
const PADS = ['', '', '', ' ', '\t', '\n', ' ', ' ', '　', '﻿', ' ', '\u0085', '​', '᠎'];
const IDS = ['ws_1', 'W', '', ' ', 'é', '日本', '😀', 'a"b', 'back\\slash', 'line\nbreak', '0', 'x'.repeat(200)];

function zoneValue(rng: Rng): unknown {
  if (rng.chance(0.08)) return rng.pick([5, null, true, [], {}, ['UTC'], { z: 1 }, 0, false]);
  const base = rng.chance(0.07) ? 'A'.repeat(rng.pick([79, 80, 81])) : rng.pick(ZONES);
  return `${rng.pick(PADS)}${base}${rng.pick(PADS)}`;
}

function rawText(rng: Rng, zone: unknown): string | null {
  const mode = rng.int(0, 11);
  const ws = rng.chance(0.85) ? rng.pick(IDS) : rng.pick([5, null, true, [], {}]);
  switch (mode) {
    case 0: return null;
    case 1: return rng.pick(['', '{', 'null', '[]', '5', '"s"', 'true', '0', 'false', '{}', '[{"workspaceId":"w","timeZone":"UTC"}]', '﻿{"workspaceId":"w","timeZone":"UTC"}']);
    case 2: return `{"workspaceId": ${JSON.stringify(ws)}}`;
    case 3: return `{"timeZone": ${JSON.stringify(zone)}}`;
    case 4: return `{"timeZone": ${JSON.stringify(zone)}, "workspaceId": ${JSON.stringify(ws)}, "extra": [1, 2]}`;
    case 5: return JSON.stringify({ workspaceId: ws, timeZone: zone }, null, 2);
    case 6: return `{"workspaceId": "first", "workspaceId": ${JSON.stringify(ws)}, "timeZone": ${JSON.stringify(zone)}}`;
    default: return JSON.stringify({ workspaceId: ws, timeZone: zone });
  }
}

const candidates = (zone: unknown): string[] => {
  const out = new Set<string>();
  if (typeof zone === 'string') out.add(zone.trim());
  return [...out];
};

function build(raw: string | null, zone: unknown): Input {
  const valid = candidates(zone).filter((z) => z.length >= 1 && z.length <= 80 && TimeZoneSchema.safeParse(z).success);
  return { raw, valid };
}

const spec: FnSpec<Input> = {
  crate: 'timo-store',
  module,
  fn: 'workspaceTime',
  edge: () => [
    build(null, null),
    build('{"workspaceId":"ws_1","timeZone":"Asia/Kolkata"}', 'Asia/Kolkata'),
    build('{"workspaceId":"ws_1","timeZone":" Asia/Kolkata\\n"}', ' Asia/Kolkata\n'),
    build('{"workspaceId":"ws_1","timeZone":"\\u0085UTC"}', '\u0085UTC'),
    build('{"workspaceId":"ws_1","timeZone":"\\ufeffUTC"}', '﻿UTC'),
    build('{"workspaceId":"","timeZone":"UTC"}', 'UTC'),
    build('{"workspaceId":"w","timeZone":"Nope/Zone"}', 'Nope/Zone'),
    build(`{"workspaceId":"w","timeZone":"${'A'.repeat(81)}"}`, 'A'.repeat(81)),
  ],
  random: (rng) => {
    const zone = zoneValue(rng);
    return build(rawText(rng, zone), zone);
  },
  // `valid` is not an input of the oracle: the real schema decides.
  call: ({ raw }) => {
    let parsed: PersistedWorkspaceTime | null = null;
    let failure: string | null = null;
    try {
      if (raw === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      parsed = parsePersisted(JSON.parse(raw));
      if (!parsed) throw new Error('invalid_workspace_time_cache');
    } catch (err) {
      failure = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unusable';
    }
    const written = parsed ? JSON.stringify({ workspaceId: parsed.workspaceId, timeZone: parsed.timeZone } satisfies PersistedWorkspaceTime) : null;
    return plain({ parsed, failure, written });
  },
};

export const specs: FnSpec<any>[] = [spec];
