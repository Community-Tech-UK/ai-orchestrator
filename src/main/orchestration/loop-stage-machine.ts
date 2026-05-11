/**
 * Loop Stage Machine
 *
 * Owns the on-disk loop artifacts (STAGE.md, PLAN.md, NOTES.md,
 * ITERATION_LOG.md) and builds the per-iteration prompt. The agent reads
 * STAGE.md at the top of an iteration, does that stage's work, and
 * advances STAGE.md itself — the coordinator does NOT mutate STAGE.md
 * after bootstrap. This collapses the user's three-stage workflow
 * (PLAN/REVIEW/IMPLEMENT) into a single-loop state machine where the
 * agent owns its own progression.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { getLogger } from '../logging/logger';
import type { LoopConfig, LoopStage } from '../../shared/types/loop.types';

const logger = getLogger('LoopStageMachine');

const ARTIFACT_FILES = ['STAGE.md', 'NOTES.md', 'ITERATION_LOG.md'] as const;

const VALID_STAGES = new Set<LoopStage>(['PLAN', 'REVIEW', 'IMPLEMENT']);

/**
 * Parsed view of a markdown plan-file's checkbox state. Single source of
 * truth shared by `LoopStageMachine.captureStartupSnapshot` and
 * `LoopCompletionDetector.observe` so the baseline measurement matches the
 * runtime measurement bit-for-bit.
 */
export interface PlanChecklistState {
  /** `[x]` or `[X]` items. */
  checked: number;
  /** `[ ]` items. */
  unchecked: number;
  /** `checked + unchecked`. */
  total: number;
  /** True iff the file has at least one item and none are unchecked. */
  fullyChecked: boolean;
}

/**
 * Parse markdown checkboxes (`- [x]`, `- [ ]`, `* [X]`, etc.) out of a plan
 * file. Pure function — exposed as a static so the completion detector and
 * the coordinator's startup snapshot use *exactly* the same regex. If they
 * ever drifted, "did this transition during the run?" comparisons would
 * break silently.
 */
export function parsePlanChecklist(text: string): PlanChecklistState {
  const checked = (text.match(/^\s*[-*]\s*\[[xX]\]/gm) || []).length;
  const unchecked = (text.match(/^\s*[-*]\s*\[\s\]/gm) || []).length;
  const total = checked + unchecked;
  return { checked, unchecked, total, fullyChecked: total > 0 && unchecked === 0 };
}

/**
 * Workspace snapshot captured by `LoopStageMachine.captureStartupSnapshot`
 * and stored on `LoopState`. Each flag answers "was this artefact already in
 * its 'completed' shape before the agent did any work?" The detector ignores
 * completion signals when the corresponding flag is true so a stale
 * artefact from a prior run can't terminate the loop on iteration 0.
 */
export interface LoopStartupSnapshot {
  /** `config.completion.doneSentinelFile` existed when the snapshot ran. */
  doneSentinelPresent: boolean;
  /** `config.planFile` existed and every `[ ]/[x]` item was already ticked. */
  planChecklistFullyChecked: boolean;
  /**
   * Root-level `.md` files that look like uncompleted planning documents.
   * Excludes:
   *   - files already matching the completion pattern (`*_[Cc]ompleted.md`)
   *   - the well-known project doc denylist (README, CHANGELOG, LICENSE,
   *     AGENTS, CLAUDE, NOTES, STAGE, ITERATION_LOG, DESIGN, DEVELOPMENT, …)
   *
   * Used by the coordinator to auto-enable `requireCompletedFileRename`
   * belt-and-braces when the caller did not explicitly set it. The agent's
   * default prompt already instructs it to rename a fully-implemented plan
   * with `_completed` before stopping; this surface ensures the loop does
   * not accept a bare `DONE.txt` sentinel in workspaces where renames are
   * obviously expected.
   */
  uncompletedPlanFilesAtStart: string[];
}

/**
 * Root-level `.md` filenames that are **not** plan files. These are stable
 * project docs that we never expect the agent to rename to `_completed`.
 * Match is case-insensitive on the basename.
 */
