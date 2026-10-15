import type { CliResponse, CliToolCall, CliUsage } from './base-cli-adapter';
import type { RawCliPayload } from './claude-cli-adapter.types';
import { readClaudeResultStop, resultMetadata, type ClaudeResultStop } from './claude-result-stop';
import { parseNdjsonLine } from '../json-parse';
import { structuredOutputContent, type StructuredOutputCandidate } from './structured-output-content';
import { generateId } from '../../../shared/utils/id-generator';
import { sanitizeClaudeToolInput, sanitizeClaudeSelfWakeupRawNdjson } from './claude-cli-self-wakeup';
export function parseClaudeOutput(raw: string, id: string, quota: (notice: string) => unknown): CliResponse {
    const toolCalls: CliToolCall[] = [];
    const structuredCandidates: StructuredOutputCandidate[] = [];
    let content = '';
    // We accumulate tokens across all assistant turns as a fallback. Some CLI
    // versions emit the authoritative `result` message at the end with the
    // final tally; older versions emit `system / context_usage` (kept here for
    // backward compatibility); current 2.1.x versions place per-turn counts on
    // each `assistant.message.usage`. We prefer `result.usage` when present
    // because it's the final authoritative count after all turns settle.
    let assistantInput = 0;
    let assistantOutput = 0;
    let assistantSawAny = false;
    let resultUsage: CliUsage | null = null;
    let legacySystemTotal: number | undefined;
    let costUsd: number | undefined;
    let planLimitNotice: string | undefined;
    let resultStop: ClaudeResultStop | undefined;

    // Parse all NDJSON lines
    const lines = raw.split('\n').filter((line) => line.trim());

    for (const line of lines) {
      const parsedLine = parseNdjsonLine<RawCliPayload>(line);
      if (parsedLine.ok) {
        const msg = parsedLine.value;

        if (msg.type === 'assistant' && msg.message?.content) {
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

          // Per-turn token usage (Claude CLI 2.1.x schema). Cache tokens are
          // not double-counted: we only sum the new-generation portions
          // (input_tokens + output_tokens) for our totalTokens metric.
          if (msg.message.usage) {
            assistantSawAny = true;
            assistantInput += msg.message.usage.input_tokens ?? 0;
            assistantOutput += msg.message.usage.output_tokens ?? 0;
          }
        }

        // Authoritative final tally (Claude CLI 2.1.x). The CLI emits one
        // `{type:"result", usage:{...}, total_cost_usd}` line at the end of
        // each turn. Prefer this over per-assistant accumulation. Cache
        // tokens are NOT folded into totalTokens — they reflect billing
        // (cached reads are cheaper / writes are billed once) and would
        // double-count actual generation if added here.
        if (msg.type === 'result') resultStop = readClaudeResultStop(msg);
        if (msg.type === 'result' && msg.usage) {
          resultUsage = {
            inputTokens: msg.usage.input_tokens,
            outputTokens: msg.usage.output_tokens,
            totalTokens:
              (msg.usage.input_tokens ?? 0) + (msg.usage.output_tokens ?? 0),
            // Surface cache tokens separately (they were previously discarded)
            // so cost accounting can price cached reads/writes at their distinct
            // rates. They are intentionally NOT folded into totalTokens — see the
            // comment above on the generation-count metric.
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

    const usage: CliUsage = resultUsage
      ?? (assistantSawAny
        ? {
            inputTokens: assistantInput,
            outputTokens: assistantOutput,
            totalTokens: assistantInput + assistantOutput,
          }
        : (legacySystemTotal !== undefined
          ? { totalTokens: legacySystemTotal }
          : {}));
    if (costUsd !== undefined) {
      usage.providerSessionTotalUsd = costUsd;
    }

    return {
      id,
      content: structuredOutputContent(structuredCandidates) ?? content.trim(),
      role: 'assistant',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      raw: sanitizeClaudeSelfWakeupRawNdjson(raw),
      ...resultMetadata(planLimitNotice !== undefined ? quota(planLimitNotice) : undefined, resultStop),
    };
  }
