import type { ChildProcess } from 'child_process';
import type { CliMessage, CliResponse } from '../base-cli-adapter';
import type { OutputMessage } from '../../../../shared/types/instance.types';
import { generateId } from '../../../../shared/utils/id-generator';
import { CODEX_TIMEOUTS } from '../../../../shared/constants/limits';
import { getLogger } from '../../../logging/logger';
import { parseNdjsonLine } from '../../json-parse';
import { terminateProcessTree } from './app-server-client';
import { classifyCodexDiagnostic, type CodexDiagnostic } from './exec-diagnostics';
import { consumeLines } from './exec-helpers';
import { isBenignCodexStdinNotice } from './exec-error-classifier';
import { parseCodexExecTranscript } from './exec-transcript-parser';
import { CodexTimeoutError, type CodexExecPhase, type CodexTimeoutKind } from './exec-timeout';
import type { ThinkingBlock } from '../../../../shared/utils/thinking-extractor';

const logger = getLogger('CodexCliAdapter');

export interface CodexExecProcessResult {
  code: number | null;
  diagnostics: CodexDiagnostic[];
  raw: string;
  response: CliResponse & { metadata: Record<string, unknown>; thinking?: ThinkingBlock[] };
}

interface CodexExecProcessState {
  diagnostics: CodexDiagnostic[];
  emittedDiagnosticKeys: Set<string>;
  partialStderr: string;
  partialStdout: string;
  rawStderr: string;
  rawStdout: string;
  threadId?: string;
}

export interface CodexExecProcessOptions {
  deadlineMs: number;
  emitExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  emitHeartbeat: () => void;
  emitOutput: (message: OutputMessage) => void;
  generateResponseId: () => string;
  isActiveProcess: (process: ChildProcess) => boolean;
  message: CliMessage;
  onThreadId: (threadId: string) => void;
  phase: CodexExecPhase;
  recordActivity?: (chunk: string) => Promise<void>;
  setProcess: (process: ChildProcess | null) => void;
  spawn: () => ChildProcess;
  timeoutMs: number;
  turnIdleTimeoutMs: number;
}

