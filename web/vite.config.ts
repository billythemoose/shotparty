import { defineConfig } from 'vite';

// `npm start` serves the page locally. To exercise a deployed API from the local page, set
// API_ORIGIN (e.g. the CloudFront URL) and /api/* is proxied there.
const apiOrigin = process.env.API_ORIGIN;

export default defineConfig({
  server: {
    port: 5173,
    proxy: apiOrigin ? { '/api': { target: apiOrigin, changeOrigin: true } } : undefined,
  },
  // Serve index.html for /e/<token> during local dev, like the CloudFront function does.
  appType: 'spa',
});
