/**
 * Loop Completion Detector
 *
 * Implements `plan_loop_mode.md` § B (Robust break-out detection).
 *
 * Six signals are observed; output-only claims do not stop the loop on their
 * own. When any durable sufficient signal fires, the coordinator runs the
 * configured verify command. Only when verify passes (twice, by default, to
 * guard against flakes) does the loop actually stop.
 *
 * Signals:
 *   1. completed-rename — `*_Completed.md` rename observed (watcher state)
 *   2. done-promise     — `<promise>DONE</promise>` in iteration output
 *                          (acknowledgement only; never sufficient alone)
 *   3. done-sentinel    — `DONE.txt` exists in workspace at iteration end
 *   4. all-green        — verify passes after previously-failing iteration
 *   5. self-declared    — output literal "TASK COMPLETE" / "DONE" — auxiliary
 *                          only; never sufficient alone (per spec).
 *   6. plan-checklist   — PLAN.md checkbox completion ratio = 1.0
 */

import { spawn } from 'child_process';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as fs from 'fs';
import { setTimeout as rawSetTimeout } from 'node:timers';
import { watch, type FSWatcher } from 'chokidar';
import { getLogger } from '../logging/logger';
import { parsePlanChecklist, LOOP_TASKS_FILE, INVESTIGATION_REPORT_FILE } from './loop-stage-machine';
import {
  findSelfAssignedCaveat,
  findTargetedVerifyMasqueradeWithExecution,
  type ObservedVerificationCommand,
} from './loop-anti-self-grading';
import { parseTaskLedger } from './loop-task-ledger';
import { resolveLoopArtifactPaths, loopStateFile } from './loop-artifact-paths';
import { readUtf8FileHead } from './bounded-file-read';
import { isInsideOrEqual } from '../util/path-helpers';
import {
  completedPlanFileCandidates,
  isCompletedRenameForPlan,
  pathExists,
  resolveActualPathCase,
} from './loop-completed-plan-helpers';
import {
  hasTerminalSentinelLine,
  matchesTerminalOutputPattern,
} from './loop-terminal-sentinels';
import type {
  CompletionSignalEvidence,
  LoopConfig,
  LoopIteration,
  LoopState,
} from '../../shared/types/loop.types';

const logger = getLogger('LoopCompletionDetector');

/**
 * Build the spawn invocation for a verify command.
 *
 * The loop coordinator usually runs inside a GUI/launchd-launched Electron
 * process whose PATH is the minimal macOS default `/usr/bin:/bin:/usr/sbin:/sbin`
 * — it does NOT include nvm / homebrew / volta node locations. A bare
 * `spawn(cmd, { shell: true })` therefore fails the verify gate with
 * `npm: command not found` even though the user's terminal runs the exact same
 * command fine.
 *
 * Running through a *login* shell (`-lc`) sources the user's profile
 * (`.zprofile` / `.profile` / `/etc/paths`), restoring the same PATH the command
 * would see in their terminal. We deliberately use login but NOT interactive
 * (`-i`) mode: interactive shells emit prompt / shell-integration escape
 * sequences into the captured verify output and can hang when there is no TTY.
 *
 * Windows GUI launches inherit a usable PATH, so there we keep the original
 * `shell: true` behavior.
 *
 * Pure + exported for unit testing.
 */
export function buildVerifyInvocation(
  cmd: string,
  platform: NodeJS.Platform = process.platform,
  shellPath: string | undefined = process.env['SHELL'],
): { file: string; args: string[]; useShellOption: boolean } {
  if (platform === 'win32') {
    return { file: cmd, args: [], useShellOption: true };
  }
  const shell = shellPath && shellPath.trim() ? shellPath.trim() : '/bin/bash';
  return { file: shell, args: ['-lc', cmd], useShellOption: false };
}