const PROJECT_DOC_DENYLIST = new Set<string>([
  'readme.md',
  'changelog.md',
  'license.md',
  'agents.md',
  'claude.md',
  'design.md',
  'development.md',
  'architecture.md',
  'contributing.md',
  'code_of_conduct.md',
  'security.md',
  'support.md',
  'notes.md',
  'stage.md',
  'iteration_log.md',
  'todo.md',
  'roadmap.md',
]);

function looksLikeCompletedRename(basename: string): boolean {
  return /_[Cc]ompleted\.md$/.test(basename);
}

function isPlanLikeMarkdown(basename: string): boolean {
  if (!basename.toLowerCase().endsWith('.md')) return false;
  if (PROJECT_DOC_DENYLIST.has(basename.toLowerCase())) return false;
  if (looksLikeCompletedRename(basename)) return false;
  return true;
}

export class LoopStageMachine {
  constructor(public readonly cwd: string) {}

  /**
   * Bootstrap loop artifacts on disk. Idempotent — won't overwrite existing
   * files. Returns the resolved initial stage (whatever STAGE.md ends up
   * containing).
   */
  async bootstrap(config: LoopConfig): Promise<LoopStage> {
    const stagePath = path.join(this.cwd, 'STAGE.md');
    const notesPath = path.join(this.cwd, 'NOTES.md');
    const logPath = path.join(this.cwd, 'ITERATION_LOG.md');

    let resolvedStage: LoopStage = config.initialStage;
    try {
      const existing = (await fsp.readFile(stagePath, 'utf8')).trim();
      const parsed = this.parseStage(existing);
      if (parsed) resolvedStage = parsed;
      else await fsp.writeFile(stagePath, `${config.initialStage}\n`, 'utf8');
    } catch {
      await fsp.writeFile(stagePath, `${config.initialStage}\n`, 'utf8');
    }

    for (const fname of [notesPath, logPath]) {
      try { await fsp.access(fname); } catch {
        const banner = fname.endsWith('NOTES.md')
          ? '# Loop Notes\n\nRolling, compressed memory between iterations. The agent appends a short summary at the end of each iteration.\n\n'
          : '# Iteration Log\n\nFull per-iteration record (the coordinator may also append from main process).\n\n';
        await fsp.writeFile(fname, banner, 'utf8');
      }
    }

    // Delete sentinel file left by a prior loop run. A stale DONE.txt would
    // immediately fire the done-sentinel completion signal on the first
    // IMPLEMENT iteration of the new run, stopping the loop before it does
    // any work.
    if (config.completion.doneSentinelFile) {
      try {
        await fsp.unlink(path.join(this.cwd, config.completion.doneSentinelFile));
      } catch {
        // Not present — fine.
      }
    }

    return resolvedStage;
  }

  /** Read STAGE.md. Returns initialStage from config if missing/invalid. */
  async readStage(config: LoopConfig): Promise<LoopStage> {
    try {
      const text = (await fsp.readFile(path.join(this.cwd, 'STAGE.md'), 'utf8')).trim();
      const parsed = this.parseStage(text);
      if (parsed) return parsed;
      logger.warn('STAGE.md unparseable; defaulting to initialStage', { content: text.slice(0, 80) });
      return config.initialStage;
    } catch {
      return config.initialStage;
    }
  }

