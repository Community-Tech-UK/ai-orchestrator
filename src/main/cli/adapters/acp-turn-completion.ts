import { createHash } from 'node:crypto';
import type { AcpSessionPromptResult } from '../../../shared/types/cli.types';
import type { CliResponse, CliUsage } from './base-cli-adapter';
import type { AcpAssistantTurnState } from './acp-assistant-stream';
import { buildAcpTurnThinking } from './acp-thought-stream';
import { classifyTurnEnding, readTurnEndingMetadata } from '../turn-ending-classifier';
import { classifyTurnEndingFailure, describeTruncatedAcpTurn, turnEndingFailureMetadata } from './acp-transport-failure';
import { safeDiagnosticIdentifier, safeDiagnosticNativeEnding, safeDiagnosticNumber, safeDiagnosticToolKind } from '../turn-ending-diagnostic-fields';

interface CompletionTool { title: string; kind: string; status: string }
interface AcpTurnCompletionInput {
  result: AcpSessionPromptResult;
  turn: AcpAssistantTurnState;
  usage: CliUsage | undefined;
  toolCalls: Iterable<CompletionTool>;
  adapter: string;
  model?: string;
  providerUsageReported: boolean;
  leaseMs: number;
  generationBudget?: { combinedOutputTokens: number; reasoningBudgetSupported: false; model: string };
}

/** Finish classification and safe observability live outside the capped adapter. */
export function buildAcpTurnCompletion(input: AcpTurnCompletionInput) {
  const content = input.turn.chunks.join('');
  const tools = [...input.toolCalls];
  const lastTool = tools.at(-1);
  const activeTool = [...tools].reverse().find((tool) => ['pending', 'in_progress'].includes(tool.status));
  const thinking = buildAcpTurnThinking(input.turn);
  const native = readTurnEndingMetadata(input.result);
  const turnEnding = classifyTurnEnding({
    kind: 'complete', text: content, metadata: native, thinking,
    outputTokens: input.result.usage?.outputTokens,
    reasoningTokens: input.result.usage?.thoughtTokens,
    hasOpenToolCall: Boolean(activeTool), lastToolReadLike: lastTool?.kind === 'read',
  });
  const endingFailure = classifyTurnEndingFailure(content);
  const response: CliResponse = {
    id: input.turn.responseId, role: 'assistant', content, usage: input.usage,
    metadata: {
      stopReason: input.result.stopReason,
      ...(typeof native['finish'] === 'string' ? { finish: native['finish'] } : {}),
      ...(typeof native['finish_reason'] === 'string' ? { finish: native['finish_reason'] } : {}),
      ...(typeof native['finishReason'] === 'string' ? { finish: native['finishReason'] } : {}),
      ...(input.result.usage?.outputTokens !== undefined ? { outputTokens: input.result.usage.outputTokens } : {}),
      ...(input.result.usage?.thoughtTokens !== undefined ? { reasoningTokens: input.result.usage.thoughtTokens } : {}),
      ...(endingFailure ? turnEndingFailureMetadata(endingFailure) : {}),
      ...(turnEnding.reasoningCollapsed ? { reasoningCollapsed: true } : {}),
      ...(turnEnding.reason === 'content_filter' ? { contentFilterBlocked: true } : {}),
      ...(turnEnding.contentFilterFromTool ? { contentFilterFromTool: true } : {}),
      ...(activeTool ? { hasOpenToolCall: true } : {}),
      turnEnding,
      ...(input.generationBudget ? { generationBudget: input.generationBudget } : {}),
    },
  };
  const durationMs = Date.now() - input.turn.startedAt;
  const truncated = endingFailure ? describeTruncatedAcpTurn({
    adapter: input.adapter, kind: endingFailure.kind, failure: endingFailure.failure,
    stopReason: input.result.stopReason, providerUsageReported: input.providerUsageReported,
    durationMs, contentLength: content.length,
  }) : undefined;
  return { response, truncated, logFields: {
    adapter: safeDiagnosticIdentifier(input.adapter), model: safeDiagnosticIdentifier(input.model), stopReason: safeDiagnosticNativeEnding(input.result.stopReason),
    finish: safeDiagnosticNativeEnding(response.metadata?.['finish']), outputTokens: safeDiagnosticNumber(input.result.usage?.outputTokens),
    reasoningTokens: safeDiagnosticNumber(input.result.usage?.thoughtTokens), activeToolKind: safeDiagnosticToolKind(activeTool?.kind),
    leaseMs: safeDiagnosticNumber(input.leaseMs), classifierReason: turnEnding.reason, evidence: turnEnding.evidence,
    ...(input.generationBudget ? { generationBudget: { model: safeDiagnosticIdentifier(input.generationBudget.model), combinedOutputTokens: safeDiagnosticNumber(input.generationBudget.combinedOutputTokens), reasoningBudgetSupported: false } } : {}),
    ...(turnEnding.reasoningCollapsed ? { collapsedTailHash: createHash('sha256').update((thinking ?? []).map((block) => block.content.slice(-4000)).join('\n')).digest('hex').slice(0, 16) } : {}),
  } };
}
