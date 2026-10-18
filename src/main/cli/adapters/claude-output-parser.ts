import type { CliResponse, CliToolCall, CliUsage } from './base-cli-adapter';
import type { RawCliPayload } from './claude-cli-adapter.types';
import { readClaudeResultStop, resultMetadata, type ClaudeResultStop } from './claude-result-stop';
import { claudeResultMetadata } from './claude-result-usage';
import { parseClaudeStreamError } from './claude-stream-error';
import { parseNdjsonLine } from '../json-parse';
import { structuredOutputContent, type StructuredOutputCandidate } from './structured-output-content';
import { generateId } from '../../../shared/utils/id-generator';
import { sanitizeClaudeToolInput, sanitizeClaudeSelfWakeupRawNdjson } from './claude-cli-self-wakeup';
export function parseClaudeOutput(raw: string, id: string, quota: (notice: string) => unknown): CliResponse {
    const toolCalls: CliToolCall[] = [];
    const structuredCandidates: StructuredOutputCandidate[] = [];
    let content = '';
    // Prefer the final result tally; retain per-assistant and legacy fallbacks.
    let assistantInput = 0;
    let assistantOutput = 0;
    let assistantCacheRead = 0;
    let assistantCacheWrite = 0;
    let assistantSawAny = false;
    let resultUsage: CliUsage | null = null;
    let legacySystemTotal: number | undefined;
    let costUsd: number | undefined;
    let modelUsage: CliUsage['providerModelUsage'];
    let planLimitNotice: string | undefined;
    let resultStop: ClaudeResultStop | undefined;
    let turnMetadata: Record<string, unknown> | undefined;

    // Parse all NDJSON lines
    const lines = raw.split('\n').filter((line) => line.trim());

    for (const line of lines) {
      const parsedLine = parseNdjsonLine<RawCliPayload>(line);
      if (parsedLine.ok) {
        const msg = parsedLine.value;

        if (msg.type === 'assistant' && msg.message?.content && !parseClaudeStreamError(msg)) {
          // Extract text content
          const textContent = msg.message.content
            .filter((block) => block.type === 'text' && block.text)
            .map((block) => block.text)
            .join('');
          if (textContent) {
            content += textContent;
          }

          // Extract tool uses
          const toolUses = msg.message.content.filter(
            (block) => block.type === 'tool_use'
          );
          for (const tool of toolUses) {
            // LT-025: keep the subagent tag with the block. `parseOutput`
            // flattens every assistant message — including subagent turns,
            // which the CLI streams into the same NDJSON — so the structured
            // answer has to be chosen with that provenance in hand.
            structuredCandidates.push({
              name: tool.name,
              input: tool.input,
              parentToolUseId: (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id,
            });
            toolCalls.push({
              id: tool.id || generateId(),
              name: tool.name || '',
              arguments: sanitizeClaudeToolInput(tool.name || '', tool.input || {})
            });
          }
        }
        // Per-turn token usage (Claude CLI 2.1.x schema). Cache tokens are
        // not double-counted: we only sum the new-generation portions
        // (input_tokens + output_tokens) for our totalTokens metric.
        if (msg.type === 'assistant' && msg.message?.usage && !(msg as { parent_tool_use_id?: string | null }).parent_tool_use_id) {
          assistantSawAny = true;
          assistantInput += msg.message.usage.input_tokens ?? 0;
          assistantOutput += msg.message.usage.output_tokens ?? 0;
          assistantCacheRead += msg.message.usage.cache_read_input_tokens ?? 0;
          assistantCacheWrite += msg.message.usage.cache_creation_input_tokens ?? 0;
        }

        // Native final tally. totalTokens counts generation; caches stay separate.
        if (msg.type === 'result') {
          resultStop = readClaudeResultStop(msg);
          turnMetadata = claudeResultMetadata(msg);
        }
        if (msg.type === 'result' && msg.usage) {
          resultUsage = {
            inputTokens: msg.usage.input_tokens,
            outputTokens: msg.usage.output_tokens,
            totalTokens:
              (msg.usage.input_tokens ?? 0) + (msg.usage.output_tokens ?? 0),
            // Cache reads and writes have distinct billing rates.
            ...(typeof msg.usage.cache_read_input_tokens === 'number'
              ? { cacheReadTokens: msg.usage.cache_read_input_tokens }
              : {}),
            ...(typeof msg.usage.cache_creation_input_tokens === 'number'
              ? { cacheWriteTokens: msg.usage.cache_creation_input_tokens }
              : {}),
          };
        }
        if (msg.type === 'result' && typeof msg.total_cost_usd === 'number') {
          costUsd = msg.total_cost_usd;
          modelUsage = msg.modelUsage;
        }
        if (msg.type === 'result' && msg.is_error === true && msg.api_error_status === 429) {
          planLimitNotice = typeof msg.result === 'string' ? msg.result.trim() : '';
        }

        // Legacy schema (older Claude CLI). Kept for backward compatibility.
        if (
          msg.type === 'system' &&
          msg.subtype === 'context_usage' &&
          msg.usage
        ) {
          legacySystemTotal = msg.usage.total_tokens;
        }
      } else {
        // Ignore non-JSON lines
      }
    }

    if (resultUsage?.totalTokens === 0 && !resultUsage.cacheReadTokens && !resultUsage.cacheWriteTokens && assistantSawAny) resultUsage = null;
    const usage: CliUsage = resultUsage
      ?? (assistantSawAny
        ? {
            inputTokens: assistantInput,
            outputTokens: assistantOutput,
            cacheReadTokens: assistantCacheRead,
            cacheWriteTokens: assistantCacheWrite,
            totalTokens: assistantInput + assistantOutput,
          }
        : (legacySystemTotal !== undefined
          ? { totalTokens: legacySystemTotal }
          : {}));
    if (costUsd !== undefined) {
      usage.providerSessionTotalUsd = costUsd;
      if (modelUsage) usage.providerModelUsage = modelUsage;
    }

    const stopMeta = resultMetadata(planLimitNotice !== undefined ? quota(planLimitNotice) : undefined, resultStop);
    const metadata = { ...(stopMeta.metadata ?? {}), ...(turnMetadata ?? {}) };
    return {
      id,
      content: structuredOutputContent(structuredCandidates) ?? content.trim(),
      role: 'assistant',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      raw: sanitizeClaudeSelfWakeupRawNdjson(raw),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
  }