  /** Read PLAN.md (the user's plan file the loop is driving). */
  async readPlan(config: LoopConfig): Promise<string | null> {
    if (!config.planFile) return null;
    try {
      return await fsp.readFile(path.join(this.cwd, config.planFile), 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * Capture the workspace's "starting state" so the completion detector can
   * tell in-run progress apart from stale artefacts left over from prior
   * runs. Designed to run *after* `bootstrap` (which itself unlinks any
   * lingering `DONE.txt`), so the snapshot reflects post-cleanup truth.
   *
   * Both flags here gate the corresponding completion signal in
   * `LoopCompletionDetector.observe`:
   *   - `doneSentinelPresent` → `done-sentinel`
   *   - `planChecklistFullyChecked` → `plan-checklist`
   *
   * This is the single canonical place that captures the snapshot. The
   * coordinator stores the result on `LoopState` and never re-measures.
   */
  async captureStartupSnapshot(config: LoopConfig): Promise<LoopStartupSnapshot> {
    const doneSentinelPresent = config.completion.doneSentinelFile
      ? await this.fileExists(config.completion.doneSentinelFile)
      : false;
    let planChecklistFullyChecked = false;
    if (config.planFile) {
      const text = await this.readPlan(config);
      if (text !== null) {
        planChecklistFullyChecked = parsePlanChecklist(text).fullyChecked;
      }
    }
    const uncompletedPlanFilesAtStart = await this.scanUncompletedPlanFiles();
    return {
      doneSentinelPresent,
      planChecklistFullyChecked,
      uncompletedPlanFilesAtStart,
    };
  }

  /**
   * Scan the workspace root for `.md` files that look like uncompleted
   * planning docs (see `isPlanLikeMarkdown` denylist). Best-effort —
   * unreadable directories return [].
   */
  private async scanUncompletedPlanFiles(): Promise<string[]> {
    try {
      const entries = await fsp.readdir(this.cwd, { withFileTypes: true });
      const out: string[] = [];
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (isPlanLikeMarkdown(entry.name)) out.push(entry.name);
      }
      out.sort();
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Internal helper — workspace-relative existence check. Kept private so
   * callers go through `captureStartupSnapshot` rather than re-implementing
   * the path-resolution boilerplate.
   */
  private async fileExists(relativePath: string): Promise<boolean> {
    try {
      await fsp.access(path.join(this.cwd, relativePath));
      return true;
    } catch {
      return false;
    }
  }

  /** Read NOTES.md. Empty string if missing. */
  async readNotes(): Promise<string> {
    try {
      return await fsp.readFile(path.join(this.cwd, 'NOTES.md'), 'utf8');
    } catch {
      return '';
    }
  }

  /**
   * Build the per-iteration prompt sent to the child agent. The prompt
   * encodes the entire three-stage workflow as a self-advancing state
   * machine: agent reads STAGE.md, does that stage's work, advances
   * STAGE.md, optionally writes DONE.txt or renames the plan file.
   */
  buildPrompt(args: {
    config: LoopConfig;
    iterationSeq: number;
    pendingInterventions: string[];
    existingSessionContext?: string;
    /**
     * Uncompleted plan-like `.md` filenames at the workspace root, captured
     * once at startLoop. When non-empty the prompt explicitly tells the
     * agent which files it is expected to rename with `_completed` before
     * declaring done — this is the operator's contract with the loop.
     */
    uncompletedPlanFilesAtStart?: string[];
  }): string {
    const {
      config,
      iterationSeq,
      pendingInterventions,
      existingSessionContext,
      uncompletedPlanFilesAtStart = [],
    } = args;
    const planRef = config.planFile
      ? `the plan in \`${config.planFile}\` (referred to below as PLAN.md)`
      : 'the prompt below';
    const uncompletedPlansBlock =
      uncompletedPlanFilesAtStart.length > 0
        ? `\n\n## Uncompleted Plan Files Detected\nThe workspace root contained these uncompleted plan-like markdown files when the loop started:\n${uncompletedPlanFilesAtStart.map((f) => `  - \`${f}\``).join('\n')}\n\nThe loop coordinator has auto-enabled the \`requireCompletedFileRename\` gate. Writing \`DONE.txt\` alone is **not sufficient** — at least one of these files must be renamed to \`<name>_completed.md\` during the run before the loop will accept a stop signal. When you finish implementing all addressable items in a file, perform the rename (\`mv <name>.md <name>_completed.md\` or \`git mv\` if tracked). Items explicitly deferred to future architectural specs do not block the rename — document them in NOTES.md and rename anyway.\n`
        : '';
    const interventions =
      pendingInterventions.length > 0
        ? `\n\n## User Intervention\nThe operator added the following hint(s) since the last iteration. Treat them as binding direction:\n\n${pendingInterventions.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`
        : '';
    // Iteration 0 sees the goal (initialPrompt). Iterations 1+ see the
    // continuation directive (iterationPrompt) if one was set, falling back
    // to initialPrompt for legacy/single-prompt loops. State on disk plus
    // the stage machine carry context forward.
    //
    // We also persist the goal (initialPrompt) on every iteration so the
    // fresh-process AI can re-anchor; without this, iter 1+ relies entirely
    // on NOTES.md/plan-file reads to reconstruct context, and any iter that
    // forgot to write notes causes drift.
    const isFirstIteration = iterationSeq === 0;
    const existingSessionContextBlock = existingSessionContext?.trim()
      && (isFirstIteration || config.contextStrategy !== 'same-session')
      ? `\n\n## Existing Session Context (read-only background)\n${existingSessionContext.trim()}\n`
      : '';
    const goalBlock = `\n\n## Goal (persistent across iterations)\n${config.initialPrompt}\n`;
    const directiveBlock = !isFirstIteration && config.iterationPrompt
      ? `\n\n## Loop Continuation Directive\n${config.iterationPrompt}\n`
      : '';
    const promptBlocks = `${existingSessionContextBlock}${goalBlock}${directiveBlock}`;
    const contextModeLine = config.contextStrategy === 'same-session'
      ? 'You are running inside an autonomous Loop Mode using one persistent child CLI session across iterations. State still belongs on disk so the loop can recover if the process restarts.'
      : 'You are running inside an autonomous Loop Mode. State lives on disk; do not rely on chat history. Every iteration is a fresh process.';

    return `# Loop Mode — Iteration ${iterationSeq}

${contextModeLine}

## Autonomous Mode Rules

There is no human in the loop to answer questions. You must:

1. **Make decisions.** If you are uncertain, choose the option a senior engineer would defend in code review. Document your reasoning in \`NOTES.md\`.
2. **Do not ask clarifying questions.** They will not be answered — the next iteration is a fresh process and will not see them.
3. **If you are genuinely blocked** (missing credentials, ambiguous requirements that cannot be resolved by best-judgement, hardware/network you cannot access): write \`BLOCKED.md\` describing exactly what you need, then exit. The loop will pause and wait for the operator.

## Step 1 — Read your state
1. Open \`STAGE.md\`. It contains exactly one of: PLAN, REVIEW, IMPLEMENT.
2. Open ${planRef}.
3. Open \`NOTES.md\`. It contains the rolling notes from prior iterations.
4. Open \`ITERATION_LOG.md\` if you need detailed per-iteration history.
5. If no plan file is configured and the goal is broad, maintain a \`## Completion Inventory\` section in \`NOTES.md\`: list discovered concrete work items, check them off only when fully implemented and verified, and add newly discovered items instead of losing them between iterations.${uncompletedPlansBlock}${interventions}${promptBlocks}

## Step 2 — Do this iteration's work

Based on the value of STAGE.md:

- **PLAN** — Continue or improve the plan. Choose the best architectural decisions. Do not take shortcuts. If a plan does not exist yet, draft one.
- **REVIEW** — Re-read the plan with completely fresh eyes. Treat the plan as if a stranger wrote it. Identify and fix issues. Improve clarity, completeness, and correctness. If the plan is sound, say so explicitly.
- **IMPLEMENT** — Implement the next concrete chunk toward the goal. If a plan exists, follow it. If no plan exists, inspect the code and make progress directly rather than drafting a new plan unless the user explicitly asked for planning. For broad goals such as "implement everything", first build or update the \`NOTES.md\` completion inventory by searching for unfinished implementations (for example TODO/FIXME, "not implemented", placeholder, stub, fake/mock behavior in production paths, constant returns standing in for real logic). Use maintainable architecture. After implementing, re-review your code with completely fresh eyes and fix anything you'd reject in code review. Run appropriate verification if you can.

Honor every safety rail: do not run destructive operations (\`rm -rf\`, \`git push --force\`, schema drops) unless the loop config explicitly allows them — this loop ${config.allowDestructiveOps ? 'DOES' : 'DOES NOT'} allow destructive operations.

## Step 3 — Advance state at the end of the iteration

If the work for the current STAGE is complete:
- PLAN done → write \`REVIEW\` into STAGE.md. **Do NOT emit \`<promise>DONE</promise>\` or write \`DONE.txt\` — those are reserved for IMPLEMENT when the plan is fully complete.**
- REVIEW done → write \`IMPLEMENT\` into STAGE.md. **Do NOT emit \`<promise>DONE</promise>\` or write \`DONE.txt\` — those are reserved for IMPLEMENT when the plan is fully complete.**
- IMPLEMENT done **but plan still has unfinished items** → write \`REVIEW\` into STAGE.md (loop back through review).
- IMPLEMENT done **and the plan or completion inventory is fully implemented & verified** →
    1. Confirm there are no unchecked plan items or unchecked \`NOTES.md\` completion-inventory items. For broad implementation goals, run a final targeted search for unfinished implementation markers and either implement each actionable item or record why it is out of scope.
    2. Run the verify command if one is configured (\`${config.completion.verifyCommand || '(none configured)'}\`). If none is configured, run the appropriate project checks yourself and summarize them. Verification must pass.
    3. If a plan file exists, rename it before declaring done: \`mv ${config.planFile ?? '<plan-file>'} ${(config.planFile ?? '<plan-file>').replace(/\.md$/, '_Completed.md')}\` (or use git mv if applicable).
    4. Write \`DONE.txt\` containing the date — this durable sentinel is required for no-plan loops.
    5. Append \`<promise>DONE</promise>\` on its own line at the end of your output only after the durable marker above exists.

If you are blocked and need a human, write \`BLOCKED.md\` describing what you need, then exit.

## Step 4 — Update notes

Append a one-paragraph summary of this iteration to \`NOTES.md\`. Keep it terse — what changed, what's next.

## Step 5 — Exit

Exit the iteration. The loop coordinator will continue according to the configured context strategy.

---

Begin.`;
  }

  /** Parse a STAGE.md value. Returns null if invalid. */
  private parseStage(raw: string): LoopStage | null {
    const upper = raw.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
    if (VALID_STAGES.has(upper as LoopStage)) return upper as LoopStage;
    return null;
  }

  /**
   * Append a structured iteration record to ITERATION_LOG.md. Called by
   * the coordinator after each iteration completes.
   */
  async appendIterationLog(entry: {
    seq: number;
    stage: LoopStage;
    verdict: 'OK' | 'WARN' | 'CRITICAL';
    tokens: number;
    durationMs: number;
    filesChanged: number;
    progressNotes: string[];
    completionNotes: string[];
  }): Promise<void> {
    const logPath = path.join(this.cwd, 'ITERATION_LOG.md');
    const lines = [
      `## Iteration ${entry.seq} — ${entry.stage} — ${entry.verdict}`,
      `- duration: ${(entry.durationMs / 1000).toFixed(1)}s`,
      `- tokens: ${entry.tokens}`,
      `- files changed: ${entry.filesChanged}`,
    ];
    if (entry.progressNotes.length > 0) {
      lines.push('- progress signals:');
      for (const n of entry.progressNotes) lines.push(`  - ${n}`);
    }
    if (entry.completionNotes.length > 0) {
      lines.push('- completion signals fired:');
      for (const n of entry.completionNotes) lines.push(`  - ${n}`);
    }
    lines.push('');
    try {
      await fsp.appendFile(logPath, lines.join('\n') + '\n', 'utf8');
    } catch (err) {
      logger.warn('Failed to append iteration log', { error: String(err) });
    }
  }

  /** True if any of the loop's artifact files exist. */
  async hasExistingArtifacts(): Promise<boolean> {
    for (const f of ARTIFACT_FILES) {
      try {
        await fsp.access(path.join(this.cwd, f));
        return true;
      } catch {
        // continue
      }
    }
    return false;
  }
}
