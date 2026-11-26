import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { waitForChangeClockTick } from '../testing/change-clock.test-helpers';
import {
  ATTACHMENT_SESSION_MAX_AGE_MS,
  listAttachmentFolders,
  removeAttachmentSessions,
} from './attachments-folders';

let root: string;

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

const NOW = 100 * 24 * 60 * 60 * 1000;

async function makeProject(): Promise<string> {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'attachments-folders-')));
  const project = join(root, 'project');
  await fs.mkdir(project);
  return project;
}

describe('listAttachmentFolders', () => {
  it('counts sessions and offers only copies last changed more than 30 days ago', async () => {
    const project = await makeProject();
    const folder = join(project, '.claude-attachments');
    await fs.mkdir(join(folder, 'old-session'), { recursive: true });
    await fs.writeFile(join(folder, 'old-session', 'paste.txt'), Buffer.alloc(50));
    await fs.utimes(join(folder, 'old-session', 'paste.txt'), new Date(NOW - ATTACHMENT_SESSION_MAX_AGE_MS - 1000), new Date(NOW - ATTACHMENT_SESSION_MAX_AGE_MS - 1000));
    await fs.mkdir(join(folder, 'fresh-session'));
    await fs.writeFile(join(folder, 'fresh-session', 'shot.png'), Buffer.alloc(30));

    const [usage] = await listAttachmentFolders([project], NOW);

    expect(usage.path).toBe(folder);
    expect(usage.bytes).toBe(80);
    expect(usage.totalSessions).toBe(2);
    expect(usage.clearable.map(session => session.path)).toEqual([join(folder, 'old-session')]);
    expect(usage.clearable[0].bytes).toBe(50);
  });

  it('skips missing folders and link folders, and never follows links', async () => {
    const project = await makeProject();
    const outside = join(root, 'outside');
    await fs.mkdir(join(outside, 'session'), { recursive: true });
    await fs.writeFile(join(outside, 'session', 'x'), Buffer.alloc(40));
    await fs.symlink(outside, join(project, '.claude-attachments'));

    expect(await listAttachmentFolders([project], NOW)).toEqual([]);
    expect(await listAttachmentFolders([join(root, 'missing')], NOW)).toEqual([]);
  });
});

describe('removeAttachmentSessions', () => {
  it('counts a valid empty session file without inventing freed bytes', async () => {
    const project = await makeProject();
    const folder = join(project, '.claude-attachments');
    await fs.mkdir(folder);
    await fs.writeFile(join(folder, 'empty'), '');
    await fs.utimes(join(folder, 'empty'), new Date(1), new Date(1));
    const [usage] = await listAttachmentFolders([project], NOW);
    expect(await removeAttachmentSessions(usage.clearable)).toEqual({ removed: 1, bytesFreed: 0 });
    await expect(fs.stat(join(folder, 'empty'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['retained', 'nested-selected', 'session-selected'] as const)('counts actual reclaimed hard-link content for %s links', async kind => {
    const project = await makeProject();
    const folder = join(project, '.claude-attachments');
    const session = join(folder, 'old-session');
    await fs.mkdir(session, { recursive: true });
    const first = join(session, 'first');
    await fs.writeFile(first, Buffer.alloc(1024));
    const second = kind === 'retained' ? join(root, 'retained')
      : kind === 'session-selected' ? join(folder, 'other-session') : join(session, 'second');
    await fs.link(first, second);
    await fs.utimes(first, new Date(1), new Date(1));
    const [usage] = await listAttachmentFolders([project], NOW);
    expect(await removeAttachmentSessions(usage.clearable)).toEqual({
      removed: kind === 'session-selected' ? 2 : 1,
      bytesFreed: kind === 'retained' ? 0 : 1024,
    });
    expect(await fs.readdir(folder)).toEqual([]);
    if (kind === 'retained') expect((await fs.lstat(second)).size).toBe(1024);
  });

  it('leaves a session containing a nested symlink and its retained target intact', async () => {
    const project = await makeProject();
    const session = join(project, '.claude-attachments', 'old');
    await fs.mkdir(session, { recursive: true });
    const retained = join(root, 'retained');
    await fs.writeFile(retained, Buffer.alloc(1024));
    await fs.symlink(retained, join(session, 'linked'));
    const stat = await fs.lstat(session);
    expect(await removeAttachmentSessions([{ path: session, bytes: 0, createdAt: 0, inode: stat.ino, changedAt: stat.ctimeMs }]))
      .toEqual({ removed: 0, bytesFreed: 0 });
    expect((await fs.lstat(retained)).size).toBe(1024);
    expect((await fs.lstat(join(session, 'linked'))).isSymbolicLink()).toBe(true);
  });

  it('keeps a replacement session copy at the same path', async () => {
    const project = await makeProject();
    const folder = join(project, '.claude-attachments');
    await fs.mkdir(folder);
    const copy = join(folder, 'old');
    await fs.writeFile(copy, Buffer.alloc(11));
    await fs.utimes(copy, new Date(1), new Date(1));
    const [usage] = await listAttachmentFolders([project], NOW);
    await fs.unlink(copy);
    waitForChangeClockTick(); // ext4 may hand the replacement the same inode number
    await fs.writeFile(copy, Buffer.alloc(11));
    await fs.utimes(copy, new Date(1), new Date(1));
    expect(await removeAttachmentSessions(usage.clearable)).toEqual({ removed: 0, bytesFreed: 0 });
    expect((await fs.stat(copy)).size).toBe(11);
  });
  it('removes the listed session copies and keeps the rest', async () => {
    const project = await makeProject();
    const folder = join(project, '.claude-attachments');
    await fs.mkdir(join(folder, 'old-session'), { recursive: true });
    await fs.writeFile(join(folder, 'old-session', 'paste.txt'), Buffer.alloc(50));
    await fs.mkdir(join(folder, 'fresh-session'));
    await fs.writeFile(join(folder, 'fresh-session', 'shot.png'), Buffer.alloc(30));

    await fs.utimes(join(folder, 'old-session', 'paste.txt'), new Date(1), new Date(1));
    const [usage] = await listAttachmentFolders([project], NOW);
    const removed = await removeAttachmentSessions(usage.clearable);

    expect(removed).toEqual({ removed: 1, bytesFreed: 50 });
    expect(await fs.readdir(folder)).toEqual(['fresh-session']);
  });

  it('refuses a target outside a .claude-attachments folder and skips vanished copies', async () => {
    const project = await makeProject();
    const folder = join(project, '.claude-attachments');
    await fs.mkdir(folder, { recursive: true });
    await expect(removeAttachmentSessions([{ path: join(project, 'other', 'x'), bytes: 1, createdAt: 1, inode: 1, changedAt: 1 }]))
      .rejects.toThrow('The file location changed');
    expect(await removeAttachmentSessions([{ path: join(folder, 'gone'), bytes: 1, createdAt: 1, inode: 1, changedAt: 1 }]))
      .toEqual({ removed: 0, bytesFreed: 0 });
  });
});
