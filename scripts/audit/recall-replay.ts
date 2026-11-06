#!/usr/bin/env -S npx tsx
/**
 * Long-chat recall check (Phase D, Step 5): does Claude still remember earlier detail
 * after summarising a chat at about 300K tokens? Run it every quarter and before
 * turning the own-chat context ceiling on. See docs/runbooks/recall-replay-quarterly.md.
 *
 *   npx tsx scripts/audit/recall-replay.ts candidates [--min-mb 0.5] [--max-mb 200] [--min-prompts 20]
 *   npx tsx scripts/audit/recall-replay.ts run [--count 3] [--chat <key> ...] [--model 'sonnet[1m]']
 *        [--helper-model sonnet] [--total-budget 8] [--per-call 2.5] [--target-tokens 300000]
 *        [--min-prompts 20] [--prepare-only] [--out <evidence.json>] [--receipts <dir>]
 *        [--compact-instructions "<text>"]   exploratory only: tests wording the app does not send; never passes the gate
 *   npx tsx scripts/audit/recall-replay.ts evaluate --in <evidence.json>
 *   npx tsx scripts/audit/recall-replay.ts write-evidence --in <evidence.json> [--to <module path>]
 *
 * Measurement rules (housekeeping K9): coverage is printed first; every figure here is OBSERVED from real
 * CLI answers, and only the pass/fail thresholds are MODELLED (see recall-evidence.ts); chats are
 * de-duplicated by the API message id at the cut; a run uses three or more distinct conversations; and
 * recall differences of a few points are noise with questions this few, which is why the rule allows ten.
 *
 * Read-only on your transcripts: each chat is copied (cut at the target size) into a throwaway project
 * folder this run creates and marks, which is removed when the run ends. The originals are hashed before
 * and after and the run fails if they changed. Before answering and summarising use separate forks of the
 * chat, so the earlier answers can never leak into the summary. Every call has a spend cap and the run a
 * hard total; calls load no settings, hooks or MCP servers and no tools. The child CLI is handed the
 * current access token only (never the refresh token), so it cannot refresh, or damage, the stored login.
 * Output is counts, hashes and costs: no paths, questions, answers or transcript text are printed or stored.
 *
 * A requested target or chat cut outside 240K-360K cannot pass as evidence (the rule requires about 300K).
 */
import { execFileSync, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeRecallRunner, RecallProcessNotRetiredError } from '../../src/main/context/recall-replay/recall-cli-runner';
import { withRecallSandbox } from '../../src/main/context/recall-replay/recall-sandbox';
import { MIN_LOGIN_MINUTES, buildChildEnv, loginMinutesLeft, parseStoredLogin, type HandedInLogin } from '../../src/main/context/recall-replay/recall-cli-env';
import { buildRecallEvidence, evaluateRecallEvidence, renderEvidenceModule, summariseRecall } from '../../src/main/context/recall-replay/recall-evidence';
import {
  SpendLedger,
  parseCliJson,
  prepareChat,
  runChat,
  type ClaudeInvocation,
  type ClaudeProcessResult,
  type ClaudeRunner,
  type PipelineDeps,
} from '../../src/main/context/recall-replay/recall-pipeline';
import { analyseTranscript, conversationKeyAt } from '../../src/main/context/recall-replay/recall-transcript';
import {
  RECALL_CUT_TOLERANCE,
  RECALL_MIN_PROMPTS,
  RECALL_TARGET_TOKENS,
  recallScore,
  type RecallChatResult,
  type RecallEvidence,
} from '../../src/main/context/recall-replay/recall-types';

// Run from the repository root, like the other scripts.
const ROOT = process.cwd();
const DEFAULT_EVIDENCE_MODULE = join(ROOT, 'src/main/core/config/own-chat-ceiling-recall-evidence.ts');
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function values(name: string): string[] {
  const found: string[] = [];
  process.argv.forEach((item, index) => { if (item === `--${name}` && process.argv[index + 1]) found.push(process.argv[index + 1]); });
  return found;
}
function option(name: string, fallback: string): string {
  return values(name)[0] ?? fallback;
}
const MIN_PROMPTS = ((): number => {
  const wanted = Number(option('min-prompts', ''));
  return Number.isInteger(wanted) && wanted > 0 ? wanted : RECALL_MIN_PROMPTS;
})();
const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const short = (text: string): string => sha256(text).slice(0, 8);

interface Candidate { key: string; fingerprint: string; file: string; project: string; sizeMb: number; modified: string; contextTokens: number; humanPrompts: number; priorBoundaries: number }

