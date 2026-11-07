import { createWriteStream, mkdirSync } from 'fs';
import { dirname } from 'path';
import { buildClaudeInvocation, buildCodexInvocation, summarizeAgentResult } from './arms';
import type { AgentRunResult, TokenUsage } from './types';
import { addUsage, emptyUsage } from './types';

interface StreamParseState {
  finalText: string;
  usage: TokenUsage;
  turns: number;
  toolErrors: string[];
  hitTurnCap: boolean;
  /** True when the stream's result event carried is_error. */
  resultIsError: boolean;
}

function tokensFrom(raw: unknown): TokenUsage {
  if (!raw || typeof raw !== 'object') return emptyUsage();
  const usage = raw as Record<string, unknown>;
  const num = (key: string): number => {
    const value = usage[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };
  return {
    inputTokens: num('input_tokens') || num('inputTokens'),
    outputTokens: num('output_tokens') || num('outputTokens'),
    cacheReadTokens:
      num('cache_read_input_tokens') || num('cached_input_tokens') || num('cacheReadInputTokens'),
    cacheWriteTokens: num('cache_creation_input_tokens') || num('cacheWriteInputTokens'),
  };
}

function recordUsage(state: StreamParseState, raw: unknown): void {
  state.usage = addUsage(state.usage, tokensFrom(raw));
}

/**
 * One result event's usage. `usage` is the aggregate for the invocation;
 * `modelUsage` is that same aggregate split per model, so adding both
 * double-counts every token. The aggregate wins when it carries figures; a
 * zero/absent aggregate falls back to summing the per-model entries.
 */
function resultEventUsage(event: Record<string, unknown>): TokenUsage {
  const sumModelUsage = (): TokenUsage => {
    const modelUsage = event['modelUsage'];
    if (!modelUsage || typeof modelUsage !== 'object') return emptyUsage();
    let total = emptyUsage();
    for (const entry of Object.values(modelUsage as Record<string, unknown>)) {
      total = addUsage(total, tokensFrom(entry));
    }
    return total;
  };
  const aggregate = event['usage'];
  const fromAggregate = aggregate && typeof aggregate === 'object' ? tokensFrom(aggregate) : emptyUsage();
  const aggregateHasFigures = fromAggregate.inputTokens > 0
    || fromAggregate.outputTokens > 0
    || fromAggregate.cacheReadTokens > 0
    || fromAggregate.cacheWriteTokens > 0;
  return aggregateHasFigures ? fromAggregate : sumModelUsage();
}

/**
 * Result events re-emit the invocation's CUMULATIVE usage at segment closes
 * (values non-decrease and exact duplicate lines appear — see cost.ts), so one
 * run's usage is the largest snapshot, not their sum. Summing snapshots
 * recorded ~2x the billed basis (plan note, 16 Oct round 3).
 */
function maxUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: Math.max(left.inputTokens, right.inputTokens),
    outputTokens: Math.max(left.outputTokens, right.outputTokens),
    cacheReadTokens: Math.max(left.cacheReadTokens, right.cacheReadTokens),
    cacheWriteTokens: Math.max(left.cacheWriteTokens, right.cacheWriteTokens),
  };
}

function mergeCumulativeUsage(state: StreamParseState, next: TokenUsage): void {
  state.usage = maxUsage(state.usage, next);
}

