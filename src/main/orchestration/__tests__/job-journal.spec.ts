import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { JobJournal } from '../job-journal';

describe('JobJournal', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-jobjournal-'));
    JobJournal._resetForTesting();
  });

  afterEach(() => {
    JobJournal._resetForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists job lifecycle to JSONL', () => {
    const journal = JobJournal.getInstance(tmpDir);

    journal.start('debate-1', 'Debate', { topic: 'foo' });
    journal.complete('debate-1', { rounds: 3 });

    const lines = fs
      .readFileSync(path.join(tmpDir, 'jobs.jsonl'), 'utf-8')
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(first.id).toBe('debate-1');
    expect(first.status).toBe('running');
    expect(second.status).toBe('completed');
    expect(second.metadata).toMatchObject({ topic: 'foo', rounds: 3 });
  });

  it('replays existing journal on second getInstance', () => {
    const journal1 = JobJournal.getInstance(tmpDir);
    journal1.start('verify-1', 'Verify');
    journal1.fail('verify-1', 'broken');

    // Simulate process restart
    JobJournal._resetForTesting();
    const journal2 = JobJournal.getInstance(tmpDir);
    const record = journal2.get('verify-1');
    expect(record).toBeDefined();
    expect(record!.status).toBe('failed');
    expect(record!.error).toBe('broken');
  });

  it('list() can filter by status', () => {
    const journal = JobJournal.getInstance(tmpDir);
    journal.start('a', 'A');
    journal.start('b', 'B');
    journal.complete('a');

    expect(journal.list({ status: 'running' }).map((j) => j.id)).toEqual(['b']);
    expect(journal.list({ status: 'completed' }).map((j) => j.id)).toEqual(['a']);
  });
});
