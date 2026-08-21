import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/.turbo/**',
      '**/packages/db/node_modules/.prisma/**',
      '**/prisma/migrations/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
    },
  },
  {
    /**
     * The agent keeps two clocks: the device wall clock, and the server-aligned
     * clock that everything the server judges must be stamped with. Both are a
     * plain `number`, so nothing distinguishes them at a call site.
     *
     * That is exactly how the last bug happened — the server-aligned clock was
     * introduced, one caller was converted, and five were missed. Entries ended
     * up in one frame and the boundaries that closed them in another, which the
     * server rejected as invalid_segments on every retry, forever.
     *
     * So in the modules where the frame decides correctness, reaching for the
     * device clock has to be a deliberate, justified act rather than the
     * default. Comparing two device readings is still perfectly valid — a gap
     * is frame-free — so this is not a ban. It is a requirement to say why.
     *
     *   // eslint-disable-next-line no-restricted-syntax -- device↔device gap
     *
     * Tests are exempt: they mock Date.now() to simulate a skewed machine, which
     * is how the frame split is now proven not to have come back.
     */
    files: [
      'apps/agent/src/main/services/timer/**/*.ts',
      'apps/agent/src/main/services/activity/**/*.ts',
      'apps/agent/src/main/services/capture/**/*.ts',
      'apps/agent/src/main/services/heartbeat.ts',
      'apps/agent/src/main/services/power.ts',
      'apps/agent/src/main/services/trackingPermissionMonitor.ts',
      'apps/agent/src/main/services/workspaceTime.ts',
    ],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message:
            'Two clocks live here. Use serverAlignedNow() for anything the server will judge (entry, segment, evidence, checkpoint). Date.now() is only correct for a gap between two device readings — if that is what this is, disable this rule on the line and say so.',
        },
      ],
    },
  },
);