export function parseClaudeStream(lines: string[]): StreamParseState {
  const state: StreamParseState = {
    finalText: '',
    usage: emptyUsage(),
    turns: 0,
    toolErrors: [],
    hitTurnCap: false,
    resultIsError: false,
  };
  // Assistant events are per content block: one message (one model turn) emits
  // several events sharing `message.id`, each repeating the same per-message
  // `message.usage`. Summing every event double- or triple-counts; summing once
  // per message id is the billed basis (verified against a real run: the
  // per-message sums equal its result event's cumulative input/cache exactly).
  const messageUsageById = new Map<string, TokenUsage>();
  const seenMessageIds = new Set<string>();
  let idlessUsage = emptyUsage();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof event['type'] === 'string' ? event['type'] : '';
    if (type === 'assistant') {
      const message = event['message'] as Record<string, unknown> | undefined;
      // One assistant message is one turn (the unit `--max-turns` / `num_turns`
      // count); counting content-block events inflated turns ~2-3x and starved
      // arm F's remaining-turn takeover budget.
      const messageId = typeof message?.['id'] === 'string' ? message['id'] as string : undefined;
      if (messageId === undefined) {
        state.turns += 1;
      } else if (!seenMessageIds.has(messageId)) {
        seenMessageIds.add(messageId);
        state.turns += 1;
      }
      const usage = tokensFrom(message?.['usage']);
      if (messageId === undefined) {
        idlessUsage = addUsage(idlessUsage, usage);
      } else {
        messageUsageById.set(messageId, maxUsage(messageUsageById.get(messageId) ?? emptyUsage(), usage));
      }
      const content = Array.isArray(message?.['content']) ? (message['content'] as Record<string, unknown>[]) : [];
      for (const block of content) {
        if (block['type'] === 'text' && typeof block['text'] === 'string') {
          state.finalText = block['text'];
        }
      }
    } else if (type === 'user') {
      const message = event['message'] as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.['content']) ? (message['content'] as Record<string, unknown>[]) : [];
      for (const block of content) {
        if (block['type'] === 'tool_result' && block['is_error'] === true) {
          const text = typeof block['content'] === 'string' ? block['content'] : JSON.stringify(block['content'] ?? '');
          state.toolErrors.push(text.slice(0, 400));
        }
      }
    } else if (type === 'result') {
      const subtype = typeof event['subtype'] === 'string' ? event['subtype'] : '';
      if (subtype.includes('max_turns')) state.hitTurnCap = true;
      if (event['is_error'] === true) state.resultIsError = true;
      if (typeof event['result'] === 'string' && event['result'].trim()) {
        state.finalText = event['result'];
      }
      mergeCumulativeUsage(state, resultEventUsage(event));
      if (typeof event['num_turns'] === 'number') {
        state.turns = Math.max(state.turns, event['num_turns']);
      }
    }
  }
  // Interrupted runs (timeout / kill / abort) never emit a result event, so
  // without the per-message fallback their usage recorded as zero — real
  // pilot runs lost 911k/489k-token volumes that way. Result snapshots and
  // per-message sums measure the same billed basis, so the component-wise max
  // keeps whichever is complete without ever double-counting.
  let messageUsage = idlessUsage;
  for (const usage of messageUsageById.values()) {
    messageUsage = addUsage(messageUsage, usage);
  }
  state.usage = maxUsage(state.usage, messageUsage);
  return state;
}

/**
 * Codex "turn" counting for the shared execution limit. `codex exec`'s
 * `turn.started` marks ONE submitted prompt and wraps every internal
 * model/tool cycle the agent loop runs while answering it (OpenAI's
 * sdk/typescript/src/events.ts: "A turn encompasses all events that happen
 * while processing the prompt"), so counting `turn.started` gave arm G a whole
 * prompt as one turn — no cap at all. The unit that matches `claude
 * --max-turns` (one assistant message = one model invocation) is the internal
 * model/tool cycle: one model response and the tool execution that follows it.
 *
 * A cycle opens at a model-produced item (`reasoning`, `agent_message`) or at
 * the first tool item (`command_execution`, `file_change`, `mcp_tool_call`,
 * `web_search`) of a response that produced none; a tool item's completion
 * closes it. `item.started` opens cycles in real streams (so the cap kills the
 * over-budget cycle BEFORE its work runs); completed-only streams (older
 * fixtures) still count the same cycles. `todo_list`/`error` items never count.
 */
export class CodexTurnCounter {
  private cycleOpen = false;

  /** Feed one stream event; returns true when it opens a new model/tool cycle. */
  handle(event: Record<string, unknown>): boolean {
    const type = typeof event['type'] === 'string' ? event['type'] : '';
    if (type === 'turn.started') {
      // A new prompt is a hard cycle boundary.
      this.cycleOpen = false;
      return false;
    }
    if (type !== 'item.started' && type !== 'item.completed') return false;
    const item = (event['item'] ?? {}) as Record<string, unknown>;
    const itemType = typeof item['type'] === 'string' ? item['type'] : '';
    if (itemType === 'reasoning' || itemType === 'agent_message') {
      return this.open();
    }
    if (
      itemType === 'command_execution'
      || itemType === 'file_change'
      || itemType === 'mcp_tool_call'
      || itemType === 'web_search'
    ) {
      const opened = this.open();
      if (type === 'item.completed') this.cycleOpen = false;
      return opened;
    }
    return false;
  }

