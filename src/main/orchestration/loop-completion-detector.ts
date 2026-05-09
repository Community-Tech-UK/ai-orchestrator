/**
 * Loop Completion Detector
 *
 * Implements `plan_loop_mode.md` § B (Robust break-out detection).
 *
 * Six signals are observed; **none of them stops the loop on their own**.
 * When any sufficient signal fires, the coordinator runs the configured
 * verify command. Only when verify passes (twice, by default, to guard
 * against flakes) does the loop actually stop.
 *
 * Signals:
 *   1. completed-rename — `*_Completed.md` rename observed (watcher state)
 *   2. done-promise     — `<promise>DONE</promise>` in iteration output
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
import { watch, type FSWatcher } from 'chokidar';
import { getLogger } from '../logging/logger';
import { parsePlanChecklist } from './loop-stage-machine';
import type {
  CompletionSignalEvidence,
  LoopConfig,
  LoopIteration,
  LoopState,
} from '../../shared/types/loop.types';

const logger = getLogger('LoopCompletionDetector');

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

  constructor(
    public readonly workspaceCwd: string,
    public readonly pattern = '*_[Cc]ompleted.md',
  ) {}

  isObserved(): boolean {
    return this.observed;
  }

  onCompleted(listener: (filePath: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Scan once for an existing match (e.g. immediately after restart). */
  scanOnce(): string | null {
    try {
      const entries = fs.readdirSync(this.workspaceCwd);
      const re = this.globToRegex(this.pattern);
      for (const e of entries) {
        if (re.test(e)) return path.join(this.workspaceCwd, e);
      }
    } catch (err) {
      logger.warn('CompletedFileWatcher.scanOnce failed', { error: String(err) });
    }
    return null;
  }

  start(): void {
    if (this.watcher) return;
    const re = this.globToRegex(this.pattern);
    this.watcher = watch(this.workspaceCwd, {
      depth: 0,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
    });
    const fire = (filePath: string) => {
      const base = path.basename(filePath);
      if (!re.test(base)) return;
      this.observed = true;
      for (const l of this.listeners) {
        try { l(filePath); } catch (err) { logger.warn('CompletedFileWatcher listener threw', { error: String(err) }); }
      }
    };
    // Listen to `add` only. A `mv X.md X_Completed.md` rename is reported by
    // chokidar as `unlink('X.md')` + `add('X_Completed.md')`, so renames are
    // covered. We deliberately do NOT listen to `change`: editing a
    // pre-existing `*_Completed.md` (e.g. appending a "what we did" note)
    // would otherwise trip completion on the edit, not on a rename.
    this.watcher.on('add', fire);
  }

  async stop(): Promise<void> {
    if (!this.watcher) return;
    try { await this.watcher.close(); } catch { /* noop */ }
    this.watcher = null;
    this.listeners.clear();
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
}

export interface CompletionObservationInput {
  iteration: LoopIteration;
  config: LoopConfig;
  state: LoopState;
}

export type VerifyOutcome =
  | { status: 'passed'; output: string; durationMs: number }
  | { status: 'failed'; output: string; durationMs: number; exitCode: number | null };

export class LoopCompletionDetector {
  /**
   * Inspect the just-completed iteration + workspace and return any
   * completion signals that fired. Pure (modulo file-existence checks).
   */
  async observe(input: CompletionObservationInput): Promise<CompletionSignalEvidence[]> {
    const { iteration, config, state } = input;
    const out: CompletionSignalEvidence[] = [];

    // Completion signals are only actionable (sufficient to stop the loop)
    // when the agent is actually in the IMPLEMENT stage. In PLAN and REVIEW
    // stages, an agent emitting DONE has gone off-script — most commonly after
    // a context compaction mid-iteration. We still record the signals for
    // observability but mark them as insufficient so the loop continues.
    const isImplement = iteration.stage === 'IMPLEMENT';

    // 1. *_Completed.md rename — owned by the watcher, recorded in state.
    if (state.completedFileRenameObserved) {
      out.push({
        id: 'completed-rename',
        sufficient: isImplement,
        detail: isImplement
          ? 'A *_Completed.md rename was observed during the loop'
          : 'A *_Completed.md rename was observed, but stage is not IMPLEMENT — ignoring',
      });
    }

    // 2. done-promise marker
    try {
      const re = new RegExp(config.completion.donePromiseRegex, 'i');
      if (re.test(iteration.outputExcerpt)) {
        out.push({
          id: 'done-promise',
          sufficient: isImplement,
          detail: isImplement
            ? 'Output contained <promise>DONE</promise>'
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
      const sentinel = path.resolve(config.workspaceCwd, config.completion.doneSentinelFile);
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
        const text = await fsp.readFile(planPath, 'utf8');
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

    return out;
  }

  /**
   * Run the configured verify command. Returns passed/failed with output.
   * Times out per `config.completion.verifyTimeoutMs`.
   */
  async runVerify(config: LoopConfig): Promise<VerifyOutcome> {
    const cmd = (config.completion.verifyCommand || '').trim();
    if (!cmd) {
      return { status: 'passed', output: '(no verify command configured)', durationMs: 0 };
    }
    const started = Date.now();
    return new Promise<VerifyOutcome>((resolve) => {
      const child = spawn(cmd, [], {
        cwd: config.workspaceCwd,
        shell: true,
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
          output: `${stdout}\n${stderr}\n(timed out after ${config.completion.verifyTimeoutMs}ms)`,
          durationMs: Date.now() - started,
          exitCode: null,
        });
      }, config.completion.verifyTimeoutMs);

      child.on('close', (code) => {
        clearTimeout(to);
        const output = `${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ''}`;
        if (code === 0) {
          resolve({ status: 'passed', output, durationMs: Date.now() - started });
        } else {
          resolve({ status: 'failed', output, durationMs: Date.now() - started, exitCode: code });
        }
      });
      child.on('error', (err) => {
        clearTimeout(to);
        resolve({
          status: 'failed',
          output: `verify command failed to spawn: ${err.message}`,
          durationMs: Date.now() - started,
          exitCode: null,
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
   * Belt-and-braces gate. When the user explicitly enables completed-file
   * enforcement, completion isn't accepted until a *_Completed.md rename has
   * actually happened during this run. General continuation loops leave this
   * off because there may be no plan file to rename.
   */
  passesBeltAndBraces(state: LoopState, config: LoopConfig): boolean {
    if (!config.completion.requireCompletedFileRename) return true;
    return state.completedFileRenameObserved;
  }
}
