import { describe, it, expect, vi } from 'vitest';
import { runPauseCli } from './pause-cli';

describe('pause CLI', () => {
  it.each(['restart', 'resume', 'discard', 'unknown'])('rejects operator-only or unknown command %s', async command => {
    const call = vi.fn();
    await expect(runPauseCli([command], { client: { call }, stdout: vi.fn() })).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });
  it('sends hold through the parent RPC without leaking session notes', async () => {
    const call = vi.fn(async () => ({ phase: 'holding', since: 1000, reason: 'Held by James' }));
    const stdout = vi.fn();
    await runPauseCli(['hold', '--json'], { client: { call }, stdout });
    expect(call).toHaveBeenCalledWith('orchestrator_tools.pause.hold', {});
    expect(JSON.parse(stdout.mock.calls[0][0])).toEqual({ phase: 'holding', since: 1000, reason: 'Held by James' });
  });
  it('rejects unexpected options before making a request', async () => {
    const call = vi.fn();
    await expect(runPauseCli(['hold', '--restart'], { client: { call } })).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });
});
