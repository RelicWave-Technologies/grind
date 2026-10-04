// Records what the real Electron 33.2.0 (ICU 74.2, tzdata 2024a) says about the time
// zone ids the harness Node cannot be trusted on, for `tests/tz_electron_snapshot.rs`.
//
//   ELECTRON_RUN_AS_NODE=1 <Electron 33.2.0 binary> src/electronDrift.mjs ../crates/timo-core/tests/data/tz_electron_drift.json
//
// - VALIDITY_DRIFT ids (Electron and Node disagree about being valid at all): the verdict.
// - OFFSET_DRIFT ids (valid in both, different offsets in 1970-2100): the offset-change
//   table, read through Intl one day at a time and bisected to the second.
// The id lists come from src/gen/tzIds.ts, which is where the fixtures leave them out.
import { readFileSync, writeFileSync } from 'node:fs';

const source = readFileSync(new URL('./gen/tzIds.ts', import.meta.url), 'utf8');
const listOf = (name) => {
  const block = source.slice(source.indexOf(`export const ${name}`));
  return [...block.slice(0, block.indexOf('];')).matchAll(/'([^']+)'/g)].map((m) => m[1]);
};

const formatters = new Map();
const offsetAt = (timeZone, seconds) => {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(timeZone, f);
  }
  const p = {};
  for (const x of f.formatToParts(seconds * 1000)) p[x.type] = x.value;
  return Math.round(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) / 1000) - seconds;
};

function table(timeZone, from, to) {
  let previous = offsetAt(timeZone, from);
  const list = [[from, previous]];
  for (let t = from + 86400; t <= to; t += 86400) {
    const offset = offsetAt(timeZone, t);
    if (offset === previous) continue;
    let low = t - 86400;
    let high = t;
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      if (offsetAt(timeZone, mid) === previous) low = mid;
      else high = mid;
    }
    list.push([high, offset]);
    previous = offset;
  }
  return list;
}

const valid = (id) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: id }).format(0);
    return true;
  } catch {
    return false;
  }
};

const out = {
  runtime: { electron: process.versions.electron, node: process.versions.node, icu: process.versions.icu, tz: process.versions.tz },
  validity: Object.fromEntries(listOf('VALIDITY_DRIFT').map((id) => [id, valid(id)])),
  offsets: Object.fromEntries(listOf('OFFSET_DRIFT').map((id) => [id, table(id, 0, Date.UTC(2100, 0, 1) / 1000)])),
};
writeFileSync(process.argv[2], `${JSON.stringify(out)}\n`);
