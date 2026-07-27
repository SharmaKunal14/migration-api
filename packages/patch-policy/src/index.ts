import { createHash } from 'node:crypto';

import {
  migrationPatchManifestSchema,
  migrationPatchValidationResultSchema,
  type MigrationAgentInputArtifact,
  type MigrationAgentProposedEdit,
  type MigrationExecutionPlan,
  type MigrationPatchManifest,
  type MigrationPatchValidationResult,
} from '@migration/contracts';

const safePatchPath = /^[A-Za-z0-9._/-]+$/u;
const forbiddenPaths = [
  /^\.git(?:\/|$)/u,
  /^\.github(?:\/|$)/u,
  /^\.buildkite(?:\/|$)/u,
  /^\.circleci(?:\/|$)/u,
  /^\.gitlab(?:\/|$)/u,
  /(?:^|\/)\.gitlab-ci\.ya?ml$/u,
  /(?:^|\/)azure-pipelines\.ya?ml$/u,
  /(?:^|\/)bitbucket-pipelines\.ya?ml$/u,
  /(?:^|\/)CODEOWNERS$/u,
  /(?:^|\/)Jenkinsfile$/u,
  /(?:^|\/)\.env(?:\.|$)/u,
  /(?:^|\/)(?:secrets?|credentials?)(?:\.|\/|$)/iu,
];

export interface PatchBuildInput {
  readonly migration: MigrationAgentInputArtifact;
  readonly plan: MigrationExecutionPlan;
  readonly edits: readonly MigrationAgentProposedEdit[];
  readonly readFile: (path: string) => string | undefined;
}

export interface PatchBuildResult {
  readonly patch: string;
  readonly manifest: MigrationPatchManifest;
  readonly validation: MigrationPatchValidationResult;
}

interface BuiltFile {
  readonly patch: string;
  readonly manifest: MigrationPatchManifest['files'][number];
}

