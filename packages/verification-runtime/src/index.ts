import { spawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { VerificationProfileName } from '@migration/contracts';

const MAX_PROJECT_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const NPM_EXECUTABLE = '/usr/local/bin/npm';
const SUPPORTED_POLICY_VERSION = 'typescript-default-1.0';

const commandRegistry = {
  'npm.install': {
    args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    timeoutMs: 5 * 60 * 1000,
  },
  'npm.typecheck': {
    args: ['run', 'typecheck', '--'],
    timeoutMs: 10 * 60 * 1000,
    requiredScript: 'typecheck',
  },
  'npm.test': {
    args: ['test', '--'],
    timeoutMs: 10 * 60 * 1000,
    requiredScript: 'test',
  },
} as const;

type VerificationCommandId = keyof typeof commandRegistry;
type CommandStatus = 'passed' | 'failed' | 'skipped' | 'timed_out' | 'policy_rejected';

export interface VerificationCommandExecution {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export type VerificationCommandExecutor = (input: {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maximumOutputBytes: number;
}) => Promise<VerificationCommandExecution>;

export interface VerificationRuntimeInput {
  readonly workspaceRoot: string;
  readonly repositoryPath: string;
  readonly verificationPolicyVersion: string;
  readonly selectedProfiles: readonly VerificationProfileName[];
  readonly authorizedProfiles: readonly {
    readonly profile: VerificationProfileName;
    readonly availability: 'available' | 'unavailable';
    readonly commandIds: readonly string[];
  }[];
  readonly approvedRegistryUrl: string;
  readonly execute?: VerificationCommandExecutor;
}

export interface VerificationRuntimeResult {
  readonly outcome:
    | 'passed'
    | 'failed'
    | 'partial'
    | 'unavailable'
    | 'timed_out'
    | 'policy_rejected'
    | 'infrastructure_failed';
  readonly safeErrorCode: string | null;
  readonly commands: readonly {
    readonly commandId: VerificationCommandId;
    readonly status: CommandStatus;
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly durationMs: number;
    readonly stdoutTruncated: boolean;
    readonly stderrTruncated: boolean;
  }[];
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export async function runVerificationProfiles(
  input: VerificationRuntimeInput,
): Promise<VerificationRuntimeResult> {
  if (
    input.verificationPolicyVersion !== SUPPORTED_POLICY_VERSION ||
    input.selectedProfiles.length === 0 ||
    new Set(input.selectedProfiles).size !== input.selectedProfiles.length
  ) {
    return terminal('policy_rejected', 'VERIFICATION_POLICY_REJECTED');
  }

  let repositoryPath: string;
  try {
    repositoryPath = await requireContainedRepository(
      input.workspaceRoot,
      input.repositoryPath,
    );
  } catch {
    return terminal('policy_rejected', 'VERIFICATION_WORKSPACE_REJECTED');
  }

  const project = await inspectNpmProject(repositoryPath);
  if (project.status === 'terminal') {
    return terminal(project.outcome, project.safeErrorCode);
  }

  const commandIds = resolveCommands(input.selectedProfiles);
  if (
    !commandsAreAuthorized(input.authorizedProfiles, input.selectedProfiles, commandIds)
  ) {
    return terminal('policy_rejected', 'VERIFICATION_PROFILE_UNAUTHORIZED');
  }
  for (const commandId of commandIds) {
    const requiredScript = commandRegistry[commandId].requiredScript;
    if (!project.scripts.has(requiredScript)) {
      return terminal('unavailable', 'VERIFICATION_SCRIPT_UNAVAILABLE');
    }
  }

  const registryUrl = approvedRegistry(input.approvedRegistryUrl);
  if (registryUrl === null) {
    return terminal('policy_rejected', 'VERIFICATION_REGISTRY_REJECTED');
  }

  const execute = input.execute ?? executeVerificationCommand;
  const environment = verificationEnvironment(registryUrl);
  const results: VerificationRuntimeResult['commands'][number][] = [];
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];

  for (const commandId of ['npm.install', ...commandIds] as const) {
    const command = commandRegistry[commandId];
    let execution: VerificationCommandExecution;
    try {
      execution = await execute({
        executable: NPM_EXECUTABLE,
        args: command.args,
        cwd: repositoryPath,
        env: environment,
        timeoutMs: command.timeoutMs,
        maximumOutputBytes: MAX_OUTPUT_BYTES,
      });
    } catch {
      return withOutput(
        terminal('infrastructure_failed', 'VERIFICATION_PROCESS_START_FAILED', results),
        stdout,
        stderr,
      );
    }
    stdout.push(execution.stdout);
    stderr.push(execution.stderr);
    const status: CommandStatus = execution.timedOut
      ? 'timed_out'
      : execution.exitCode === 0 && execution.signal === null
        ? 'passed'
        : 'failed';
    results.push({
      commandId,
      status,
      exitCode: execution.timedOut ? null : execution.exitCode,
      signal: execution.signal,
      durationMs: execution.durationMs,
      stdoutTruncated: execution.stdoutTruncated,
      stderrTruncated: execution.stderrTruncated,
    });
    if (status !== 'passed') {
      return withOutput(
        terminal(
          status === 'timed_out' ? 'timed_out' : 'failed',
          status === 'timed_out'
            ? 'VERIFICATION_COMMAND_TIMED_OUT'
            : commandId === 'npm.install'
              ? 'VERIFICATION_DEPENDENCY_INSTALL_FAILED'
              : 'VERIFICATION_COMMAND_FAILED',
          results,
        ),
        stdout,
        stderr,
      );
    }
  }

  return withOutput(
    {
      ...terminal('passed', null, results),
      safeErrorCode: null,
    },
    stdout,
    stderr,
  );
}

export async function executeVerificationCommand(input: {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maximumOutputBytes: number;
}): Promise<VerificationCommandExecution> {
  const startedAt = Date.now();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = new BoundedOutput(input.maximumOutputBytes);
    const stderr = new BoundedOutput(input.maximumOutputBytes);
    child.stdout.on('data', chunk => stdout.append(chunk as Uint8Array));
    child.stderr.on('data', chunk => stderr.append(chunk as Uint8Array));
    child.once('error', reject);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateGroup(child.pid, 'SIGTERM');
      setTimeout(() => terminateGroup(child.pid, 'SIGKILL'), 2_000).unref();
    }, input.timeoutMs);
    timeout.unref();
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout);
      resolvePromise({
        exitCode: timedOut ? null : exitCode,
        signal: signal ?? null,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: stdout.bytes(),
        stderr: stderr.bytes(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    });
  });
}

