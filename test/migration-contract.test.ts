import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { GITHUB_INSTALL_RETURN_PATH } from '../services/api/src/repository.js';

const stageTwoMigration = readFileSync(
  fileURLToPath(new URL('../supabase/migrations/0002_stage_2.sql', import.meta.url)),
  'utf8',
);

describe('Stage 2 database contracts', () => {
  it('allows the API installation return path', () => {
    const returnPathConstraint = /return_path\s+in\s+\((?<allowed>[^)]+)\)/u.exec(
      stageTwoMigration,
    );

    expect(returnPathConstraint?.groups?.allowed).toContain(
      `'${GITHUB_INSTALL_RETURN_PATH}'`,
    );
  });
});
