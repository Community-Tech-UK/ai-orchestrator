import { describe, expect, it, vi } from 'vitest';
import { runLoopCli } from './loop-cli';
import type { OrchestratorToolsRpcClientLike } from './orchestrator-tools-rpc-client';

function stdoutText(stdout: ReturnType<typeof vi.fn>): string {
  return stdout.mock.calls.map((call) => String(call[0])).join('');
}

function clientReturning(result: unknown): OrchestratorToolsRpcClientLike & {
  call: ReturnType<typeof vi.fn>;
} {
  return { call: vi.fn(async () => result) };
}

const PARKED_RUN = {
  loopRunId: 'loop-1789608176316-f9af53a7',
  status: 'provider-limit',
  startedAt: 1789608178949,
  endedAt: null,
  endReason: 'Parked on a recorded provider limit from loop-quota',
  totalIterations: 0,
  workspaceCwd: '/Users/x/work/repo',
  goal: 'Please work through all the livetests, fix any issues you find.',
  live: false,
  checkpointAvailable: true,
  resumable: true,
};

describe('loop-cli', () => {
  it('prints help without contacting the parent RPC server', async () => {
    const stdout = vi.fn();
    const client = clientReturning({});

    await runLoopCli([], { client, stdout });

    expect(client.call).not.toHaveBeenCalled();
    expect(stdoutText(stdout)).toContain('aio-mcp loop resume <loop-run-id>');
  });

  it('points at aio-loop-control for ending the current loop', async () => {
    const stdout = vi.fn();
    await runLoopCli(['--help'], { client: clientReturning({}), stdout });

    expect(stdoutText(stdout)).toContain('aio-loop-control');
  });

  it('rejects unknown commands and options before any RPC call', async () => {
    const client = clientReturning({});

    await expect(runLoopCli(['restart'], { client, stdout: vi.fn() }))
      .rejects.toThrow(/Unknown loop command: restart/);
    await expect(runLoopCli(['list', '--wat'], { client, stdout: vi.fn() }))
      .rejects.toThrow(/Unknown loop list option: --wat/);
    await expect(runLoopCli(['resume', '--wat'], { client, stdout: vi.fn() }))
      .rejects.toThrow(/Unknown loop resume option: --wat/);
    expect(client.call).not.toHaveBeenCalled();
  });

  it('requires a loop id for resume', async () => {
    const client = clientReturning({});

    await expect(runLoopCli(['resume'], { client, stdout: vi.fn() }))
      .rejects.toThrow(/loop resume requires <loop-run-id>/);
    expect(client.call).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range --limit before any RPC call', async () => {
    const client = clientReturning({});

    await expect(runLoopCli(['list', '--limit', '0'], { client, stdout: vi.fn() }))
      .rejects.toThrow(/--limit must be an integer between 1 and 200/);
    await expect(runLoopCli(['list', '--limit=500'], { client, stdout: vi.fn() }))
      .rejects.toThrow(/--limit must be an integer between 1 and 200/);
    expect(client.call).not.toHaveBeenCalled();
  });

  it('lists resumable loops with the exact command that resumes each one', async () => {
    const stdout = vi.fn();
    const client = clientReturning({ count: 1, runs: [PARKED_RUN] });

    await runLoopCli(['list'], { client, stdout });

    expect(client.call).toHaveBeenCalledWith(
      'orchestrator_tools.loop.list',
      { all: false, limit: 50 },
    );
    const text = stdoutText(stdout);
    expect(text).toContain('Resumable loops: 1');
    expect(text).toContain('provider-limit (parked)');
    expect(text).toContain('resume: aio-mcp loop resume loop-1789608176316-f9af53a7');
  });

  it('forwards --all and --limit and marks runs that cannot resume', async () => {
    const stdout = vi.fn();
    const client = clientReturning({
      count: 1,
      runs: [{
        ...PARKED_RUN,
        status: 'cap-reached',
        endedAt: 1789660971684,
        endReason: 'cap=iterations; after 50 iteration(s)',
        checkpointAvailable: false,
        resumable: false,
      }],
    });

    await runLoopCli(['list', '--all', '--limit', '5'], { client, stdout });

    expect(client.call).toHaveBeenCalledWith(
      'orchestrator_tools.loop.list',
      { all: true, limit: 5 },
    );
    const text = stdoutText(stdout);
    expect(text).toContain('Loop runs: 1');
    expect(text).toContain('not resumable: cap-reached is a terminal state');
  });

  it('explains the empty case differently for the filtered and --all views', async () => {
    const filtered = vi.fn();
    await runLoopCli(['list'], { client: clientReturning({ count: 0, runs: [] }), stdout: filtered });
    expect(stdoutText(filtered)).toContain('No resumable loops');

    const all = vi.fn();
    await runLoopCli(['list', '--all'], { client: clientReturning({ count: 0, runs: [] }), stdout: all });
    expect(stdoutText(all)).toContain('No loop runs recorded.');
  });

  it('resumes a loop and reports the status transition', async () => {
    const stdout = vi.fn();
    const client = clientReturning({
      loopRunId: 'loop-1',
      resumed: true,
      status: 'running',
      previousStatus: 'provider-limit',
      restoredFromCheckpoint: true,
    });

    await runLoopCli(['resume', 'loop-1'], { client, stdout });

    expect(client.call).toHaveBeenCalledWith(
      'orchestrator_tools.loop.resume',
      { loopRunId: 'loop-1' },
    );
    const text = stdoutText(stdout);
    expect(text).toContain('Resumed loop-1 (re-hydrated from its stored checkpoint)');
    expect(text).toContain('provider-limit -> running');
  });

  it('emits machine-readable output with --json', async () => {
    const stdout = vi.fn();
    const result = {
      loopRunId: 'loop-1',
      resumed: true,
      status: 'running',
      previousStatus: 'paused',
      restoredFromCheckpoint: false,
    };

    await runLoopCli(['resume', 'loop-1', '--json'], { client: clientReturning(result), stdout });

    expect(JSON.parse(stdoutText(stdout))).toEqual(result);
  });

  it('refuses to print a result the parent could not produce in the agreed shape', async () => {
    const client = clientReturning({ loopRunId: 'loop-1', resumed: false });

    await expect(runLoopCli(['resume', 'loop-1'], { client, stdout: vi.fn() }))
      .rejects.toThrow(/invalid loop resume result/);
  });

  it('surfaces the parent refusal message verbatim', async () => {
    const client: OrchestratorToolsRpcClientLike = {
      call: vi.fn(async () => {
        throw new Error('Loop loop-1 is cap-reached, which is terminal.');
      }),
    };

    await expect(runLoopCli(['resume', 'loop-1'], { client, stdout: vi.fn() }))
      .rejects.toThrow(/cap-reached, which is terminal/);
  });
});
