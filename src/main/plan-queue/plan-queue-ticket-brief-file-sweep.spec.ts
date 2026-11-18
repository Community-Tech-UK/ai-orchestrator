/** The brief folder's sweep: what it removes and what it leaves, by the item ids it is told to keep. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _setPlanQueueDataDirForTesting } from './plan-queue-data-dir';
import { sweepTicketBriefFiles, TICKET_BRIEF_TEMPORARY_FILE_GRACE_MS } from './plan-queue-ticket-brief-file';

let dataDir: string;
let folder: string;
const NOW = 1_800_000_000_000;

const put = (name: string, modified = NOW) => {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, name), 'x');
  utimesSync(join(folder, name), new Date(modified), new Date(modified));
};

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'brief-sweep-'));
  folder = join(dataDir, 'briefs');
  _setPlanQueueDataDirForTesting(dataDir);
});
afterEach(() => {
  _setPlanQueueDataDirForTesting(null);
  rmSync(dataDir, { recursive: true, force: true });
});

describe('sweepTicketBriefFiles', () => {
  it('removes the brief of every item it is not told to keep, and keeps the others', async () => {
    put('item-a.md');
    put('item-b.md');
    put('item-c.md');
    expect(await sweepTicketBriefFiles((id) => id === 'item-b', NOW)).toBe(2);
    expect([existsSync(join(folder, 'item-a.md')), existsSync(join(folder, 'item-b.md')), existsSync(join(folder, 'item-c.md'))]).toEqual([false, true, false]);
  });

  it('removes a half-written file only once it is older than the grace time', async () => {
    put('.item-a.aaaa.tmp', NOW - TICKET_BRIEF_TEMPORARY_FILE_GRACE_MS + 1_000);
    put('.item-a.bbbb.tmp', NOW - TICKET_BRIEF_TEMPORARY_FILE_GRACE_MS - 1_000);
    expect(await sweepTicketBriefFiles(() => true, NOW)).toBe(1);
    expect([existsSync(join(folder, '.item-a.aaaa.tmp')), existsSync(join(folder, '.item-a.bbbb.tmp'))]).toEqual([true, false]);
  });

  it('leaves a file that is not a brief alone', async () => {
    put('notes.txt');
    put('a b.md');
    expect(await sweepTicketBriefFiles(() => false, NOW)).toBe(0);
    expect(existsSync(join(folder, 'notes.txt'))).toBe(true);
    expect(existsSync(join(folder, 'a b.md'))).toBe(true);
  });

  it('has nothing to do when the folder does not exist', async () => {
    expect(await sweepTicketBriefFiles(() => false, NOW)).toBe(0);
  });
});