class BoundedOutput {
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  public truncated = false;

  public constructor(private readonly maximumBytes: number) {}

  public append(value: Uint8Array): void {
    const chunk = Buffer.from(value);
    const accepted = chunk.subarray(0, this.maximumBytes - this.#bytes);
    if (accepted.byteLength > 0) {
      this.#chunks.push(accepted);
      this.#bytes += accepted.byteLength;
    }
    if (accepted.byteLength !== chunk.byteLength) this.truncated = true;
  }

  public bytes(): Buffer {
    return Buffer.concat(this.#chunks, this.#bytes);
  }
}

async function requireContainedRepository(
  workspaceRoot: string,
  repositoryPath: string,
): Promise<string> {
  if (!isAbsolute(workspaceRoot) || !isAbsolute(repositoryPath)) {
    throw new Error('Verification paths must be absolute.');
  }
  const [root, repository] = await Promise.all([
    realpath(workspaceRoot),
    realpath(repositoryPath),
  ]);
  if (root !== resolve(workspaceRoot) || repository !== resolve(repositoryPath)) {
    throw new Error('Verification paths must be canonical.');
  }
  const contained = relative(root, repository);
  if (
    contained === '' ||
    contained === '..' ||
    contained.startsWith(`..${sep}`) ||
    isAbsolute(contained)
  ) {
    throw new Error('Repository is outside the verification workspace.');
  }
  return repository;
}

async function inspectNpmProject(repositoryPath: string): Promise<
  | { readonly status: 'ready'; readonly scripts: ReadonlySet<string> }
  | {
      readonly status: 'terminal';
      readonly outcome: 'unavailable' | 'policy_rejected';
      readonly safeErrorCode: string;
    }
> {
  const packagePath = join(repositoryPath, 'package.json');
  const lockfilePath = join(repositoryPath, 'package-lock.json');
  const paths = [packagePath, lockfilePath];
  try {
    for (const path of paths) {
      const metadata = await lstat(path);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size < 1 ||
        metadata.size > MAX_PROJECT_FILE_BYTES
      ) {
        return rejectedProject();
      }
    }
    const [packageBytes, lockfileBytes] = await Promise.all([
      readFile(packagePath),
      readFile(lockfilePath),
    ]);
    const packageJson = record(JSON.parse(packageBytes.toString('utf8')));
    const lockfile = record(JSON.parse(lockfileBytes.toString('utf8')));
    if (lockfile.lockfileVersion !== 2 && lockfile.lockfileVersion !== 3) {
      return {
        status: 'terminal',
        outcome: 'unavailable',
        safeErrorCode: 'VERIFICATION_LOCKFILE_UNSUPPORTED',
      };
    }
    const lockfilePackages = lockfile.packages;
    if (
      lockfilePackages === null ||
      typeof lockfilePackages !== 'object' ||
      Array.isArray(lockfilePackages) ||
      Object.values(lockfilePackages).some(entry => {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          return true;
        }
        const resolved = (entry as Record<string, unknown>).resolved;
        return (
          typeof resolved === 'string' &&
          !resolved.startsWith('https://registry.npmjs.org/')
        );
      })
    ) {
      return {
        status: 'terminal',
        outcome: 'unavailable',
        safeErrorCode: 'VERIFICATION_DEPENDENCY_SOURCE_UNSUPPORTED',
      };
    }
    const scriptsValue = packageJson.scripts;
    const scripts =
      scriptsValue !== null &&
      typeof scriptsValue === 'object' &&
      !Array.isArray(scriptsValue)
        ? new Set(Object.keys(scriptsValue))
        : new Set<string>();
    return { status: 'ready', scripts };
  } catch {
    return {
      status: 'terminal',
      outcome: 'unavailable',
      safeErrorCode: 'VERIFICATION_LOCKFILE_UNAVAILABLE',
    };
  }
}

