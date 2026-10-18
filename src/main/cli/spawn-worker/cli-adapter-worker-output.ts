import { claudeResultMetadata } from '../adapters/claude-result-usage';
import type { ClaudeModelUsageSnapshot } from '../../../shared/types/provider-model-usage.types';
import type { CliResponse } from '../adapters/base-cli-adapter';
import { estimateTokens } from '../../../shared/utils/token-estimate';

export function parseWorkerOutput(
  raw: string,
  cliType: 'claude' | 'gemini',
  adapterName: string,
): CliResponse {
  const lines = raw.split('\n').filter((line) => line.trim());
  let content = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let cost: number | undefined;
  let providerModelUsage: ClaudeModelUsageSnapshot | undefined;
  let resultUsage: ReturnType<typeof extractUsage> | undefined;
  let assistantSawUsage = false;
  let metadata: Record<string, unknown> | undefined;
  let assistantInput = 0, assistantOutput = 0, assistantCacheRead = 0, assistantCacheWrite = 0;
  for (const line of lines) {
    try {
      const msg = JSON.parse(line) as Record<string, unknown>;
      // Synthetic error diagnostics are not model-generated text to estimate.
      if (cliType === 'claude' && msg['type'] === 'assistant' && !msg['isApiErrorMessage'] && msg['error'] == null) {
        const message = msg['message'] as { content?: { type?: string; text?: string }[] } | undefined;
        content += message?.content
          ?.filter((block) => block.type === 'text' && block.text)
          .map((block) => block.text)
          .join('') ?? '';
      } else if (cliType === 'gemini') {
        if (msg['type'] === 'message' && msg['role'] === 'assistant' && typeof msg['content'] === 'string') {
          content += msg['content'];
        } else if (msg['type'] === 'text' && typeof msg['text'] === 'string') {
          content += msg['text'];
        }
      }
      const usage = extractUsage(msg);
      if (cliType === 'claude' && msg['type'] === 'assistant' && !msg['parent_tool_use_id']) {
        const message = isRecord(msg['message']) ? msg['message'] : undefined;
        assistantSawUsage ||= isRecord(message?.['usage']) || isRecord(msg['usage']);
        assistantInput += usage.inputTokens; assistantOutput += usage.outputTokens;
        assistantCacheRead += usage.cacheReadTokens ?? 0; assistantCacheWrite += usage.cacheWriteTokens ?? 0;
      }
      if (cliType === 'claude' && msg['type'] === 'result') {
        if (isRecord(msg['usage'])) resultUsage = usage;
        if (isRecord(msg['modelUsage'])) providerModelUsage = msg['modelUsage'] as ClaudeModelUsageSnapshot;
        metadata = claudeResultMetadata(msg);
      }
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      totalTokens += usage.totalTokens;
      if (typeof msg['total_cost_usd'] === 'number') {
        cost = msg['total_cost_usd'];
      }
    } catch {
      if (cliType === 'gemini' && line.trim() && !line.startsWith('{')) {
        content += line;
      }
    }
  }
  if (resultUsage?.totalTokens === 0 && !resultUsage.cacheReadTokens && !resultUsage.cacheWriteTokens) {
    resultUsage={inputTokens:assistantInput,outputTokens:assistantOutput,totalTokens:assistantInput+assistantOutput,
      cacheReadTokens:assistantCacheRead,cacheWriteTokens:assistantCacheWrite};
  }
  if (resultUsage) ({inputTokens,outputTokens,totalTokens} = resultUsage);
  if (outputTokens === 0 && content.trim() && !resultUsage && !assistantSawUsage) {
    outputTokens = estimateTokens(content);
  }
  totalTokens = cliType === 'claude' && !resultUsage
    ? inputTokens + outputTokens
    : totalTokens || inputTokens + outputTokens;
  const usage = {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cost !== undefined ? (cliType === 'claude' ? {providerSessionTotalUsd:cost} : {cost}) : {}),
    ...(providerModelUsage ? {providerModelUsage} : {}),
    ...(resultUsage ? {cacheReadTokens:resultUsage.cacheReadTokens, cacheWriteTokens:resultUsage.cacheWriteTokens}
      : cliType === 'claude' ? {cacheReadTokens:assistantCacheRead, cacheWriteTokens:assistantCacheWrite} : {}),
  };
  return {
    id: `${adapterName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    content: content.trim(),
    role: 'assistant',
    usage,
    raw,
    metadata,
  };
}

function extractUsage(msg: Record<string, unknown>): { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } {
  const usage = isRecord(msg['usage']) ? msg['usage'] : undefined;
  if (usage) {
    const inputTokens = Number(usage['input_tokens'] ?? usage['inputTokens'] ?? 0);
    const cacheReadTokens = Number(usage['cache_read_input_tokens'] ?? 0);
    const cacheWriteTokens = Number(usage['cache_creation_input_tokens'] ?? 0);
    const outputTokens = Number(usage['output_tokens'] ?? usage['outputTokens'] ?? 0);
    const totalTokens = Number(usage['total_tokens'] ?? usage['totalTokens'] ?? 0) || inputTokens + outputTokens;
    return { inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens };
  }
  const message = isRecord(msg['message']) ? msg['message'] : undefined;
  const messageUsage = message && isRecord(message['usage']) ? message['usage'] : undefined;
  if (messageUsage) {
    const inputTokens = Number(messageUsage['input_tokens'] ?? 0);
    const outputTokens = Number(messageUsage['output_tokens'] ?? 0);
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
      cacheReadTokens:Number(messageUsage['cache_read_input_tokens'] ?? 0),
      cacheWriteTokens:Number(messageUsage['cache_creation_input_tokens'] ?? 0) };
  }
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
