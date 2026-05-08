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
  }): string {
    const { config, iterationSeq, pendingInterventions } = args;
    const planRef = config.planFile
      ? `the plan in \`${config.planFile}\` (referred to below as PLAN.md)`
      : 'the prompt below';
    const interventions =
      pendingInterventions.length > 0
        ? `\n\n## User Intervention\nThe operator added the following hint(s) since the last iteration. Treat them as binding direction:\n\n${pendingInterventions.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`
        : '';
    const initialPromptBlock = config.planFile
      ? ''
      : `\n\n## Original Loop Prompt\n${config.initialPrompt}\n`;

    return `# Loop Mode — Iteration ${iterationSeq}

You are running inside an autonomous Loop Mode. State lives on disk; do not rely on chat history. Every iteration is a fresh process.

## Step 1 — Read your state
1. Open \`STAGE.md\`. It contains exactly one of: PLAN, REVIEW, IMPLEMENT.
2. Open ${planRef}.
3. Open \`NOTES.md\`. It contains the rolling notes from prior iterations.
4. Open \`ITERATION_LOG.md\` if you need detailed per-iteration history.${interventions}${initialPromptBlock}

## Step 2 — Do this iteration's work

Based on the value of STAGE.md:

- **PLAN** — Continue or improve the plan. Choose the best architectural decisions. Do not be lazy. Do not take shortcuts. If a plan does not exist yet, draft one.
- **REVIEW** — Re-read the plan with completely fresh eyes. Treat the plan as if a stranger wrote it. Identify and fix issues. Improve clarity, completeness, and correctness. If the plan is sound, say so explicitly.
- **IMPLEMENT** — Implement the next chunk of the plan. Use best architecture. Do not take shortcuts. After implementing, re-review your code with completely fresh eyes and fix anything you'd reject in code review. Run the verify command if you can.

Honor every safety rail: do not run destructive operations (\`rm -rf\`, \`git push --force\`, schema drops) unless the loop config explicitly allows them — this loop ${config.allowDestructiveOps ? 'DOES' : 'DOES NOT'} allow destructive operations.

## Step 3 — Advance state at the end of the iteration

If the work for the current STAGE is complete:
- PLAN done → write \`REVIEW\` into STAGE.md.
- REVIEW done → write \`IMPLEMENT\` into STAGE.md.
- IMPLEMENT done **but plan still has unfinished items** → write \`REVIEW\` into STAGE.md (loop back through review).
- IMPLEMENT done **and plan is fully implemented & verified** →
    1. Run the verify command (\`${config.completion.verifyCommand || '(none configured)'}\`). It must pass.
    2. Append \`<promise>DONE</promise>\` on its own line at the end of your output.
    3. If a plan file exists, rename it: \`mv ${config.planFile ?? '<plan-file>'} ${(config.planFile ?? '<plan-file>').replace(/\.md$/, '_Completed.md')}\` (or use git mv if applicable).
    4. Write \`DONE.txt\` containing the date — this is the sentinel.

If you are blocked and need a human, write \`BLOCKED.md\` describing what you need, then exit.

## Step 4 — Update notes

Append a one-paragraph summary of this iteration to \`NOTES.md\`. Keep it terse — what changed, what's next.

## Step 5 — Exit

Exit the iteration. The loop coordinator will spawn the next one with a fresh context.

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
