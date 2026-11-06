/**
 * Runs the recall check for one chat through the real Claude CLI.
 *
 * For each chat: cut a read-only copy of the transcript at about 300K tokens, write
 * questions about its early part, ask them with the full chat (before), summarise a
 * fork of the chat with `/compact`, ask the same questions again (after), and have a
 * blind judge grade both sets. The CLI is injected, so the whole flow is tested
 * without spending anything.
 *
 * Safety rules baked in:
 *  - the original transcript is never opened for writing; the copy lives in a
 *    throwaway project folder for a scratch working directory;
 *  - every call has a spend cap and the run has a hard total (see {@link SpendLedger});
 *  - error messages carry phase, exit code and cost only, never CLI output, because
 *    CLI output contains the conversation.
 */

import { randomUUID } from 'crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join, resolve, sep } from 'path';
import { assignJudgeOrder, buildAnswerPrompt, buildJudgePrompt, buildQuestionPrompt, parseAnswers, parseJudgement, parseQuestions } from './recall-questions';
import { tallyVerdicts } from './recall-evidence';
import { analyseTranscript, carriedCostUsd, contextPoints, conversationKeyAt, conversationSegments, lineAtContext, renderExcerpt, type TranscriptCut } from './recall-transcript';
import {
  RECALL_CUT_TOLERANCE,
  RECALL_MAX_QUESTIONS,
  RECALL_MIN_PROMPTS,
  RECALL_MIN_QUESTIONS,
  RECALL_TARGET_TOKENS,
  type RecallChatResult,
  type RecallQuestion,
} from './recall-types';

export interface ClaudeInvocation {
  args: string[];
  cwd: string;
  /** Prompt text sent on stdin, so conversation text never appears in the process list. */
  stdin?: string;
  timeoutMs: number;
}
export interface ClaudeProcessResult { exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean }
export type ClaudeRunner = (invocation: ClaudeInvocation) => Promise<ClaudeProcessResult>;

export class BudgetExhaustedError extends Error {
  constructor(spent: number, limit: number) {
    super(`spend limit reached ($${spent.toFixed(2)} of $${limit.toFixed(2)})`);
    this.name = 'BudgetExhaustedError';
  }
}

/** Smallest call worth starting: below this the CLI cannot finish a turn. */
const MIN_CALL_USD = 0.02;

export class SpendLedger {
  spent = 0;
  constructor(readonly limitUsd: number) {}
  /** The cap for the next call: the per-call cap, or what is left if that is less. */
  capFor(perCallUsd: number): number {
    const left = this.limitUsd - this.spent;
    if (left < MIN_CALL_USD) throw new BudgetExhaustedError(this.spent, this.limitUsd);
    return Math.min(perCallUsd, left);
  }
  charge(usd: number): void {
    if (Number.isFinite(usd) && usd > 0) this.spent += usd;
  }
}

export interface PipelineDeps {
  runner: ClaudeRunner;
  /** Scratch working directory the CLI runs in; outside any repository. */
  sandboxCwd: string;
  /** The CLI's `projects` folder (`~/.claude/projects`). */
  projectsRoot: string;
  /** Proof that this run created the throwaway project folder; see {@link claimSandbox}. */
  claim: SandboxClaim;
  /** Model that holds the chat, answers and summarises; must have a window larger than the cut. */
  model: string;
  /** Cheaper model for writing questions and grading. */
  helperModel: string;
  ledger: SpendLedger;
  perCallCapUsd: number;
  /** Context size to cut at. Defaults to 300K; smaller values are for cheap smoke runs and can never pass as evidence. */
  targetTokens?: number;
  /** Typed prompts a chat needs to count as a real conversation. Defaults to {@link RECALL_MIN_PROMPTS}. */
  minPrompts?: number;
  /** Extra instructions after `/compact`. Informative runs only: the app sends none, so the result can never pass the gate. */
  compactInstructions?: string;
  /** Register the owned fork id before invocation, including calls that never return a result. */
  onForkSession?(sessionId: string): void;
  /** Progress lines. Must never receive conversation text. */
  log(message: string): void;
  now(): Date;
}

export interface CliJson {
  result: string;
  sessionId: string | null;
  costUsd: number;
  isError: boolean;
  subtype: string | null;
  model: string | null;
}

