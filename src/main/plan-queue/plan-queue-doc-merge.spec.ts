import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const hook = vi.hoisted(() => ({ beforeManifest: null as (() => Promise<void>) | null,
  beforeWrite: null as (() => Promise<void>) | null, beforeRead: null as (() => Promise<void>) | null,
  beforeRename: null as (() => Promise<void>) | null, target: '' }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    if (String(args[0]) === hook.target && args[1] === 'w' && hook.beforeWrite) {
      const run = hook.beforeWrite; hook.beforeWrite = null; await run();
    }
    if (String(args[0]).endsWith('manifest.json') && hook.beforeManifest) {
      const run = hook.beforeManifest; hook.beforeManifest = null; await run();
    }
    return actual.open(...args);
  }, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    if (String(args[0]) === hook.target && hook.beforeRead) {
      const run = hook.beforeRead; hook.beforeRead = null; await run();
    }
    return actual.readFile(...args);
  }, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (String(args[0]) === hook.target && hook.beforeRename) {
      const run = hook.beforeRename; hook.beforeRename = null; await run();
    }
    return actual.rename(...args);
  } };
});
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { integrationOwnershipRef, promoteIntegrationBranch } from '../workspace/git/worktree-integration';
import { createDocumentOverlapResolver, recoverDocumentMergeForItem, recoverInterruptedDocumentMerges } from './plan-queue-doc-merge';
import { newPlanQueueItem } from './plan-queue-state';
import type { PlanQueueStore } from './plan-queue-store';

// Every test drives real git through many child processes. Alone each takes
// about a second, but under the full suite's load several exceeded the 5s
// default budget, so give the file the same generous budget as the other
// real-git specs.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let repo: string;
const base = '# Register\n| ID | Note |\n| --- | --- |\n\n# Details\nBase.\n';
const append = (id: string) => base.replace('| --- | --- |\n', `| --- | --- |\n| ${id} | note |\n`) + `\n## ${id}\nDetails.\n`;
const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let baseTip: string;
let integrationTip: string;

