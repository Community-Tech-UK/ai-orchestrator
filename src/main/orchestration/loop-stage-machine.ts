import * as fsp from 'fs/promises';
import * as path from 'path';
import { getLogger } from '../logging/logger';
import type { LoopConfig, LoopStage } from '../../shared/types/loop.types';
import { parseTaskLedger, type LoopTaskLedger } from './loop-task-ledger';
import { resolveLoopArtifactPaths, loopStateFile, type LoopArtifactPaths } from './loop-artifact-paths';
import {
  curateNotesContent,
  hasPlanNameHint,
  isPlanLikeMarkdown,
  NOTES_CURATION_MAX_CHARS,
  NOTES_CURATION_KEEP_TAIL_CHARS,
  outstandingHasHumanItems,
  parsePlanChecklist,
  type NotesCurationResult,
} from './loop-stage-markdown';
import {
  LOOP_TEXT_FILE_MAX_BYTES,
  readUtf8FileHead,
  readUtf8FileTail,
} from './bounded-file-read';
import {
  renderPendingInput,
  renderSystemReminder,
  type PendingInputLike,
} from './loop-stage-prompt-helpers';
import {
  ARTIFACT_FILES,
  INVESTIGATION_REPORT_FILE,
  LOOP_TASKS_FILE,
  LOOP_TASKS_TEMPLATE,
} from './loop-stage-files';
import { renderPlanPacketInstructions } from './loop-plan-packet';

export {
  curateNotesContent,
  outstandingHasHumanItems,
  parsePlanChecklist,
  type NotesCurationResult,
  type PlanChecklistState,
} from './loop-stage-markdown';
export { INVESTIGATION_REPORT_FILE, LOOP_TASKS_FILE } from './loop-stage-files';

const logger = getLogger('LoopStageMachine');

const VALID_STAGES = new Set<LoopStage>(['PLAN', 'REVIEW', 'IMPLEMENT']);
const LOOP_ARTIFACT_HEAD_BYTES = LOOP_TEXT_FILE_MAX_BYTES;
const LOOP_NOTES_TAIL_BYTES = 64 * 1024;

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
  /**
   * LF-4: `LOOP_TASKS.md` existed with ≥1 item and every item was already
   * resolved (done/deferred) at startLoop. Gates the `ledger-complete` signal
   * so a stale, pre-resolved ledger from a prior run is not treated as in-run
   * completion (mirrors `planChecklistFullyChecked`).
   */
  loopTasksLedgerResolvedAtStart: boolean;
}

export class LoopStageMachine {
  /**
   * Per-run state-file paths under `<cwd>/.aio-loop-state/<loopRunId>/`. All
   * loop-owned scaffolding (STAGE/NOTES/ITERATION_LOG/LOOP_TASKS/DONE/BLOCKED)
   * lives here so concurrent loops in the same workspace never collide.
   * `this.cwd` stays the workspace root for user artefacts (planFile, the
   * `*_completed.md` rename scan).
   */
  readonly paths: LoopArtifactPaths;

  constructor(
    public readonly cwd: string,
    public readonly loopRunId: string,
  ) {
    this.paths = resolveLoopArtifactPaths(cwd, loopRunId);
  }

  /**
   * Bootstrap loop artifacts on disk. Idempotent — won't overwrite existing
   * files. Returns the resolved initial stage (whatever STAGE.md ends up
   * containing).
   */
  async bootstrap(config: LoopConfig): Promise<LoopStage> {
    // Every loop-owned state file lives in this per-run directory. Because the
    // directory is keyed by the unique loopRunId, a brand-new run always gets a
    // FRESH, empty dir — a prior run's STAGE/LOOP_TASKS/DONE can never be
    // inherited, and two concurrent loops in the same workspace never collide.
    // bootstrap runs once per run (only from startLoop; recovery never
    // re-bootstraps), so the only way the dir pre-exists is same-run recovery —
    // in which case the existing files are real in-progress state and the
    // idempotent "write only if absent" below correctly preserves them.
    await fsp.mkdir(this.paths.dir, { recursive: true });

    const { stage: stagePath, notes: notesPath, iterationLog: logPath, tasks: tasksPath } = this.paths;

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

    // LF-4: bootstrap an empty LOOP_TASKS.md ledger template (write only if
    // absent — a present file is in-progress recovery state, not stale). It has
    // no checkbox items yet, so it does NOT gate completion until the agent adds
    // tasks — but its presence + instructions nudge per-item tracking.
    try { await fsp.access(tasksPath); } catch {
      await fsp.writeFile(tasksPath, LOOP_TASKS_TEMPLATE, 'utf8');
    }

    // Delete a done sentinel left inside this run's dir. Only reachable on
    // same-run recovery (a fresh dir has none); a stale sentinel would
    // otherwise fire the done-sentinel completion signal on the first IMPLEMENT
    // iteration before the run does any work.
    if (config.completion.doneSentinelFile) {
      try {
        await fsp.unlink(loopStateFile(this.paths, config.completion.doneSentinelFile));
      } catch {
        // Not present — fine.
      }
    }

    return resolvedStage;
  }