/** The CLI's `--output-format json` reply: one result object, or an event list ending in one. */
export function parseCliJson(stdout: string): CliJson {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new Error('claude produced no result object'); }
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  const found = candidates.find((item): item is Record<string, unknown> => !!item && typeof item === 'object' && (item as Record<string, unknown>)['type'] === 'result');
  if (!found) throw new Error('claude produced no result object');
  const usageModels = found['modelUsage'];
  return {
    result: typeof found['result'] === 'string' ? found['result'] : '',
    sessionId: typeof found['session_id'] === 'string' ? found['session_id'] : null,
    costUsd: typeof found['total_cost_usd'] === 'number' && Number.isFinite(found['total_cost_usd']) ? found['total_cost_usd'] : 0,
    isError: found['is_error'] === true,
    subtype: typeof found['subtype'] === 'string' ? found['subtype'] : null,
    model: usageModels && typeof usageModels === 'object' ? Object.keys(usageModels)[0] ?? null : null,
  };
}

const encodeProject = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-');

/** Where the CLI keeps transcripts for a working directory (it encodes the resolved path). */
export function projectDirFor(projectsRoot: string, cwd: string): string {
  let resolved = cwd;
  try { resolved = realpathSync(cwd); } catch { /* use the path as given */ }
  return join(projectsRoot, encodeProject(resolved));
}

const CALL_TIMEOUT_MS = 25 * 60 * 1000;
/** Keeps the CLI from loading anything beyond the conversation itself. */
const ISOLATION_ARGS = [
  '--tools', '',
  '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--setting-sources', '',
  '--exclude-dynamic-system-prompt-sections',
];

interface CallOptions {
  phase: string; model: string; stdin?: string; prompt?: string; resume?: string; fork?: boolean; persist: boolean;
  /**
   * What the session being resumed had already cost. The CLI continues that total, so `total_cost_usd` in the reply is
   * this plus what the call added; only the difference is charged. A call that starts a new session carries nothing.
   */
  carriedUsd?: number;
}

/** What a reply added to the total it started from; a total below that start cannot be netted, so it is charged in full. */
export const addedUsd = (replyTotalUsd: number, carriedUsd: number): number =>
  replyTotalUsd >= carriedUsd ? replyTotalUsd - carriedUsd : replyTotalUsd;

async function callClaude(deps: PipelineDeps, options: CallOptions): Promise<CliJson & { spentUsd: number }> {
  const cap = deps.ledger.capFor(deps.perCallCapUsd);
  const args = ['-p', '--model', options.model, '--output-format', 'json', '--max-budget-usd', cap.toFixed(2), ...ISOLATION_ARGS];
  if (options.resume) args.push('--resume', options.resume);
  let forkId: string | undefined;
  if (options.fork) {
    // Pre-register the owned UUID: a timeout may leave no result from which to recover it.
    forkId = randomUUID();
    args.push('--fork-session', '--session-id', forkId);
    deps.onForkSession?.(forkId);
  }
  if (!options.persist) args.push('--no-session-persistence');
  // `--` ends the options, so a variadic flag can never swallow the prompt.
  if (options.prompt) args.push('--', options.prompt);
  const run = await deps.runner({ args, cwd: deps.sandboxCwd, stdin: options.stdin, timeoutMs: CALL_TIMEOUT_MS });
  let reply: CliJson | null = null;
  try { reply = parseCliJson(run.stdout); } catch { /* reported below without the output */ }
  const spentUsd = reply ? addedUsd(reply.costUsd, options.carriedUsd ?? 0) : 0;
  deps.ledger.charge(spentUsd);
  // A reply cannot grant ownership of another session's files. Only our preallocated id may be cleaned.
  if (forkId && reply && reply.sessionId !== forkId) throw new Error(`claude returned an unexpected fork session during ${options.phase}`);
  if (run.timedOut || run.exitCode !== 0 || !reply || reply.isError) {
    throw new Error(`claude failed during ${options.phase} (exit ${run.exitCode ?? 'none'}${reply?.subtype ? `, ${reply.subtype}` : ''}, spent $${spentUsd.toFixed(2)})`);
  }
  deps.log(`${options.phase}: ok, $${spentUsd.toFixed(2)}, total $${deps.ledger.spent.toFixed(2)}`);
  return { ...reply, spentUsd };
}

export type PreparedChat =
  | { kind: 'skipped'; reason: 'no-cut' | 'already-compacted' | 'too-few-prompts' | 'too-few-questions' }
  | { kind: 'ready'; chatKey: string; conversationKey: string; sessionId: string; cut: TranscriptCut; questions: RecallQuestion[]; prepCostUsd: number; seedCostUsd: number };

/**
 * Early parts of the chat to ask about, as shares of the conversation's growth between the first request (which already
 * carries the system prompt, tools and memory) and the cut.
 */
const WINDOWS: readonly (readonly [number, number])[] = [[0.02, 0.12], [0.12, 0.26], [0.26, 0.42]];
const ASK_PER_WINDOW = 6;
const KEEP_PER_WINDOW = 5;
const EXCERPT_CHARS = 24_000;

