import type {
  ResponseFunctionToolCall,
  ResponseInputItem,
} from 'openai/resources/responses/responses';

import type {
  ImpactAnalysisInputArtifact,
  ImpactAnalysisResult,
  ImpactReport,
} from '@migration/contracts';

import { InvalidImpactOutputError } from './gateway.js';
import type { ImpactAnalysisGateway } from './gateway.js';
import { RepositoryToolError } from './tools.js';
import type { RepositoryTools } from './tools.js';

const budgets = {
  maximumModelCalls: 5,
  maximumToolCalls: 30,
  maximumIterations: 6,
  maximumInputTokens: 100_000,
  maximumOutputTokens: 16_000,
  maximumWallClockMilliseconds: 5 * 60 * 1_000,
} as const;

export class ImpactAnalysisKernel {
  public constructor(
    private readonly gateway: ImpactAnalysisGateway,
    private readonly tools: RepositoryTools,
  ) {}

  public async run(input: ImpactAnalysisInputArtifact): Promise<ImpactAnalysisResult> {
    const startedAt = Date.now();
    const deadline = startedAt + budgets.maximumWallClockMilliseconds;
    const actions: ImpactAnalysisResult['actions'] = [];
    const modelInput = this.gateway.initialInput();
    const calledTools = new Set<string>();
    let modelCalls = 0;
    let toolCalls = 0;
    let iterations = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let returnedModel = process.env.OPENAI_MODEL ?? 'unknown';
    let requestId: string | null = null;

    while (iterations < budgets.maximumIterations) {
      iterations += 1;
      if (Date.now() >= deadline) return envelope('AGENT_TIME_BUDGET_EXHAUSTED');
      if (modelCalls >= budgets.maximumModelCalls) {
        return envelope('MODEL_CALL_BUDGET_EXHAUSTED');
      }
      const remaining = budgets.maximumOutputTokens - outputTokens;
      if (remaining <= 0) return envelope('OUTPUT_TOKEN_BUDGET_EXHAUSTED');
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
        return envelope('INPUT_TOKEN_BUDGET_EXHAUSTED');
      }
      if (outputTokens > budgets.maximumOutputTokens) {
        return envelope('OUTPUT_TOKEN_BUDGET_EXHAUSTED');
      }
      const calls = turn.response.output.filter(
        (item): item is ResponseFunctionToolCall => item.type === 'function_call',
      );
      if (calls.length === 0) {
        if (
          !calledTools.has('list_repository_files') ||
          !calledTools.has('inspect_manifest') ||
          !calledTools.has('search_repository') ||
          !calledTools.has('inspect_typescript')
        ) {
          return envelope('REPOSITORY_TOOL_REQUIREMENTS_NOT_MET');
        }
        try {
          return envelope(null, this.gateway.parseTerminal(turn.response, new Date()));
        } catch (error) {
          return envelope(
            error instanceof InvalidImpactOutputError
              ? error.safeCode
              : 'MODEL_OUTPUT_INVALID',
          );
        }
      }
      modelInput.push(...calls);
      for (const call of calls) {
        if (toolCalls >= budgets.maximumToolCalls) {
          return envelope('TOOL_CALL_BUDGET_EXHAUSTED');
        }
        toolCalls += 1;
        try {
          const execution = this.tools.execute(call.name, call.arguments, toolCalls);
          actions.push(execution.action);
          calledTools.add(call.name);
          const output: ResponseInputItem.FunctionCallOutput = {
            type: 'function_call_output',
            call_id: call.call_id,
            output: execution.output,
          };
          modelInput.push(output);
        } catch (error) {
          return envelope(
            error instanceof RepositoryToolError
              ? error.safeCode
              : 'REPOSITORY_TOOL_FAILED',
          );
        }
      }
    }
    return envelope('ITERATION_BUDGET_EXHAUSTED');

    function envelope(
      safeErrorCode: string | null,
      report: ImpactReport | null = null,
    ): ImpactAnalysisResult {
      return {
        schemaVersion: '1.0',
        candidateId: input.candidateId,
        impactAnalysisRunId: input.impactAnalysisRunId,
        repositorySnapshotId: input.repositorySnapshotId,
        snapshotDigest: input.snapshotDigest,
        status: report ? 'succeeded' : 'failed',
        safeErrorCode,
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
        report,
      };
    }
  }
}
