/**
 * Turns the root DESIGN.md into CSS custom properties.
 *
 * DESIGN.md is the sole authority on how Timo looks, on the dashboard and the
 * desktop app alike. Hand-copying hex values into two stylesheets makes that a
 * promise rather than a fact — the copies drift, and nothing notices.
 * Generating means a colour that is not in DESIGN.md cannot be used, and one
 * that changes there changes in both apps at once.
 *
 * The output is committed so a build never depends on parsing at deploy time.
 * `--check` regenerates in memory and fails when the committed file is stale;
 * it runs as this package's typecheck, so a stale file fails CI rather than
 * shipping.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(here, '../../../DESIGN.md');
const TARGET = resolve(here, '../src/tokens.css');

/**
 * Only the parts we emit. Parsed rather than narrowed by hand, so a malformed
 * design source fails here with the offending path named — not later, as a
 * stylesheet with `undefined` in it.
 */
const designSchema = z.object({
  colors: z.record(z.string(), z.string()),
  fonts: z.object({ sans: z.string(), mono: z.string() }),
  typography: z.record(
    z.string(),
    z.object({
      fontSize: z.string(),
      fontWeight: z.number(),
      lineHeight: z.number(),
      letterSpacing: z.string().optional(),
      fontFamily: z.enum(['sans', 'mono']).optional(),
    }),
  ),
  rounded: z.record(z.string(), z.string()),
  spacing: z.record(z.string(), z.string()),
  control: z.record(z.string(), z.string()),
  layout: z.record(z.string(), z.string()),
  motion: z.record(z.string(), z.string()),
  elevation: z.record(z.string(), z.string()),
});

const raw = readFileSync(SOURCE, 'utf8');
const frontMatter = /^---\n([\s\S]*?)\n---/.exec(raw);
if (frontMatter === null) {
  throw new Error(`${SOURCE} has no front matter; the design tokens live there.`);
}

const design = designSchema.parse(parse(frontMatter[1] ?? ''));

/**
 * A colour written as `"{name}"` is a role drawn from the palette (the ribbon's
 * work block is `{brand}`). It is emitted as a reference, never resolved to its
 * hex, so the role follows the palette when the palette changes. A reference to
 * a colour that does not exist fails the build.
 */
function colourValue(name: string, value: string): string {
  const ref = /^\{([a-z0-9-]+)\}$/.exec(value);
  if (ref === null) {
    if (!/^#[0-9a-f]{6}$/.test(value)) {
      throw new Error(`colors.${name} is "${value}"; write a 6-digit lowercase hex or a {reference}.`);
    }
    return value;
  }
  const target = ref[1] ?? '';
  if (!(target in design.colors)) {
    throw new Error(`colors.${name} refers to {${target}}, which DESIGN.md does not define.`);
  }
  return `var(--color-${target})`;
}

const lines: string[] = [
  '/* GENERATED FROM DESIGN.md (repository root) — do not edit.',
  ' * Run `pnpm --filter @grind/design tokens` after changing the design source.',
  ' */',
  ':root {',
];

for (const [name, value] of Object.entries(design.colors)) {
  lines.push(`  --color-${name}: ${colourValue(name, value)};`);
}

for (const [name, value] of Object.entries(design.fonts)) {
  lines.push(`  --font-${name}: ${value};`);
}

for (const [name, type] of Object.entries(design.typography)) {
  lines.push(`  --type-${name}-size: ${type.fontSize};`);
  lines.push(`  --type-${name}-weight: ${String(type.fontWeight)};`);
  lines.push(`  --type-${name}-leading: ${String(type.lineHeight)};`);
  lines.push(`  --type-${name}-tracking: ${type.letterSpacing ?? 'normal'};`);
  lines.push(`  --type-${name}-family: var(--font-${type.fontFamily ?? 'sans'});`);
}

for (const [name, value] of Object.entries(design.rounded)) {
  lines.push(`  --radius-${name}: ${value};`);
}

for (const [name, value] of Object.entries(design.spacing)) {
  lines.push(`  --space-${name}: ${value};`);
}

for (const [name, value] of Object.entries(design.control)) {
  lines.push(`  --control-${name}: ${value};`);
}

for (const [name, value] of Object.entries(design.layout)) {
  lines.push(`  --layout-${name}: ${value};`);
}

// Emitted without a prefix: the keys already carry one (`duration-fast`,
// `ease-standard`), and `var(--duration-slow)` reads better than
// `var(--motion-duration-slow)`.
for (const [name, value] of Object.entries(design.motion)) {
  lines.push(`  --${name}: ${value};`);
}

for (const [name, value] of Object.entries(design.elevation)) {
  lines.push(`  --elevation-${name}: ${value};`);
}

lines.push('}', '');
const output = lines.join('\n');

if (process.argv.includes('--check')) {
  const committed = readFileSync(TARGET, 'utf8');
  if (committed !== output) {
    process.stderr.write(
      `${TARGET} is stale: DESIGN.md changed without regenerating.\n` +
        'Run `pnpm --filter @grind/design tokens` and commit the result.\n',
    );
    process.exit(1);
  }
  process.stdout.write('tokens.css matches DESIGN.md\n');
} else {
  writeFileSync(TARGET, output, 'utf8');
  process.stdout.write(`wrote ${TARGET}\n`);
}