export interface PrepareInput {
  /** Transcript lines. Held in memory only. */
  lines: readonly string[];
  sessionId: string;
  /** Short non-reversible label for reports. */
  chatKey: string;
}

export async function prepareChat(deps: PipelineDeps, input: PrepareInput): Promise<PreparedChat> {
  const cut = analyseTranscript(input.lines, deps.targetTokens ?? RECALL_TARGET_TOKENS, RECALL_CUT_TOLERANCE);
  if (!cut) return { kind: 'skipped', reason: 'no-cut' };
  if (cut.priorBoundaries > 0) return { kind: 'skipped', reason: 'already-compacted' };
  if (cut.humanPrompts < (deps.minPrompts ?? RECALL_MIN_PROMPTS)) return { kind: 'skipped', reason: 'too-few-prompts' };

  // Install the read-only copy first: it fails fast, and never replaces a transcript that already exists.
  writeFileSync(join(deps.claim.folder, `${input.sessionId}.jsonl`), `${input.lines.slice(0, cut.cutLine + 1).join('\n')}\n`, { flag: 'wx', mode: 0o600 });

  const points = contextPoints(input.lines);
  const segments = conversationSegments(input.lines, cut.cutLine);
  const questions: RecallQuestion[] = [];
  let prepCostUsd = 0;
  const baseline = points[0]?.contextTokens ?? 0;
  const growth = Math.max(0, cut.contextTokens - baseline);
  for (const [from, to] of WINDOWS) {
    const startLine = lineAtContext(points, baseline + growth * from);
    const endLine = lineAtContext(points, baseline + growth * to);
    const excerpt = renderExcerpt(segments.filter(segment => segment.lineIndex > startLine && segment.lineIndex <= endLine), EXCERPT_CHARS);
    if (excerpt.length < 500) continue;
    const reply = await callClaude(deps, { phase: 'question writing', model: deps.helperModel, stdin: buildQuestionPrompt(excerpt, ASK_PER_WINDOW), persist: false });
    prepCostUsd += reply.spentUsd;
    questions.push(...parseQuestions(reply.result, excerpt, KEEP_PER_WINDOW));
  }
  const kept = questions.slice(0, RECALL_MAX_QUESTIONS);
  if (kept.length < RECALL_MIN_QUESTIONS) return { kind: 'skipped', reason: 'too-few-questions' };
  return { kind: 'ready', chatKey: input.chatKey, conversationKey: conversationKeyAt(input.lines, cut.cutLine), sessionId: input.sessionId, cut, questions: kept, prepCostUsd, seedCostUsd: carriedCostUsd(input.lines, cut.cutLine) };
}

function compactionFacts(file: string): { boundaries: number; preTokens: number | null; postTokens: number | null } {
  let boundaries = 0;
  let preTokens: number | null = null;
  let postTokens: number | null = null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('compact_boundary')) continue;
    try {
      const record = JSON.parse(line) as { subtype?: string; compactMetadata?: { preTokens?: unknown; postTokens?: unknown } };
      if (record.subtype !== 'compact_boundary') continue;
      boundaries++;
      preTokens = typeof record.compactMetadata?.preTokens === 'number' ? record.compactMetadata.preTokens : preTokens;
      postTokens = typeof record.compactMetadata?.postTokens === 'number' ? record.compactMetadata.postTokens : postTokens;
    } catch { /* a damaged line is not a boundary */ }
  }
  return { boundaries, preTokens, postTokens };
}

async function judgeWithRetry(deps: PipelineDeps, prompt: string, count: number, swapped: boolean[]) {
  for (let attempt = 0; ; attempt++) {
    const reply = await callClaude(deps, { phase: 'grading', model: deps.helperModel, stdin: prompt, persist: false });
    try { return parseJudgement(reply.result, count, swapped); } catch (error) {
      if (attempt >= 1) throw new Error(`grading reply was unusable (${(error as Error).message})`);
    }
  }
}

const compactPrompt = (instructions: string | undefined): string => {
  const text = instructions?.replace(/\s+/g, ' ').trim().slice(0, 600);
  return text ? `/compact ${text}` : '/compact';
};

