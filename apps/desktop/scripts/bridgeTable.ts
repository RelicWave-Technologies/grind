// Prints the README "channel -> command" table from the bridge manifest:
//   pnpm --filter @grind/desktop exec vite-node scripts/bridgeTable.ts
import { readFileSync } from 'node:fs';
import { MANIFEST, commandFor } from '../src/bridge/agentBridge';

const names = readFileSync(new URL('../src-tauri/src/commands/names.rs', import.meta.url), 'utf8');
const ported = new Set([...names.matchAll(/^\s*"([a-z_]+)",?$/gm)].map((m) => m[1]));

const channels = new Set<string>();
const events = new Set<string>();
for (const methods of Object.values(MANIFEST)) {
  for (const spec of Object.values(methods)) {
    if ('event' in spec) events.add(spec.event);
    else for (const channel of [spec.channel, ...(spec.also ?? [])]) channels.add(channel);
  }
}

console.log('| Channel | Tauri command | Rust |\n| --- | --- | --- |');
for (const channel of channels) {
  const command = commandFor(channel);
  console.log(`| \`${channel}\` | \`${command}\` | ${ported.has(command) ? 'ported' : 'not ported'} |`);
}
console.log('\nPush events: ' + [...events].map((e) => `\`${e}\``).join(', '));
