import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['api/test/**/*.test.ts', 'web/test/**/*.test.ts', 'scripts/test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['api/src/**/*.ts', 'web/src/**/*.ts', 'scripts/**/*.ts'],
      exclude: ['scripts/test/**'],
      // text-summary for the CI log, json-summary for a badge later, lcov for editors.
      reporter: ['text-summary', 'json-summary', 'lcov'],
    },
  },
});