/** Ask with the full chat, summarise a fork, ask again, grade blind. Returns counts only. */
export async function runChat(
  deps: PipelineDeps,
  prepared: Extract<PreparedChat, { kind: 'ready' }>,
): Promise<RecallChatResult & { model: string | null; forkSessionIds: string[] }> {
  const folder = deps.claim.folder;
  const answerPrompt = buildAnswerPrompt(prepared.questions);
  const count = prepared.questions.length;
  const startSpend = deps.ledger.spent;
  const readAnswers = (reply: CliJson): string[] => {
    const answers = parseAnswers(reply.result, count);
    if (answers.every(answer => answer === '')) throw new Error('claude answers could not be read');
    return answers;
  };

  const beforeReply = await callClaude(deps, { phase: 'answering with the full chat', model: deps.model, stdin: answerPrompt, resume: prepared.sessionId, fork: true, persist: true, carriedUsd: prepared.seedCostUsd });
  const beforeAnswers = readAnswers(beforeReply);

  const compactReply = await callClaude(deps, { phase: 'summarising', model: deps.model, prompt: compactPrompt(deps.compactInstructions), resume: prepared.sessionId, fork: true, persist: true, carriedUsd: prepared.seedCostUsd });
  const summarised = compactReply.sessionId;
  const file = summarised ? join(folder, `${summarised}.jsonl`) : null;
  const facts = file ? compactionFacts(file) : { boundaries: 0, preTokens: null, postTokens: null };
  if (!summarised || facts.boundaries < 1) throw new Error('claude wrote no compaction boundary');

  // The summarised session already holds the summarising call's total, so only the answers are new.
  const afterReply = await callClaude(deps, { phase: 'answering after the summary', model: deps.model, stdin: answerPrompt, resume: summarised, persist: true, carriedUsd: compactReply.costUsd });
  const afterAnswers = readAnswers(afterReply);

  const swapped = assignJudgeOrder(count, prepared.chatKey);
  const verdicts = await judgeWithRetry(deps, buildJudgePrompt(prepared.questions, beforeAnswers, afterAnswers, swapped), count, swapped);
  return {
    chatKey: prepared.chatKey,
    conversationKey: prepared.conversationKey,
    contextTokensAtCut: prepared.cut.contextTokens,
    humanPrompts: prepared.cut.humanPrompts,
    questionCount: count,
    before: tallyVerdicts(verdicts.before),
    after: tallyVerdicts(verdicts.after),
    compaction: facts,
    costUsd: deps.ledger.spent - startSpend,
    model: beforeReply.model,
    forkSessionIds: [...new Set([beforeReply.sessionId, summarised].filter((id): id is string => !!id))],
  };
}

/** Proof that this run created the throwaway project folder, and may therefore remove it. */
export interface SandboxClaim { folder: string; token: string }

export const OWNER_MARKER = '.aio-recall-owner';

/**
 * Create the throwaway project folder for `sandboxCwd`, refusing one that already exists so a real project
 * folder can never be adopted. The marker holds this run's token; only a folder carrying it is ever removed.
 */
export function claimSandbox(projectsRoot: string, sandboxCwd: string, token: string = randomUUID()): SandboxClaim {
  const folder = projectDirFor(projectsRoot, sandboxCwd);
  mkdirSync(projectsRoot, { recursive: true });
  let present = true;
  try { lstatSync(folder); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') present = false; else throw error; }
  if (present) throw new Error('refusing to use a project folder that already exists');
  mkdirSync(folder, { mode: 0o700 });
  try {
    writeFileSync(join(folder, OWNER_MARKER), JSON.stringify({ token, createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    // mkdir above succeeded, so this is our new folder, even if the marker write failed.
    rmSync(folder, { recursive: true, force: true });
    throw error;
  }
  return { folder, token };
}

/** Remove the folder this run claimed (copies, forks and the marker) and nothing else. */
export function cleanupSandbox(projectsRoot: string, sandboxCwd: string, claim: SandboxClaim): { removedFiles: number; removedDirectory: boolean; refused?: string } {
  const refuse = (reason: string) => ({ removedFiles: 0, removedDirectory: false, refused: reason });
  const root = resolve(projectsRoot);
  const folder = resolve(claim.folder);
  if (folder !== resolve(projectDirFor(root, sandboxCwd)) || !folder.startsWith(root + sep)) return refuse('not the claimed sandbox folder');
  let info;
  try { info = lstatSync(folder); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removedFiles: 0, removedDirectory: false };
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return refuse('not a plain directory (symbolic link or file)');
  let owner: unknown;
  try { owner = (JSON.parse(readFileSync(join(folder, OWNER_MARKER), 'utf8')) as { token?: unknown }).token; } catch { return refuse('owner marker missing'); }
  if (owner !== claim.token) return refuse('owner marker belongs to another run');
  let removedFiles = 0;
  const count = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) count(join(directory, entry.name));
      else if (entry.name.endsWith('.jsonl')) removedFiles++;
    }
  };
  count(folder);
  rmSync(folder, { recursive: true, force: true });
  return { removedFiles, removedDirectory: true };
}