export function buildAndValidatePatch(input: PatchBuildInput): PatchBuildResult {
  const checks = new Map<
    MigrationPatchValidationResult['checks'][number]['check'],
    string | null
  >([
    ['base_binding', null],
    ['diff_structure', null],
    ['path_safety', null],
    ['allowed_paths', null],
    ['forbidden_paths', null],
    ['binary_files', null],
    ['change_budget', null],
  ]);
  if (
    !sameJson(input.plan.binding, input.migration.binding) ||
    input.plan.attemptNumber !== input.migration.attemptNumber
  ) {
    checks.set('base_binding', 'PATCH_BASE_BINDING_MISMATCH');
  }
  const knownChanges = new Set(
    input.migration.migrationSpecification.changes.map(change => change.changeId),
  );
  const knownTransformations = new Set(
    input.migration.migrationSpecification.changes
      .filter(change => change.transformations.length > 0)
      .map(change => change.changeId),
  );
  if (
    input.plan.files.some(
      file =>
        file.evidenceChangeIds.some(changeId => !knownChanges.has(changeId)) ||
        file.transformationIds.some(changeId => !knownTransformations.has(changeId)),
    )
  ) {
    checks.set('diff_structure', 'PATCH_PLAN_EVIDENCE_INVALID');
  }
  const planPaths = input.plan.files.map(file => file.path);
  const plansByPath = new Map(input.plan.files.map(file => [file.path, file]));
  const editsByPath = new Map(input.edits.map(edit => [edit.path, edit]));
  const impactByPath = new Map(
    input.migration.impact.affectedFiles.map(file => [file.path, file]),
  );
  if (
    editsByPath.size !== input.edits.length ||
    planPaths.length !== input.edits.length ||
    planPaths.some(path => !editsByPath.has(path))
  ) {
    checks.set('diff_structure', 'PATCH_PLAN_MISMATCH');
  }

  const policy = input.migration.authority.patchPolicy;
  const allowedPaths = new Set(policy.allowedPaths);
  const allowedCategories = new Set(policy.allowedChangeCategories);
  const built: BuiltFile[] = [];
  for (const edit of input.edits) {
    const planned = plansByPath.get(edit.path);
    const planMatches =
      planned?.operation === edit.operation &&
      planned.changeCategory === edit.changeCategory;
    if (!planMatches) {
      checks.set('diff_structure', 'PATCH_PLAN_MISMATCH');
    }
    if (edit.operation !== 'modify' || planned?.operation !== 'modify') {
      checks.set('diff_structure', 'PATCH_FILE_OPERATION_NOT_AUTHORIZED');
    }
    if (!safePatchPath.test(edit.path) || edit.path.includes('//')) {
      checks.set('path_safety', 'PATCH_PATH_UNSAFE');
      continue;
    }
    const isAllowed =
      allowedPaths.has(edit.path) && allowedCategories.has(edit.changeCategory);
    const isForbidden = forbiddenPaths.some(pattern => pattern.test(edit.path));
    if (!isAllowed) {
      checks.set('allowed_paths', 'PATCH_SCOPE_NOT_AUTHORIZED');
    }
    const impacted = impactByPath.get(edit.path);
    if (
      isAllowed &&
      !isForbidden &&
      edit.changeCategory !== 'dependency_manifest' &&
      edit.changeCategory !== 'lockfile' &&
      impacted?.classification !== edit.changeCategory
    ) {
      checks.set('allowed_paths', 'PATCH_IMPACT_SCOPE_MISMATCH');
    }
    if (isForbidden) {
      checks.set('forbidden_paths', 'PATCH_FORBIDDEN_PATH');
    }
    if (edit.content?.includes('\u0000')) {
      checks.set('binary_files', 'PATCH_BINARY_CONTENT');
    }
    const before = input.readFile(edit.path);
    if (
      (edit.operation === 'create' && before !== undefined) ||
      (edit.operation !== 'create' && before === undefined)
    ) {
      checks.set('diff_structure', 'PATCH_FILE_STATE_MISMATCH');
      continue;
    }
    if (edit.operation !== 'delete' && edit.content === null) {
      checks.set('diff_structure', 'PATCH_CONTENT_MISSING');
      continue;
    }
    if (edit.operation === 'modify' && before === edit.content) {
      checks.set('diff_structure', 'PATCH_EMPTY_CHANGE');
      continue;
    }
    built.push(buildFilePatch(edit, before));
  }

  const patch = built.map(file => file.patch).join('');
  const patchBytes = Buffer.byteLength(patch, 'utf8');
  const addedLines = sum(built.map(file => file.manifest.addedLines));
  const deletedLines = sum(built.map(file => file.manifest.deletedLines));
  if (
    built.length !== input.edits.length ||
    parsePatchPaths(patch).length !== built.length
  ) {
    checks.set('diff_structure', 'PATCH_STRUCTURE_INVALID');
  }
  if (
    built.length > policy.maxChangedFiles ||
    patchBytes > policy.maxPatchBytes ||
    addedLines > policy.maxAddedLines ||
    deletedLines > policy.maxDeletedLines
  ) {
    checks.set('change_budget', 'PATCH_CHANGE_BUDGET_EXCEEDED');
  }

  const patchDigest = digest(patch);
  const manifest = migrationPatchManifestSchema.parse({
    schemaVersion: '1.0',
    proposalStatus: 'unvalidated',
    binding: input.migration.binding,
    attemptNumber: input.migration.attemptNumber,
    planDigest: digestJson(input.plan),
    patchDigest,
    patchBytes,
    changedFiles: built.length,
    addedLines,
    deletedLines,
    files: built.map(file => file.manifest),
  });
  const failedCheck = [...checks.entries()].find(([, safeCode]) => safeCode !== null);
  const validation = migrationPatchValidationResultSchema.parse({
    schemaVersion: '1.0',
    binding: input.migration.binding,
    attemptNumber: input.migration.attemptNumber,
    planDigest: manifest.planDigest,
    patchDigest,
    policyVersion: input.migration.authority.patchPolicyVersion,
    policyDigest: input.migration.authority.patchPolicyDigest,
    status: failedCheck ? 'rejected' : 'accepted',
    safeErrorCode: failedCheck?.[1] ?? null,
    checks: [...checks.entries()].map(([check, safeErrorCode]) => ({
      check,
      outcome: safeErrorCode === null ? 'passed' : 'failed',
      safeErrorCode,
    })),
  });
  return { patch, manifest, validation };
}

