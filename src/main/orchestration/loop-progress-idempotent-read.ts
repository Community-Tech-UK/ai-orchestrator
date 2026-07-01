import type {
  LoopIteration,
  LoopProgressThresholds,
  ProgressSignalEvidence,
} from '../../shared/types/loop.types';

function isReadOnlyToolName(toolName: string): boolean {
  return /^(read|grep|glob|ls|list|search|find|view)$/i.test(toolName.trim());
}

function readResultKey(call: LoopIteration['toolCalls'][number]): string | null {
  if (!call.success || !call.resultHash) return null;
  if (!isReadOnlyToolName(call.toolName)) return null;
  return `${call.toolName.toLowerCase()}::${call.resultHash}`;
}

/**
 * Signal I — Idempotent read identity.
 * Argument hashes are deliberately ignored: Signal G covers identical args,
 * while this catches semantically identical reads through different paths.
 */
export function signalI_idempotentReadIdentity(
  history: LoopIteration[],
  current: LoopIteration,
  th: LoopProgressThresholds,
): ProgressSignalEvidence | null {
  const threshold = th.idempotentReadRepeatWarn ?? 3;
  const window = [...history, current].slice(-Math.max(th.warnEscalationWindow, threshold));
  let lastKey: string | null = null;
  let repeatCount = 0;
  let toolName = '';
  let resultHash = '';

  for (const iteration of window) {
    if (iteration.filesChanged.length > 0) {
      lastKey = null;
      repeatCount = 0;
    }
    for (const call of iteration.toolCalls) {
      const key = readResultKey(call);
      if (!key) continue;
      repeatCount = key === lastKey ? repeatCount + 1 : 1;
      lastKey = key;
      toolName = call.toolName;
      resultHash = call.resultHash ?? '';
    }
  }

  if (repeatCount < threshold || !lastKey) return null;
  const wasAlreadyFlagged = history.at(-1)?.progressSignals.some((signal) => signal.id === 'I') ?? false;
  return {
    id: 'I',
    verdict: wasAlreadyFlagged ? 'CRITICAL' : 'WARN',
    message: `Read-only tool ${toolName} returned the same result hash ${repeatCount}x without intervening edits`,
    detail: { toolName, resultHash, repeatCount, threshold },
  };
}
