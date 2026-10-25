/**
 * @fileoverview Regenerates the QR code for an existing event link (event:create already writes
 * one).
 *
 *   npm run qr -- --url https://<site>/e/<token> --name pizza-and-games-2026-prod [--dir qr-codes]
 */
import { parseArgs } from 'node:util';
import { writeQrFiles } from './lib/qr.js';

const { values: opts } = parseArgs({
  options: {
    url: { type: 'string' },
    name: { type: 'string', default: 'event-qr' },
    dir: { type: 'string', default: 'qr-codes' },
  },
});

if (!opts.url || !/^https:\/\/[^/]+\/e\/[A-Za-z0-9_-]{16,64}$/.test(opts.url)) {
  console.error('error: --url must look like https://<site>/e/<token>');
  process.exit(1);
}
const files = await writeQrFiles(opts.url, opts.dir, opts.name);
console.log(
  `QR code written:\n  ${files.join('\n  ')}\nThese contain the secret link: keep them private until printing.`,
);
