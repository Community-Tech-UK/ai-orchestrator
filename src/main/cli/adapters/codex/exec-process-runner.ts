import type { ChildProcess } from 'child_process';
import type { CliMessage, CliResponse } from '../base-cli-adapter';
import type { OutputMessage } from '../../../../shared/types/instance.types';
import { generateId } from '../../../../shared/utils/id-generator';
import { CODEX_TIMEOUTS } from '../../../../shared/constants/limits';
import { getLogger } from '../../../logging/logger';
import { errorDiagnostic, textDiagnostic } from '../../../logging/source-diagnostics';
import { parseNdjsonLine } from '../../json-parse';
import { terminateProcessTree } from './app-server-client';
import { classifyCodexDiagnostic, type CodexDiagnostic } from './exec-diagnostics';
import { consumeLines } from './exec-helpers';
import { isBenignCodexStdinNotice } from './exec-error-classifier';
import { parseCodexExecTranscript } from './exec-transcript-parser';
import { CodexTimeoutError, type CodexExecPhase, type CodexTimeoutKind } from './exec-timeout';
import type { ThinkingBlock } from '../../../../shared/utils/thinking-extractor';
import type { AdapterInputDispatch } from '../base-cli-adapter.types';
import { assertAdapterInputCurrent } from '../adapter-input-dispatch';
import { writeChildStdin } from '../child-stdin-write';
import { cancelCodexExecInputFailure, markCodexExecInputFailure, type CodexExecInputWritePhase } from './exec-input-write';

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
  writePhase?: CodexExecInputWritePhase;
  dispatch?: AdapterInputDispatch;
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
    assertAdapterInputCurrent(options.dispatch);
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
    let finished = false;
    const writePhase = options.writePhase ?? { accepted: false, cancelled: false };
    let inputFailure: Error | undefined;
    let inputSettled: Promise<void> = Promise.resolve();
    const stdin = childProcess.stdin;
    const recordInputFailure = (error: unknown): void => {
      if (finished || inputFailure) return;
      inputFailure = markCodexExecInputFailure(error instanceof Error ? error : new Error(String(error)), writePhase.accepted);
    };
    const onInputError = (error: Error): void => { if (!writePhase.accepted) recordInputFailure(error); };
    const inputError = (): Error => writePhase.cancelled && !writePhase.accepted
      ? cancelCodexExecInputFailure(inputFailure!) : inputFailure!;

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
      options.dispatch?.signal?.removeEventListener('abort', onAbort);
      stdin?.off('error', onInputError);
    };
    const cancel = (error: unknown) => {
      if (finished) return;
      finished = true;
      clearTimers();
      terminateProcessTree(childProcess.pid);
      if (!writePhase.accepted) stdin?.destroy();
      if (options.isActiveProcess(childProcess)) options.setProcess(null);
      reject(error);
    };
    const onAbort = () => {
      try { assertAdapterInputCurrent(options.dispatch); } catch (error) { cancel(error); }
    };

    const fireWatchdogTimeout = (kind: CodexTimeoutKind) => {
      if (finished) return;
      try { assertAdapterInputCurrent(options.dispatch); }
      catch (error) { cancel(error); return; }
      if (inputFailure) { cancel(inputError()); return; }
      finished = true;
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
        stdout: textDiagnostic(state.rawStdout),
        stderr: textDiagnostic(state.rawStderr),
        diagnosticsCount: state.diagnostics.length,
        networkErrorCount: networkErrors.length,
        networkError: textDiagnostic(lastNetworkError ?? ''),
      });
      terminateProcessTree(childProcess.pid);
      if (options.isActiveProcess(childProcess)) options.setProcess(null);
      clearTimers();
      if (!writePhase.accepted) stdin?.destroy();

      if (writePhase.accepted && options.message.metadata?.['allowPartialOnTimeout'] === true) {
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

      const error = new CodexTimeoutError(effectivePhase, budgetMs, {
        kind,
        networkErrorCount: networkErrors.length,
        lastNetworkError,
        stdoutBytes: state.rawStdout.length,
      });
      reject(writePhase.cancelled ? cancelCodexExecInputFailure(error, writePhase.accepted) : error);
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
      if (inputFailure || !options.isActiveProcess(childProcess) || childProcess.killed || childProcess.exitCode !== null) return;
      options.emitHeartbeat();
    }, CODEX_TIMEOUTS.EXEC_LIVENESS_HEARTBEAT_MS);
    livenessTimer.unref?.();

    childProcess.stdout?.on('data', (data) => {
      if (finished || inputFailure) return;
      receivedAnyData = true;
      escalateIdleBudgetToTurn();
      resetIdleTimer();
      const chunk = data.toString();
      state.rawStdout += chunk;
      if (!writePhase.accepted) { state.partialStdout += chunk; return; }
      options.recordActivity?.(chunk).catch((error: unknown) => {
        logger.debug('Failed to record Codex terminal activity', {
          ...errorDiagnostic(error),
        });
      });
      state.partialStdout = consumeLines(chunk, state.partialStdout, (line) => {
        processStdoutLine(line, state, options);
      });
    });

    childProcess.stderr?.on('data', (data) => {
      if (finished || inputFailure) return;
      receivedAnyData = true;
      resetIdleTimer();
      options.emitHeartbeat();
      const chunk = data.toString();
      state.rawStderr += chunk;
      if (!writePhase.accepted) { state.partialStderr += chunk; return; }
      state.partialStderr = consumeLines(chunk, state.partialStderr, (line) => {
        processStderrLine(line, state, options);
      });
    });

    childProcess.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimers();
      if (!writePhase.accepted) stdin?.destroy();
      if (options.isActiveProcess(childProcess)) options.setProcess(null);
      reject(inputFailure ? inputError() : error);
    });

    const finishClose = async (code: number | null, signal: NodeJS.Signals | null): Promise<void> => {
      // A failed write callback may settle after Node publishes close.
      await Promise.resolve();
      await inputSettled;
      if (finished) return;
      finished = true;
      clearTimers();
      if (options.isActiveProcess(childProcess)) options.setProcess(null);
      options.emitExit(code, signal);
      if (inputFailure) {
        try { assertAdapterInputCurrent(options.dispatch); }
        catch (error) { reject(error); return; }
        reject(inputError());
        return;
      }
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
      if (writePhase.cancelled && !parsed.hasMeaningfulOutput) {
        reject(cancelCodexExecInputFailure(new Error(parsed.errorMessage || `Codex exited with code ${code}`), writePhase.accepted));
        return;
      }
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
    };
    childProcess.on('close', (code, signal) => {
      void finishClose(code, signal).catch(error => { finished = true; clearTimers(); reject(error); });
    });
    options.dispatch?.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      // Spawn and observers may synchronously revoke eligibility. Charge only
      // immediately before the first native input write, then recheck admission.
      assertAdapterInputCurrent(options.dispatch);
      if (!childProcess.stdin) throw new Error('Codex exec stdin is unavailable');
      options.dispatch?.beforeProviderDispatch?.();
      assertAdapterInputCurrent(options.dispatch);
      stdin!.on('error', onInputError);
      const accept = (): void => {
        writePhase.accepted = true;
        if (finished) return;
        try { assertAdapterInputCurrent(options.dispatch); }
        catch (error) { cancel(error); return; }
      };
      const write = options.message.content ? writeChildStdin(childProcess, options.message.content, accept)
        : Promise.resolve().then(accept);
      inputSettled = write.then(() => {
        if (finished) return;
        state.partialStdout = consumeLines('', state.partialStdout, line => processStdoutLine(line, state, options));
        state.partialStderr = consumeLines('', state.partialStderr, line => processStderrLine(line, state, options));
        stdin!.end();
      }).catch(recordInputFailure);
    } catch (error) { cancel(error); }
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
      logger.warn('Failed to parse Codex exec JSONL line', textDiagnostic(trimmed));
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

function processStderrLine(
  line: string,
  state: CodexExecProcessState,
  options: CodexExecProcessOptions,
): void {
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
}
