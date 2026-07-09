/**
 * Goal-intent wiring at loop start: an investigation/audit prompt must be
 * detected and must NOT be treated as an implementation task (no plan-file
 * rename gate). An explicit caller intent always wins over detection.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';

let workspace: string;
let coordinator: LoopCoordinator;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-goal-intent-'));
  writeFileSync(join(workspace, 'STAGE.md'), 'IMPLEMENT\n');
  coordinator = new LoopCoordinator();
  coordinator.on('loop:invoke-iteration', (payload: unknown) => {
    const p = payload as { callback: (result: LoopChildResult) => void };
    queueMicrotask(() => {
      p.callback({
        childInstanceId: null,
        output: 'ok',
        tokens: 1,
        filesChanged: [],
        toolCalls: [],
        errors: [],
        testPassCount: null,
        testFailCount: null,
        exitedCleanly: true,
      });
    });
  });
});

afterEach(async () => {
  for (const loop of coordinator.getActiveLoops()) {
    await coordinator.cancelLoop(loop.id).catch(() => undefined);
  }
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('LoopCoordinator — goalIntent derivation', () => {
  it('detects an investigation goal and does not auto-enable the rename gate', async () => {
    // A plan-like markdown file is present — for an IMPLEMENT goal this would
    // auto-enable requireCompletedFileRename. An investigation must not rename it.
    writeFileSync(join(workspace, 'backlog.md'), '# Backlog\n\n- [ ] item\n');

    const state = await coordinator.startLoop('chat-investigation', {
      initialPrompt: 'Is this fully implemented? Please check against the actual code.',
      workspaceCwd: workspace,
    });
    try {
      expect(state.config.goalIntent).toBe('investigation');
      expect(state.config.completion.requireCompletedFileRename).toBe(false);
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  }, 30_000);

  it('classifies a typed audit goal as investigation despite the default impl-verb continuation prompt', async () => {
    // Reproduces the exact renderer path that caused the original failure:
    // the textarea goal becomes initialPrompt; the default Loop panel prompt
    // (DEFAULT_LOOP_PROMPT — full of "update/rename/implement") becomes
    // iterationPrompt. That boilerplate must NOT drag the audit into IMPLEMENT.
    const defaultPanelBoilerplate =
      "Continue toward the user's goal. Read relevant files before changing code, " +
      'choose the maintainable architecture, and make concrete progress this turn. ' +
      'If implementing a plan, update the code and tests until the plan is fully implemented. ' +
      'Verify with the appropriate checks. If a plan file is fully implemented and verified, ' +
      'rename it with _completed before stopping.';
    const state = await coordinator.startLoop('chat-audit-boilerplate', {
      initialPrompt: 'Is this fully implemented? Please be thorough and check against actual code.',
      iterationPrompt: defaultPanelBoilerplate,
      workspaceCwd: workspace,
    });
    try {
      expect(state.config.goalIntent).toBe('investigation');
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  }, 30_000);

  it('keeps the rename gate off for an investigation even when a planFile is configured', async () => {
    writeFileSync(join(workspace, 'audit-plan.md'), '# Plan\n\n- [ ] item\n');
    const state = await coordinator.startLoop('chat-investigation-planfile', {
      initialPrompt: 'Audit whether the plan in audit-plan.md is actually implemented',
      workspaceCwd: workspace,
      planFile: 'audit-plan.md',
    });
    try {
      expect(state.config.goalIntent).toBe('investigation');
      // materializeConfig auto-enables the rename gate for any planFile; the
      // investigation override must turn it back off.
      expect(state.config.completion.requireCompletedFileRename).toBe(false);
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  }, 30_000);

  it('detects an implementation goal as implementation', async () => {
    const state = await coordinator.startLoop('chat-implement', {
      initialPrompt: 'Implement the dark-mode toggle in settings',
      workspaceCwd: workspace,
    });
    try {
      expect(state.config.goalIntent).toBe('implementation');
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  }, 30_000);

  it('honours an explicit caller goalIntent over detection', async () => {
    const state = await coordinator.startLoop('chat-explicit', {
      // Reads like an implementation goal, but the caller forced investigation.
      initialPrompt: 'Implement the parser',
      workspaceCwd: workspace,
      goalIntent: 'investigation',
    });
    try {
      expect(state.config.goalIntent).toBe('investigation');
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  }, 30_000);
});
