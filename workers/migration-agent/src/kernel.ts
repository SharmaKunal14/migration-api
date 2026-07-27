import type {
  ResponseFunctionToolCall,
  ResponseInputItem,
} from 'openai/resources/responses/responses';

import type {
  MigrationAgentResult,
  MigrationAgentProposedEdit,
  MigrationExecutionPlan,
} from '@migration/contracts';

import { InvalidMigrationOutputError, type MigrationAgentGateway } from './gateway.js';
import {
  RepositoryToolError,
  type RepositoryTools,
} from '../../impact-analysis-agent/src/tools.js';

const budgets = {
  maximumModelCalls: 5,
  maximumToolCalls: 40,
  maximumIterations: 6,
  maximumInputTokens: 120_000,
  maximumOutputTokens: 24_000,
  maximumWallClockMilliseconds: 5 * 60 * 1_000,
} as const;

export interface MigrationKernelResult {
  readonly plan: MigrationExecutionPlan;
  readonly edits: readonly MigrationAgentProposedEdit[];
  readonly model: MigrationAgentResult['model'];
  readonly usage: MigrationAgentResult['usage'];
  readonly actions: MigrationAgentResult['actions'];
}

export class MigrationAgentKernel {
  public constructor(
    private readonly gateway: MigrationAgentGateway,
    private readonly tools: RepositoryTools,
  ) {}

  public async run(): Promise<MigrationKernelResult> {
    const startedAt = Date.now();
    const deadline = startedAt + budgets.maximumWallClockMilliseconds;
    const modelInput = this.gateway.initialInput();
    const actions: MigrationAgentResult['actions'] = [];
    const calledTools = new Set<string>();
    const readPaths = new Set<string>();
    let modelCalls = 0;
    let toolCalls = 0;
    let iterations = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let returnedModel: string;
    let requestId: string | null;

    while (iterations < budgets.maximumIterations) {
      iterations += 1;
      if (Date.now() >= deadline) {
        throw new MigrationAgentRuntimeError('AGENT_TIME_BUDGET_EXHAUSTED');
      }
      if (modelCalls >= budgets.maximumModelCalls) {
        throw new MigrationAgentRuntimeError('MODEL_CALL_BUDGET_EXHAUSTED');
      }
      const remaining = budgets.maximumOutputTokens - outputTokens;
      if (remaining <= 0) {
        throw new MigrationAgentRuntimeError('OUTPUT_TOKEN_BUDGET_EXHAUSTED');
      }
      modelCalls += 1;
      const turn = await this.gateway.runTurn(
        modelInput,
        remaining,
        modelCalls < budgets.maximumModelCalls,
        AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      );
      returnedModel = turn.response.model;
      requestId = turn.requestId;
      inputTokens += turn.inputTokens;
      outputTokens += turn.outputTokens;
      if (inputTokens > budgets.maximumInputTokens) {
        throw new MigrationAgentRuntimeError('INPUT_TOKEN_BUDGET_EXHAUSTED');
      }
      if (outputTokens > budgets.maximumOutputTokens) {
        throw new MigrationAgentRuntimeError('OUTPUT_TOKEN_BUDGET_EXHAUSTED');
      }
      const calls = turn.response.output.filter(
        (item): item is ResponseFunctionToolCall => item.type === 'function_call',
      );
      if (calls.length === 0) {
        for (const required of [
          'list_repository_files',
          'inspect_manifest',
          'search_repository',
          'inspect_typescript',
        ]) {
          if (!calledTools.has(required)) {
            throw new MigrationAgentRuntimeError('MIGRATION_TOOL_REQUIREMENTS_NOT_MET');
          }
        }
        let proposal;
        try {
          proposal = this.gateway.parseTerminal(turn.response);
        } catch (error) {
          throw new MigrationAgentRuntimeError(
            error instanceof InvalidMigrationOutputError
              ? error.safeCode
              : 'MIGRATION_MODEL_OUTPUT_INVALID',
          );
        }
        if (
          proposal.edits.some(
            edit => edit.operation !== 'create' && !readPaths.has(edit.path),
          )
        ) {
          throw new MigrationAgentRuntimeError('PATCH_SOURCE_NOT_READ');
        }
        return {
          ...proposal,
          model: {
            requestedModel: process.env.OPENAI_MODEL ?? 'unknown',
            returnedModel,
            requestId,
          },
          usage: {
            modelCalls,
            toolCalls,
            iterations,
            inputTokens,
            outputTokens,
            durationMs: Math.min(Date.now() - startedAt, 10 * 60 * 1_000),
          },
          actions,
        };
      }
      modelInput.push(...calls);
      for (const call of calls) {
        if (toolCalls >= budgets.maximumToolCalls) {
          throw new MigrationAgentRuntimeError('TOOL_CALL_BUDGET_EXHAUSTED');
        }
        toolCalls += 1;
        let execution;
        try {
          execution = this.tools.execute(call.name, call.arguments, toolCalls);
        } catch (error) {
          throw new MigrationAgentRuntimeError(
            error instanceof RepositoryToolError
              ? error.safeCode
              : 'REPOSITORY_TOOL_FAILED',
          );
        }
        if (
          execution.action.status !== 'succeeded' ||
          execution.action.safeErrorCode !== null ||
          execution.action.outputDigest === null
        ) {
          throw new MigrationAgentRuntimeError('REPOSITORY_TOOL_FAILED');
        }
        actions.push({
          ...execution.action,
          status: 'succeeded',
          safeErrorCode: null,
          outputDigest: execution.action.outputDigest,
        });
        calledTools.add(call.name);
        if (call.name === 'read_repository_file' && execution.action.path) {
          readPaths.add(execution.action.path);
        }
        const output: ResponseInputItem.FunctionCallOutput = {
          type: 'function_call_output',
          call_id: call.call_id,
          output: execution.output,
        };
        modelInput.push(output);
      }
    }
    throw new MigrationAgentRuntimeError('ITERATION_BUDGET_EXHAUSTED');
  }
}

export class MigrationAgentRuntimeError extends Error {
  public constructor(public readonly safeCode: string) {
    super('The bounded migration agent could not produce an acceptable proposal.');
    this.name = 'MigrationAgentRuntimeError';
  }
}
