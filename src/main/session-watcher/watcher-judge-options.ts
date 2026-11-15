import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_PRICING_MODELS } from '../../shared/types/provider.types';

export const WATCHER_JUDGE_TIMEOUT_MS = 60_000;
const WATCHER_JUDGE_BUDGET_USD = 0.05;

/**
 * The exact model that met the safety marks on 15 November 2026 (plan history). Pinned by id, not by the "haiku"
 * alias: the alias moves to newer models nobody has scored. The id is Haiku 5.5, named through the shared
 * constant. If it is retired the call fails and the watcher does nothing, which the report shows; a successor
 * goes here only after `npm run bench:session-watcher`.
 */
export const QUALIFIED_WATCHER_JUDGE_MODEL = CLAUDE_PRICING_MODELS.HAIKU_55;

/** An empty folder for the judge to run in, so there is no project, no instruction file and nothing to read. */
export function watcherJudgeWorkingDirectory(): string {
  const directory = join(tmpdir(), 'harness-session-watcher-judge');
  mkdirSync(directory, { recursive: true });
  return directory;
}

/**
 * How the judge is called. One place, shared by the app and the offline replay, so the configuration that is
 * measured is the configuration that ships: a plain completion (no tools, no MCP servers, none of the user's
 * settings or hooks), our system prompt in place of the default, an empty working folder and a small budget.
 */
export function watcherJudgeSpawnOptions(systemPrompt: string) {
  return {
    workingDirectory: watcherJudgeWorkingDirectory(),
    model: QUALIFIED_WATCHER_JUDGE_MODEL,
    systemPrompt,
    systemPromptMode: 'replace' as const,
    plainCompletion: true,
    yoloMode: false,
    timeout: WATCHER_JUDGE_TIMEOUT_MS,
    maxBudgetUsd: WATCHER_JUDGE_BUDGET_USD,
  };
}
