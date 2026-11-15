import { buildWatcherBrief } from '../../src/main/session-watcher/watcher-brief';
import { buildWatcherJudgePrompt } from '../../src/main/session-watcher/watcher-judge-prompt';
import { applyWatcherPostChecks, type WatcherLevel } from '../../src/main/session-watcher/watcher-post-checks';
import { parseWatcherVerdict } from '../../src/main/session-watcher/watcher-verdict';
import type { JudgeBackend } from './judge-backends';
import { appendJsonl, forEachLimited, readJsonl } from './jsonl';
import { loadMessagesUpToStop } from './load-messages';
import type { ResultRow, StopRef } from './types';

export const JUDGE_MAX_TOKENS = 400;
export const JUDGE_TIMEOUT_MS = 60_000;

/** One stop through the production brief, prompt, parser and post-checks. Never throws. */
export async function judgeOne(stop: StopRef, backend: JudgeBackend, level: WatcherLevel): Promise<ResultRow> {
  const startedAt = Date.now();
  let promptChars = 0;
  try {
    const brief = buildWatcherBrief(loadMessagesUpToStop(stop));
    const prompt = buildWatcherJudgePrompt(brief);
    promptChars = prompt.system.length + prompt.user.length;
    let raw: string;
    try {
      raw = await backend.call(prompt.system, prompt.user, { maxTokens: JUDGE_MAX_TOKENS, temperature: 0, timeoutMs: JUDGE_TIMEOUT_MS });
    } catch (error) {
      return { id: stop.id, parseOk: false, error: 'backend call failed', backendError: (error instanceof Error ? error.message : String(error)).slice(0, 300), latencyMs: Date.now() - startedAt, promptChars };
    }
    const latencyMs = Date.now() - startedAt;
    const parsed = parseWatcherVerdict(raw);
    if (!parsed.ok) return { id: stop.id, parseOk: false, error: parsed.error.slice(0, 200), latencyMs, promptChars };
    const decision = applyWatcherPostChecks(parsed.verdict, {
      level,
      attempts: brief.watcherRepliesSincePerson,
      toolRanSinceWatcherReply: brief.toolRanSinceWatcherReply,
      personTexts: brief.personTexts,
      finalReply: brief.finalReplyFull,
    });
    return {
      id: stop.id, parseOk: true, repaired: parsed.repaired, verdict: parsed.verdict.verdict, stop: parsed.verdict.stop,
      verdictBasis: parsed.verdict.basis, action: decision.action, basis: decision.basis, override: decision.override,
      latencyMs, promptChars,
    };
  } catch (error) {
    return { id: stop.id, parseOk: false, error: `local failure: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`, latencyMs: Date.now() - startedAt, promptChars };
  }
}

export async function runJudge(opts: {
  stops: readonly StopRef[]; backend: JudgeBackend; level: WatcherLevel; out: string; limit: number; concurrency: number;
}): Promise<{ done: number; skipped: number; parseFailures: number }> {
  const done = new Set(readJsonl<ResultRow>(opts.out).map((row) => row.id));
  const todo = opts.stops.filter((stop) => !done.has(stop.id)).slice(0, opts.limit > 0 ? opts.limit : undefined);
  let parseFailures = 0;
  await forEachLimited(todo, opts.concurrency, async (stop) => {
    const row = await judgeOne(stop, opts.backend, opts.level);
    if (!row.parseOk) parseFailures += 1;
    appendJsonl(opts.out, row);
  });
  return { done: todo.length, skipped: opts.stops.length - todo.length, parseFailures };
}
