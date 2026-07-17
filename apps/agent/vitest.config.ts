import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only the pure, Electron-free logic (timer service, future domain helpers).
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