export function parsePatchPaths(patch: string): string[] {
  if (patch.length === 0) return [];
  const paths: string[] = [];
  for (const line of patch.split('\n')) {
    const match = /^diff --git a\/([A-Za-z0-9._/-]+) b\/([A-Za-z0-9._/-]+)$/u.exec(
      line,
    );
    if (!match) continue;
    const oldPath = match[1];
    const newPath = match[2];
    if (!oldPath || !newPath || oldPath !== newPath || paths.includes(oldPath)) {
      return [];
    }
    paths.push(oldPath);
  }
  return paths;
}

function buildFilePatch(
  edit: MigrationAgentProposedEdit,
  before: string | undefined,
): BuiltFile {
  const after = edit.content ?? undefined;
  const oldLines = splitLines(before ?? '');
  const newLines = splitLines(after ?? '');
  let { prefix, suffix } = commonEdges(oldLines, newLines);
  if (
    before !== after &&
    prefix === oldLines.length &&
    prefix === newLines.length &&
    prefix > 0
  ) {
    prefix -= 1;
    suffix = 0;
  }
  const oldChanged = oldLines.slice(prefix, oldLines.length - suffix);
  const newChanged = newLines.slice(prefix, newLines.length - suffix);
  const contextStart = Math.max(0, prefix - 3);
  const contextEndOld = Math.min(oldLines.length, oldLines.length - suffix + 3);
  const contextEndNew = Math.min(newLines.length, newLines.length - suffix + 3);
  const leadingContext = oldLines.slice(contextStart, prefix);
  const trailingContext = oldLines.slice(oldLines.length - suffix, contextEndOld);
  const oldStart = oldLines.length === 0 ? 0 : contextStart + 1;
  const newStart = newLines.length === 0 ? 0 : contextStart + 1;
  const oldChangedLines = oldChanged.map(line => `-${line}`);
  const newChangedLines = newChanged.map(line => `+${line}`);
  const trailingContextLines = trailingContext.map(line => ` ${line}`);
  if (
    trailingContextLines.length === 0 &&
    oldChangedLines.length > 0 &&
    before !== undefined &&
    !before.endsWith('\n')
  ) {
    oldChangedLines.push('\\ No newline at end of file');
  }
  if (
    trailingContextLines.length === 0 &&
    newChangedLines.length > 0 &&
    after !== undefined &&
    !after.endsWith('\n')
  ) {
    newChangedLines.push('\\ No newline at end of file');
  }
  if (
    trailingContextLines.length > 0 &&
    ((before !== undefined && !before.endsWith('\n')) ||
      (after !== undefined && !after.endsWith('\n')))
  ) {
    trailingContextLines.push('\\ No newline at end of file');
  }
  const hunk = [
    `@@ -${String(oldStart)},${String(contextEndOld - contextStart)} +${String(
      newStart,
    )},${String(contextEndNew - contextStart)} @@`,
    ...leadingContext.map(line => ` ${line}`),
    ...oldChangedLines,
    ...newChangedLines,
    ...trailingContextLines,
  ].join('\n');
  const patch = [
    `diff --git a/${edit.path} b/${edit.path}`,
    edit.operation === 'create' ? 'new file mode 100644' : null,
    edit.operation === 'delete' ? 'deleted file mode 100644' : null,
    edit.operation === 'create' ? '--- /dev/null' : `--- a/${edit.path}`,
    edit.operation === 'delete' ? '+++ /dev/null' : `+++ b/${edit.path}`,
    hunk,
    '',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
  return {
    patch,
    manifest: {
      path: edit.path,
      operation: edit.operation,
      changeCategory: edit.changeCategory,
      beforeDigest: before === undefined ? null : digest(before),
      afterDigest: after === undefined ? null : digest(after),
      hunkCount: 1,
      addedLines: newChanged.length,
      deletedLines: oldChanged.length,
    },
  };
}

function commonEdges(
  before: readonly string[],
  after: readonly string[],
): { readonly prefix: number; readonly suffix: number } {
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return { prefix, suffix };
}

function splitLines(value: string): string[] {
  if (value.length === 0) return [];
  const lines = value.replace(/\r\n/gu, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function digestJson(value: unknown): string {
  return digest(JSON.stringify(value));
}
