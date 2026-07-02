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

  it('redacts secrets from metadata and error fields before writing (Task 14)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lifecycle-trace-'));
    tempDirs.push(dir);
    const tracePath = path.join(dir, 'lifecycle.ndjson');
    const secret = 'sk-1234567890abcdefghij';

    recordLifecycleTrace({
      instanceId: 'inst-1',
      eventType: 'recovery',
      errorClass: `auth failure using ${secret}`,
      metadata: {
        apiKey: secret,
        detail: `request rejected: Bearer abcdef1234567890ghijkl`,
        durationMs: 42,
      },
    }, tracePath);

    await flushLifecycleTraces();

    const contents = await fs.readFile(tracePath, 'utf8');
    expect(contents).not.toContain(secret);
    expect(contents).not.toContain('abcdef1234567890ghijkl');
    const record = JSON.parse(contents.trim());
    expect(record.errorClass).toContain('<redacted-secret>');
    expect(record.metadata.apiKey).toBe('<redacted-secret>');
    expect(record.metadata.detail).toContain('Bearer <redacted-secret>');
    // Operational fields survive redaction.
    expect(record.instanceId).toBe('inst-1');
    expect(record.eventType).toBe('recovery');
    expect(record.metadata.durationMs).toBe(42);
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
