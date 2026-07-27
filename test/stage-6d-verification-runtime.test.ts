import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  executeVerificationCommand,
  runVerificationProfiles,
  type VerificationCommandExecution,
  type VerificationCommandExecutor,
  type VerificationRuntimeInput,
} from '@migration/verification-runtime';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

describe('Stage 6D verification runtime', () => {
  it('installs once without scripts and runs only fixed authorized commands', async () => {
    const fixture = await npmProject({ typecheck: 'tsc', test: 'vitest' });
    const invocations: Parameters<VerificationCommandExecutor>[0][] = [];
    const result = await runVerificationProfiles({
      ...baseInput(fixture),
      selectedProfiles: ['typescript_static', 'typescript_unit'],
      authorizedProfiles: [
        {
          profile: 'typescript_static',
          availability: 'available',
          commandIds: ['npm.typecheck'],
        },
        {
          profile: 'typescript_unit',
          availability: 'available',
          commandIds: ['npm.test'],
        },
      ],
      execute: input => {
        invocations.push(input);
        return Promise.resolve(success());
      },
    });

    expect(result.outcome).toBe('passed');
    expect(invocations.map(command => command.args)).toEqual([
      ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
      ['run', 'typecheck', '--'],
      ['test', '--'],
    ]);
    expect(
      invocations.every(command => command.executable === '/usr/local/bin/npm'),
    ).toBe(true);
    expect(invocations[0]?.env).toMatchObject({
      npm_config_ignore_scripts: 'true',
      npm_config_userconfig: '/dev/null',
      npm_config_globalconfig: '/dev/null',
    });
    expect(invocations[0]?.env).not.toHaveProperty('AWS_ACCESS_KEY_ID');
    expect(invocations[0]?.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(invocations[0]?.env).not.toHaveProperty('DATABASE_URL');
  });

  it('rejects unapproved commands, policies, and registries before spawning', async () => {
    const fixture = await npmProject({ typecheck: 'tsc' });
    const cases = [
      { verificationPolicyVersion: 'typescript-default-2.0' },
      {
        authorizedProfiles: [
          {
            profile: 'typescript_static' as const,
            availability: 'available' as const,
            commandIds: ['npm.arbitrary'],
          },
        ],
      },
      { approvedRegistryUrl: 'http://127.0.0.1:4873/' },
    ];
    for (const testCase of cases) {
      const result = await runVerificationProfiles({
        ...baseInput(fixture),
        ...testCase,
        execute: () => {
          throw new Error('Untrusted command must not run.');
        },
      });
      expect(result.outcome).toBe('policy_rejected');
    }
  });

  it('reports missing scripts and unsupported lockfiles as unavailable', async () => {
    const noScript = await npmProject({});
    await expect(runVerificationProfiles(baseInput(noScript))).resolves.toMatchObject({
      outcome: 'unavailable',
      safeErrorCode: 'VERIFICATION_SCRIPT_UNAVAILABLE',
    });

    const oldLockfile = await npmProject({ typecheck: 'tsc' }, 1);
    await expect(
      runVerificationProfiles(baseInput(oldLockfile)),
    ).resolves.toMatchObject({
      outcome: 'unavailable',
      safeErrorCode: 'VERIFICATION_LOCKFILE_UNSUPPORTED',
    });
  });

  it('stops after dependency installation fails', async () => {
    const fixture = await npmProject({ typecheck: 'tsc' });
    let calls = 0;
    const result = await runVerificationProfiles({
      ...baseInput(fixture),
      execute: () => {
        calls += 1;
        return Promise.resolve({ ...success(), exitCode: 1 });
      },
    });

    expect(calls).toBe(1);
    expect(result).toMatchObject({
      outcome: 'failed',
      safeErrorCode: 'VERIFICATION_DEPENDENCY_INSTALL_FAILED',
      commands: [{ commandId: 'npm.install', status: 'failed', exitCode: 1 }],
    });
  });

  it('classifies command timeout separately from failure', async () => {
    const fixture = await npmProject({ typecheck: 'tsc' });
    let calls = 0;
    const result = await runVerificationProfiles({
      ...baseInput(fixture),
      execute: () => {
        calls += 1;
        return Promise.resolve(
          calls === 1
            ? success()
            : {
                ...success(),
                exitCode: null,
                signal: 'SIGKILL',
                timedOut: true,
                stdoutTruncated: true,
              },
        );
      },
    });

    expect(result).toMatchObject({
      outcome: 'timed_out',
      safeErrorCode: 'VERIFICATION_COMMAND_TIMED_OUT',
      commands: [
        { commandId: 'npm.install', status: 'passed' },
        {
          commandId: 'npm.typecheck',
          status: 'timed_out',
          stdoutTruncated: true,
        },
      ],
    });
  });

  it('executes without a shell and bounds captured output', async () => {
    const fixture = await npmProject({ typecheck: 'tsc' });
    const result = await executeVerificationCommand({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("abcdef"); process.stderr.write("xy")'],
      cwd: fixture.repositoryPath,
      env: { PATH: '/usr/bin:/bin' },
      timeoutMs: 5_000,
      maximumOutputBytes: 4,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdoutTruncated: true,
      stderrTruncated: false,
    });
    expect(result.stdout.toString('utf8')).toBe('abcd');
    expect(result.stderr.toString('utf8')).toBe('xy');
  });

  it('kills the process group at the wall-clock timeout', async () => {
    const fixture = await npmProject({ typecheck: 'tsc' });
    const result = await executeVerificationCommand({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => undefined, 1_000)'],
      cwd: fixture.repositoryPath,
      env: { PATH: '/usr/bin:/bin' },
      timeoutMs: 25,
      maximumOutputBytes: 100,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe('SIGTERM');
  });

  it('fails closed for invalid workspaces and malformed project files', async () => {
    const fixture = await npmProject({ typecheck: 'tsc' });
    await expect(
      runVerificationProfiles({
        ...baseInput(fixture),
        repositoryPath: fixture.workspaceRoot,
      }),
    ).resolves.toMatchObject({
      outcome: 'policy_rejected',
      safeErrorCode: 'VERIFICATION_WORKSPACE_REJECTED',
    });

    await writeFile(join(fixture.repositoryPath, 'package.json'), '{');
    await expect(runVerificationProfiles(baseInput(fixture))).resolves.toMatchObject({
      outcome: 'unavailable',
      safeErrorCode: 'VERIFICATION_LOCKFILE_UNAVAILABLE',
    });
  });

  it('reports process-start and verification-command failures separately', async () => {
    const fixture = await npmProject({ typecheck: 'tsc' });
    await expect(
      runVerificationProfiles({
        ...baseInput(fixture),
        execute: () => Promise.reject(new Error('spawn failed')),
      }),
    ).resolves.toMatchObject({
      outcome: 'infrastructure_failed',
      safeErrorCode: 'VERIFICATION_PROCESS_START_FAILED',
    });

    let calls = 0;
    await expect(
      runVerificationProfiles({
        ...baseInput(fixture),
        execute: () => {
          calls += 1;
          return Promise.resolve(
            calls === 1 ? success() : { ...success(), exitCode: 2 },
          );
        },
      }),
    ).resolves.toMatchObject({
      outcome: 'failed',
      safeErrorCode: 'VERIFICATION_COMMAND_FAILED',
    });
  });
});

function baseInput(fixture: {
  readonly workspaceRoot: string;
  readonly repositoryPath: string;
}): VerificationRuntimeInput {
  return {
    ...fixture,
    verificationPolicyVersion: 'typescript-default-1.0',
    selectedProfiles: ['typescript_static'] as const,
    authorizedProfiles: [
      {
        profile: 'typescript_static' as const,
        availability: 'available' as const,
        commandIds: ['npm.typecheck'],
      },
    ],
    approvedRegistryUrl: 'https://registry.npmjs.org/',
    execute: (): Promise<VerificationCommandExecution> => Promise.resolve(success()),
  };
}

async function npmProject(
  scripts: Readonly<Record<string, string>>,
  lockfileVersion = 3,
): Promise<{ readonly workspaceRoot: string; readonly repositoryPath: string }> {
  const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), 'stage-6d-')));
  temporaryRoots.push(workspaceRoot);
  const repositoryPath = join(workspaceRoot, 'repository');
  await mkdir(repositoryPath);
  await writeFile(
    join(repositoryPath, 'package.json'),
    JSON.stringify({ name: 'fixture', private: true, scripts }),
  );
  await writeFile(
    join(repositoryPath, 'package-lock.json'),
    JSON.stringify({
      name: 'fixture',
      lockfileVersion,
      packages: { '': { name: 'fixture' } },
    }),
  );
  return { workspaceRoot, repositoryPath };
}

function success(): VerificationCommandExecution {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 10,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}