  private open(): boolean {
    if (this.cycleOpen) return false;
    this.cycleOpen = true;
    return true;
  }
}

export function parseCodexStream(lines: string[]): StreamParseState {
  const state: StreamParseState = {
    finalText: '',
    usage: emptyUsage(),
    turns: 0,
    toolErrors: [],
    hitTurnCap: false,
    resultIsError: false,
  };
  const counter = new CodexTurnCounter();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof event['type'] === 'string' ? event['type'] : '';
    if (counter.handle(event)) state.turns += 1;
    if (type === 'turn.completed') {
      recordUsage(state, event['usage']);
    } else if (type === 'turn.failed') {
      state.resultIsError = true;
      state.toolErrors.push(JSON.stringify(event['error'] ?? event).slice(0, 400));
    } else if (type === 'item.completed') {
      const item = (event['item'] ?? {}) as Record<string, unknown>;
      const itemType = typeof item['type'] === 'string' ? item['type'] : '';
      if (itemType === 'agent_message' && typeof item['text'] === 'string') {
        state.finalText = item['text'];
      }
      if (itemType === 'command_execution' && item['exit_code'] !== 0 && item['exit_code'] !== undefined) {
        state.toolErrors.push(`command exit ${String(item['exit_code'])}: ${String(item['command'] ?? '').slice(0, 200)}`);
      }
      if (itemType === 'error' || item['error'] !== undefined) {
        state.toolErrors.push(JSON.stringify(item).slice(0, 400));
      }
      recordUsage(state, item['usage']);
    } else if (type === 'error') {
      state.toolErrors.push(JSON.stringify(event).slice(0, 400));
    }
  }
  return state;
}

/**
 * Stream-level turn cap. `claude` enforces its own `--max-turns`; `codex exec`
 * has no such flag, so the shared turn cap ("same limits for every arm") is
 * enforced here: the turn after the last allowed one is killed before it runs.
 * `noteEvent` counts the same unit `parseCodexStream` reports (model/tool
 * cycles — see CodexTurnCounter), so the live cap and the recorded `turns`
 * can never drift apart.
 */
export interface TurnCapRule {
  maxTurns: number;
  /** Feed one stream event; true when it opens a new turn (the unit `turns` counts). */
  noteEvent: (event: Record<string, unknown>) => boolean;
}

