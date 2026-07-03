export interface TimeInvalidationInput {
  userId: string;
  startedAt: number;
  endedAt: number;
}

export interface InvalidatedInterval {
  start: number;
  end: number;
}

export type InvalidationsByUser = Map<string, InvalidatedInterval[]>;

export function groupInvalidationsByUser(input: TimeInvalidationInput[] | undefined): InvalidationsByUser {
  const grouped = new Map<string, InvalidatedInterval[]>();
  for (const row of input ?? []) {
    if (row.endedAt <= row.startedAt) continue;
    const arr = grouped.get(row.userId) ?? [];
    arr.push({ start: row.startedAt, end: row.endedAt });
    grouped.set(row.userId, arr);
  }
  for (const [userId, intervals] of grouped) {
    intervals.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: InvalidatedInterval[] = [];
    for (const iv of intervals) {
      const last = merged[merged.length - 1];
      if (last && iv.start <= last.end) {
        last.end = Math.max(last.end, iv.end);
      } else {
        merged.push({ ...iv });
      }
    }
    grouped.set(userId, merged);
  }
  return grouped;
}

export function isInvalidatedAt(grouped: InvalidationsByUser, userId: string, epochMs: number): boolean {
  const intervals = grouped.get(userId);
  if (!intervals) return false;
  for (const iv of intervals) {
    if (epochMs < iv.start) return false;
    if (epochMs >= iv.start && epochMs < iv.end) return true;
  }
  return false;
}

export function subtractInvalidations(
  grouped: InvalidationsByUser,
  userId: string,
  start: number,
  end: number,
): { valid: InvalidatedInterval[]; invalidatedMs: number } {
  if (end <= start) return { valid: [], invalidatedMs: 0 };
  const intervals = grouped.get(userId);
  if (!intervals || intervals.length === 0) return { valid: [{ start, end }], invalidatedMs: 0 };

  let valid: InvalidatedInterval[] = [{ start, end }];
  let invalidatedMs = 0;
  for (const iv of intervals) {
    if (iv.end <= start) continue;
    if (iv.start >= end) break;
    const ovStart = Math.max(start, iv.start);
    const ovEnd = Math.min(end, iv.end);
    if (ovEnd <= ovStart) continue;
    invalidatedMs += ovEnd - ovStart;
    const next: InvalidatedInterval[] = [];
    for (const part of valid) {
      if (ovEnd <= part.start || ovStart >= part.end) {
        next.push(part);
        continue;
      }
      if (part.start < ovStart) next.push({ start: part.start, end: ovStart });
      if (ovEnd < part.end) next.push({ start: ovEnd, end: part.end });
    }
    valid = next;
    if (valid.length === 0) continue;
  }

  return { valid, invalidatedMs };
}

export function invalidatedOverlapMs(
  grouped: InvalidationsByUser,
  userId: string,
  start: number,
  end: number,
): number {
  return subtractInvalidations(grouped, userId, start, end).invalidatedMs;
}
