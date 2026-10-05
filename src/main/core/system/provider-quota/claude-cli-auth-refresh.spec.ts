import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClaudeCliAuthRefresh } from './claude-credentials-reader';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('child_process', async (importOriginal) => {
  const mocked = { ...await importOriginal<typeof import('child_process')>(), spawn };
  return { ...mocked, default: mocked };
});

function child() {
  return Object.assign(new EventEmitter(), {
    stdout: { resume: vi.fn() }, stderr: { resume: vi.fn() }, kill: vi.fn(),
  });
}

describe('Claude doctor renewal lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); spawn.mockReset(); });

  it('never starts doctor when readiness defers', async () => {
    expect(await createClaudeCliAuthRefresh(undefined, undefined, async () => false)()).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('drains private output and gives native refresh longer than its 30s HTTP deadline', async () => {
    const proc = child();
    spawn.mockReturnValue(proc);
    const pending = createClaudeCliAuthRefresh(undefined, undefined, async () => true)();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(proc.kill).not.toHaveBeenCalled();
    expect(proc.stdout.resume).toHaveBeenCalled();
    expect(proc.stderr.resume).toHaveBeenCalled();
    proc.emit('close', 0);
    expect(await pending).toBe(true);
  });

  it('coalesces concurrent calls per profile and allows a later retry', async () => {
    const proc = child();
    spawn.mockReturnValue(proc);
    const refresh = createClaudeCliAuthRefresh('/PLACEHOLDER_PROFILE', undefined, async () => true);
    const first = refresh();
    const second = refresh();
    expect(first).toBe(second);
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    const options = spawn.mock.calls[0][2];
    expect(options.env.CLAUDE_CONFIG_DIR).toBe('/PLACEHOLDER_PROFILE');
    expect(options.shell).toBe(false);
    proc.emit('close', 0);
    expect(await first).toBe(true);
    const retry = refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledTimes(2);
    proc.emit('close', 1);
    expect(await retry).toBe(false);
  });

  it('ends a hung doctor at its bounded deadline', async () => {
    const proc = child();
    spawn.mockReturnValue(proc);
    const pending = createClaudeCliAuthRefresh(undefined, undefined, async () => true)();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await pending).toBe(false);
    expect(proc.kill).toHaveBeenCalledTimes(1);
    proc.emit('close', 0);
  });

  it('cleans up the deadline on spawn error', async () => {
    const proc = child();
    spawn.mockReturnValue(proc);
    const pending = createClaudeCliAuthRefresh(undefined, undefined, async () => true)();
    await vi.advanceTimersByTimeAsync(0);
    proc.emit('error', new Error('PLACEHOLDER_SPAWN_ERROR'));
    expect(await pending).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(proc.kill).not.toHaveBeenCalled();
  });
});
