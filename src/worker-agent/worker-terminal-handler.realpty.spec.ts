/**
 * Real-PTY integration test (no mock): exercises WorkerTerminalHandler with the
 * actual node-pty native module, which also covers `lazyDefaultSpawn` and the
 * `ensureSpawnHelperExecutable` chmod fix. Skips automatically where node-pty
 * can't load (e.g. an unsupported platform with no prebuild).
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerTerminalHandler } from './worker-terminal-handler';

const nodePtyAvailable = await (async (): Promise<boolean> => {
  try {
    await import('node-pty');
    return true;
  } catch {
    return false;
  }
})();

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('WorkerTerminalHandler (real node-pty)', () => {
  it.skipIf(!nodePtyAvailable)(
    'spawns a real PTY, echoes input, and reports a clean exit',
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'aio-pty-')));
      const outputs: string[] = [];
      let exited: { code: number | null; signal: string | null } | null = null;

      const handler = new WorkerTerminalHandler([root], {
        onOutput: (_sessionId, data) => outputs.push(data),
        onExit: (_sessionId, code, signal) => {
          exited = { code, signal };
        },
      });

      try {
        const { pid } = handler.create({ sessionId: 't1', cwd: root });
        expect(pid).toBeGreaterThan(0);

        handler.input('t1', 'echo REALPTY_OK\r');
        await waitFor(() => outputs.join('').includes('REALPTY_OK'), 5000);
        expect(outputs.join('')).toContain('REALPTY_OK');

        handler.input('t1', 'exit\r');
        await waitFor(() => exited !== null, 5000);
        expect(exited).not.toBeNull();
        expect(handler.sessionCount()).toBe(0);
      } finally {
        handler.killAll();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