function listCandidates(projectsRoot: string, target: number): Candidate[] {
  const minBytes = Number(option('min-mb', '0.5')) * 1e6;
  const maxBytes = Number(option('max-mb', '200')) * 1e6;
  const idleMs = 30 * 60_000;
  const found: Candidate[] = [];
  for (const directory of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    for (const entry of readdirSync(join(projectsRoot, directory.name), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = join(projectsRoot, directory.name, entry.name);
      const info = statSync(file);
      if (info.size < minBytes || info.size > maxBytes || Date.now() - info.mtimeMs < idleMs) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      const cut = analyseTranscript(lines, target, RECALL_CUT_TOLERANCE);
      if (!cut) continue;
      found.push({ key: short(file), fingerprint: conversationKeyAt(lines, cut.cutLine), file, project: short(directory.name), sizeMb: +(info.size / 1e6).toFixed(1),
        modified: new Date(info.mtimeMs).toISOString().slice(0, 10), contextTokens: cut.contextTokens, humanPrompts: cut.humanPrompts, priorBoundaries: cut.priorBoundaries });
    }
  }
  return found;
}

/** Real chats with a clean cut: no earlier compaction, many typed prompts, one conversation once, other projects first. */
function selectDiverse(candidates: Candidate[], count: number): Candidate[] {
  const usable = candidates.filter(item => item.priorBoundaries === 0 && item.humanPrompts >= MIN_PROMPTS).sort((a, b) => b.humanPrompts - a.humanPrompts);
  const chosen: Candidate[] = [];
  const projects = new Set<string>();
  const conversations = new Set<string>();
  const take = (item: Candidate): void => { chosen.push(item); projects.add(item.project); conversations.add(item.fingerprint); };
  for (const item of usable) if (chosen.length < count && !conversations.has(item.fingerprint) && !projects.has(item.project)) take(item);
  for (const item of usable) if (chosen.length < count && !conversations.has(item.fingerprint)) take(item);
  return chosen;
}

function readKeychainLogin(): Promise<HandedInLogin | null> {
  return new Promise(resolve => {
    const child = execFile('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { timeout: 15_000, maxBuffer: 1 << 20 },
      (error, stdout) => resolve(error ? null : parseStoredLogin(stdout)));
    child.stdin?.end();
  });
}

interface CallReceipt {
  n: number;
  /** Flags as run; the session id after --resume is replaced by a short hash and the prompt by its length and hash. */
  args: string[];
  stdinBytes: number | null;
  stdinSha256: string | null;
  exitCode: number | null;
  seconds: number;
  stdoutBytes: number | null;
  stdoutSha256: string | null;
  stderrBytes: number | null;
  isError: boolean | null;
  subtype: string | null;
  costUsd: number | null;
  timedOut: boolean;
  transportError?: 'not-retired' | 'runner-error';
}

function redactArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  args.forEach((arg, index) => {
    const previous = args[index - 1];
    if (previous === '--resume' || previous === '--session-id') out.push(`id:${short(arg)}`);
    else if (previous === '--' && arg !== '/compact') out.push(`prompt:${arg.length}b:${short(arg)}`);
    else out.push(arg);
  });
  return out;
}

/** Wraps the runner so every call leaves a private-data-free receipt. */
export function recordingRunner(inner: ClaudeRunner, receipts: CallReceipt[]): ClaudeRunner {
  return async (invocation: ClaudeInvocation): Promise<ClaudeProcessResult> => {
    const started = Date.now();
    let result: ClaudeProcessResult;
    try { result = await inner(invocation); } catch (error) {
      // Output and spend are unknown when retirement fails. Never claim a zero-byte or free call.
      receipts.push({
        n: receipts.length + 1, args: redactArgs(invocation.args),
        stdinBytes: invocation.stdin === undefined ? null : Buffer.byteLength(invocation.stdin),
        stdinSha256: invocation.stdin === undefined ? null : sha256(invocation.stdin),
        exitCode: null, seconds: +((Date.now() - started) / 1000).toFixed(1),
        stdoutBytes: null, stdoutSha256: null, stderrBytes: null, isError: null, subtype: null, costUsd: null,
        timedOut: error instanceof RecallProcessNotRetiredError,
        transportError: error instanceof RecallProcessNotRetiredError ? 'not-retired' : 'runner-error',
      });
      throw error;
    }
    let parsed: ReturnType<typeof parseCliJson> | null = null;
    try { parsed = parseCliJson(result.stdout); } catch { /* receipt records null */ }
    receipts.push({
      n: receipts.length + 1, args: redactArgs(invocation.args),
      stdinBytes: invocation.stdin === undefined ? null : Buffer.byteLength(invocation.stdin), stdinSha256: invocation.stdin === undefined ? null : sha256(invocation.stdin),
      exitCode: result.exitCode, seconds: +((Date.now() - started) / 1000).toFixed(1),
      stdoutBytes: Buffer.byteLength(result.stdout), stdoutSha256: sha256(result.stdout), stderrBytes: Buffer.byteLength(result.stderr),
      isError: parsed?.isError ?? null, subtype: parsed?.subtype ?? null, costUsd: parsed?.costUsd ?? null, timedOut: result.timedOut === true,
    });
    return result;
  };
}

