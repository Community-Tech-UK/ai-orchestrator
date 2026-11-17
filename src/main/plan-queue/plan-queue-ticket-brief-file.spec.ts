import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _setPlanQueueDataDirForTesting } from './plan-queue-data-dir';
import { deleteTicketBriefFile, ticketBriefPath, writeTicketBriefFile } from './plan-queue-ticket-brief-file';

let root: string;
let dataDir: string;
let repoRoot: string;
let workFolder: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brief-file-')));
  dataDir = path.join(root, 'data');
  repoRoot = path.join(root, 'repo');
  workFolder = path.join(repoRoot, '.worktrees', 'queue', 'item-1');
  fs.mkdirSync(workFolder, { recursive: true });
  _setPlanQueueDataDirForTesting(dataDir);
});
afterEach(() => {
  _setPlanQueueDataDirForTesting(null);
  fs.rmSync(root, { recursive: true, force: true });
});

const write = (brief: string, itemId = 'item-1') => writeTicketBriefFile({ itemId, brief, repoRoot, workFolder });

describe('the ticket brief file', () => {
  it('is <data folder>/briefs/<item id>.md, holds the whole brief, and is for the owner only', async () => {
    const file = await write('x'.repeat(20_000));
    expect(file).toBe(path.join(dataDir, 'briefs', 'item-1.md'));
    expect(file).toBe(ticketBriefPath('item-1'));
    expect(fs.readFileSync(file, 'utf8')).toHaveLength(20_000);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o077).toBe(0);
  });

  it('is replaced whole by a second write, leaving no other file beside it', async () => {
    await write('the first brief, which is the longer one');
    const file = await write('second');
    expect(fs.readFileSync(file, 'utf8')).toBe('second');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['item-1.md']);
  });

  it('keeps the owner-only permissions when it replaces a file that was readable by others', async () => {
    const file = await write('first');
    fs.chmodSync(file, 0o644);
    await write('second');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses a data folder inside the repository, and creates nothing', async () => {
    _setPlanQueueDataDirForTesting(path.join(repoRoot, 'data'));
    await expect(write('brief')).rejects.toThrow('never written inside a repository or a work folder');
    expect(fs.existsSync(path.join(repoRoot, 'data'))).toBe(false);
  });

  it('refuses a data folder inside the item\'s work folder, and creates nothing', async () => {
    const elsewhere = path.join(root, 'other-repo');
    fs.mkdirSync(elsewhere);
    _setPlanQueueDataDirForTesting(path.join(workFolder, 'data'));
    await expect(writeTicketBriefFile({ itemId: 'item-1', brief: 'brief', repoRoot: elsewhere, workFolder })).rejects.toThrow('never written inside');
    expect(fs.existsSync(path.join(workFolder, 'data'))).toBe(false);
  });

  it('refuses a data folder that is a link into the repository', async () => {
    fs.symlinkSync(repoRoot, dataDir);
    await expect(write('brief')).rejects.toThrow('never written inside');
    expect(fs.readdirSync(repoRoot)).toEqual(['.worktrees']);
  });

  it('refuses an item id that could name another folder', async () => {
    await expect(write('brief', '../escape')).rejects.toThrow('plain item id');
    expect(() => ticketBriefPath('a/b')).toThrow('plain item id');
  });

  it('is deleted by its one delete function, and deleting a brief that is not there is fine', async () => {
    const file = await write('brief');
    await deleteTicketBriefFile('item-1');
    expect(fs.existsSync(file)).toBe(false);
    await expect(deleteTicketBriefFile('item-1')).resolves.toBeUndefined();
  });
});
