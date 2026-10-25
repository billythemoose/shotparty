/**
 * @fileoverview A stand-in API for looking at the guest page locally, with no AWS involved. Uploads
 * don't work.
 *
 *   npm run mock-api                                  (listens on http://localhost:8787)
 *   API_ORIGIN=http://localhost:8787 npm start        (in a second terminal)
 *   then open http://localhost:5173/e/<sample>, where <sample> is one of the names printed at start
 */
import { createServer } from 'node:http';

// Same shape as EventDisplay in web/src/display.ts (not imported: that file needs DOM types).
interface EventDisplay {
  headline?: string;
  welcome?: string;
  thanks?: string;
  accentColor?: string;
}

const PORT = Number(process.env.PORT ?? 8787);
const day = 86_400_000;
const open = { openFrom: new Date(Date.now() - day).toISOString() };

const samples: Record<string, { name: string; display: EventDisplay; status?: string }> = {
  default: { name: 'Summer Party', display: {} },
  styled: {
    name: 'Launch Night',
    display: {
      headline: 'Say cheese',
      welcome: 'Drop your shots from tonight. Full quality, straight from your phone.',
      thanks: 'Thanks for coming to the launch!',
      accentColor: '#1a5fb4',
    },
  },
  pale: { name: 'Lemonade Stand', display: { accentColor: '#ffef5a' } },
  navy: { name: 'Gala Dinner', display: { accentColor: '#0b1f4d' } },
  long: {
    name: 'The Annual Neighborhood Street Festival and Community Bake-Off',
    display: {
      headline: 'Supercalifragilisticexpialidocious photo drop for everyone who came along today',
      welcome: '<b>Markup shows as plain text</b>, never as HTML.',
    },
  },
  closed: { name: 'Last Year’s Picnic', display: {}, status: 'closed' },
};

createServer((req, res) => {
  const send = (status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/health') return send(200, { ok: true, stage: 'mock' });
  const match = /^\/api\/event\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  const sample = samples[match?.[1] ?? ''];
  if (!sample) return send(404, { error: 'unknown-event' });
  send(200, {
    name: sample.name,
    display: sample.display,
    requiresPin: false,
    status: sample.status ?? 'open',
    ...open,
    openUntil: new Date(Date.now() + 30 * day).toISOString(),
    uploadsEnabled: true,
    turnstileSiteKey: '1x00000000000000000000AA', // Cloudflare's always-pass test key
  });
}).listen(PORT, () => {
  console.log(
    `Mock API on http://localhost:${PORT}. With API_ORIGIN=http://localhost:${PORT} npm start, open:`,
  );
  for (const name of Object.keys(samples)) {
    console.log(`  http://localhost:5173/e/${name}`);
  }
});
