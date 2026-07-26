import type {
  ResponseFunctionToolCall,
  ResponseInputItem,
} from 'openai/resources/responses/responses';

import type {
  ChangeIntelligenceResult,
  MigrationSpecification,
} from '@migration/contracts';

import {
  InvalidSpecificationOutputError,
  type ChangeIntelligenceGateway,
} from './gateway.js';
import { ToolPolicyError } from './tools.js';
import type { ChangeIntelligenceTools } from './tools.js';

const budgets = {
  maximumModelCalls: 3,
  maximumToolCalls: 12,
  maximumIterations: 4,
  maximumInputTokens: 60_000,
  maximumOutputTokens: 12_000,
  maximumWallClockMilliseconds: 5 * 60 * 1_000,
} as const;

const requiredEvidenceSourceKeys = new Set([
  'release_metadata',
  'migration_guide',
  'changelog',
  'v1_api',
  'v2_api',
]);

export interface ChangeIntelligenceKernelInput {
  readonly vendorReleaseId: string;
  readonly changeIntelligenceRunId: string;
  readonly evidenceObjectKey: string;
  readonly evidenceDigest: string;
  readonly requestedModel: string;
}

export class ChangeIntelligenceKernel {
  public constructor(
    private readonly gateway: ChangeIntelligenceGateway,
    private readonly tools: ChangeIntelligenceTools,
  ) {}

  public async run(
    input: ChangeIntelligenceKernelInput,
  ): Promise<ChangeIntelligenceResult> {
    const startedAt = Date.now();
    const deadline = startedAt + budgets.maximumWallClockMilliseconds;
    const actions: ChangeIntelligenceResult['actions'] = [];
    const modelInput = this.gateway.initialInput();
    const readSourceKeys = new Set<string>();
    let listedEvidence = false;
    let modelCalls = 0;
    let toolCalls = 0;
    let iterations = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let returnedModel = input.requestedModel;
    let requestId: string | null = null;

    while (iterations < budgets.maximumIterations) {
      iterations += 1;
      if (Date.now() >= deadline) {
        return envelope('failed', 'AGENT_TIME_BUDGET_EXHAUSTED', null);
      }
      if (modelCalls >= budgets.maximumModelCalls) {
        return envelope('failed', 'MODEL_CALL_BUDGET_EXHAUSTED', null);
      }
      const remainingOutputTokens = budgets.maximumOutputTokens - outputTokens;
      if (remainingOutputTokens <= 0) {
        return envelope('failed', 'OUTPUT_TOKEN_BUDGET_EXHAUSTED', null);
      }

      modelCalls += 1;
      const turn = await this.gateway.runTurn(
        modelInput,
        remainingOutputTokens,
        AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      );
      returnedModel = turn.response.model;
      requestId = turn.requestId;
      inputTokens += turn.inputTokens;
      outputTokens += turn.outputTokens;
      if (inputTokens > budgets.maximumInputTokens) {
        return envelope('failed', 'INPUT_TOKEN_BUDGET_EXHAUSTED', null);
      }
      if (outputTokens > budgets.maximumOutputTokens) {
        return envelope('failed', 'OUTPUT_TOKEN_BUDGET_EXHAUSTED', null);
      }

      const calls = turn.response.output.filter(
        (item): item is ResponseFunctionToolCall => item.type === 'function_call',
      );
      if (calls.length === 0) {
        if (
          !listedEvidence ||
          [...requiredEvidenceSourceKeys].some(
            sourceKey => !readSourceKeys.has(sourceKey),
          )
        ) {
          return envelope('failed', 'EVIDENCE_TOOL_REQUIREMENTS_NOT_MET', null);
        }
        try {
          const specification = this.gateway.parseTerminal(turn.response, new Date());
          if (
            specification.evidence.some(
              evidence => !readSourceKeys.has(evidence.sourceKey),
            )
          ) {
            return envelope('failed', 'SPECIFICATION_CITES_UNREAD_EVIDENCE', null);
          }
          return envelope('succeeded', null, specification);
        } catch (error) {
          return envelope(
            'failed',
            error instanceof InvalidSpecificationOutputError
              ? error.safeCode
              : 'MODEL_OUTPUT_INVALID',
            null,
          );
        }
      }

      modelInput.push(...calls);
      for (const call of calls) {
        if (toolCalls >= budgets.maximumToolCalls) {
          return envelope('failed', 'TOOL_CALL_BUDGET_EXHAUSTED', null);
        }
        toolCalls += 1;
        try {
          const execution = await this.tools.execute(
            call.name,
            call.arguments,
            toolCalls,
          );
          actions.push(execution.action);
          if (call.name === 'list_vendor_evidence') {
            listedEvidence = true;
          }
          if (execution.action.sourceKey) {
            readSourceKeys.add(execution.action.sourceKey);
          }
          const output: ResponseInputItem.FunctionCallOutput = {
            type: 'function_call_output',
            call_id: call.call_id,
            output: execution.output,
          };
          modelInput.push(output);
        } catch (error) {
          return envelope(
            'failed',
            error instanceof ToolPolicyError ? error.safeCode : 'EVIDENCE_TOOL_FAILED',
            null,
          );
        }
      }
    }
    return envelope('failed', 'ITERATION_BUDGET_EXHAUSTED', null);

    function envelope(
      status: ChangeIntelligenceResult['status'],
      safeErrorCode: string | null,
      specification: MigrationSpecification | null,
    ): ChangeIntelligenceResult {
      return {
        schemaVersion: '1.0',
        vendorReleaseId: input.vendorReleaseId,
        changeIntelligenceRunId: input.changeIntelligenceRunId,
        evidenceObjectKey: input.evidenceObjectKey,
        evidenceDigest: input.evidenceDigest,
        status,
        safeErrorCode,
        model: {
          requestedModel: input.requestedModel,
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
        specification,
      };
    }
  }
}
