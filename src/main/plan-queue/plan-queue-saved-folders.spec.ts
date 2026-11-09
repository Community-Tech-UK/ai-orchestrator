import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveListedWorkspace } from './plan-queue-saved-folders';

describe('resolveListedWorkspace', () => {
  let root: string;
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'pq-folders-'))); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('refuses a folder that is not on the saved list, in plain words, without touching the disk', async () => {
    const topFolderOf = vi.fn();
    await expect(resolveListedWorkspace('/work/other', ['/work/shop'], topFolderOf))
      .rejects.toThrow(/\/work\/other is not on James's Plan Queue folder list.*Only James can add a folder, on the Plan Queue page/);
    expect(topFolderOf).not.toHaveBeenCalled();
  });

  it('refuses every folder when nothing is saved', async () => {
    await expect(resolveListedWorkspace('/work/shop', [], vi.fn())).rejects.toThrow(/not on James's Plan Queue folder list/);
  });

  it('refuses a relative path before looking at the list', async () => {
    const topFolderOf = vi.fn();
    await expect(resolveListedWorkspace('shop', ['shop'], topFolderOf)).rejects.toThrow(/full folder path/);
    expect(topFolderOf).not.toHaveBeenCalled();
  });

  it('allows a listed project folder and returns its top folder', async () => {
    const shop = join(root, 'shop'); mkdirSync(shop);
    await expect(resolveListedWorkspace(shop, [shop], async folder => folder)).resolves.toBe(shop);
  });

  it('matches a differently spelled path to the same folder', async () => {
    const shop = join(root, 'shop'); mkdirSync(shop);
    await expect(resolveListedWorkspace(`${root}/shop/`, [`${root}//other/../shop`], async () => shop)).resolves.toBe(shop);
  });

  it('refuses a listed folder that is only a folder inside a project, naming the top folder', async () => {
    const inner = join(root, 'shop', 'packages'); mkdirSync(inner, { recursive: true });
    await expect(resolveListedWorkspace(inner, [inner], async () => join(root, 'shop')))
      .rejects.toThrow(/is a folder inside the project at .*shop\. Give the project's top folder/);
  });

  it('compares a folder reached through a link by where it really is', async () => {
    const shop = join(root, 'shop'); mkdirSync(shop);
    const link = join(root, 'link'); symlinkSync(shop, link);
    // Git reports the real path; the listed spelling is the link.
    await expect(resolveListedWorkspace(link, [link], async () => shop)).resolves.toBe(shop);
  });
});
