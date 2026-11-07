/**
 * Reader for `agy --print --output-format stream-json`.
 *
 * Shapes checked against agy 1.5.3 on 7 November 2026. One JSON object per line:
 *  - `{"event":"init","conversation_id":…,"init":{model,cwd,tools,…}}` once, when
 *    agy has accepted the prompt.
 *  - `{"event":"step_update","step_update":{step_index,state,step_type,…}}` for
 *    each step. `agent_response` steps carry `text_delta` chunks and, when DONE,
 *    per-step `usage`; `tool` steps go ACTIVE (with `tool_info.parameters`) then
 *    DONE (with `tool_info.output`) or ERROR (with `tool_info.error.message`).
 *  - `{"event":"result","result":{status,response,error?,usage?,denied_actions?}}`
 *    once at the end. agy exits 0 even when `status` is `ERROR`.
 *
 * `result.usage` is the sum of the step usages. `total_tokens` equals
 * `input_tokens + output_tokens`, so `cache_read_tokens` is a part of
 * `input_tokens` and `thinking_tokens` a part of `output_tokens`.
 */

import type { OutputMessage } from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import type { CliUsage } from './base-cli-adapter';

/** Longest tool output copied into the transcript. */
const TOOL_OUTPUT_LIMIT = 4000;

interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

interface AgyStepUpdate {
  step_index?: number;
  state?: string;
  step_type?: string;
  text_delta?: string;
  tool_name?: string;
  usage?: AgyUsage;
  tool_info?: {
    name?: string;
    parameters?: Record<string, unknown>;
    output?: string;
    error?: { message?: string };
  };
}

export interface AntigravityTurnResult {
  status: string;
  response: string;
  error?: string;
  usage?: AgyUsage;
  deniedActions: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function truncate(text: string): string {
  return text.length > TOOL_OUTPUT_LIMIT ? `${text.slice(0, TOOL_OUTPUT_LIMIT)}\n… (${text.length - TOOL_OUTPUT_LIMIT} more characters)` : text;
}

/** Converts agy's usage block into Harness's measured usage. */
export function antigravityUsageToCliUsage(usage: AgyUsage): CliUsage {
  const cacheRead = count(usage.cache_read_tokens);
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  return {
    inputTokens: Math.max(0, input - cacheRead),
    outputTokens: output,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    totalTokens: count(usage.total_tokens) || input + output,
  };
}

/**
 * Follows one agy turn. Feed it each stdout line; it returns the transcript
 * messages that line produced and remembers what the turn needs at the end.
 */
export class AntigravityStreamReader {
  /** True once agy has accepted the prompt (the `init` event arrived). */
  started = false;
  conversationId: string | null = null;
  result: AntigravityTurnResult | null = null;
  /** Tokens in the model's context at the most recent finished model step. */
  contextTokens: number | null = null;

  private readonly textSteps = new Map<number, { id: string; text: string }>();
  private readonly toolSteps = new Map<number, string>();
  private readonly finishedTools = new Set<number>();

  /** Messages produced by one stdout line, or null when the line is not an agy event. */
  readLine(line: string): OutputMessage[] | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }
    if (!isRecord(parsed) || typeof parsed['event'] !== 'string') return null;

    switch (parsed['event']) {
      case 'init':
        this.started = true;
        if (typeof parsed['conversation_id'] === 'string') this.conversationId = parsed['conversation_id'];
        return [];
      case 'step_update':
        return isRecord(parsed['step_update']) ? this.readStep(parsed['step_update'] as AgyStepUpdate) : [];
      case 'result':
        if (isRecord(parsed['result'])) this.readResult(parsed['result']);
        return [];
      default:
        return [];
    }
  }

  /** True while a tool agy started has not reported finishing. */
  toolRunning(): boolean {
    return this.toolSteps.size > this.finishedTools.size;
  }

  /** All reply text the turn streamed, in step order. */
  streamedText(): string {
    return [...this.textSteps.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, step]) => step.text)
      .join('\n\n');
  }

  /** The turn's answer: agy's own final response, else whatever was streamed. */
  responseText(): string {
    return this.result?.response || this.streamedText();
  }

  /**
   * The answer as a transcript message when agy reported one but streamed no
   * text for it, so the user still sees the reply.
   */
  unstreamedReply(): OutputMessage | null {
    const response = this.result?.response;
    if (!response || this.textSteps.size > 0) return null;
    return { id: generateId(), timestamp: Date.now(), type: 'assistant', content: response };
  }

  private readStep(step: AgyStepUpdate): OutputMessage[] {
    const index = typeof step.step_index === 'number' ? step.step_index : -1;
    if (step.step_type === 'agent_response') return this.readModelStep(index, step);
    if (step.step_type === 'tool') return this.readToolStep(index, step);
    return [];
  }

  private readModelStep(index: number, step: AgyStepUpdate): OutputMessage[] {
    if (step.state === 'DONE' && step.usage) {
      this.contextTokens = count(step.usage.input_tokens) + count(step.usage.output_tokens);
    }
    const delta = step.text_delta;
    if (typeof delta !== 'string' || delta.length === 0) return [];
    const current = this.textSteps.get(index) ?? { id: generateId(), text: '' };
    current.text += delta;
    this.textSteps.set(index, current);
    return [{
      id: current.id,
      timestamp: Date.now(),
      type: 'assistant',
      content: delta,
      metadata: { streaming: true, accumulatedContent: current.text },
    }];
  }

  private readToolStep(index: number, step: AgyStepUpdate): OutputMessage[] {
    if (this.finishedTools.has(index)) return [];
    const name = step.tool_name || step.tool_info?.name || 'tool';
    const messages: OutputMessage[] = [];
    let toolUseId = this.toolSteps.get(index);
    if (!toolUseId) {
      toolUseId = `${this.conversationId ?? 'agy'}:${index}`;
      this.toolSteps.set(index, toolUseId);
      const input = step.tool_info?.parameters ?? {};
      const command = typeof input['CommandLine'] === 'string' ? input['CommandLine'] : null;
      messages.push({
        id: generateId(),
        timestamp: Date.now(),
        type: 'tool_use',
        content: command ? `Running command: ${command}` : `Using tool: ${name}`,
        metadata: { name, input, tool_use_id: toolUseId },
      });
    }
    if (step.state !== 'DONE' && step.state !== 'ERROR') return messages;

    this.finishedTools.add(index);
    const failed = step.state === 'ERROR';
    const output = failed
      ? step.tool_info?.error?.message || `Tool ${name} failed`
      : step.tool_info?.output || `Tool ${name} completed`;
    messages.push({
      id: generateId(),
      timestamp: Date.now(),
      type: 'tool_result',
      content: truncate(output),
      metadata: { name, tool_use_id: toolUseId, is_error: failed },
    });
    return messages;
  }

  private readResult(result: Record<string, unknown>): void {
    const denied = Array.isArray(result['denied_actions']) ? result['denied_actions'] : [];
    this.result = {
      status: typeof result['status'] === 'string' ? result['status'] : 'UNKNOWN',
      response: typeof result['response'] === 'string' ? result['response'] : '',
      ...(typeof result['error'] === 'string' ? { error: result['error'] } : {}),
      ...(isRecord(result['usage']) ? { usage: result['usage'] as AgyUsage } : {}),
      deniedActions: denied
        .map(action => (isRecord(action) && typeof action['action'] === 'string' ? action['action'] : null))
        .filter((action): action is string => action !== null),
    };
  }
}
