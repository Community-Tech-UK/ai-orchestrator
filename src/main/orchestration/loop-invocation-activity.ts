/**
 * Loop invocation activity stream — adapter event → activity translation.
 *
 * Extracted verbatim from default-invokers.ts (file-size ratchet): subscribes
 * to a CLI adapter's runtime events and translates them into the loop's
 * activity vocabulary, including the hidden-child auto-answer path for
 * `input_required` (Loop Mode is unattended; ordinary clarification prompts
 * get an autonomous response, unanswerable prompt types terminate the child).
 */

import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { CliResponse, CliToolCall } from '../cli/adapters/base-cli-adapter.types';

export type LoopInvocationActivityKind =
  | 'spawned'
  | 'status'
  | 'tool_use'
  | 'tool_result'
  | 'assistant'
  | 'system'
  | 'input_required'
  | 'error'
  | 'stream-idle'
  | 'complete'
  | 'heartbeat';

export interface LoopInvocationActivity {
  kind: LoopInvocationActivityKind;
  message: string;
  detail?: Record<string, unknown>;
}

const LOOP_AUTONOMOUS_INPUT_RESPONSE =
  'Loop Mode is unattended. Do not wait for human input. Make the best reasonable assumption a senior engineer would defend, document it in your loop NOTES file, and continue. If the work is genuinely blocked, write the BLOCKED.md file at the loop-state path given in your iteration prompt with the exact blocker, then exit the iteration.';

