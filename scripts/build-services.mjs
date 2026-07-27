import { mkdir } from 'node:fs/promises';

import { build } from 'esbuild';

const common = {
  banner: {
    js: "import { createRequire } from 'node:module'; import { fileURLToPath } from 'node:url'; import { dirname } from 'node:path'; const require = createRequire(import.meta.url); const __filename = fileURLToPath(import.meta.url); const __dirname = dirname(__filename);",
  },
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
await mkdir('dist/workers/source-fetcher', { recursive: true });
await mkdir('dist/workers/vendor-fetcher', { recursive: true });
await mkdir('dist/workers/change-intelligence-agent', { recursive: true });
await mkdir('dist/workers/impact-analysis-agent', { recursive: true });
await mkdir('dist/workers/migration-agent', { recursive: true });
await mkdir('dist/workers/verifier', { recursive: true });

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
    entryPoints: ['services/github-webhook/src/handler.ts'],
    outfile: 'dist/services/github-webhook.js',
  }),
  build({
    ...common,
    entryPoints: ['services/github-token-broker/src/handler.ts'],
    outfile: 'dist/services/github-token-broker.js',
  }),
  build({
    ...common,
    entryPoints: ['services/github-reconciler/src/handler.ts'],
    outfile: 'dist/services/github-reconciler.js',
  }),
  build({
    ...common,
    entryPoints: ['services/repository-scan-control/src/handler.ts'],
    outfile: 'dist/services/repository-scan-control.js',
  }),
  build({
    ...common,
    entryPoints: ['services/vendor-intelligence-control/src/handler.ts'],
    outfile: 'dist/services/vendor-intelligence-control.js',
  }),
  build({
    ...common,
    entryPoints: ['services/impact-analysis-control/src/handler.ts'],
    outfile: 'dist/services/impact-analysis-control.js',
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
  build({
    ...common,
    entryPoints: ['workers/source-fetcher/src/main.ts'],
    outfile: 'dist/workers/source-fetcher/main.js',
  }),
  build({
    ...common,
    entryPoints: ['workers/vendor-fetcher/src/main.ts'],
    outfile: 'dist/workers/vendor-fetcher/main.js',
  }),
  build({
    ...common,
    entryPoints: ['workers/change-intelligence-agent/src/main.ts'],
    outfile: 'dist/workers/change-intelligence-agent/main.js',
  }),
  build({
    ...common,
    entryPoints: ['workers/impact-analysis-agent/src/main.ts'],
    outfile: 'dist/workers/impact-analysis-agent/main.js',
  }),
  build({
    ...common,
    entryPoints: ['workers/migration-agent/src/main.ts'],
    outfile: 'dist/workers/migration-agent/main.js',
  }),
  build({
    ...common,
    entryPoints: ['workers/verifier/src/main.ts'],
    outfile: 'dist/workers/verifier/main.js',
  }),
]);
