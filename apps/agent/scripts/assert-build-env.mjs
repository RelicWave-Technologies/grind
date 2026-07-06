#!/usr/bin/env node
// Guard: a production agent build MUST bake a real API host. `.env.production`
// is gitignored, so a build on a machine that lacks it silently falls back to
// http://localhost:4000 (see src/main/env.ts) and ships an agent that can't
// reach the API — login opens an unreachable URL. Fail the build instead.
//
// Invoked by scripts/package-mac.sh and scripts/package-windows.mjs before the
// electron-vite build step. Runnable standalone: `node scripts/assert-build-env.mjs`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const agentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

async function readEnvProduction() {
  try {
    return parseEnvFile(await fs.readFile(path.join(agentDir, '.env.production'), 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return {};
    throw err;
  }
}

function fail(msg) {
  console.error(`\n✗ build blocked: ${msg}\n`);
  process.exit(1);
}

const fileEnv = await readEnvProduction();
// electron-vite reads .env.production; a process.env override wins if present.
const apiUrl = process.env.MAIN_VITE_API_URL || fileEnv.MAIN_VITE_API_URL || '';
const scheme = process.env.MAIN_VITE_CALLBACK_SCHEME || fileEnv.MAIN_VITE_CALLBACK_SCHEME || '';

if (!apiUrl) {
  fail('MAIN_VITE_API_URL is unset. Add it to apps/agent/.env.production (e.g. https://timo.emiactech.com).');
}
if (/localhost|127\.0\.0\.1/i.test(apiUrl)) {
  fail(`MAIN_VITE_API_URL is localhost ("${apiUrl}") — that ships an agent that can't reach the real API.`);
}
if (scheme && !['grind', 'timo'].includes(scheme.toLowerCase())) {
  fail(`MAIN_VITE_CALLBACK_SCHEME "${scheme}" must be "grind" or "timo".`);
}

console.log(`▸ build env ok: API_URL=${apiUrl} scheme=${scheme || '(default timo)'}`);