export function attachInvocationActivity(
  adapter: CliAdapter,
  sink: (activity: LoopInvocationActivity) => void,
  options: { autoAnswerInputRequired?: boolean } = {},
): () => void {
  const emitter = adapter as unknown as {
    on?: (event: string, handler: (...args: unknown[]) => void) => void;
    off?: (event: string, handler: (...args: unknown[]) => void) => void;
    removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
  };
  if (typeof emitter.on !== 'function') return () => { /* noop */ };

  const removers: (() => void)[] = [];
  const listen = (event: string, handler: (...args: unknown[]) => void) => {
    emitter.on!(event, handler);
    removers.push(() => {
      if (typeof emitter.off === 'function') emitter.off(event, handler);
      else if (typeof emitter.removeListener === 'function') emitter.removeListener(event, handler);
    });
  };

  listen('spawned', (pid) => {
    sink({
      kind: 'spawned',
      message: `CLI child spawned${typeof pid === 'number' ? ` (pid ${pid})` : ''}`,
      detail: typeof pid === 'number' ? { pid } : undefined,
    });
  });
  listen('status', (status) => {
    sink({
      kind: 'status',
      message: `CLI status: ${String(status)}`,
      detail: { status: String(status) },
    });
  });
  listen('heartbeat', () => {
    sink({ kind: 'heartbeat', message: 'CLI heartbeat received' });
  });
  listen('stream:idle', (info) => {
    const meta = isRecord(info) ? info : {};
    const timeoutMs = typeof meta['timeoutMs'] === 'number' ? meta['timeoutMs'] : undefined;
    const seconds = timeoutMs ? Math.round(timeoutMs / 1000) : null;
    sink({
      kind: 'stream-idle',
      message: seconds
        ? `No CLI output for ${seconds}s; still waiting for the iteration to finish`
        : 'No CLI output recently; still waiting for the iteration to finish',
      detail: { ...meta },
    });
  });
  listen('output', (output) => {
    sink(describeAdapterOutput(output));
  });
  listen('tool_use', (toolCall) => {
    sink(describeToolEvent(toolCall, 'tool_use'));
  });
  listen('tool_result', (toolCall) => {
    sink(describeToolEvent(toolCall, 'tool_result'));
  });
  listen('input_required', (payload) => {
    const data = isRecord(payload) ? payload : {};
    const metadata = isRecord(data['metadata']) ? data['metadata'] : {};
    const prompt = typeof data['prompt'] === 'string' ? data['prompt'] : 'CLI requested input';
    const promptType = typeof metadata['type'] === 'string' ? metadata['type'] : 'input_required';
    sink({
      kind: 'input_required',
      message: summarizeActivityText(`CLI requested input (${promptType}): ${prompt}`),
      detail: {
        ...metadata,
        id: typeof data['id'] === 'string' ? data['id'] : undefined,
        prompt,
      },
    });

    if (!options.autoAnswerInputRequired) {
      return;
    }

    const terminateHiddenInputWait = (reason: string): void => {
      const terminate = (adapter as unknown as { terminate?: (graceful?: boolean) => Promise<void> }).terminate;
      if (typeof terminate !== 'function') {
        return;
      }
      sink({
        kind: 'status',
        message: `Terminating hidden loop child after input request: ${reason}`,
        detail: { promptType },
      });
      terminate.call(adapter, false).catch((error: unknown) => {
        sink({
          kind: 'error',
          message: `Failed to terminate hidden loop child after input request: ${error instanceof Error ? error.message : String(error)}`,
          detail: { promptType },
        });
      });
    };

    const canAutoAnswer =
      promptType !== 'permission_denial' &&
      promptType !== 'deferred_permission' &&
      promptType !== 'mcp_elicitation' &&
      promptType !== 'acp_elicitation';
    const sendRaw = (adapter as unknown as { sendRaw?: (text: string) => Promise<void> }).sendRaw;
    if (!canAutoAnswer || typeof sendRaw !== 'function') {
      sink({
        kind: 'error',
        message: canAutoAnswer
          ? 'Loop child requested input, but this adapter cannot receive an automatic response'
          : `Loop child requested ${promptType}; cannot auto-answer that safely in hidden Loop Mode`,
        detail: { promptType, prompt },
      });
      terminateHiddenInputWait(canAutoAnswer ? 'adapter cannot receive automatic response' : `${promptType} cannot be answered safely`);
      return;
    }

    sink({
      kind: 'status',
      message: 'Auto-answering hidden loop question with autonomous-mode guidance',
      detail: { promptType },
    });
    sendRaw.call(adapter, LOOP_AUTONOMOUS_INPUT_RESPONSE).catch((error: unknown) => {
      sink({
        kind: 'error',
        message: `Failed to auto-answer hidden loop question: ${error instanceof Error ? error.message : String(error)}`,
        detail: { promptType },
      });
      terminateHiddenInputWait('automatic response failed');
    });
  });
  listen('complete', (response) => {
    const meta = isRecord(response) ? response : {};
    const usage = isRecord(meta['usage']) ? meta['usage'] : {};
    const metadata = isRecord(meta['metadata']) ? meta['metadata'] : {};
    const finishReason = readFinishReason(response);
    sink({
      kind: 'complete',
      message: metadata['timedOut'] === true
        ? 'CLI iteration timeout reached after partial output; continuing from partial result'
        : 'CLI response complete',
      detail: {
        tokens: typeof usage['totalTokens'] === 'number' ? usage['totalTokens'] : undefined,
        timedOut: metadata['timedOut'] === true ? true : undefined,
        timeoutMs: typeof metadata['timeoutMs'] === 'number' ? metadata['timeoutMs'] : undefined,
        ...(finishReason ? { finishReason } : {}),
      },
    });
  });
  listen('error', (error) => {
    sink({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  });

  return () => {
    for (const remove of removers.splice(0)) remove();
  };
}

function describeAdapterOutput(output: unknown): LoopInvocationActivity {
  if (typeof output === 'string') {
    return { kind: 'assistant', message: summarizeActivityText(output) };
  }
  if (!isRecord(output)) {
    return { kind: 'system', message: summarizeActivityText(String(output)) };
  }

  const type = typeof output['type'] === 'string' ? output['type'] : 'output';
  const content = typeof output['content'] === 'string' ? output['content'] : '';
  const metadata = isRecord(output['metadata']) ? output['metadata'] : {};
  if (type === 'tool_use') {
    const tool = isRecord(output['tool']) ? output['tool'] : {};
    const name = typeof metadata['name'] === 'string'
      ? metadata['name']
      : typeof tool['name'] === 'string'
        ? tool['name']
        : undefined;
    const id = typeof metadata['id'] === 'string'
      ? metadata['id']
      : typeof tool['id'] === 'string'
        ? tool['id']
        : undefined;
    const input = isRecord(metadata['input'])
      ? metadata['input']
      : isRecord(tool['input'])
        ? tool['input']
        : undefined;
    return {
      kind: 'tool_use',
      message: summarizeActivityText(name ? `Using tool: ${name}` : content || 'Using tool'),
      detail: {
        ...metadata,
        ...(id ? { id } : {}),
        ...(name ? { name } : {}),
        ...(input ? { input } : {}),
      },
    };
  }
  if (type === 'tool_result') {
    const id = typeof output['tool_use_id'] === 'string'
      ? output['tool_use_id']
      : typeof metadata['tool_use_id'] === 'string'
        ? metadata['tool_use_id']
        : typeof metadata['id'] === 'string'
          ? metadata['id']
          : undefined;
    const name = typeof metadata['name'] === 'string' ? metadata['name'] : undefined;
    const isError = output['is_error'] === true || metadata['is_error'] === true;
    return {
      kind: 'tool_result',
      message: summarizeActivityText(name ? `Tool result: ${name}` : content || 'Tool result'),
      detail: {
        ...metadata,
        ...(id ? { id } : {}),
        ...(name ? { name } : {}),
        result: content,
        success: !isError,
      },
    };
  }
  if (type === 'error') {
    return { kind: 'error', message: summarizeActivityText(content || 'CLI emitted an error'), detail: metadata };
  }
  if (type === 'assistant') {
    const finishReason = readFinishReason(output);
    return {
      kind: 'assistant',
      message: summarizeActivityText(content || 'Assistant output received'),
      detail: { ...metadata, ...(finishReason ? { finishReason } : {}) },
    };
  }
  if (type === 'result') {
    const finishReason = readFinishReason(output);
    return {
      kind: 'complete',
      message: summarizeActivityText(content || 'CLI response complete'),
      detail: { ...metadata, ...(finishReason ? { finishReason } : {}) },
    };
  }
  return {
    kind: 'system',
    message: summarizeActivityText(content || `CLI output: ${type}`),
    detail: metadata,
  };
}

function describeToolEvent(toolCall: unknown, kind: 'tool_use' | 'tool_result'): LoopInvocationActivity {
  const call = isRecord(toolCall) ? toolCall as Partial<CliToolCall> & Record<string, unknown> : {};
  const name = typeof call['name'] === 'string' ? call['name'] : 'unknown';
  const id = typeof call['id'] === 'string' ? call['id'] : undefined;
  const input = isRecord(call['arguments']) ? call['arguments'] : {};
  const result = typeof call['result'] === 'string' ? call['result'] : undefined;
  return {
    kind,
    message: summarizeActivityText(kind === 'tool_use' ? `Using tool: ${name}` : `Tool result: ${name}`),
    detail: {
      ...(id ? { id } : {}),
      name,
      input,
      ...(result !== undefined ? { result } : {}),
    },
  };
}

function readFinishReason(value: unknown): string | undefined {
  const direct = readString(value, 'finishReason') ?? readString(value, 'stopReason') ?? readString(value, 'stop_reason');
  if (direct) return direct;
  const response = value as Partial<CliResponse> | null | undefined;
  const metadata = isRecord(response?.metadata) ? response.metadata : undefined;
  return readString(metadata, 'finishReason') ?? readString(metadata, 'stopReason') ?? readString(metadata, 'stop_reason');
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const child = value[key];
  return typeof child === 'string' && child.trim() ? child : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function summarizeActivityText(value: string, max = 280): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}
