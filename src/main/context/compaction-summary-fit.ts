import { getTokenCounter } from '../rlm/token-counter';

export class CompactionInputBudgetError extends Error {
  constructor(maxInputTokens: number) {
    super(`Compaction stopped: the ${maxInputTokens}-token summary input limit cannot fit the prior summary and required reference material. Increase the compression input limit and try again. The session was not restarted.`);
  }
}

/** Fit the complete dispatched request, including fixed carry-forward and template text. */
export function fitCompactionSummary<T extends { content: string; role?: string; type?: string }>(
  turns: readonly T[],
  maxInputTokens = 96000,
  composeRequest: (selected: readonly T[]) => { system: string; user: string } = selected => ({
    system: '', user: selected.map(turn => `[${turn.role ?? turn.type ?? 'turn'}]: ${turn.content}`).join('\n\n'),
  }),
) {
  if (!Number.isFinite(maxInputTokens) || maxInputTokens <= 0) throw new CompactionInputBudgetError(maxInputTokens);
  const budget = Math.floor(maxInputTokens);
  const counter = getTokenCounter();
  const count = (selected: readonly T[]) => {
    const request = composeRequest(selected);
    return counter.countTokens(request.system) + counter.countTokens(request.user);
  };
  const requiredTokens = count([]);
  if (requiredTokens > budget) throw new CompactionInputBudgetError(budget);
  if (count(turns) <= budget) {
    return { turns: [...turns], sampledCount: turns.length, totalCount: turns.length, skippedRanges: [] as string[] };
  }
  // Count each candidate once instead of repeatedly scanning the growing full prompt on Electron main.
  // Labels, escaped delimiters and rounding allowance are included. The final composed count is authoritative.
  const cost = (turn: T) => counter.countTokens(
    `[${turn.role ?? turn.type ?? 'turn'}]: ${turn.content.replace(/<\/conversation_turns/gi, '<\\/conversation_turns')}\n\n`,
  ) + 8;
  const costs = new Map<number, number>();
  const sample = (messageBudget: number) => {
    const fitted = new Map<number, T>();
    const clipped: string[] = [];
    let used = 0;
    const add = (index: number, endpointBudget?: number) => {
      if (fitted.has(index)) return;
      const original = turns[index]!;
      let turn = original;
      let length = original.content.length;
      let tokens = costs.get(index);
      if (tokens === undefined) { tokens = cost(original); costs.set(index, tokens); }
      const limit = Math.min(endpointBudget ?? messageBudget - used, messageBudget - used);
      if (endpointBudget !== undefined) {
        while (tokens > limit && length > 0) {
          length = Math.floor(length * 0.75);
          if (length > 0 && /[\uDC00-\uDFFF]/.test(original.content[length]!)) length--;
          turn = { ...original, content: original.content.slice(0, length) + '\n[Earlier message clipped to fit the summary input budget.]' };
          tokens = cost(turn);
        }
      }
      if (tokens <= limit) {
        fitted.set(index, turn); used += tokens;
        if (turn !== original) clipped.push(`message ${index + 1} clipped`);
      }
    };
    // Reserve fixed reference data first; keep the original goal/newest state, then sample whole turns.
    const firstUser = turns.findIndex(turn => turn.role === 'user' || turn.type === 'user');
    const first = firstUser >= 0 ? firstUser : 0;
    if (turns.length) {
      add(first, Math.floor(messageBudget / (first === turns.length - 1 ? 1 : 3)));
      if (turns.length > 1) add(turns.length - 1, messageBudget - used);
    }
    for (let stride = Math.max(1, Math.ceil(turns.length / 16)); stride >= 1; stride = Math.floor(stride / 2)) {
      for (let i = 0; i < turns.length; i += stride) add(i);
      if (stride === 1) break;
    }
    return { fitted, clipped, turns: [...fitted].sort(([a], [b]) => a - b).map(([, turn]) => turn) };
  };
  let messageBudget = budget - requiredTokens;
  let selected = sample(messageBudget);
  // Whole-prompt heuristics are not additive. If the final request exceeds the limit,
  // reduce selection geometrically with cached charges; never truncate the composed request.
  while (count(selected.turns) > budget) {
    messageBudget = Math.floor(messageBudget / 2);
    if (messageBudget <= 0) throw new CompactionInputBudgetError(budget);
    selected = sample(messageBudget);
  }
  if (turns.length && selected.fitted.size === 0) throw new CompactionInputBudgetError(budget);
  const skippedRanges: string[] = [...selected.clipped];
  let start: number | undefined;
  for (let i = 0; i <= turns.length; i++) {
    if (i < turns.length && !selected.fitted.has(i)) { start ??= i; }
    else if (start !== undefined) { skippedRanges.push(`${start + 1}-${i}`); start = undefined; }
  }
  return { turns: selected.turns, sampledCount: selected.fitted.size, totalCount: turns.length, skippedRanges };
}