async function runStreamChild(
  command: string[],
  prompt: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  logPath: string,
  timeoutMs: number,
  parse: (lines: string[]) => StreamParseState,
  onEvent?: (event: Record<string, unknown>) => 'abort' | undefined,
  turnCap?: TurnCapRule,
): Promise<AgentRunResult> {
  const { spawn } = await import('child_process');
  const startedAt = Date.now();
  mkdirSync(dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: 'a' });
  log.write(`\n=== ${new Date().toISOString()} ${command.join(' ')} (cwd ${cwd}) ===\n`);

  return new Promise<AgentRunResult>((resolve) => {
    const [cmd, ...args] = command;
    if (!cmd) {
      resolve(summarizeAgentResult({ error: 'empty agent command', rawLogPath: logPath }));
      return;
    }
    const child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdoutLines: string[] = [];
    let stderrText = '';
    let stdoutBuffer = '';
    let timedOut = false;
    let settled = false;
    let abortReason: string | undefined;
    let turnStarts = 0;
    let hitTurnCap = false;
    let frozenByTurnCap = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, timeoutMs);

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      log.write(text);
      stdoutBuffer += text;
      const parts = stdoutBuffer.split('\n');
      stdoutBuffer = parts.pop() ?? '';
      for (const part of parts) {
        if (frozenByTurnCap) continue;
        let event: Record<string, unknown> | undefined;
        try {
          event = JSON.parse(part) as Record<string, unknown>;
        } catch {
          event = undefined;
        }
        if (event && turnCap && turnCap.noteEvent(event)) {
          if (turnStarts >= turnCap.maxTurns) {
            // The budget is spent before this turn runs: kill the child and
            // drop the over-budget turn's events so they can never count —
            // the cap means at most maxTurns turns execute, same as `claude
            // --max-turns` (whose runs end with no extra turn either).
            hitTurnCap = true;
            frozenByTurnCap = true;
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 5_000);
            continue;
          }
          turnStarts += 1;
        }
        stdoutLines.push(part);
        if (event && onEvent) {
          try {
            if (onEvent(event) === 'abort') {
              abortReason = 'aborted by caller (takeover monitor)';
              child.kill('SIGTERM');
              setTimeout(() => child.kill('SIGKILL'), 5_000);
            }
          } catch {
            // Non-JSON lines are not events; a monitor throw must not kill the run.
          }
        }
      }
    });
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      log.write(`[stderr] ${text}`);
      stderrText += text;
    });
    child.stdin?.on('error', () => { /* EPIPE is expected if the child exits before reading stdin. */ });
    child.stdin?.write(prompt);
    child.stdin?.end();

    const finish = (exitCode: number | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!frozenByTurnCap && stdoutBuffer.trim()) stdoutLines.push(stdoutBuffer);
      log.end();

      const state = parse(stdoutLines);
      const errorParts: string[] = [];
      if (abortReason) errorParts.push(abortReason);
      if (spawnError) errorParts.push(spawnError);
      if (timedOut) errorParts.push(`timed out after ${timeoutMs}ms`);
      if (state.resultIsError && state.finalText) {
        // The stream itself reported a failed result; that text is the reason.
        errorParts.push(state.finalText.slice(0, 400));
      } else if (!timedOut && exitCode !== 0 && !spawnError && !hitTurnCap) {
        // A turn-cap kill exits nonzero by design; the cap itself is not an error.
        errorParts.push(`exit ${exitCode}: ${stderrText.slice(0, 400)}`);
      }
      if (!state.finalText && exitCode === 0 && !timedOut) {
        errorParts.push('no final text parsed from stream');
      }

      resolve(summarizeAgentResult({
        finalText: state.finalText,
        usage: state.usage,
        turns: state.turns,
        toolErrors: state.toolErrors,
        hitTurnCap: state.hitTurnCap || hitTurnCap,
        durationMs: Date.now() - startedAt,
        exitCode,
        timedOut,
        error: errorParts.length > 0 ? errorParts.join(' | ') : undefined,
        rawLogPath: logPath,
      }));
    };

    child.on('error', (err) => finish(null, `spawn error: ${err.message}`));
    child.on('close', (code) => finish(code));
  });
}

export interface AgentInvocationRequest {
  prompt: string;
  cwd: string;
  logPath: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  model?: string;
  maxTurns?: number;
  readOnly?: boolean;
  claudeCommand?: string;
  codexCommand?: string;
  onEvent?: (event: Record<string, unknown>) => 'abort' | undefined;
}

export async function runClaudeAgent(request: AgentInvocationRequest): Promise<AgentRunResult> {
  const invocation = buildClaudeInvocation({
    prompt: request.prompt,
    cwd: request.cwd,
    model: request.model ?? 'claude-opus-5-5',
    maxTurns: request.maxTurns ?? 75,
    env: request.env,
    readOnly: request.readOnly,
    claudeCommand: request.claudeCommand,
  });
  return runStreamChild(
    invocation.command,
    invocation.prompt,
    request.cwd,
    invocation.env,
    request.logPath,
    request.timeoutMs,
    parseClaudeStream,
    request.onEvent,
  );
}

export async function runCodexAgent(request: AgentInvocationRequest): Promise<AgentRunResult> {
  const invocation = buildCodexInvocation({
    prompt: request.prompt,
    cwd: request.cwd,
    model: request.model,
    env: request.env,
    codexCommand: request.codexCommand,
  });
  const counter = new CodexTurnCounter();
  return runStreamChild(
    invocation.command,
    invocation.prompt,
    request.cwd,
    invocation.env,
    request.logPath,
    request.timeoutMs,
    parseCodexStream,
    request.onEvent,
    // `codex exec` has no `--max-turns`, so the shared turn cap is enforced at
    // the stream boundary: the model/tool cycle beyond the cap is killed
    // before its work runs and never counts. `turn.started` is NOT the unit —
    // one `codex exec` prompt emits a single `turn.started` around every
    // internal cycle (see CodexTurnCounter) — so the counter tracks the same
    // model/tool cycles `parseCodexStream` reports as `turns`.
    {
      maxTurns: request.maxTurns ?? 75,
      noteEvent: (event) => counter.handle(event),
    },
  );
}
