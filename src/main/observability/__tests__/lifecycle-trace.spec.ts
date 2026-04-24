import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetLifecycleTraceForTesting,
  flushLifecycleTraces,
  recordLifecycleTrace,
} from '../lifecycle-trace';

const tempDirs: string[] = [];

describe('lifecycle trace', () => {
  afterEach(async () => {
    _resetLifecycleTraceForTesting();
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('writes lifecycle events as NDJSON with recovery fields', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lifecycle-trace-'));
    tempDirs.push(dir);
    const tracePath = path.join(dir, 'lifecycle.ndjson');

    recordLifecycleTrace({
      instanceId: 'inst-1',
      turnId: 'turn-1',
      adapterGeneration: 3,
      provider: 'codex',
      recoveryReason: 'interrupt',
      eventType: 'status-transition',
      previousStatus: 'busy',
      status: 'interrupting',
    }, tracePath);

    await flushLifecycleTraces();

    const [line] = (await fs.readFile(tracePath, 'utf8')).trim().split('\n');
    expect(JSON.parse(line)).toMatchObject({
      instanceId: 'inst-1',
      turnId: 'turn-1',
      adapterGeneration: 3,
      provider: 'codex',
      recoveryReason: 'interrupt',
      eventType: 'status-transition',
      previousStatus: 'busy',
      status: 'interrupting',
    });
  });

  it('does not reject when the trace path cannot be written', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lifecycle-trace-'));
    tempDirs.push(dir);
    const blockedPath = path.join(dir, 'blocked');
    await fs.writeFile(blockedPath, 'not a directory', 'utf8');

    recordLifecycleTrace({
      instanceId: 'inst-1',
      eventType: 'status-transition',
      status: 'busy',
    }, path.join(blockedPath, 'lifecycle.ndjson'));

    await expect(flushLifecycleTraces()).resolves.toBeUndefined();
  });
});
