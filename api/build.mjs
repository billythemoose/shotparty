// Bundles each Lambda handler in src/handlers/<name>.ts to dist/<name>/index.mjs.
// SAM points each function's CodeUri at dist/<name> (see infra/app/template.yaml).
import { build } from 'esbuild';
import { readdirSync, rmSync } from 'node:fs';
import { basename } from 'node:path';

const handlers = readdirSync('src/handlers').filter((f) => f.endsWith('.ts'));
rmSync('dist', { recursive: true, force: true });

await Promise.all(
  handlers.map((file) =>
    build({
      entryPoints: [`src/handlers/${file}`],
      outfile: `dist/${basename(file, '.ts')}/index.mjs`,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      // Whitespace/syntax minification only: keeps identifiers (and keepNames) so stack traces stay
      // readable without shipping multi-MB source maps (AWS SDK bundles are large).
      minifyWhitespace: true,
      minifySyntax: true,
      keepNames: true,
      logLevel: 'warning',
      // Bundled CommonJS deps (the AWS SDK) call require() for Node built-ins, which doesn't exist
      // in an ES module. Provide one; without it Lambda crashes at import time.
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
    }),
  ),
);
console.log(`Built ${handlers.length} handler(s): ${handlers.join(', ')}`);
