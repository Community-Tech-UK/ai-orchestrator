import { describe, expect, it } from 'vitest';

import { MockCliHarness } from './cli-mock-harness';

function collectStdout(proc: ReturnType<MockCliHarness['createProcess']>): Promise<string[]> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    proc.stdout.on('data', (chunk: Buffer) => lines.push(chunk.toString()));
    proc.once('close', () => resolve(lines));
  });
}

describe('MockCliHarness', () => {
  it('responds to stdin triggers with scripted stdout', async () => {
    const harness = new MockCliHarness();
    harness.script([{ trigger: 'ping', response: 'pong\n' }]);
    const proc = harness.createProcess();

    const linesPromise = collectStdout(proc);
    proc.stdin.write('ping\n');
    harness.exit();

    const lines = await linesPromise;
    expect(lines.join('')).toContain('pong');
  });

  it('emits a scripted exit code when configured', async () => {
    const harness = new MockCliHarness();
    harness.script([{ trigger: 'crash-me', exitCode: 2 }]);
    const proc = harness.createProcess();

    const closedWith = await new Promise<number | null>((resolve) => {
      proc.once('close', (code) => resolve(code));
      proc.stdin.write('crash-me\n');
    });

    expect(closedWith).toBe(2);
  });

  it('kill() sets killed and emits lifecycle events', async () => {
    const harness = new MockCliHarness();
    const proc = harness.createProcess();

    const exitedWith = await new Promise<number | null>((resolve) => {
      proc.once('exit', (code) => resolve(code));
      proc.kill('SIGTERM');
    });

    expect(proc.killed).toBe(true);
    expect(exitedWith).toBe(0);
  });

  it('emitStdout() works before any stdin is written', async () => {
    const harness = new MockCliHarness();
    const proc = harness.createProcess();

    const linePromise = new Promise<string>((resolve) => {
      proc.stdout.once('data', (chunk: Buffer) => resolve(chunk.toString()));
    });

    harness.emitStdout('startup-banner\n');
    expect(await linePromise).toBe('startup-banner\n');
  });

  it('crash() emits a non-zero close code', async () => {
    const harness = new MockCliHarness();
    const proc = harness.createProcess();

    const closedWith = new Promise<number | null>((resolve) => {
      proc.once('close', (code) => resolve(code));
    });

    harness.crash(137);
    expect(await closedWith).toBe(137);
  });
});
