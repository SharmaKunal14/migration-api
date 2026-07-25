import type {
  ResponseFunctionToolCall,
  ResponseInputItem,
} from 'openai/resources/responses/responses';

import type { AgentResultEnvelope, MigrationPlan } from '@migration/contracts';
import type { AgentToolAction, AgentTools } from '@migration/agent-tools';
import { InvalidModelOutputError, type ModelGateway } from '@migration/model-gateway';

const budgets = {
  maxModelCalls: 4,
  maxToolCalls: 12,
  maxIterations: 6,
  maxInputTokens: 50_000,
  maxOutputTokens: 12_000,
  maxWallClockMs: 5 * 60 * 1000,
} as const;

export interface AgentKernelInput {
  readonly organisationId: string;
  readonly agentRunId: string;
  readonly requestedModel: string;
}

export class AgentKernel {
  public constructor(
    private readonly gateway: ModelGateway,
    private readonly tools: AgentTools,
  ) {}

  public async run(input: AgentKernelInput): Promise<AgentResultEnvelope> {
    const started = Date.now();
    const deadline = started + budgets.maxWallClockMs;
    const actions: AgentToolAction[] = [];
    const modelInput = this.gateway.initialInput();
    let modelCalls = 0;
    let toolCalls = 0;
    let iterations = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let returnedModel = input.requestedModel;
    let requestId: string | null = null;

    while (iterations < budgets.maxIterations) {
      iterations += 1;
      if (Date.now() >= deadline) {
        return failure('budget_exhausted_time', 'AGENT_TIME_BUDGET_EXHAUSTED');
      }
      if (modelCalls >= budgets.maxModelCalls) {
        return failure('budget_exhausted_model_calls', 'MODEL_CALL_BUDGET_EXHAUSTED');
      }
      const remainingOutputTokens = budgets.maxOutputTokens - outputTokens;
      if (remainingOutputTokens <= 0) {
        return failure('invalid_model_output', 'OUTPUT_TOKEN_BUDGET_EXHAUSTED');
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
      if (inputTokens > budgets.maxInputTokens) {
        return failure('invalid_model_output', 'INPUT_TOKEN_BUDGET_EXHAUSTED');
      }
      if (outputTokens > budgets.maxOutputTokens) {
        return failure('invalid_model_output', 'OUTPUT_TOKEN_BUDGET_EXHAUSTED');
      }
      const calls = turn.response.output.filter(
        (item): item is ResponseFunctionToolCall => item.type === 'function_call',
      );
      if (calls.length === 0) {
        let plan: MigrationPlan;
        try {
          plan = this.gateway.parseTerminal(turn.response);
        } catch (error) {
          return failure(
            'invalid_model_output',
            error instanceof InvalidModelOutputError
              ? error.safeCode
              : 'INVALID_MODEL_OUTPUT',
          );
        }
        return envelope('completed', null, plan);
      }
      modelInput.push(...calls);
      for (const call of calls) {
        if (toolCalls >= budgets.maxToolCalls) {
          return failure('budget_exhausted_tool_calls', 'TOOL_CALL_BUDGET_EXHAUSTED');
        }
        toolCalls += 1;
        const execution = await this.tools.execute(
          call.name,
          call.arguments,
          toolCalls,
        );
        actions.push(execution.action);
        const output: ResponseInputItem.FunctionCallOutput = {
          type: 'function_call_output',
          call_id: call.call_id,
          output: execution.output,
        };
        modelInput.push(output);
      }
    }
    return failure('budget_exhausted_iterations', 'ITERATION_BUDGET_EXHAUSTED');

    function failure(
      code: Exclude<AgentResultEnvelope['terminal']['code'], 'completed' | 'cancelled'>,
      safeCode: string,
    ): AgentResultEnvelope {
      return envelope(code, safeCode, null);
    }

    function envelope(
      code: AgentResultEnvelope['terminal']['code'],
      safeCode: string | null,
      result: MigrationPlan | null,
    ): AgentResultEnvelope {
      return {
        schemaVersion: '1.0',
        organisationId: input.organisationId,
        agentRunId: input.agentRunId,
        model: {
          provider: 'openai',
          requestedModel: input.requestedModel,
          returnedModel,
          reasoningEffort: 'medium',
          requestId,
        },
        usage: {
          modelCalls,
          toolCalls,
          iterations,
          inputTokens,
          outputTokens,
          durationMs: Date.now() - started,
        },
        actions,
        terminal: { code, safeErrorCode: safeCode },
        result,
      };
    }
  }
}
