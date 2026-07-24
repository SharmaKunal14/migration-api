import { mkdir } from 'node:fs/promises';

import { build } from 'esbuild';

const common = {
  bundle: true,
  format: 'esm',
  logLevel: 'info',
  minify: false,
  platform: 'node',
  sourcemap: true,
  target: 'node22',
  tsconfig: 'tsconfig.json',
};

await mkdir('dist/services', { recursive: true });
await mkdir('dist/workers/agent', { recursive: true });
await mkdir('dist/workers/database-migrator', { recursive: true });

await Promise.all([
  build({
    ...common,
    entryPoints: ['services/api/src/handler.ts'],
    outfile: 'dist/services/api.js',
  }),
  build({
    ...common,
    entryPoints: ['services/outbox-dispatcher/src/handler.ts'],
    outfile: 'dist/services/outbox-dispatcher.js',
  }),
  build({
    ...common,
    entryPoints: ['services/workflow-control/src/handler.ts'],
    outfile: 'dist/services/workflow-control.js',
  }),
  build({
    ...common,
    entryPoints: ['workers/agent/src/main.ts'],
    outfile: 'dist/workers/agent/main.js',
  }),
  build({
    ...common,
    entryPoints: ['workers/database-migrator/src/main.ts'],
    outfile: 'dist/workers/database-migrator/main.js',
  }),
]);