function resolveCommands(
  profiles: readonly VerificationProfileName[],
): readonly ('npm.typecheck' | 'npm.test')[] {
  const commands: ('npm.typecheck' | 'npm.test')[] = [];
  if (profiles.includes('typescript_static')) commands.push('npm.typecheck');
  if (profiles.includes('typescript_unit')) commands.push('npm.test');
  return commands;
}

function commandsAreAuthorized(
  profiles: VerificationRuntimeInput['authorizedProfiles'],
  selected: readonly VerificationProfileName[],
  commands: readonly string[],
): boolean {
  const authorized = new Map(profiles.map(profile => [profile.profile, profile]));
  const entries = selected.map(profile => authorized.get(profile));
  return (
    entries.every(
      entry => entry?.availability === 'available' && entry.commandIds.length === 1,
    ) &&
    entries.flatMap(entry => entry?.commandIds ?? []).length === commands.length &&
    commands.every(command =>
      entries.some(entry => entry?.commandIds.includes(command)),
    )
  );
}

function approvedRegistry(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      url.pathname === '/'
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function verificationEnvironment(
  registryUrl: string,
): Readonly<Record<string, string>> {
  return {
    HOME: '/workspace/home',
    LANG: 'C.UTF-8',
    NODE_ENV: 'test',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_globalconfig: '/dev/null',
    npm_config_ignore_scripts: 'true',
    npm_config_registry: registryUrl,
    npm_config_update_notifier: 'false',
    npm_config_userconfig: '/dev/null',
  };
}

function rejectedProject(): {
  readonly status: 'terminal';
  readonly outcome: 'policy_rejected';
  readonly safeErrorCode: string;
} {
  return {
    status: 'terminal' as const,
    outcome: 'policy_rejected' as const,
    safeErrorCode: 'VERIFICATION_PROJECT_FILE_REJECTED',
  };
}

function terminal(
  outcome: VerificationRuntimeResult['outcome'],
  safeErrorCode: string | null,
  commands: VerificationRuntimeResult['commands'] = [],
): VerificationRuntimeResult {
  return {
    outcome,
    safeErrorCode,
    commands,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  };
}

function withOutput(
  result: VerificationRuntimeResult,
  stdout: readonly Buffer[],
  stderr: readonly Buffer[],
): VerificationRuntimeResult {
  return {
    ...result,
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr),
  };
}

function terminateGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The process may have exited between timeout detection and termination.
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object.');
  }
  return value as Record<string, unknown>;
}
