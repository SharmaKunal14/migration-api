import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const serviceBundles = [
  'dist/services/api.js',
  'dist/services/outbox-dispatcher.js',
  'dist/services/workflow-control.js',
];
const workerBundles = [
  'dist/workers/agent/main.js',
  'dist/workers/database-migrator/main.js',
];

for (const bundle of serviceBundles) {
  await import(new URL(`../${bundle}`, import.meta.url));
}

for (const bundle of workerBundles) {
  const result = spawnSync(process.execPath, [resolve(bundle)], {
    encoding: 'utf8',
    env: { NODE_ENV: 'production' },
  });
  if (result.error) {
    throw result.error;
  }

  const output = `${result.stdout}${result.stderr}`;
  if (
    result.status === 0 ||
    !output.includes('Invalid service configuration:') ||
    output.includes('Dynamic require of')
  ) {
    throw new Error(`Bundle startup verification failed for ${bundle}.`);
  }
}

console.log('Verified Node service and worker bundle startup.');