/** Runs one `codex exec --json` child and resolves its parsed transcript. */
export function runCodexExecProcess(
  options: CodexExecProcessOptions,
): Promise<CodexExecProcessResult> {
  return new Promise((resolve, reject) => {
    const childProcess = options.spawn();
    const state: CodexExecProcessState = {
      diagnostics: [],
      emittedDiagnosticKeys: new Set<string>(),
      partialStderr: '',
      partialStdout: '',
      rawStderr: '',
      rawStdout: '',
    };
    options.setProcess(childProcess);

    const startedAt = Date.now();
    let lastActivityAt = startedAt;
    let receivedAnyData = false;
    let idleTimer: NodeJS.Timeout | null = null;
    let deadlineTimer: NodeJS.Timeout | null = null;
    let livenessTimer: NodeJS.Timeout | null = null;
    let currentBudgetMs = options.timeoutMs;
    let effectivePhase = options.phase;

    const clearIdleTimer = () => {
      if (!idleTimer) return;
      clearTimeout(idleTimer);
      idleTimer = null;
    };
    const clearDeadlineTimer = () => {
      if (!deadlineTimer) return;
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
    };
    const clearLivenessTimer = () => {
      if (!livenessTimer) return;
      clearInterval(livenessTimer);
      livenessTimer = null;
    };
    const clearTimers = () => {
      clearIdleTimer();
      clearDeadlineTimer();
      clearLivenessTimer();
    };

    const fireWatchdogTimeout = (kind: CodexTimeoutKind) => {
      if (!options.isActiveProcess(childProcess)) return;
      const budgetMs = kind === 'deadline' ? options.deadlineMs : currentBudgetMs;
      const elapsedMs = Date.now() - startedAt;
      const silentMs = Date.now() - lastActivityAt;
      const networkErrors = state.diagnostics.filter((diagnostic) =>
        /network error|sending request|connection (refused|reset|timed out|closed)|dns|tls|handshake/i.test(diagnostic.line)
      );
      const lastNetworkError = networkErrors.at(-1)?.line ?? null;
      logger.warn(kind === 'deadline' ? 'Codex exec total deadline exceeded' : 'Codex exec idle timeout', {
        pid: childProcess.pid,
        phase: effectivePhase,
        kind,
        budgetMs,
        silentMs,
        elapsedMs,
        receivedAnyData,
        stdoutBytes: state.rawStdout.length,
        stderrBytes: state.rawStderr.length,
        stdoutTail: state.rawStdout.slice(-500),
        stderrTail: state.rawStderr.slice(-500),
        diagnosticsTail: state.diagnostics.slice(-5).map((diagnostic) => diagnostic.line),
        networkErrorCount: networkErrors.length,
        lastNetworkError,
      });
      terminateProcessTree(childProcess.pid);
      options.setProcess(null);
      clearTimers();

      if (options.message.metadata?.['allowPartialOnTimeout'] === true) {
        const partial = parseCodexExecTranscript(
          state.rawStdout,
          state.diagnostics,
          options.generateResponseId(),
        );
        if (partial.hasMeaningfulOutput) {
          if (partial.threadId) options.onThreadId(partial.threadId);
          const raw = [state.rawStdout.trim(), state.rawStderr.trim()].filter(Boolean).join('\n');
          logger.warn('Codex exec timed out after partial output — returning partial transcript', {
            phase: effectivePhase,
            kind,
            budgetMs,
            elapsedMs,
            stdoutBytes: state.rawStdout.length,
          });
          resolve({
            code: null,
            diagnostics: state.diagnostics,
            raw,
            response: {
              ...partial.response,
              metadata: {
                ...partial.response.metadata,
                diagnostics: state.diagnostics,
                timedOut: true,
                timeoutKind: kind,
                partial: true,
                idleBudgetMs: currentBudgetMs,
              },
              raw,
            },
          });
          return;
        }
      }

      reject(new CodexTimeoutError(effectivePhase, budgetMs, {
        kind,
        networkErrorCount: networkErrors.length,
        lastNetworkError,
        stdoutBytes: state.rawStdout.length,
      }));
    };

    const resetIdleTimer = () => {
      lastActivityAt = Date.now();
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fireWatchdogTimeout('idle'), currentBudgetMs);
    };
    const escalateIdleBudgetToTurn = () => {
      if (effectivePhase !== 'startup' || currentBudgetMs >= options.turnIdleTimeoutMs) return;
      effectivePhase = 'turn';
      currentBudgetMs = options.turnIdleTimeoutMs;
      logger.info('Codex exec escalated idle budget startup → turn on first stdout', {
        startupBudgetMs: options.timeoutMs,
        turnBudgetMs: options.turnIdleTimeoutMs,
      });
    };

    resetIdleTimer();
    deadlineTimer = setTimeout(() => fireWatchdogTimeout('deadline'), options.deadlineMs);
    livenessTimer = setInterval(() => {
      if (childProcess.killed || childProcess.exitCode !== null) return;
      options.emitHeartbeat();
    }, CODEX_TIMEOUTS.EXEC_LIVENESS_HEARTBEAT_MS);
    livenessTimer.unref?.();

    if (childProcess.stdin) {
      if (options.message.content) childProcess.stdin.write(options.message.content);
      childProcess.stdin.end();
    }

    childProcess.stdout?.on('data', (data) => {
      receivedAnyData = true;
      escalateIdleBudgetToTurn();
      resetIdleTimer();
      const chunk = data.toString();
      state.rawStdout += chunk;
      options.recordActivity?.(chunk).catch((error: unknown) => {
        logger.debug('Failed to record Codex terminal activity', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      state.partialStdout = consumeLines(chunk, state.partialStdout, (line) => {
        processStdoutLine(line, state, options);
      });
    });

    childProcess.stderr?.on('data', (data) => {
      receivedAnyData = true;
      resetIdleTimer();
      options.emitHeartbeat();
      const chunk = data.toString();
      state.rawStderr += chunk;
      state.partialStderr = consumeLines(chunk, state.partialStderr, (line) => {
        const diagnostic = classifyCodexDiagnostic(line);
        state.diagnostics.push(diagnostic);
        if (diagnostic.level === 'info') return;
        const key = `${diagnostic.category}:${diagnostic.line}`;
        if (state.emittedDiagnosticKeys.has(key)) {
          diagnostic.streamed = true;
          return;
        }
        state.emittedDiagnosticKeys.add(key);
        diagnostic.streamed = true;
        options.emitOutput({
          id: generateId(),
          timestamp: Date.now(),
          type: diagnostic.fatal ? 'error' : 'system',
          content: `[codex] ${diagnostic.line}`,
          metadata: {
            diagnostic: true,
            category: diagnostic.category,
            fatal: diagnostic.fatal,
            level: diagnostic.level,
          },
        });
      });
    });

    childProcess.on('error', (error) => {
      clearTimers();
      options.setProcess(null);
      reject(error);
    });

    childProcess.on('close', (code, signal) => {
      clearTimers();
      if (state.partialStdout.trim()) processStdoutLine(state.partialStdout, state, options);
      if (state.partialStderr.trim()) {
        for (const line of state.partialStderr.split('\n')) {
          if (line.trim()) state.diagnostics.push(classifyCodexDiagnostic(line));
        }
      }

      const parsed = parseCodexExecTranscript(
        state.rawStdout,
        state.diagnostics,
        options.generateResponseId(),
      );
      const raw = [state.rawStdout.trim(), state.rawStderr.trim()].filter(Boolean).join('\n');
      options.setProcess(null);
      options.emitExit(code, signal);

      if (code !== 0 && !parsed.hasMeaningfulOutput) {
        const diagnosticSummary = state.diagnostics
          .map((diagnostic) => diagnostic.line)
          .filter((line) => !isBenignCodexStdinNotice(line))
          .join('\n');
        reject(new Error(parsed.errorMessage || diagnosticSummary || `Codex exited with code ${code}`));
        return;
      }

      if (parsed.threadId) options.onThreadId(parsed.threadId);
      resolve({
        code,
        diagnostics: state.diagnostics,
        raw,
        response: {
          ...parsed.response,
          metadata: {
            ...parsed.response.metadata,
            diagnostics: state.diagnostics,
          },
          raw,
        },
      });
    });
  });
}

function processStdoutLine(
  line: string,
  state: CodexExecProcessState,
  options: CodexExecProcessOptions,
): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  const parsedLine = parseNdjsonLine<Record<string, unknown>>(trimmed);
  if (!parsedLine.ok) {
    if (trimmed.startsWith('{')) {
      logger.warn('Failed to parse Codex exec JSONL line', { linePreview: trimmed.slice(0, 200) });
    }
    return;
  }

  const event = parsedLine.value;
  const eventType = typeof event['type'] === 'string' ? event['type'] : '';
  options.emitHeartbeat();
  if (!state.threadId) {
    const id = event['thread_id'] ?? event['session_id'] ?? event['id'];
    if (
      typeof id === 'string'
      && ['thread.started', 'session.started', 'session.created', 'thread.created'].includes(eventType)
    ) {
      state.threadId = id;
    }
  }

  if (eventType === 'item.created' && event['item'] && typeof event['item'] === 'object') {
    const item = event['item'] as Record<string, unknown>;
    if (item['type'] === 'command_execution' && typeof item['command'] === 'string') {
      options.emitOutput({
        id: generateId(),
        timestamp: Date.now(),
        type: 'tool_use',
        content: `Running command: ${item['command']}`,
        metadata: { streaming: true },
      });
    }
  }
}
