import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import pg from 'pg';

import {
  databaseCredentialSchema,
  migratorConfigSchema,
  parseConfig,
} from '@migration/config';
import { writeLog } from '@migration/observability';

const migrationName = /^\d{4}_[a-z0-9_]+\.sql$/u;
const advisoryLockName = 'migration-api-schema-v1';

async function main(): Promise<void> {
  const config = parseConfig(migratorConfigSchema);
  const secrets = new SecretsManagerClient({ region: config.AWS_REGION });
  const response = await secrets.send(
    new GetSecretValueCommand({
      SecretId: config.DATABASE_MIGRATION_SECRET_ARN,
      VersionStage: 'AWSCURRENT',
    }),
  );
  if (!response.SecretString) {
    throw new Error('The migration credential secret has no string value.');
  }
  const credentials = databaseCredentialSchema.parse(JSON.parse(response.SecretString));
  const client = new pg.Client({
    host: credentials.host,
    port: credentials.port,
    database: credentials.database,
    user: credentials.username,
    password: credentials.password,
    application_name: 'migration-api-migrator',
    connectionTimeoutMillis: 5_000,
    options:
      '-c statement_timeout=30000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=30000',
    ssl: {
      ca: credentials.sslCaCertificate,
      rejectUnauthorized: true,
    },
  });
  await client.connect();
  try {
    await client.query('select pg_advisory_lock(hashtext($1))', [advisoryLockName]);
    await client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
        applied_at timestamptz not null default now()
      )
    `);
    const files = (await readdir(config.MIGRATIONS_DIRECTORY))
      .filter(file => migrationName.test(file))
      .sort();
    for (const file of files) {
      const sql = await readFile(join(config.MIGRATIONS_DIRECTORY, file), 'utf8');
      const digest = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query<{ sha256: string }>(
        'select sha256 from schema_migrations where name = $1',
        [file],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].sha256 !== digest) {
          throw new Error(`Applied migration digest changed: ${file}`);
        }
        continue;
      }
      await client.query('begin');
      try {
        // Migration SQL is reviewed repository-owned code, never external input.
        await client.query(sql);
        await client.query(
          'insert into schema_migrations (name, sha256) values ($1, $2)',
          [file, digest],
        );
        await client.query('commit');
        writeLog('info', { event: 'database_migration_applied', outcome: file });
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock(hashtext($1))', [advisoryLockName]);
    await client.end();
  }
}

await main();
