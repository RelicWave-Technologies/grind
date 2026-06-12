import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  // Bundle the workspace packages (TypeScript source) into the output so the
  // artifact runs under plain `node dist/index.cjs` in production — without
  // them inlined, Node would try to require their `.ts` entry points. Real
  // npm deps (incl. @prisma/client, which ships a native engine) stay external.
  noExternal: [/^@grind\//],
});
