import base from './playwright.config';
import { defineConfig } from '@playwright/test';

// Draws the README screenshots (docs/images/) from the built page with the e2e mocks.
// Not part of the test run: `npm run screenshots`.
export default defineConfig({
  ...base,
  testMatch: '**/*.shots.ts',
  reporter: 'list',
  retries: 0,
});