/**
 * Watches a workspace for `*_Completed.md` files. Fires `onCompleted` only on
 * NEW appearances during the run — chokidar's `ignoreInitial: true` ensures
 * pre-existing matches are not reported. This is intentional: many workspaces
 * accumulate stale `*_completed.md` plan files over time, and counting them
 * as "the agent finished this run" is a false positive that has terminated
 * loops on iteration 0 with zero tokens spent. `scanOnce()` is retained for
 * observability logging only — the coordinator uses it to log "FYI a stale
 * file is present" without seeding completion state.
 *
 * The watcher is idempotent — `start()` returns the existing watcher if
 * already running. Designed to be owned by the LoopCoordinator for the
 * duration of a single LoopState.
 */
export class CompletedFileWatcher {
  private watcher: FSWatcher | null = null;
  private observed = false;
  private listeners = new Set<(filePath: string) => void>();
  /** Listeners notified when every previously-observed completed file is gone. */
  private undoneListeners = new Set<(filePath: string) => void>();
  /** Absolute paths of completed files we've seen during the current run. */
  private observedPaths = new Set<string>();
  private scanTimer: NodeJS.Timeout | null = null;

  constructor(
    public readonly workspaceCwd: string,
    public readonly pattern = '*_[Cc]ompleted.md',
    private readonly additionalWatchDirs: string[] = [],
  ) {}

  isObserved(): boolean {
    return this.observed;
  }