beforeEach(async () => {
  hook.beforeManifest = null;
  hook.beforeWrite = null; hook.beforeRead = null; hook.beforeRename = null; hook.target = '';
  GitWriteQueue._resetForTesting();
  repo = await mkdtemp(join(tmpdir(), 'queue-doc-merge-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Queue Test']);
  git(['config', 'user.email', 'queue@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  await writeFile(join(repo, 'register.md'), base);
  await writeFile(join(repo, 'source.ts'), 'base\n');
  git(['add', '.']); git(['commit', '-qm', 'base']); baseTip = git(['rev-parse', 'HEAD']);
});
afterEach(async () => { await rm(repo, { recursive: true, force: true }); GitWriteQueue._resetForTesting(); });

async function prepare(ours: string, theirs: string, path = 'register.md') {
  await writeFile(join(repo, path), theirs);
  git(['add', '--', path]); git(['commit', '-qm', 'item']);
  integrationTip = git(['rev-parse', 'HEAD']);
  git(['branch', '-f', 'integration/item', integrationTip]);
  git(['update-ref', integrationOwnershipRef('integration/item'), integrationTip]);
  git(['reset', '--hard', baseTip]);
  await writeFile(join(repo, path), ours);
}

const promote = () => promoteIntegrationBranch(repo, 'main', 'integration/item', integrationTip, {
  dirtyRootPolicy: 'block-overlap', resolveDirtyOverlap: createDocumentOverlapResolver({ itemId: 'item-1' }),
});

function recoveryStore() {
  let item = newPlanQueueItem('item-1', 'run-1', join(repo, 'x_plan.md'), 1, { state: 'parked', detail: 'Merge blocked.' });
  return {
    listWorkspaceRoots: () => [repo], getItem: () => item,
    getRun: () => ({ workspaceCwd: repo }), upsertItem: (next: typeof item) => { item = next; },
  } as unknown as Pick<PlanQueueStore, 'listWorkspaceRoots' | 'getItem' | 'getRun' | 'upsertItem'>;
}

describe('document-only landing overlap', () => {
  async function twoDocuments() {
    const content = 'first\n\nsecond\n\nthird\n';
    for (const file of ['register.md', 'second.md']) await writeFile(join(repo, file), content);
    git(['add', '.']); git(['commit', '-qm', 'two documents']); baseTip = git(['rev-parse', 'HEAD']);
    for (const file of ['register.md', 'second.md']) await writeFile(join(repo, file), content.replace('third', 'item'));
    git(['add', '.']); git(['commit', '-qm', 'item']); integrationTip = git(['rev-parse', 'HEAD']);
    git(['branch', '-f', 'integration/item', integrationTip]); git(['update-ref', integrationOwnershipRef('integration/item'), integrationTip]);
    git(['reset', '--hard', baseTip]);
    for (const file of ['register.md', 'second.md']) await writeFile(join(repo, file), content.replace('first', 'ours'));
    return { repoRoot: repo, baseTip, integrationTip, overlaps: ['register.md', 'second.md'].map((path) => ({ path, status: ' M' })) };
  }

  it.each(['finish', 'undo', 'recovery'] as const)('preserves a later human edit to the second document during %s', async (operation) => {
    const input = await twoDocuments();
    const backup = join(repo, '.git/aio-plan-queue/doc-merge/item-1');
    let injected = false;
    hook.target = join(await realpath(repo), 'register.md');
    hook.beforeWrite = async () => { injected = true; await writeFile(join(repo, 'second.md'), 'later human edit\n'); };
    if (operation === 'finish') {
      // The fast-forward advanced HEAD, so the promotion is reported as real;
      // only the document writes were interrupted, with the backup named.
      expect(await promote()).toMatchObject({ status: 'promoted', tip: integrationTip, documentMergeInterrupted: expect.stringContaining('doc-merge/item-1') });
    } else {
      const prepared = await createDocumentOverlapResolver({ itemId: 'item-1' }).prepare(input);
      expect(prepared.ok).toBe(true); if (!prepared.ok) return;
      if (operation === 'undo') await expect(prepared.undo()).rejects.toThrow(/second.md.*backup kept/);
      else {
        git(['merge', '--ff-only', integrationTip]); const store = recoveryStore();
        await recoverInterruptedDocumentMerges(store);
        expect(store.getItem('item-1')?.detail).toContain('second.md');
      }
    }
    expect(injected).toBe(true);
    expect(await readFile(join(repo, 'second.md'), 'utf8')).toBe('later human edit\n');
    for (const index of [0, 1]) {
      expect(await readFile(join(backup, `ours-${index}`), 'utf8')).toBe('ours\n\nsecond\n\nthird\n');
      expect(await readFile(join(backup, `merged-${index}`), 'utf8')).toBe('ours\n\nsecond\n\nitem\n');
    }
    expect(await recoverDocumentMergeForItem(repo, 'item-1')).toMatchObject({ ok: false, reason: expect.stringContaining('second.md') });
    expect(await readFile(join(repo, 'second.md'), 'utf8')).toBe('later human edit\n');
    expect(await readFile(join(backup, 'ours-0'), 'utf8')).toContain('ours');
  });

  it('rechecks document bytes after reading a recovery backup', async () => {
    const prepared = await createDocumentOverlapResolver({ itemId: 'item-1' }).prepare(await twoDocuments());
    expect(prepared.ok).toBe(true); git(['merge', '--ff-only', integrationTip]);
    hook.target = join(await realpath(repo), '.git/aio-plan-queue/doc-merge/item-1/merged-1');
    hook.beforeRead = async () => { await writeFile(join(repo, 'second.md'), 'edit during backup read\n'); };
    const store = recoveryStore(); await recoverInterruptedDocumentMerges(store);
    expect(await readFile(join(repo, 'second.md'), 'utf8')).toBe('edit during backup read\n');
    expect(store.getItem('item-1')?.detail).toContain('doc-merge/item-1');
    expect(await readFile(join(repo, '.git/aio-plan-queue/doc-merge/item-1/ours-1'), 'utf8')).toContain('ours');
  });

  it.each(['finish', 'undo', 'recovery'] as const)('retains the backup when HEAD changes between document writes during %s', async (operation) => {
    const prepared = await createDocumentOverlapResolver({ itemId: 'item-1' }).prepare(await twoDocuments());
    expect(prepared.ok).toBe(true); if (!prepared.ok) return;
    if (operation !== 'undo') git(['merge', '--ff-only', integrationTip]);
    hook.target = join(await realpath(repo), 'register.md');
    hook.beforeWrite = async () => { git(['update-ref', 'HEAD', operation !== 'undo' ? baseTip : integrationTip]); };
    if (operation === 'recovery') {
      const store = recoveryStore(); await recoverInterruptedDocumentMerges(store);
      expect(store.getItem('item-1')?.detail).toContain('doc-merge/item-1');
    } else await expect(prepared[operation]()).rejects.toThrow(/HEAD.*backup kept/);
    expect(await readFile(join(repo, 'second.md'), 'utf8')).toBe(operation !== 'undo' ? 'first\n\nsecond\n\nitem\n' : 'first\n\nsecond\n\nthird\n');
    expect(await readFile(join(repo, '.git/aio-plan-queue/doc-merge/item-1/manifest.json'), 'utf8')).toContain('second.md');
  });

  it.each(['finish', 'undo', 'recovery'] as const)('keeps all backups if an earlier restored document changes during %s', async (operation) => {
    const prepared = await createDocumentOverlapResolver({ itemId: 'item-1' }).prepare(await twoDocuments());
    expect(prepared.ok).toBe(true); if (!prepared.ok) return;
    if (operation !== 'undo') git(['merge', '--ff-only', integrationTip]);
    hook.target = join(await realpath(repo), 'second.md');
    hook.beforeWrite = async () => { await writeFile(join(repo, 'register.md'), 'latest human edit\n'); };
    if (operation === 'recovery') {
      const store = recoveryStore(); await recoverInterruptedDocumentMerges(store);
      expect(store.getItem('item-1')?.detail).toContain('register.md');
    } else await expect(prepared[operation]()).rejects.toThrow(/register.md.*backup kept/);
    expect(await readFile(join(repo, 'register.md'), 'utf8')).toBe('latest human edit\n');
    for (const index of [0, 1]) expect(await readFile(join(repo, `.git/aio-plan-queue/doc-merge/item-1/ours-${index}`), 'utf8')).toContain('ours');
  });

  it('preserves an untracked document changed while another document is moved aside', async () => {
    for (const file of ['a.md', 'b.md']) await writeFile(join(repo, file), 'item\n');
    git(['add', '.']); git(['commit', '-qm', 'item']); integrationTip = git(['rev-parse', 'HEAD']);
    git(['reset', '--hard', baseTip]);
    for (const file of ['a.md', 'b.md']) await writeFile(join(repo, file), 'item\n');
    hook.target = join(await realpath(repo), 'a.md');
    hook.beforeRename = async () => { await writeFile(join(repo, 'b.md'), 'later human edit\n'); };
    const result = await createDocumentOverlapResolver({ itemId: 'item-1' }).prepare({ repoRoot: repo, baseTip, integrationTip,
      overlaps: ['a.md', 'b.md'].map((path) => ({ path, status: '??' })) });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('doc-merge/item-1') });
    expect(await readFile(join(repo, 'b.md'), 'utf8')).toBe('later human edit\n');
    expect(await readFile(join(repo, '.git/aio-plan-queue/doc-merge/item-1/ours-1'), 'utf8')).toBe('item\n');
    expect(await readFile(join(repo, '.git/aio-plan-queue/doc-merge/item-1/aside-0'), 'utf8')).toBe('item\n');
    expect(await recoverDocumentMergeForItem(repo, 'item-1')).toMatchObject({ ok: false, reason: expect.stringContaining('b.md') });
    expect(await readFile(join(repo, 'a.md'), 'utf8')).toBe('item\n');
    expect(await readFile(join(repo, 'b.md'), 'utf8')).toBe('later human edit\n');
  });

  it('lands simultaneous table and section insertions, keeping ours then theirs uncommitted', async () => {
    await prepare(append('LT-OURS'), append('LT-ITEM'));
    expect(await promote()).toMatchObject({ status: 'promoted', mergedPaths: ['register.md'] });
    const text = await readFile(join(repo, 'register.md'), 'utf8');
    expect(text.indexOf('| LT-OURS')).toBeLessThan(text.indexOf('| LT-ITEM'));
    expect(text).toContain('## LT-OURS'); expect(text).toContain('## LT-ITEM');
    expect(git(['show', 'HEAD:register.md'])).not.toContain('LT-OURS');
    expect(git(['diff', '--', 'register.md'])).toContain('+| LT-OURS');
    expect(git(['diff', '--cached', '--name-only'])).toBe('');
  });

  it('cleanly merges edits to distinct paragraphs', async () => {
    const content = 'first\n\nsecond\n\nthird\n';
    await writeFile(join(repo, 'register.md'), content); git(['add', '.']); git(['commit', '-qm', 'paragraphs']); baseTip = git(['rev-parse', 'HEAD']);
    await prepare(content.replace('first', 'ours'), content.replace('third', 'theirs'));
    expect(await promote()).toMatchObject({ status: 'promoted' });
    expect(await readFile(join(repo, 'register.md'), 'utf8')).toBe('ours\n\nsecond\n\ntheirs\n');
  });

  it('blocks conflicting replacements and preserves root bytes', async () => {
    const ours = base.replace('Base.', 'Ours.');
    await prepare(ours, base.replace('Base.', 'Theirs.'));
    expect(await promote()).toMatchObject({ status: 'blocked', overlaps: ['register.md'], reason: expect.stringContaining('same lines') });
    expect(await readFile(join(repo, 'register.md'), 'utf8')).toBe(ours);
    expect(git(['rev-parse', 'HEAD'])).toBe(baseTip);
  });

  it('treats a whitespace ancestor line as a replacement, not an empty-base insertion', async () => {
    const content = 'before\n \nafter\n';
    await writeFile(join(repo, 'register.md'), content); git(['add', '.']); git(['commit', '-qm', 'whitespace']); baseTip = git(['rev-parse', 'HEAD']);
    const ours = content.replace('\n \n', '\nours\n');
    await prepare(ours, content.replace('\n \n', '\ntheirs\n'));
    expect(await promote()).toMatchObject({ status: 'blocked', reason: expect.stringContaining('same lines') });
    expect(await readFile(join(repo, 'register.md'), 'utf8')).toBe(ours);
  });

  it('blocks duplicate newly added table ids/headings', async () => {
    await prepare(append('LT-SAME') + 'ours\n', append('LT-SAME') + 'theirs\n');
    expect(await promote()).toMatchObject({ status: 'blocked' });
    expect(await readFile(join(repo, 'register.md'), 'utf8')).toBe(append('LT-SAME') + 'ours\n');
  });

  it('refuses code and staged overlaps', async () => {
    await prepare('ours\n', 'theirs\n', 'source.ts');
    expect(await promote()).toMatchObject({ status: 'blocked', reason: expect.stringContaining('source.ts') });
    expect(await readFile(join(repo, 'source.ts'), 'utf8')).toBe('ours\n');
    git(['reset', '--hard', baseTip]);
    await prepare(append('LT-OURS'), append('LT-ITEM'));
    git(['add', 'register.md']);
    expect(await promote()).toMatchObject({ status: 'blocked', reason: expect.stringContaining('staged') });
  });

  it('accepts an identical untracked document and refuses differing bytes', async () => {
    await prepare('item\n', 'item\n', 'new.md');
    expect(await promote()).toMatchObject({ status: 'promoted' });
    expect(await readFile(join(repo, 'new.md'), 'utf8')).toBe('item\n');
  });

  it('refuses an untracked document with different bytes', async () => {
    await prepare('ours\n', 'theirs\n', 'new.md');
    expect(await promote()).toMatchObject({ status: 'blocked', reason: expect.stringContaining('untracked') });
    expect(await readFile(join(repo, 'new.md'), 'utf8')).toBe('ours\n');
  });

  it('restores ours when promotion fails after resetting the root', async () => {
    await prepare(append('LT-OURS'), append('LT-ITEM'));
    const prepared = await createDocumentOverlapResolver({ itemId: 'item-1' }).prepare({ repoRoot: repo, baseTip, integrationTip, overlaps: [{ path: 'register.md', status: ' M' }] });
    expect(prepared.ok).toBe(true);
    expect(await readFile(join(repo, 'register.md'), 'utf8')).toBe(base);
    if (prepared.ok) await prepared.undo();
    expect(await readFile(join(repo, 'register.md'), 'utf8')).toBe(append('LT-OURS'));
  });

  it('aborts untouched when the root bytes change between read and reset', async () => {
    await prepare(append('LT-OURS'), append('LT-ITEM'));
    hook.beforeManifest = async () => { await writeFile(join(repo, 'register.md'), 'later edit\n'); };
    expect(await promote()).toMatchObject({ status: 'blocked', reason: expect.stringContaining('changed while Harness checked') });
    expect(await readFile(join(repo, 'register.md'), 'utf8')).toBe('later edit\n');
    expect(git(['rev-parse', 'HEAD'])).toBe(baseTip);
  });

  it('refuses a file staged between read and reset without changing its index or bytes', async () => {
    const ours = append('LT-OURS');
    await prepare(ours, append('LT-ITEM'));
    hook.beforeManifest = async () => { git(['add', 'register.md']); };
    expect(await promote()).toMatchObject({ status: 'blocked', reason: expect.stringContaining('status changed') });
    expect(await readFile(join(repo, 'register.md'), 'utf8')).toBe(ours);
    expect(git(['show', ':register.md'])).toBe(ours.trim());
    expect(git(['rev-parse', 'HEAD'])).toBe(baseTip);
  });

  it.each([false, true])('recovers a crash after reset, HEAD moved=%s', async (moved) => {
    await prepare(append('LT-OURS'), append('LT-ITEM'));
    const prepared = await createDocumentOverlapResolver({ itemId: 'item-1' }).prepare({ repoRoot: repo, baseTip, integrationTip, overlaps: [{ path: 'register.md', status: ' M' }] });
    expect(prepared.ok).toBe(true);
    if (moved) git(['merge', '--ff-only', 'integration/item']);
    await recoverInterruptedDocumentMerges(recoveryStore());
    const text = await readFile(join(repo, 'register.md'), 'utf8');
    expect(text).toContain('LT-OURS');
    expect(text.includes('LT-ITEM')).toBe(moved);
  });

  it('keeps the backup and notes the item when crash recovery finds unexpected content', async () => {
    await prepare(append('LT-OURS'), append('LT-ITEM'));
    await createDocumentOverlapResolver({ itemId: 'item-1' }).prepare({ repoRoot: repo, baseTip, integrationTip, overlaps: [{ path: 'register.md', status: ' M' }] });
    await writeFile(join(repo, 'register.md'), 'later edit\n');
    const store = recoveryStore(); await recoverInterruptedDocumentMerges(store);
    expect(await readFile(join(repo, 'register.md'), 'utf8')).toBe('later edit\n');
    expect(store.getItem('item-1')?.detail).toContain('Harness kept a copy of your edits');
  });

  it('never removes an older unfinished backup when another prepare is refused', async () => {
    await prepare(append('LT-OURS'), append('LT-ITEM'));
    const resolver = createDocumentOverlapResolver({ itemId: 'item-1' });
    const input = { repoRoot: repo, baseTip, integrationTip, overlaps: [{ path: 'register.md', status: ' M' }] };
    expect((await resolver.prepare(input)).ok).toBe(true);
    await writeFile(join(repo, 'register.md'), append('LT-LATER'));
    expect((await resolver.prepare(input)).ok).toBe(false);
    const backup = join(repo, '.git/aio-plan-queue/doc-merge/item-1');
    expect(await readFile(join(backup, 'ours-0'), 'utf8')).toBe(append('LT-OURS'));
    expect(await readFile(join(backup, 'manifest.json'), 'utf8')).toContain('item-1');
    expect(await readFile(join(repo, 'register.md'), 'utf8')).toBe(append('LT-LATER'));
  });

  it('passes every overlapping path and status to a resolver and preserves its refusal', async () => {
    await writeFile(join(repo, 'source.ts'), 'item\n'); git(['add', 'source.ts']); git(['commit', '-qm', 'item code']);
    await prepare(append('LT-OURS'), append('LT-ITEM'));
    await writeFile(join(repo, 'source.ts'), 'ours\n');
    const seen: unknown[] = [];
    const result = await promoteIntegrationBranch(repo, 'main', 'integration/item', integrationTip, {
      dirtyRootPolicy: 'block-overlap', resolveDirtyOverlap: { prepare: async (input) => { seen.push(input); return { ok: false, reason: 'Resolve these files first.' }; } },
    });
    expect(result).toEqual({ status: 'blocked', reason: 'Resolve these files first.', overlaps: ['register.md', 'source.ts'] });
    expect(seen).toEqual([expect.objectContaining({ overlaps: [{ path: 'register.md', status: ' M' }, { path: 'source.ts', status: ' M' }] })]);
  });

  it('calls undo when the fast-forward fails after an accepted resolver preparation', async () => {
    await prepare(append('LT-OURS'), append('LT-ITEM'));
    const undo = vi.fn(async () => undefined); const finish = vi.fn(async () => []);
    const result = await promoteIntegrationBranch(repo, 'main', 'integration/item', integrationTip, {
      dirtyRootPolicy: 'block-overlap', resolveDirtyOverlap: { prepare: async () => ({ ok: true, finish, undo }) },
    });
    expect(result).toMatchObject({ status: 'blocked' });
    expect(undo).toHaveBeenCalledTimes(1); expect(finish).not.toHaveBeenCalled();
    expect(await readFile(join(repo, 'register.md'), 'utf8')).toBe(append('LT-OURS'));
  });

  it('reports the promotion and never undoes when finish fails after the fast-forward', async () => {
    await prepare(append('LT-OURS'), append('LT-ITEM'));
    const undo = vi.fn(async () => undefined);
    const finish = vi.fn(async (): Promise<string[]> => { throw new Error('write failed'); });
    const result = await promoteIntegrationBranch(repo, 'main', 'integration/item', integrationTip, {
      dirtyRootPolicy: 'block-overlap', resolveDirtyOverlap: { prepare: async () => {
        // Like the real prepare's reset, clear the root edit so the ff can run.
        git(['checkout', '--', 'register.md']);
        return { ok: true as const, finish, undo };
      } },
    });
    expect(result).toMatchObject({ status: 'promoted', method: 'checked-out-ff', tip: integrationTip, documentMergeInterrupted: 'write failed' });
    expect(finish).toHaveBeenCalledTimes(1); expect(undo).not.toHaveBeenCalled();
    expect(git(['rev-parse', 'HEAD'])).toBe(integrationTip);
  });

  it('refuses invalid UTF-8 before a root write', async () => {
    await prepare(append('LT-OURS'), append('LT-ITEM'));
    const bytes = Buffer.from([0xc3, 0x28]); await writeFile(join(repo, 'register.md'), bytes);
    expect(await promote()).toMatchObject({ status: 'blocked' });
    expect(await readFile(join(repo, 'register.md'))).toEqual(bytes);
  });
});