  /** Read STAGE.md. Returns initialStage from config if missing/invalid. */
  async readStage(config: LoopConfig): Promise<LoopStage> {
    try {
      const text = (await readUtf8FileHead(this.paths.stage, 1024)).text.trim();
      const parsed = this.parseStage(text);
      if (parsed) return parsed;
      logger.warn('STAGE.md unparseable; defaulting to initialStage', { content: text.slice(0, 80) });
      return config.initialStage;
    } catch {
      return config.initialStage;
    }
  }

  /**
   * F2 (#22): coordinator-authoritative STAGE.md write. Used by the enforced
   * REVIEW→PLAN back-edge — the agent *proposes* stage transitions by writing
   * the file itself; the coordinator *disposes* by overwriting it when the
   * post-review veto fires.
   */
  async writeStage(stage: LoopStage): Promise<void> {
    await fsp.writeFile(this.paths.stage, `${stage}\n`, 'utf8');
  }

  /** Read PLAN.md (the user's plan file the loop is driving). */
  async readPlan(config: LoopConfig): Promise<string | null> {
    if (!config.planFile) return null;
    try {
      return (await readUtf8FileHead(path.join(this.cwd, config.planFile), LOOP_ARTIFACT_HEAD_BYTES)).text;
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
      ? await this.pathExists(loopStateFile(this.paths, config.completion.doneSentinelFile))
      : false;
    let planChecklistFullyChecked = false;
    if (config.planFile) {
      const text = await this.readPlan(config);
      if (text !== null) {
        planChecklistFullyChecked = parsePlanChecklist(text).fullyChecked;
      }
    }
    const uncompletedPlanFilesAtStart = await this.scanUncompletedPlanFiles();
    // LF-4: a ledger that already has items AND is fully resolved at start is a
    // stale baseline — don't let it fire ledger-complete on iteration 0.
    const startLedger = await this.readTaskLedger();
    const loopTasksLedgerResolvedAtStart = startLedger.total > 0 && startLedger.complete;
    return {
      doneSentinelPresent,
      planChecklistFullyChecked,
      uncompletedPlanFilesAtStart,
      loopTasksLedgerResolvedAtStart,
    };
  }

  /** LF-4: read + parse `LOOP_TASKS.md`. Returns an empty ledger when absent. */
  async readTaskLedger(): Promise<LoopTaskLedger> {
    try {
      const text = (await readUtf8FileHead(this.paths.tasks, LOOP_ARTIFACT_HEAD_BYTES)).text;
      return parseTaskLedger(text);
    } catch {
      return parseTaskLedger('');
    }
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
        if (!isPlanLikeMarkdown(entry.name)) continue;
        if (await this.looksLikePlanDoc(entry.name)) out.push(entry.name);
      }
      out.sort();
      return out;
    } catch {
      return [];
    }
  }

  /**
   * A root `.md` (already past the name denylist / completed-suffix checks) is
   * only treated as an uncompleted PLAN — which the loop will tell the agent to
   * rename `_completed` — when it actually looks like one: a plan-ish filename
   * OR a body containing a markdown checklist. Prose docs (e.g. blog drafts)
   * are not plans, so the loop never demands they be renamed.
   */
  private async looksLikePlanDoc(basename: string): Promise<boolean> {
    if (hasPlanNameHint(basename)) return true;
    try {
      const text = (await readUtf8FileHead(path.join(this.cwd, basename), LOOP_ARTIFACT_HEAD_BYTES)).text;
      return parsePlanChecklist(text).total > 0;
    } catch {
      return false;
    }
  }

  /** Internal helper — absolute-path existence check. */
  private async pathExists(absPath: string): Promise<boolean> {
    try {
      await fsp.access(absPath);
      return true;
    } catch {
      return false;
    }
  }

  /** Read NOTES.md. Empty string if missing. */
  async readNotes(): Promise<string> {
    try {
      return (await readUtf8FileTail(this.paths.notes, LOOP_NOTES_TAIL_BYTES)).text;
    } catch {
      return '';
    }
  }

  /**
   * review-driven mode: read OUTSTANDING.md, which the agent maintains with
   * items it could not resolve autonomously. Returns the raw contents plus a
   * `needsHuman` flag — true when the "Needs human" section contains at least
   * one real bullet (not a "(none)" placeholder). Drives the coordinator's
   * choice of terminal state (`completed` vs `completed-needs-review`).
   */
  async readOutstanding(): Promise<{ raw: string; needsHuman: boolean }> {
    let raw = '';
    try {
      raw = (await readUtf8FileHead(this.paths.outstanding, LOOP_ARTIFACT_HEAD_BYTES)).text;
    } catch {
      return { raw: '', needsHuman: false };
    }
    return { raw, needsHuman: outstandingHasHumanItems(raw) };
  }

  /**
   * LF-3 — curate NOTES.md if it has grown past the size threshold. Reads the
   * file, runs {@link curateNotesContent} (preserving the completion
   * inventory), and writes back only when curation actually changed something.
   * Best-effort: a read/write failure returns `changed: false` and the loop
   * continues with the un-curated file. Returns the result so the coordinator
   * can log/emit the elision for observability.
   */
  async curateNotesIfNeeded(opts: { maxChars?: number; keepTailChars?: number } = {}): Promise<NotesCurationResult> {
    const notesPath = this.paths.notes;
    let content: string;
    let boundedReadElidedBytes = 0;
    try {
      const readLimit = Math.min(
        LOOP_TEXT_FILE_MAX_BYTES,
        Math.max(opts.maxChars ?? NOTES_CURATION_MAX_CHARS, opts.keepTailChars ?? NOTES_CURATION_KEEP_TAIL_CHARS),
      );
      const read = await readUtf8FileTail(notesPath, readLimit);
      boundedReadElidedBytes = read.truncated ? Math.max(0, read.sizeBytes - Buffer.byteLength(read.text, 'utf8')) : 0;
      content = read.truncated
        ? `# Loop Notes\n\n_[loop] NOTES.md exceeded the bounded read cap; preserving the newest entries._\n\n${read.text}`
        : read.text;
    } catch {
      return { curated: '', changed: false, elidedChars: 0 };
    }
    const result = curateNotesContent(content, opts);
    const writeResult = boundedReadElidedBytes > 0 ? {
      curated: result.curated,
      changed: true,
      elidedChars: boundedReadElidedBytes + result.elidedChars,
    } : result;
    if (!writeResult.changed) return writeResult;
    try {
      await fsp.writeFile(notesPath, writeResult.curated, 'utf8');
    } catch (err) {
      logger.warn('Failed to write curated NOTES.md', { error: String(err) });
      return { curated: content, changed: false, elidedChars: 0 };
    }
    return writeResult;
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
    pendingInterventions: PendingInputLike[];
    capUsage?: { totalTokens: number; totalCostCents: number };
    existingSessionContext?: string;
    currentStage?: LoopStage;
    /**
     * Uncompleted plan-like `.md` filenames at the workspace root, captured
     * once at startLoop. When non-empty the prompt explicitly tells the
     * agent which files it is expected to rename with `_completed` before
     * declaring done — this is the operator's contract with the loop.
     */
    uncompletedPlanFilesAtStart?: string[];
    /**
     * FU-2: when true, the loop has no `verifyCommand` configured so
     * completion attempts will pause for human review rather than
     * stopping the loop. Surfacing this in the prompt avoids the agent
     * wasting an iteration on a completion attempt the loop cannot
     * accept.
     */
    manualReviewOnly?: boolean;
    /**
     * LF-6: prior-run observations surfaced from cross-loop memory. Rendered as
     * non-binding context so the agent can avoid known dead-ends without being
     * forced down a stale path.
     */
    priorObservations?: string[];
  }): string {
    const {
      config,
      iterationSeq,
      pendingInterventions,
      existingSessionContext,
      currentStage = config.initialStage,
      uncompletedPlanFilesAtStart = [],
      manualReviewOnly = false,
      priorObservations = [],
    } = args;
    // All loop-owned state files live in this per-run directory. Use the
    // absolute path (this.paths.dir) so the agent can locate state files
    // regardless of its working directory — critical when executionCwd (the
    // agent's spawn cwd) differs from workspaceCwd (where state lives).
    const sd = this.paths.dir;
    const stageRel = `${sd}/STAGE.md`;
    const notesRel = `${sd}/NOTES.md`;
    const logRel = `${sd}/ITERATION_LOG.md`;
    const tasksRel = `${sd}/${LOOP_TASKS_FILE}`;
    const doneRel = `${sd}/${config.completion.doneSentinelFile || 'DONE.txt'}`;
    const blockedRel = `${sd}/BLOCKED.md`;
    const reportRel = `${sd}/${INVESTIGATION_REPORT_FILE}`;
    const planPacketBlock = config.audit?.planPacketMode === 'prompted'
      ? `\n\n## Plan Packet\n${renderPlanPacketInstructions(this.paths)}\n`
      : '';
    const reanchorBlock = renderSystemReminder({ blockedPath: blockedRel, capUsage: args.capUsage, config, currentStage, iterationSeq, stagePath: stageRel, tasksPath: tasksRel });
    // Investigation/audit goal: the agent ANSWERS the goal (with file:line
    // evidence in REPORT.md) instead of editing production code. `undefined`
    // intent is treated as implementation.
    const isInvestigation = config.goalIntent === 'investigation';
    const planRef = config.planFile
      ? `the plan in \`${config.planFile}\` (referred to below as PLAN.md)`
      : 'the prompt below';
    const uncompletedPlansBlock =
      uncompletedPlanFilesAtStart.length > 0 && !isInvestigation
        ? `\n\n## Uncompleted Plan Files Detected\nThe workspace root contained these uncompleted plan-like markdown files when the loop started:\n${uncompletedPlanFilesAtStart.map((f) => `  - \`${f}\``).join('\n')}\n\nThe loop coordinator has auto-enabled the \`requireCompletedFileRename\` gate. Writing \`${doneRel}\` alone is **not sufficient** — at least one of these files must be renamed to \`<name>_completed.md\` during the run before the loop will accept a stop signal. When you finish implementing all addressable items in a file, perform the rename (\`mv <name>.md <name>_completed.md\` or \`git mv\` if tracked). Items explicitly deferred to future architectural specs do not block the rename — document them in \`${notesRel}\` and rename anyway.\n`
        : '';
    // Investigation/audit override. Placed prominently because it changes the
    // job from "implement" to "answer with evidence" — the agent reads this
    // before the implementation-flavoured stage instructions below.
    const investigationBlock = isInvestigation
      ? `\n\n## Investigation / Audit Mode — READ THIS FIRST\nThe goal below is a QUESTION / AUDIT, **not an implementation task**. Your job is to ANSWER it accurately — not to write or change production code.\n- **Do NOT modify, create, or delete production source files**, and do NOT rename any plan/backlog files. This is a read-only investigation; the only files you write are \`${reportRel}\` and the loop's own state files under \`${sd}/\`.\n- Investigate by reading the ACTUAL code. Every claim in your answer must be backed by a concrete \`path/to/file.ext:line\` citation — never assert from memory or trust a doc's say-so; verify it against the code.\n- Write your findings to \`${reportRel}\` and keep extending it. It is the deliverable: a thorough, well-structured, cited answer to the goal. For any "is X done / fully implemented?" question, give an explicit per-item verdict (done / partial / not-done) with the evidence.\n- The loop will NOT accept completion until \`${reportRel}\` exists and contains a substantive, cited answer. When the answer is complete and self-reviewed, write \`${doneRel}\` and emit \`<promise>DONE</promise>\`.\n`
      : '';
    // Stage-step instructions differ by intent: investigation stages drive the
    // report, not a software build.
    const stageWorkBlock = isInvestigation
      ? `- **PLAN** — Scope the investigation: in \`${tasksRel}\`, list the concrete questions / sub-claims you must resolve to answer the goal (one checkbox each). Do not draft a software plan.
- **REVIEW** — Re-read \`${reportRel}\` with completely fresh eyes. Is every claim backed by \`file:line\` evidence? Flag and fix any unverified assertion, gap, or item you accepted from a doc without confirming in code.
- **IMPLEMENT** — Do the investigation: read the relevant code, resolve each open question in the ledger, and write/extend \`${reportRel}\` with the answer and \`file:line\` citations. **Do not edit production code.** Run read-only checks (grep/tests/build output) only to gather evidence.`
      : `- **PLAN** — Continue or improve the plan. Choose the best architectural decisions. Do not take shortcuts. If a plan does not exist yet, draft one.
- **REVIEW** — Re-read the plan with completely fresh eyes. Treat the plan as if a stranger wrote it. Identify and fix issues. Improve clarity, completeness, and correctness. If the plan is sound, say so explicitly.
- **IMPLEMENT** — Implement the next concrete chunk toward the goal. If a plan exists, follow it. If no plan exists, inspect the code and make progress directly rather than drafting a new plan unless the user explicitly asked for planning. For broad goals such as "implement everything", first build or update the \`${notesRel}\` completion inventory by searching for unfinished implementations (for example TODO/FIXME, "not implemented", placeholder, stub, fake/mock behavior in production paths, constant returns standing in for real logic). Use maintainable architecture. After implementing, re-review your code with completely fresh eyes and fix anything you'd reject in code review. Run appropriate verification if you can.`;
    // Step-3 completion criteria also differ by intent. The implementation
    // variant renames the plan file and runs a verify command; the
    // investigation variant must do NEITHER (renaming/editing the audited files
    // is the exact wrong action) — it gates on a cited REPORT.md instead.
    const completionStepsBlock = isInvestigation
      ? `If this iteration's work is complete:
- **PLAN** done → write \`REVIEW\` into \`${stageRel}\` (scope is set; next, do the investigation). **Do NOT** write \`${doneRel}\` or emit \`<promise>DONE</promise>\` yet.
- **REVIEW** done → write \`IMPLEMENT\` into \`${stageRel}\`. **Do NOT** write \`${doneRel}\` or emit \`<promise>DONE</promise>\` yet.
- **IMPLEMENT** but \`${reportRel}\` does not yet fully answer the goal → write \`REVIEW\` into \`${stageRel}\` and keep investigating.
- **IMPLEMENT** and \`${reportRel}\` fully answers the goal →
    1. Confirm every \`${tasksRel}\` ledger item is \`[x]\` or \`[-]\` (with a reason), and \`${reportRel}\` contains a substantive, \`file:line\`-cited answer — with an explicit verdict (done / partial / not-done) for each "is X done?" sub-question.
    2. **Do NOT modify, rename, or delete any plan/backlog/source files** — this is a read-only audit. Cite any read-only checks you ran (grep / build / test output) as evidence inside \`${reportRel}\`; there is no verify command to run and no plan file to rename.
    3. Write \`${doneRel}\` containing the date — the durable completion sentinel.
    4. Append \`<promise>DONE</promise>\` on its own line at the end of your output, only after \`${reportRel}\` and \`${doneRel}\` both exist.`
      : `If the work for the current STAGE is complete:
- PLAN done → write \`REVIEW\` into \`${stageRel}\`. **Do NOT emit \`<promise>DONE</promise>\` or write \`${doneRel}\` — those are reserved for IMPLEMENT when the plan is fully complete.**
- REVIEW done → write \`IMPLEMENT\` into \`${stageRel}\`. **Do NOT emit \`<promise>DONE</promise>\` or write \`${doneRel}\` — those are reserved for IMPLEMENT when the plan is fully complete.** If your review found blocking issues, write \`PLAN\` instead — you propose stage transitions, but the coordinator independently classifies review output and will overwrite \`${stageRel}\` back to \`PLAN\` (bounded by its review-cycle cap) when blocking issues are detected.
- IMPLEMENT done **but plan still has unfinished items** → write \`REVIEW\` into \`${stageRel}\` (loop back through review).
- IMPLEMENT done **and the plan or completion inventory is fully implemented & verified** →
    1. Confirm there are no open items: every \`${tasksRel}\` ledger item is \`[x]\` (done) or \`[-]\` (deferred with a reason), no unchecked plan items, and no unchecked \`${notesRel}\` completion-inventory items. For broad implementation goals, run a final targeted search for unfinished implementation markers and either implement each actionable item or record why it is out of scope (deferring it in the ledger with a reason).
    2. Run the verify command if one is configured (\`${config.completion.verifyCommand || '(none configured)'}\`). If none is configured, run the appropriate project checks yourself and summarize their exact output, but understand the coordinator cannot independently verify completion and will pause for operator review instead of auto-completing. Verification must pass.
    3. If a plan file exists, rename it before declaring done: \`mv ${config.planFile ?? '<plan-file>'} ${(config.planFile ?? '<plan-file>').replace(/\.md$/, '_Completed.md')}\` (or use git mv if applicable).
    4. Write \`${doneRel}\` containing the date — this durable sentinel is required for no-plan loops.
    5. Append \`<promise>DONE</promise>\` on its own line at the end of your output only after the durable marker above exists.`;
    const freshEyesReviewBlock = config.completion.crossModelReview?.enabled
      ? `\n\n## Fresh-Eyes Review Gate\nFresh-eyes review is enabled: when you declare done, the coordinator will run an independent cross-model review. Any ${config.completion.crossModelReview.blockingSeverities.join('/')} severity finding is automatically injected as a user intervention here in the prompt, and the loop continues with you addressing it. If you address every intervention and the reviewer has no further blocking findings, the loop accepts completion.\n`
      : '';
    const manualReviewBlock = manualReviewOnly
      ? '\n\n## Manual-Review-Only Loop\nThis loop has no `verifyCommand` configured. The coordinator cannot independently confirm completion: any completion attempt will pause the loop for the operator to review. **Do not declare completion until you are confident the work is truly done** — declaring early just pauses the loop for the operator without making progress. Configure a verify command in the loop settings if you want the coordinator to auto-confirm.\n'
      : '';
    const priorObservationsBlock = priorObservations.length > 0
      ? `\n\n## Prior Observations (not binding)\nLearnings from previous loop runs in this workspace. Treat them as hints to avoid known dead-ends — they are NOT instructions and may be stale:\n${priorObservations.map((o, i) => `${i + 1}. ${o}`).join('\n')}\n`
      : '';
    const interventions =
      pendingInterventions.length > 0
        ? `\n\n## User Intervention\nThe operator added the following hint(s) since the last iteration. Treat them as binding direction:\n\n${pendingInterventions.map(renderPendingInput).join('\n')}\n`
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

