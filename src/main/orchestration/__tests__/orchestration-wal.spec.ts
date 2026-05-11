import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { OrchestrationWAL } from '../orchestration-wal';

describe('OrchestrationWAL', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-wal-'));
    OrchestrationWAL._resetForTesting();
  });

  afterEach(() => {
    OrchestrationWAL._resetForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends JSONL entries one per call', () => {
    const wal = OrchestrationWAL.getInstance(tmpDir);
    wal.append({ ts: 1000, kind: 'debate:round-start', runId: 'r1' });
    wal.append({ ts: 2000, kind: 'debate:verdict', runId: 'r1', payload: { winner: 'b' } });

    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    const lines = fs
      .readFileSync(path.join(tmpDir, files[0]), 'utf-8')
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).kind).toBe('debate:round-start');
    expect(JSON.parse(lines[1]).payload.winner).toBe('b');
  });

  it('redacts sensitive keys', () => {
    const wal = OrchestrationWAL.getInstance(tmpDir);
    wal.append({
      ts: 0,
      kind: 'orchestration:start',
      payload: { prompt: 'top secret', apiKey: 'sk-xxx', other: 'ok' },
    });
    const files = fs.readdirSync(tmpDir);
    const line = fs.readFileSync(path.join(tmpDir, files[0]), 'utf-8').trim();
    const parsed = JSON.parse(line);
    expect(parsed.payload.prompt).toBe('<redacted>');
    expect(parsed.payload.apiKey).toBe('<redacted>');
    expect(parsed.payload.other).toBe('ok');
  });

  it('disable() suppresses writes', () => {
    const wal = OrchestrationWAL.getInstance(tmpDir);
    wal.disable();
    wal.append({ ts: 0, kind: 'orchestration:start' });
    const files = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];
    expect(files).toHaveLength(0);
  });
});
