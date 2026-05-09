import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopCoordinator } from './loop-coordinator';
import type { LoopChildResult } from './loop-coordinator';

let workspace: string;
let coordinator: LoopCoordinator;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-double-start-'));
  // Initialise STAGE.md so bootstrap is fast.
  writeFileSync(join(workspace, 'STAGE.md'), 'PLAN\n');
  coordinator = new LoopCoordinator();
  // Register a no-op invoker so runLoop doesn't reject from missing handler.
  // Each iteration "succeeds" instantly — we'll cancel before it spawns again.
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

afterEach(() => {
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

describe('LoopCoordinator double-start guard', () => {
  it('throws when a second loop is started for the same chatId while the first is running', async () => {
    const first = await coordinator.startLoop('chat-A', {
      initialPrompt: 'do thing',
      workspaceCwd: workspace,
    });
    expect(first.status).toMatch(/^(running|paused)$/);
    await expect(
      coordinator.startLoop('chat-A', {
        initialPrompt: 'do other thing',
        workspaceCwd: workspace,
      }),
    ).rejects.toThrow(/already (running|paused) for this chat/);
    coordinator.cancelLoop(first.id);
  });

  it('allows starting on a different chatId concurrently', async () => {
    const a = await coordinator.startLoop('chat-A', {
      initialPrompt: 'a',
      workspaceCwd: workspace,
    });
    const b = await coordinator.startLoop('chat-B', {
      initialPrompt: 'b',
      workspaceCwd: workspace,
    });
    expect(a.id).not.toBe(b.id);
    expect(a.chatId).toBe('chat-A');
    expect(b.chatId).toBe('chat-B');
    coordinator.cancelLoop(a.id);
    coordinator.cancelLoop(b.id);
  });
});

describe('LoopCoordinator runtime context', () => {
  it('injects existing-session context into the child prompt without storing it in config', async () => {
    const marker = 'runtime-existing-session-marker';
    let resolvePrompt!: (prompt: string) => void;
    const promptSeen = new Promise<string>((resolve) => {
      resolvePrompt = resolve;
    });
    const coord = new LoopCoordinator();
    coord.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { prompt: string; callback: (result: LoopChildResult) => void };
      resolvePrompt(p.prompt);
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

    const state = await coord.startLoop(
      'chat-context',
      {
        initialPrompt: 'current loop goal',
        workspaceCwd: workspace,
      },
      undefined,
      { existingSessionContext: marker },
    );
    const prompt = await promptSeen;

    expect(state.config.initialPrompt).toBe('current loop goal');
    expect(state.config.initialPrompt).not.toContain(marker);
    expect(prompt).toContain('Existing Session Context (read-only background)');
    expect(prompt).toContain(marker);
    expect(prompt).toContain('current loop goal');

    await coord.cancelLoop(state.id);
  });
});

describe('LoopCoordinator cancel-on-hung-iteration', () => {
  it('terminates state immediately when cancel is requested with an in-flight iteration', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'loop-cancel-hung-'));
    writeFileSync(join(ws, 'STAGE.md'), 'PLAN\n');
    const coord = new LoopCoordinator();
    // Register an invoker that NEVER calls back — simulates a hung CLI.
    coord.on('loop:invoke-iteration', () => { /* never resolves */ });

    const cancelledEvents: unknown[] = [];
    coord.on('loop:cancelled', (e) => cancelledEvents.push(e));
    const stateChanges: { status: string }[] = [];
    coord.on('loop:state-changed', (e) => {
      const data = e as { state: { status: string } };
      stateChanges.push({ status: data.state.status });
    });

    const state = await coord.startLoop('chat-hung', {
      initialPrompt: 'do something',
      workspaceCwd: ws,
    });
    expect(state.status).toBe('running');

    // Cancel while the iteration is still in flight.
    const ok = await coord.cancelLoop(state.id);
    expect(ok).toBe(true);

    // Live state must reflect the cancellation immediately, not after the
    // iteration eventually times out.
    const live = coord.getLoop(state.id);
    expect(live?.status).toBe('cancelled');
    expect(cancelledEvents).toHaveLength(1);
    expect(stateChanges.some((s) => s.status === 'cancelled')).toBe(true);

    // Calling cancel again is a no-op (idempotent).
    const second = await coord.cancelLoop(state.id);
    expect(second).toBe(false);
    expect(cancelledEvents).toHaveLength(1);

    rmSync(ws, { recursive: true, force: true });
  });
});