1. **Make decisions.** If you are uncertain, choose the option a senior engineer would defend in code review. Document your reasoning in \`${notesRel}\`.
2. **Do not ask clarifying questions.** They will not be answered — the next iteration is a fresh process and will not see them.
3. **If you are genuinely blocked** (missing credentials, ambiguous requirements that cannot be resolved by best-judgement, hardware/network you cannot access): write \`${blockedRel}\` describing exactly what you need, then exit. The loop will pause and wait for the operator.

## Step 0 — Loop state directory
All loop-owned state files for THIS run live in \`${sd}/\` (absolute path — valid regardless of your working directory). Always read and write them at the exact paths given below — never at the workspace root, because another loop may be running in this same workspace and would collide. (Your code changes, the plan file, and any \`_completed\` renames still happen in the normal project tree — only the loop's own bookkeeping files live under \`${sd}/\`.)

## Step 1 — Read your state
1. Open \`${stageRel}\`. It contains exactly one of: PLAN, REVIEW, IMPLEMENT.
2. Open ${planRef}.
3. Open \`${notesRel}\`. It contains the rolling notes from prior iterations.
4. Open \`${logRel}\` if you need detailed per-iteration history.
5. Open \`${tasksRel}\` — the structured task ledger. For a multi-item goal, list every concrete work item there as a markdown checkbox and keep it current: \`[ ]\` todo, \`[~]\` in progress, \`[x]\` done, \`[-] … — deferred: <why>\`. **The loop stops only when every ledger item is \`[x]\` or \`[-]\` (with a reason) AND verify passes** — so an item you can't finish must be explicitly deferred with a reason, not left \`[ ]\`. (If no plan file is configured and the goal is broad, you may instead keep a \`## Completion Inventory\` in \`${notesRel}\`, but the ledger is preferred because the loop reads it as the source of truth for stopping.)${reanchorBlock}${planPacketBlock}${investigationBlock}${uncompletedPlansBlock}${freshEyesReviewBlock}${manualReviewBlock}${priorObservationsBlock}${interventions}${promptBlocks}

## Step 2 — Do this iteration's work

Based on the value of STAGE.md:

${stageWorkBlock}

Honor every safety rail: do not run destructive operations (\`rm -rf\`, \`git push --force\`, schema drops) unless the loop config explicitly allows them — this loop ${config.allowDestructiveOps ? 'DOES' : 'DOES NOT'} allow destructive operations.

## Step 3 — Advance state at the end of the iteration

${completionStepsBlock}

If a completion signal would fire (the durable done sentinel \`${doneRel}\`, a completed-file rename, or a fully-checked plan) but you KNOW real work still remains — e.g. the signal was for one sub-task, or you still have open ledger items — emit \`[[LOOP:MORE_WORK_REMAINING]]\` on its own line in your output. The coordinator treats it as an authoritative "do not stop yet" and continues to the next iteration. It only ever keeps the loop going; it can never cause a premature stop, so use it whenever you are unsure you are truly done.

If you are blocked and need a human, write \`${blockedRel}\` describing what you need, then exit.

## Step 4 — Update notes

Append a one-paragraph summary of this iteration to \`${notesRel}\`. Keep it terse — what changed, what's next.

## Step 5 — Exit

Exit the iteration. The loop coordinator will continue according to the configured context strategy.

---

Begin.`;
  }

  /**
   * review-driven prompt. Far simpler than the staged buildPrompt: there is no
   * PLAN/REVIEW/IMPLEMENT machinery and no verify/rename gate. The loop's engine
   * is a relentless fresh-eyes self-review — exactly the manual workflow
   * ("re-review with fresh eyes, fix anything not done") run automatically until
   * the model goes quiet for `requiredCleanReviewPasses` consecutive rounds.
   */
  buildReviewDrivenPrompt(args: {
    config: LoopConfig;
    iterationSeq: number;
    pendingInterventions: PendingInputLike[];
    existingSessionContext?: string;
    priorObservations?: string[];
  }): string {
    const {
      config,
      iterationSeq,
      pendingInterventions,
      existingSessionContext,
      priorObservations = [],
    } = args;
    const sd = this.paths.dir;
    const notesRel = `${sd}/NOTES.md`;
    const outstandingRel = `${sd}/OUTSTANDING.md`;
    const blockedRel = `${sd}/BLOCKED.md`;
    const tasksRel = `${sd}/${LOOP_TASKS_FILE}`;
    const preferredCleanStatement = (config.completion.noOutstandingPhrase ?? 'There are no outstanding issues').trim();
    const required = Math.max(1, config.completion.requiredCleanReviewPasses ?? 2);
    const verifyCmd = config.completion.verifyCommand?.trim();

    const interventions =
      pendingInterventions.length > 0
        ? `\n\n## Direction since last iteration (binding — operator hints and/or review findings to address)\n${pendingInterventions.map(renderPendingInput).join('\n')}\n`
        : '';
    const priorObservationsBlock = priorObservations.length > 0
      ? `\n\n## Prior observations (not binding)\nHints from previous runs in this workspace — may be stale:\n${priorObservations.map((o, i) => `${i + 1}. ${o}`).join('\n')}\n`
      : '';
    const isFirstIteration = iterationSeq === 0;
    const existingSessionContextBlock = existingSessionContext?.trim()
      && (isFirstIteration || config.contextStrategy !== 'same-session')
      ? `\n\n## Existing session context (read-only background)\n${existingSessionContext.trim()}\n`
      : '';
    const verifyBlock = verifyCmd
      ? `\n- A verify command is configured: \`${verifyCmd}\`. Run it as part of your review; if it fails, that is an outstanding issue — fix it and do NOT emit the completion line this round.`
      : '';
    const contextModeLine = config.contextStrategy === 'same-session'
      ? 'You are running inside an autonomous Loop Mode using one persistent child CLI session across iterations. State still belongs on disk so the loop can recover if the process restarts.'
      : 'You are running inside an autonomous Loop Mode. State lives on disk; every iteration is a fresh process — do not rely on chat history.';
    const planPacketBlock = config.audit?.planPacketMode === 'prompted'
      ? `\n- \`${this.paths.roadmap}\` and phase files under \`${this.paths.phasesDir}\` — write or update the loop plan packet with Acceptance Criteria, Required Commands, and Evidence. Seed or update \`${tasksRel}\` from those criteria so final audit can verify coverage.`
      : '';

    return `# Loop Mode (review-driven) — Iteration ${iterationSeq}

${contextModeLine}

There is no human in the loop. Make the decisions a senior engineer would defend; do not ask questions (the next iteration won't see them).

## Your job this iteration
1. **Advance the goal.** Do the next concrete chunk of real work toward the goal below. Use maintainable architecture; no shortcuts, stubs, or placeholder/constant-return logic standing in for the real thing.
2. **Re-review your own work with completely fresh eyes.** Pretend a stranger wrote everything and you are the reviewer. Hunt specifically for:
   - things the goal asked for that are NOT actually implemented (orphan code, stubs, TODOs, "not implemented", fake/mock behaviour in production paths, docs that claim done with no real wiring);
   - specs that say one thing while the code does another;
   - half-done features, missing wiring/integration, missing error handling, regressions.
3. **Fix everything you find** in this same iteration.${verifyBlock}

## State files (under \`${sd}/\` — read/write at these exact paths)
- \`${notesRel}\` — append a terse one-paragraph summary each iteration: what you changed, what's left.
- \`${outstandingRel}\` — keep this current. It has two sections:
    \`\`\`
    ## Needs human
    - <only items literally impossible for an autonomous agent: physical-hardware testing, subjective/aesthetic or stakeholder sign-off, access/credentials you do not have. Each with a one-line WHY.>
      - Recommendation: <the single concrete decision or next step you would take on this item if it were your call>

    ## Open questions
    - <assumptions you made where the goal was ambiguous>
      - Recommendation: <the answer you'd pick / what you'd do>
    \`\`\`
  Under EVERY item, add an indented \`- Recommendation:\` sub-bullet with your single best concrete decision/next step for it. The human sees this as a pre-filled, editable suggestion in their answer box (they still confirm it) — so make it specific and actionable, not "ask a human". The bar for "Needs human" is HIGH — do everything you possibly can yourself. Only genuinely human-required items go there. If a section has nothing, write \`- (none)\`.
- \`${blockedRel}\` — only if you are truly, hard-blocked right now (missing credentials/access you cannot proceed without). Write what you need, then exit; the loop will pause for the operator.${planPacketBlock}${priorObservationsBlock}${interventions}${existingSessionContextBlock}

## Goal (persistent across iterations)
${config.initialPrompt}

## How this loop stops
The loop ends after **${required} consecutive** iterations where, after a genuine fresh-eyes pass, you (a) made **no** code changes and (b) found nothing left to fix that you can act on.

When — and ONLY when — that is true this iteration (you changed no production code, and everything remaining is either done or sits under "## Needs human" in \`${outstandingRel}\`), end your message with a clear statement that there are no actionable issues or remaining autonomous work. Preferred wording:

${preferredCleanStatement}

Do **not** write an equivalent clean statement in any other situation. If you changed code or found anything actionable, keep working. Claiming a clean review prematurely just delays the real finish, because the loop re-checks and will reset the moment it sees more changes.

If the loop is about to stop but you KNOW real work still remains — e.g. your wording was misread as "done", or an item is genuinely unresolved — emit \`[[LOOP:MORE_WORK_REMAINING]]\` on its own line in your output. The coordinator treats it as an authoritative "do not stop yet" and keeps the loop running. It can only ever keep the loop going; it can never cause a premature stop.

## Safety
This loop ${config.allowDestructiveOps ? 'DOES' : 'DOES NOT'} allow destructive operations (\`rm -rf\`, \`git push --force\`, schema drops). Honor that.

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
    const logPath = this.paths.iterationLog;
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