  onCompleted(listener: (filePath: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Subscribe to "completed file was undone" notifications. Fires when the
   * last completed-pattern file we'd observed during the run disappears
   * (rename reverted, file deleted). Allows the coordinator to clear the
   * rename observation so the rename gate is re-evaluated on the next
   * completion attempt — without this, an operator who reverts a premature
   * `_completed.md` rename couldn't reset the loop's belief that completion
   * happened.
   */
  onUndone(listener: (filePath: string) => void): () => void {
    this.undoneListeners.add(listener);
    return () => this.undoneListeners.delete(listener);
  }

  /** Scan once for an existing match (e.g. immediately after restart). */
  scanOnce(): string | null {
    return this.scanMatches()[0] ?? null;
  }

  start(): void {
    if (this.watcher) return;
    const re = this.globToRegex(this.pattern);
    const initialMatches = new Set(this.scanMatches());
    // Vitest loads zone.js for the main project. Under that + macOS FSEvents
    // pressure, chokidar's native close() can stall long enough to trip
    // afterEach/hookTimeout during pre-push. Polling keeps rename detection
    // correct in tests without pinning the kernel watcher.
    const usePolling = process.env['VITEST'] === 'true'
      || process.env['AIO_LOOP_WATCH_POLLING'] === '1';
    this.watcher = watch(this.watchTargets(), {
      depth: 0,
      ignoreInitial: true,
      usePolling,
      ...(usePolling
        ? { interval: 50, binaryInterval: 100 }
        : { awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 } }),
    });
    const fire = (filePath: string) => {
      const base = path.basename(filePath);
      if (!re.test(base)) return;
      if (this.observedPaths.has(filePath)) return;
      this.observed = true;
      this.observedPaths.add(filePath);
      for (const l of this.listeners) {
        try { l(filePath); } catch (err) { logger.warn('CompletedFileWatcher listener threw', { error: String(err) }); }
      }
    };
    const pruneInitialMatches = () => {
      for (const filePath of [...initialMatches]) {
        if (!fs.existsSync(filePath)) initialMatches.delete(filePath);
      }
    };
    const recordCurrentInRunMatches = () => {
      pruneInitialMatches();
      for (const currentPath of this.scanMatches()) {
        if (!initialMatches.has(currentPath)) fire(currentPath);
      }
    };
    const hasObservedPathOnDisk = () =>
      [...this.observedPaths].some((observedPath) => fs.existsSync(observedPath));
    const fireUndone = (filePath: string) => {
      const base = path.basename(filePath);
      if (!re.test(base)) return;
      // Only meaningful if we'd previously observed this completion. A bare
      // `unlink` event on a file we never saw doesn't represent an undo.
      if (!this.observedPaths.delete(filePath)) return;
      // Re-scan synchronously so we don't fire on transient mid-rename states.
      // Only in-run matches count here: stale files present before start()
      // must not mask deletion of the last completion observed during this run.
      recordCurrentInRunMatches();
      if (hasObservedPathOnDisk()) return;
      this.observed = false;
      for (const l of this.undoneListeners) {
        try { l(filePath); } catch (err) { logger.warn('CompletedFileWatcher undone-listener threw', { error: String(err) }); }
      }
    };
    // Listen to `add` for completion observation. A `mv X.md X_Completed.md`
    // rename is reported by chokidar as `unlink('X.md')` + `add('X_Completed.md')`,
    // so renames are covered. We deliberately do NOT listen to `change`:
    // editing a pre-existing `*_Completed.md` (e.g. appending a "what we did"
    // note) would otherwise trip completion on the edit, not on a rename.
    //
    // Listen to `unlink` to detect undo: if the operator reverts the rename
    // (or deletes the completed file), the watcher must clear observation
    // so the gate is re-evaluated. fireUndone re-scans before firing so a
    // simple in-place rename (`mv a_completed.md b_completed.md`) doesn't
    // cause a spurious undo notification.
    this.watcher.on('add', fire);
    // Keep a lightweight scan fallback active while the watcher is running.
    // Chokidar can miss or delay add events around ready/recursive-watch setup,
    // especially for additional nested watch roots. The initial snapshot keeps
    // stale completed files ignored while still catching files created later.
    this.scanTimer = setInterval(() => {
      recordCurrentInRunMatches();
      for (const filePath of [...this.observedPaths]) {
        if (!fs.existsSync(filePath)) fireUndone(filePath);
      }
    }, 250);
    if (typeof this.scanTimer.unref === 'function') {
      this.scanTimer.unref();
    }
    this.watcher.on('ready', () => {
      recordCurrentInRunMatches();
    });
    this.watcher.on('unlink', fireUndone);
  }

  async stop(timeoutMs = 2_000): Promise<void> {
    if (!this.watcher) return;
    this.clearScanTimer();
    const watcher = this.watcher;
    this.watcher = null;
    this.listeners.clear();
    this.undoneListeners.clear();
    this.observedPaths.clear();
    // Chokidar close() can stall under FSEvents pressure (large worktrees /
    // Spotlight storms). Bound the wait so cancel/test teardown can't hang
    // the process indefinitely waiting on the kernel watcher. Use the raw
    // Node timer — zone.js patches global setTimeout in the main Vitest
    // project and has been observed to delay/starve the race under load.
    try {
      watcher.removeAllListeners();
      await Promise.race([
        watcher.close().catch(() => undefined),
        new Promise<void>((resolve) => {
          const timer = rawSetTimeout(resolve, Math.max(1, timeoutMs));
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
    } catch {
      /* noop */
    }
  }

  private globToRegex(glob: string): RegExp {
    // Minimal glob support: *, ?, character classes [abc] / [a-z]. Sufficient
    // for the documented patterns ("*_[Cc]ompleted.md").
    let re = '^';
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === '*') re += '[^/]*';
      else if (c === '?') re += '.';
      else if (c === '[') {
        let j = i + 1;
        while (j < glob.length && glob[j] !== ']') j++;
        re += '[' + glob.slice(i + 1, j) + ']';
        i = j;
      } else if ('.+^$()|\\{}'.includes(c)) re += '\\' + c;
      else re += c;
    }
    re += '$';
    return new RegExp(re);
  }

  private watchTargets(): string[] {
    const workspace = path.resolve(this.workspaceCwd);
    const targets = new Set<string>([workspace]);
    for (const dir of this.additionalWatchDirs) {
      const resolved = path.isAbsolute(dir)
        ? path.resolve(dir)
        : path.resolve(workspace, dir);
      if (!isInsideOrEqual(workspace, resolved)) continue;
      try {
        if (fs.statSync(resolved).isDirectory()) targets.add(resolved);
      } catch {
        // Missing plan directories are harmless; the detector also has an
        // end-of-iteration filesystem fallback for configured plan files.
      }
    }
    return [...targets];
  }

  private scanMatches(): string[] {
    const re = this.globToRegex(this.pattern);
    const matches: string[] = [];
    for (const dir of this.watchTargets()) {
      try {
        for (const entry of fs.readdirSync(dir)) {
          if (re.test(entry)) matches.push(path.join(dir, entry));
        }
      } catch (err) {
        if (err && typeof err === 'object' && 'code' in err) {
          const code = String((err as NodeJS.ErrnoException).code);
          if (code === 'ENOENT' || code === 'ENOTDIR') continue;
        }
        logger.warn('CompletedFileWatcher.scanMatches failed', {
          dir,
          error: String(err),
        });
      }
    }
    return matches;
  }

  private clearScanTimer(): void {
    if (!this.scanTimer) return;
    clearInterval(this.scanTimer);
    this.scanTimer = null;
  }
}

export interface CompletionObservationInput {
  iteration: LoopIteration;
  config: LoopConfig;
  state: LoopState;
  /** Durable commands AIO observed before this completion claim. Undefined
   * means ledger storage was unavailable; an empty array means no command was
   * observed, so anti-self-grading falls back to claimed evidence. */
  verificationRuns?: readonly ObservedVerificationCommand[];
}

export type VerifyFailureKind = 'command' | 'timeout' | 'infra';

export type VerifyOutcome =
  | { status: 'passed'; output: string; durationMs: number }
  | { status: 'skipped'; output: string; durationMs: number }
  | {
      status: 'failed';
      output: string;
      durationMs: number;
      exitCode: number | null;
      failureKind: VerifyFailureKind;
    };

/** Minimum trimmed length for an investigation REPORT.md to count as substantive. */
const MIN_INVESTIGATION_REPORT_CHARS = 200;

/** Matches a `path/to/file.ext:line` style citation (extension + colon + line). */
const FILE_LINE_CITATION_RE = /[A-Za-z0-9_./-]+\.[A-Za-z][A-Za-z0-9]{0,9}:\d+/;

/**
 * An investigation/audit loop's REPORT.md is "substantive" only when it exists,
 * has real content (not just a stub/heading), AND cites at least one
 * `file.ext:line` location — the prompt requires every claim to be backed by
 * concrete code evidence, so a report with zero citations is an unverified
 * narrative, not the answer the loop was asked to produce. Pure + exported so
 * the gate logic is unit-testable without the filesystem.
 */
export function isSubstantiveInvestigationReport(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length < MIN_INVESTIGATION_REPORT_CHARS) return false;
  return FILE_LINE_CITATION_RE.test(trimmed);
}

/**
 * D5: the sentinel an agent emits to self-declare that work remains even when a
 * forensic completion signal (a sub-task `*_Completed.md` rename, a stray
 * DONE.txt, a fully-checked plan file) would otherwise fire. It ONLY ever forces
 * the loop to CONTINUE — never toward a false stop — so a false positive costs at
 * most one extra iteration (bounded by the hard caps). Less spoofable than the
 * coordinator re-deriving doneness, because the executor that just did the work
 * is the authority on whether it is finished.
 */
export const MORE_WORK_REMAINING_SENTINEL = '[[LOOP:MORE_WORK_REMAINING]]';

export { matchesTerminalOutputPattern } from './loop-terminal-sentinels';

/** Pure + exported for testing. True iff the agent declared more work remains. */
export function parseAgentMoreWorkRemaining(output: string): boolean {
  return hasTerminalSentinelLine(output, MORE_WORK_REMAINING_SENTINEL);
}

export class LoopCompletionDetector {
  /**
   * Inspect the just-completed iteration + workspace and return any
   * completion signals that fired. Pure (modulo file-existence checks).
   */
  async observe(input: CompletionObservationInput): Promise<CompletionSignalEvidence[]> {
    const { iteration, config, state } = input;
    const out: CompletionSignalEvidence[] = [];
    // Loop-owned state files (DONE sentinel, LOOP_TASKS.md) live in this run's
    // per-run dir, not the workspace root — keyed by the run id so concurrent
    // loops in the same workspace never read each other's completion state.
    const artifactPaths = resolveLoopArtifactPaths(config.workspaceCwd, state.id);

    if (state.terminalIntentPending?.kind === 'complete' && state.terminalIntentPending.status === 'pending') {
      // D6 (#7): with anti-self-grading on, a complete claim is demoted to
      // insufficient when its own summary admits a PARTIAL/caveated verdict
      // (3b), or when its evidence cites only a *targeted* narrowing of the
      // configured verify command (part 2) — the agent does not grade its own
      // work; only verify / fresh-eyes do.
      const intent = state.terminalIntentPending;
      let demotionReason: string | null = null;
      if (config.completion.antiSelfGrading) {
        const caveat = findSelfAssignedCaveat(intent.summary);
        if (caveat !== null) {
          demotionReason = `self-assigns a partial/caveated verdict ("${caveat}")`;
        } else {
          const masquerade = findTargetedVerifyMasqueradeWithExecution(
            intent.evidence,
            config.completion.verifyCommand,
            input.verificationRuns,
          );
          if (masquerade !== null) {
            demotionReason = masquerade.source === 'observed'
              ? `has an observed targeted verification run ("${masquerade.command}") — a narrowed subset of the ` +
                `configured verify command (\`${config.completion.verifyCommand}\`) cannot stand in for the full suite`
              : `cites only a targeted verification run ("${masquerade.command}") — an unobserved claimed verification run ` +
                `cannot stand in for the full configured verify command (\`${config.completion.verifyCommand}\`)`;
          }
        }
      }
      out.push(
        demotionReason !== null
          ? {
              id: 'declared-complete',
              sufficient: false,
              detail:
                `Loop-control complete intent ${demotionReason} — ` +
                'only the verify flow / fresh-eyes gate issues completion verdicts, so this claim cannot ' +
                `stop the loop. Finish the work (or defer ledger items with a reason) and declare again. ` +
                `Summary: ${intent.summary}`,
            }
          : {
              id: 'declared-complete',
              sufficient: true,
              detail: `Loop-control complete intent: ${intent.summary}`,
            },
      );
    }

    // Textual/sentinel/checklist completion signals are only actionable when
    // the agent is actually in IMPLEMENT. A durable completed-plan rename is
    // stronger than the stage hint, though: if the configured plan file was
    // renamed and verification passes, an unnecessary follow-up iteration can
    // only turn a valid completion into a spurious provider error.
    const isImplement = iteration.stage === 'IMPLEMENT';

    // 1. *_Completed.md rename — owned by the watcher, recorded in state.
    const completedPlanFallback = state.completedFileRenameObserved
      ? null
      : await this.detectConfiguredPlanCompletedRename(config, state);
    if (completedPlanFallback) {
      state.completedFileRenameObserved = true;
    }
    if (state.completedFileRenameObserved) {
      out.push({
        id: 'completed-rename',
        sufficient: true,
        detail: completedPlanFallback
          ? `Configured plan file was renamed during the loop: ${completedPlanFallback}`
          : 'A *_Completed.md rename was observed during the loop',
      });
    }

    // 2. done-promise marker.
    //
    // This is deliberately NOT sufficient by itself. It is just text emitted
    // by the child process; accepting it as terminal means a single optimistic
    // final answer can end the loop with no durable workspace evidence. The
    // agent prompt requires a durable marker as well (DONE.txt, plan checklist,
    // or completed-plan rename), and those signals are what can stop the loop.
    try {
      const output = iteration.outputFull || iteration.outputExcerpt;
      if (matchesTerminalOutputPattern(output, config.completion.donePromiseRegex, 'i')) {
        out.push({
          id: 'done-promise',
          sufficient: false,
          detail: isImplement
            ? 'Output contained <promise>DONE</promise>; waiting for durable completion evidence'
            : 'Output contained <promise>DONE</promise>, but stage is not IMPLEMENT — ignoring',
        });
      }
    } catch (e) {
      logger.warn('done-promise regex invalid; skipping', { regex: config.completion.donePromiseRegex, error: String(e) });
    }

    // 3. DONE sentinel.
    //
    // Staleness guard: if the sentinel was already present at startLoop, it's
    // a leftover from a prior run, not evidence the agent finished this run.
    // The coordinator captured `state.doneSentinelPresentAtStart` once at
    // boot — we only fire when the sentinel is currently present AND was
    // absent at start. (Edits to a pre-existing sentinel mid-run are
    // intentionally not treated as evidence; the agent should delete and
    // re-create it if they really mean a fresh signal.)
    if (config.completion.doneSentinelFile && !state.doneSentinelPresentAtStart) {
      const sentinel = loopStateFile(artifactPaths, config.completion.doneSentinelFile);
      try {
        await fsp.access(sentinel);
        out.push({
          id: 'done-sentinel',
          sufficient: isImplement,
          detail: isImplement
            ? `Sentinel file created during run: ${config.completion.doneSentinelFile}`
            : `Sentinel file created during run: ${config.completion.doneSentinelFile}, but stage is not IMPLEMENT — ignoring`,
        });
      } catch {
        // not present — fine
      }
    }

    // 5. self-declared (auxiliary, never sufficient)
    if (/\bTASK COMPLETE\b|\bDONE\b/i.test(iteration.outputExcerpt)) {
      out.push({
        id: 'self-declared',
        sufficient: false,
        detail: 'Output mentions TASK COMPLETE / DONE',
      });
    }

    // 6. plan-checklist 100%.
    //
    // Staleness guard: if the planFile was already fully ticked at startLoop
    // (e.g. someone committed a "done" plan and started a new loop on top
    // of it), that's not evidence the agent finished this run. We only fire
    // when the checklist transitions from "had unchecked items" → "fully
    // checked" during the run. `state.planChecklistFullyCheckedAtStart` is
    // captured once by `LoopStageMachine.captureStartupSnapshot` at boot;
    // we use the same `parsePlanChecklist` function here so the runtime
    // measurement matches the baseline measurement exactly.
    if (config.planFile && !state.planChecklistFullyCheckedAtStart) {
      const planPath = path.resolve(config.workspaceCwd, config.planFile);
      try {
        const text = (await readUtf8FileHead(planPath)).text;
        const { checked, fullyChecked } = parsePlanChecklist(text);
        if (fullyChecked) {
          out.push({
            id: 'plan-checklist',
            sufficient: isImplement,
            detail: isImplement
              ? `All ${checked} checklist items in ${config.planFile} were checked during this run`
              : `All ${checked} checklist items in ${config.planFile} were checked during this run, but stage is not IMPLEMENT — ignoring`,
          });
        }
      } catch {
        // plan file missing or unreadable — fine
      }
    }

    // 7. LF-4: structured task ledger (LOOP_TASKS.md) — the per-item source of
    //    truth for stopping. When the ledger has items it is the AUTHORITY:
    //    while any item is open (todo/doing) NO completion signal is sufficient
    //    (a premature DONE.txt / declared-complete can't stop a half-done run);
    //    once every item is done/deferred, `ledger-complete` is the stop signal
    //    (subject to verify-before-stop). A pre-resolved ledger from a prior run
    //    is ignored (staleness guard), and an empty ledger (no items) is a no-op.
    try {
      const ledgerText = (await readUtf8FileHead(artifactPaths.tasks)).text;
      const ledger = parseTaskLedger(ledgerText);
      if (ledger.total > 0) {
        if (ledger.complete) {
          if (!state.loopTasksLedgerResolvedAtStart) {
            out.push({
              id: 'ledger-complete',
              sufficient: isImplement,
              openCount: 0,
              detail: isImplement
                ? `All ${ledger.total} ${LOOP_TASKS_FILE} items resolved (done/deferred) during this run`
                : `All ${ledger.total} ${LOOP_TASKS_FILE} items resolved, but stage is not IMPLEMENT — ignoring`,
            });
          }
        } else {
          // Open items remain → the ledger blocks completion. Demote every
          // other signal so the loop keeps working the ledger, and record why.
          const open = ledger.total - ledger.resolved;
          for (const evidence of out) evidence.sufficient = false;
          out.push({
            id: 'ledger-complete',
            sufficient: false,
            openCount: open,
            detail: `${LOOP_TASKS_FILE} has ${open} open item(s)` +
              (ledger.nextTodo ? ` — next: ${ledger.nextTodo}` : '') +
              ' — completion blocked until every item is done or deferred (with a reason)',
          });
        }
      }
    } catch {
      // No LOOP_TASKS.md (or unreadable) — ledger inactive, no effect.
    }

    // Investigation/audit gate: a loop whose goal is a question/audit must
    // produce a substantive, file:line-cited REPORT.md before ANY completion
    // signal is accepted. Without this, an investigation loop could "complete"
    // on a bare DONE.txt / declared-complete with no answer delivered — exactly
    // the silent-reframe failure the goalIntent split exists to prevent. No-op
    // for implementation loops (the common case).
    if (config.goalIntent === 'investigation') {
      const reportPath = loopStateFile(artifactPaths, INVESTIGATION_REPORT_FILE);
      let report = '';
      try {
        report = (await readUtf8FileHead(reportPath)).text;
      } catch {
        // Missing — treated as not-yet-substantive below.
      }
      if (!isSubstantiveInvestigationReport(report)) {
        const hadSufficient = out.some((e) => e.sufficient);
        for (const evidence of out) evidence.sufficient = false;
        out.push({
          id: 'self-declared',
          sufficient: false,
          detail:
            `Investigation goal: ${INVESTIGATION_REPORT_FILE} is missing or not yet a substantive, ` +
            `file:line-cited answer — completion is blocked until it is written` +
            (hadSufficient ? ' (a completion signal fired but was demoted)' : ''),
        });
      }
    }

    return out;
  }

  /**
   * Run the configured verify command. Returns passed/failed with output.
   * Times out per `config.completion.verifyTimeoutMs`.
   */
  async runVerify(config: LoopConfig): Promise<VerifyOutcome> {
    const cmd = (config.completion.verifyCommand || '').trim();
    if (!cmd) {
      // No command => the loop has NOT verified anything. Returning 'passed'
      // here would make the completion gate a rubber stamp: a self-declared
      // "done" would stop the loop with zero independent evidence. Report a
      // distinct 'skipped' so the coordinator refuses to stop on it.
      return { status: 'skipped', output: '(no verify command configured)', durationMs: 0 };
    }
    return this.spawnVerify(cmd, config.workspaceCwd, config.completion.verifyTimeoutMs, 'verify');
  }

  /**
   * FU-6: run an optional cheap pre-flight verify before the full
   * `verifyCommand`. Returns:
   *  - 'skipped' when no quickVerifyCommand is configured (callers should
   *    proceed directly to runVerify);
   *  - 'passed' when the cheap command exits zero;
   *  - 'failed' when the cheap command exits non-zero or times out.
   *
   * A failed quick-verify lets the coordinator reject completion without
   * spending the (typically minutes-long) full verify on a known-failing
   * change.
   */
  async runQuickVerify(config: LoopConfig): Promise<VerifyOutcome> {
    const cmd = (config.completion.quickVerifyCommand || '').trim();
    if (!cmd) {
      return { status: 'skipped', output: '(no quick verify command configured)', durationMs: 0 };
    }
    const timeout = config.completion.quickVerifyTimeoutMs ?? 120_000;
    return this.spawnVerify(cmd, config.workspaceCwd, timeout, 'quick-verify');
  }

  private spawnVerify(
    cmd: string,
    workspaceCwd: string,
    timeoutMs: number,
    label: 'verify' | 'quick-verify',
  ): Promise<VerifyOutcome> {
    const started = Date.now();
    return new Promise<VerifyOutcome>((resolve) => {
      const inv = buildVerifyInvocation(cmd);
      const child = spawn(inv.file, inv.args, {
        cwd: workspaceCwd,
        // On non-Windows we invoke the user's login shell directly (`-lc`), so
        // `shell` must stay off — `inv.file` already IS the shell. On Windows
        // `useShellOption` is true and we fall back to the prior `shell: true`.
        shell: inv.useShellOption,
        env: { ...process.env, CI: '1' },
      });
      let stdout = '';
      let stderr = '';
      const cap = (chunk: Buffer | string, target: 'stdout' | 'stderr') => {
        const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (target === 'stdout') {
          stdout += s;
          if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
        } else {
          stderr += s;
          if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
        }
      };
      child.stdout?.on('data', (b) => cap(b, 'stdout'));
      child.stderr?.on('data', (b) => cap(b, 'stderr'));

      const to = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* noop */ }
        resolve({
          status: 'failed',
          output: `${stdout}\n${stderr}\n(${label} timed out after ${timeoutMs}ms)`,
          durationMs: Date.now() - started,
          exitCode: null,
          failureKind: 'timeout',
        });
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(to);
        const output = `${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ''}`;
        if (code === 0) {
          resolve({ status: 'passed', output, durationMs: Date.now() - started });
        } else {
          resolve({
            status: 'failed',
            output,
            durationMs: Date.now() - started,
            exitCode: code,
            failureKind: 'command',
          });
        }
      });
      child.on('error', (err) => {
        clearTimeout(to);
        resolve({
          status: 'failed',
          output: `${label} command failed to spawn: ${err.message}`,
          durationMs: Date.now() - started,
          exitCode: null,
          failureKind: 'infra',
        });
      });
    });
  }

  /**
   * Look at fired signals and decide whether ANY are "sufficient" to trigger
   * verify-before-stop.
   */
  hasSufficientSignal(evidences: CompletionSignalEvidence[]): boolean {
    return evidences.some((e) => e.sufficient);
  }

  /**
   * Belt-and-braces gate. When completed-file enforcement is enabled,
   * completion isn't accepted until a *_Completed.md rename has actually
   * happened during this run. General continuation loops leave this off
   * because there may be no plan file to rename.
   */
  passesBeltAndBraces(state: LoopState, config: LoopConfig): boolean {
    if (!config.completion.requireCompletedFileRename) return true;
    return state.completedFileRenameObserved;
  }

  private async detectConfiguredPlanCompletedRename(
    config: LoopConfig,
    state: LoopState,
  ): Promise<string | null> {
    if (!config.planFile) return null;
    const workspace = path.resolve(config.workspaceCwd);
    const original = path.resolve(workspace, config.planFile);
    if (!isInsideOrEqual(workspace, original)) return null;
    if (await pathExists(original)) return null;

    for (const candidate of completedPlanFileCandidates(config)) {
      try {
        const stat = await fsp.stat(candidate);
        if (!stat.isFile()) continue;
        const newestFileTimestamp = Math.max(stat.birthtimeMs, stat.ctimeMs, stat.mtimeMs);
        // Guard against stale completed files that predate this loop. Rename
        // updates ctime even when mtime is preserved, so this still catches a
        // real in-run `mv old.md old_completed.md`.
        if (state.startedAt > 0 && newestFileTimestamp + 2_000 < state.startedAt) {
          continue;
        }
        const actualPath = await resolveActualPathCase(candidate);
        const relative = path.relative(workspace, actualPath) || path.basename(actualPath);
        return relative.replace(/\\/g, '/');
      } catch {
        // candidate absent — try the next casing
      }
    }
    return null;
  }
}


// Re-exported for existing import sites (loop-completion-watcher-runtime,
// loop-coordinator-utils, tests). Implementations live in loop-completed-plan-helpers.
export { completedPlanFileCandidates, isCompletedRenameForPlan };