/** Names (never contents) of Claude state entries touched since `sinceMs`, outside the transcript folder. */
function touchedState(claudeRoot: string, sinceMs: number): string[] {
  const touched: string[] = [];
  for (const sub of ['', 'session-env', 'todos', 'file-history', 'shell-snapshots', 'sessions', 'debug']) {
    try {
      for (const entry of readdirSync(join(claudeRoot, sub), { withFileTypes: true })) {
        if (sub === '' && entry.name === 'projects') continue;
        if (statSync(join(claudeRoot, sub, entry.name)).mtimeMs >= sinceMs) touched.push(sub ? `${sub}/${entry.name}` : entry.name);
      }
    } catch { /* folder absent */ }
  }
  return touched;
}

/** Remove state the CLI wrote for the fork sessions this run created. Original sessions are never matched. */
export function removeForkArtifacts(claudeRoot: string, forkIds: readonly string[]): number {
  let removed = 0;
  const failures: unknown[] = [];
  for (const sub of ['session-env', 'todos', 'file-history', 'shell-snapshots', 'sessions', 'debug']) {
    let entries: string[];
    try {
      entries = readdirSync(join(claudeRoot, sub));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failures.push(error);
      continue;
    }
    for (const entry of entries) {
      if (forkIds.some(id => entry === id || entry.startsWith(`${id}-`) || entry.startsWith(`${id}.`))) {
        try {
          rmSync(join(claudeRoot, sub, entry), { recursive: true, force: true });
          removed++;
        } catch (error) { failures.push(error); }
      }
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Recall fork-state cleanup did not complete.');
  return removed;
}

function row(result: RecallChatResult): string {
  const pct = (value: number): string => `${Math.round(value * 100)}%`;
  return `  chat ${result.chatKey}: ${result.questionCount} questions, context ${Math.round(result.contextTokensAtCut / 1000)}K -> ${result.compaction.postTokens === null ? '?' : Math.round(result.compaction.postTokens / 1000)}K, `
    + `before ${pct(recallScore(result.before))} (${result.before.correct}c ${result.before.partial}p ${result.before.wrong}w ${result.before.unknown}u), `
    + `after ${pct(recallScore(result.after))} (${result.after.correct}c ${result.after.partial}p ${result.after.wrong}w ${result.after.unknown}u), $${result.costUsd.toFixed(2)}`;
}

function report(evidence: RecallEvidence): void {
  const pool = summariseRecall(evidence);
  const verdict = evaluateRecallEvidence(evidence, new Date());
  console.log(`\nPooled over ${pool.chats} chats / ${pool.questions} questions: before ${(pool.pooledBefore * 100).toFixed(1)}%, after ${(pool.pooledAfter * 100).toFixed(1)}%`);
  if (evidence.method !== 'cli-replay') { console.log('EXPLORATORY: summarised with instructions the app does not send, so this can never pass the release rule. Compare the figures only.'); return; }
  console.log(verdict.eligible ? 'RULE: passes (summarising at this size does not clearly lose recall).' : `RULE: does not pass: ${verdict.reason} - ${verdict.detail}`);
}

/** Pins the code and the record: hashes of the receipts, the evidence and every file the run used. */
function writeSeal(path: string, files: string[]): void {
  let head = 'unknown';
  try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim(); } catch { /* not a git checkout */ }
  const sealed: Record<string, string> = {};
  for (const file of files) sealed[relative(ROOT, file)] = sha256(readFileSync(file));
  writeFileSync(path, JSON.stringify({ sealedAt: new Date().toISOString(), head, files: sealed }, null, 2));
}

async function main(): Promise<number> {
  const command = process.argv[2];
  const claudeRoot = join(homedir(), '.claude');
  const projectsRoot = option('projects', join(claudeRoot, 'projects'));
  const target = Number(option('target-tokens', String(RECALL_TARGET_TOKENS)));

  if (command === 'candidates') {
    const all = listCandidates(projectsRoot, target);
    const usable = all.filter(i => i.priorBoundaries === 0 && i.humanPrompts >= MIN_PROMPTS);
    console.log(`Coverage: ${all.length} transcripts have a clean cut near ${target / 1000}K; ${usable.length} usable (no earlier compaction, ${MIN_PROMPTS}+ typed prompts), ${new Set(usable.map(i => i.fingerprint)).size} distinct conversations.`);
    console.table(selectDiverse(all, 10).map(({ file: _file, ...rest }) => rest));
    return 0;
  }

  if (command === 'evaluate' || command === 'write-evidence') {
    const evidence = JSON.parse(readFileSync(option('in', ''), 'utf8')) as RecallEvidence;
    report(evidence);
    if (command === 'evaluate') return 0;
    if (!evaluateRecallEvidence(evidence, new Date()).eligible) { console.log('Not written: only evidence that passes the rule can be recorded.'); return 2; }
    writeFileSync(option('to', DEFAULT_EVIDENCE_MODULE), renderEvidenceModule(evidence));
    console.log('Evidence module written (counts and sizes only).');
    return 0;
  }

  if (command !== 'run') { console.log('Usage: recall-replay.ts candidates | run | evaluate | write-evidence (see the header of this file)'); return 1; }

  const login = await readKeychainLogin();
  if (!login) { console.log('Cannot read the stored Claude login. Nothing was run.'); return 1; }
  const minutes = loginMinutesLeft(login, Date.now());
  if (minutes < MIN_LOGIN_MINUTES) {
    console.log(`The stored login has only ${minutes} minutes left. A normal (non-sandboxed) terminal must refresh it first: run  claude -p "ok"  there, then re-run.`);
    return 1;
  }

  const wanted = values('chat');
  const all = listCandidates(projectsRoot, target);
  const picks = wanted.length > 0 ? all.filter(item => wanted.includes(item.key)) : selectDiverse(all, Number(option('count', '3')));
  console.log(`Coverage: ${all.length} candidate transcripts; running ${picks.length} (${picks.map(item => item.key).join(', ')}); login valid for ${minutes} more minutes.`);
  if (picks.length === 0) return 1;

  const receiptsDir = option('receipts', join(ROOT, '_scratch/oct2-phaseD-round2'));
  mkdirSync(receiptsDir, { recursive: true });
  return withRecallSandbox({
    projectsRoot,
    sourceSessionIds: picks.map(pick => pick.file.split('/').pop()!.replace(/\.jsonl$/, '')),
    removeForkArtifacts: ids => removeForkArtifacts(claudeRoot, ids),
    onCleanup: cleaned => {
      writeFileSync(join(receiptsDir, 'recall-cleanup-receipt.json'), JSON.stringify({ at: new Date().toISOString(), ...cleaned }, null, 2));
      console.log(`Cleanup: removed ${cleaned.removedFiles} transcript files from the throwaway project folder, ${cleaned.forkArtifactsRemoved} fork state entries${cleaned.refused ? `; retained: ${cleaned.refused}` : ''}.`);
    },
  }, async ({ sandboxCwd, claim, recordFork, retainForUnretiredProcess }) => {
    const startedAt = Date.now();
    const ledger = new SpendLedger(Number(option('total-budget', '8')));
    const calls: CallReceipt[] = [];
    const claudePath = process.env['CLAUDE_BIN'] ?? join(homedir(), '.local', 'bin', 'claude');
    let claudeVersion = 'unknown';
    try {
      claudeVersion = execFileSync(claudePath, ['--version'], {
        env: { PATH: process.env['PATH'] ?? '' }, timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 1 << 20,
      }).toString().trim();
    } catch { /* recorded as unknown */ }
    const deps: PipelineDeps = {
      runner: recordingRunner(makeRecallRunner(claudePath, buildChildEnv(process.env, login)), calls),
      sandboxCwd, projectsRoot, claim, model: option('model', 'sonnet[1m]'), helperModel: option('helper-model', 'sonnet'),
      ledger, perCallCapUsd: Number(option('per-call', '2.5')), targetTokens: target, minPrompts: MIN_PROMPTS,
      onForkSession: id => { recordFork(id); if (!forkIds.includes(id)) forkIds.push(id); },
      ...(option('compact-instructions', '') ? { compactInstructions: option('compact-instructions', '') } : {}),
      log: message => console.log(`  ${message}`), now: () => new Date(),
    };
    const results: RecallChatResult[] = [];
    const sources: Array<{ chatKey: string; conversationKey: string; bytes: number; sha256Before: string; sha256After: string | null; unchanged: boolean | null; carriedCostUsd?: number }> = [];
    const skipped: Array<{ chatKey: string; reason: string }> = [];
    let modelSeen: string | null = null;
    const forkIds: string[] = [];
    let exitCode = 0;
    try {
      for (const pick of picks) {
        console.log(`\nchat ${pick.key}`);
        const before = readFileSync(pick.file);
        const record: (typeof sources)[number] = { chatKey: pick.key, conversationKey: pick.fingerprint, bytes: before.length, sha256Before: sha256(before), sha256After: null, unchanged: null };
        sources.push(record);
        const prepared = await prepareChat(deps, { lines: before.toString('utf8').split('\n'), sessionId: pick.file.split('/').pop()!.replace(/\.jsonl$/, ''), chatKey: pick.key });
        if (prepared.kind === 'skipped') { skipped.push({ chatKey: pick.key, reason: prepared.reason }); console.log(`  skipped: ${prepared.reason}`); continue; }
        record.carriedCostUsd = +prepared.seedCostUsd.toFixed(4);
        console.log(`  ready: cut at ${Math.round(prepared.cut.contextTokens / 1000)}K, ${prepared.cut.humanPrompts} typed prompts, ${prepared.questions.length} questions`);
        if (flag('prepare-only')) continue;
        const { model, forkSessionIds, ...result } = await runChat(deps, prepared);
        modelSeen ??= model;
        for (const id of forkSessionIds) { recordFork(id); if (!forkIds.includes(id)) forkIds.push(id); }
        results.push(result);
        console.log(row(result));
      }
    } catch (error) {
      if (error instanceof RecallProcessNotRetiredError) retainForUnretiredProcess();
      console.log(`\nStopped: ${(error as Error).message}`);
      exitCode = 1;
    }

    // The originals must be byte-for-byte what they were: this run only ever read them.
    for (const pick of picks) {
      const record = sources.find(item => item.chatKey === pick.key);
      if (!record) continue;
      record.sha256After = sha256(readFileSync(pick.file));
      record.unchanged = record.sha256After === record.sha256Before;
    }
    if (sources.some(item => item.unchanged === false)) { console.log('A source transcript changed while the run was going; the result is not recorded.'); exitCode = 1; }

    // Receipts and seal are written BEFORE anything generated is deleted.
    const evidence = results.length > 0 && !flag('prepare-only') && exitCode === 0 ? buildRecallEvidence(results, modelSeen ?? deps.model, target, new Date(), deps.compactInstructions ? 'cli-replay-custom-compact' : 'cli-replay') : null;
    const evidencePath = option('out', join(receiptsDir, 'recall-evidence.json'));
    if (evidence) writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    const outside = touchedState(claudeRoot, startedAt);
    const receiptPath = join(receiptsDir, 'recall-run-receipt.json');
    writeFileSync(receiptPath, JSON.stringify({
      startedAt: new Date(startedAt).toISOString(), endedAt: new Date().toISOString(), claudeVersion, model: deps.model, helperModel: deps.helperModel, targetTokens: target,
      budgetUsd: ledger.limitUsd, spentUsd: +ledger.spent.toFixed(4), minPrompts: MIN_PROMPTS, sources, skipped, calls, forkSessions: forkIds.length, claudeStateModifiedDuringRunNotAttributable: outside,
      evidenceWritten: evidence !== null, exitCode,
    }, null, 2));
    const sealPath = join(receiptsDir, 'recall-run-seal.json');
    const libraryDir = join(ROOT, 'src/main/context/recall-replay');
    writeSeal(sealPath, [receiptPath, ...(evidence ? [evidencePath] : []), join(ROOT, 'scripts/audit/recall-replay.ts'),
      ...readdirSync(libraryDir).filter(name => name.endsWith('.ts') && !name.endsWith('.spec.ts')).map(name => join(libraryDir, name))]);

    console.log(`\nReceipts and seal written. Claude state folders modified during the run (includes other live sessions; not attributable to this run): ${outside.length === 0 ? 'none' : outside.join(', ')}.`);
    console.log(`Sources unchanged: ${sources.every(item => item.unchanged !== false)}. Calls: ${calls.length}. Total spend $${ledger.spent.toFixed(2)} of $${ledger.limitUsd.toFixed(2)}.`);

    if (evidence) {
      report(evidence);
      console.log(`Evidence (counts only) saved to ${relative(ROOT, evidencePath)}`);
    }
    return exitCode;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }, error => { console.error(`recall-replay failed: ${(error as Error).message}`); process.exitCode = 1; });
}
