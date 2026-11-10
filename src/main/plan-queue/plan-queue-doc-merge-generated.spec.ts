import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hook = vi.hoisted(() => ({ beforeManifest: null as (() => Promise<void>) | null }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    if (String(args[0]).endsWith('manifest.json') && hook.beforeManifest) {
      const run = hook.beforeManifest; hook.beforeManifest = null; await run();
    }
    return actual.open(...args);
  } };
});
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { integrationOwnershipRef, promoteIntegrationBranch } from '../workspace/git/worktree-integration';
import { createDocumentOverlapResolver, recoverDocumentMergeForItem, recoverInterruptedDocumentMerges } from './plan-queue-doc-merge';
import { newPlanQueueItem } from './plan-queue-state';
import type { PlanQueueStore } from './plan-queue-store';
import { useGitRepoTemplate } from '../workspace/git/git-repo-template.test-helpers';

// Real git and a real `npm run` per landing: give the file the budget the other real-git specs use.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const OUT = 'gen/out.txt';
const EXTRA = 'gen/extra.txt';
const GENERATOR = "const fs=require('fs');const r=(f)=>fs.readFileSync(f,'utf8');fs.mkdirSync('gen',{recursive:true});"
  + "fs.writeFileSync('gen/out.txt','src='+r('src.txt')+'local='+r('local.txt'));fs.writeFileSync('gen/extra.txt','extra '+r('src.txt'));\n";
const list = (artifacts: string[], generators = ['generate:out']) => JSON.stringify({ artifacts, generators });
const register = '# Register\n| ID | Note |\n| --- | --- |\n\n# Details\nBase.\n';
const withRow = (id: string) => register.replace('| --- | --- |\n', `| --- | --- |\n| ${id} | note |\n`) + `\n## ${id}\nDetails.\n`;

let repo: string;
let baseTip: string;
let integrationTip: string;
const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const read = (file: string) => readFile(join(repo, file), 'utf8');
const write = async (file: string, content: string) => { await mkdir(dirname(join(repo, file)), { recursive: true }); await writeFile(join(repo, file), content); };
const exists = (file: string) => access(join(repo, file)).then(() => true, () => false);
const backupDir = () => '.git/aio-plan-queue/doc-merge/item-1';
/** The two-letter porcelain status of one path ('' when clean); `git()` would trim its leading space. */
const status = (file: string) => execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', file], { cwd: repo, encoding: 'utf8' }).slice(0, 2);

interface Landing { listBase?: string | null; listItem?: string | null; itemExtra?: Record<string, string>; itemRemoves?: string[] }
/** A base commit and an item commit whose generated files were rebuilt by the hook; the root is left at the base. */
async function build({ listBase = list([OUT]), listItem = list([OUT]), itemExtra = {}, itemRemoves = [] }: Landing = {}) {
  await write('package.json', JSON.stringify({ name: 'fixture', private: true, scripts: { 'generate:out': 'node gen.js' } }));
  await write('gen.js', GENERATOR);
  await write('src.txt', 'base\n'); await write('local.txt', 'base\n');
  await write(OUT, 'src=base\nlocal=base\n');
  await write('register.md', register); await write('source.ts', 'base\n');
  if (listBase) await write('scripts/generated-artifacts.json', listBase);
  git(['add', '.']); git(['commit', '-qm', 'base']); baseTip = git(['rev-parse', 'HEAD']);
  await write('src.txt', 'item\n'); await write(OUT, 'src=item\nlocal=base\n'); await write(EXTRA, 'extra item\n');
  if (listItem) await write('scripts/generated-artifacts.json', listItem);
  for (const [file, content] of Object.entries(itemExtra)) await write(file, content);
  for (const file of itemRemoves) await rm(join(repo, file));
  git(['add', '.']); git(['commit', '-qm', 'item']); integrationTip = git(['rev-parse', 'HEAD']);
  git(['branch', '-f', 'integration/item', integrationTip]); git(['update-ref', integrationOwnershipRef('integration/item'), integrationTip]);
  git(['reset', '--hard', baseTip]);
  await write('local.txt', 'edited\n'); // James's own unrelated edit: never an overlap, and the generator reads it
}

type Variant = 'unstaged' | 'staged' | 'both';
const ourOut = 'src=base\nlocal=edited\n';
/** Put the root's copy of the generated file into the requested state; returns its working bytes. */
async function dirtyOut(variant: Variant): Promise<string> {
  if (variant === 'unstaged') { await write(OUT, ourOut); return ourOut; }
  if (variant === 'staged') { await write(OUT, ourOut); git(['add', OUT]); return ourOut; }
  await write(OUT, 'staged copy\n'); git(['add', OUT]); await write(OUT, 'worktree copy\n'); return 'worktree copy\n';
}
const STATUS: Record<Variant, string> = { unstaged: ' M', staged: 'M ', both: 'MM' };
/** Rollback puts the working copy back and re-stages it if any copy was staged: a split 'MM' becomes one staged copy. */
const RESTORED: Record<Variant, string> = { unstaged: ' M', staged: 'M ', both: 'M ' };

const promote = () => promoteIntegrationBranch(repo, 'main', 'integration/item', integrationTip, {
  dirtyRootPolicy: 'block-overlap', resolveDirtyOverlap: createDocumentOverlapResolver({ itemId: 'item-1' }),
});
const prepare = (overlaps: { path: string; status: string }[]) =>
  createDocumentOverlapResolver({ itemId: 'item-1' }).prepare({ repoRoot: repo, baseTip, integrationTip, overlaps });

function recoveryStore() {
  let item = newPlanQueueItem('item-1', 'run-1', join(repo, 'x_plan.md'), 1, { state: 'parked', detail: 'Merge blocked.' });
  return {
    listWorkspaceRoots: () => [repo], getItem: () => item,
    getRun: () => ({ workspaceCwd: repo }), upsertItem: (next: typeof item) => { item = next; },
  } as unknown as Pick<PlanQueueStore, 'listWorkspaceRoots' | 'getItem' | 'getRun' | 'upsertItem'>;
}

/** Every test starts from its own copy of this repository, built once for the file. */
const baseRepository = useGitRepoTemplate((dir) => {
  repo = dir;
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Queue Test']); git(['config', 'user.email', 'queue@example.invalid']); git(['config', 'commit.gpgsign', 'false']);
});

beforeEach(async () => {
  hook.beforeManifest = null;
  GitWriteQueue._resetForTesting();
  repo = await mkdtemp(join(tmpdir(), 'queue-generated-'));
  baseRepository.copyTo(repo);
});
afterEach(async () => { await rm(repo, { recursive: true, force: true }); GitWriteQueue._resetForTesting(); });

describe('generated files in a landing overlap', () => {
  it.each(['unstaged', 'staged', 'both'] as const)('lands when only a %s copy of the generated file overlaps, and rebuilds it', async (variant) => {
    await build(); await dirtyOut(variant);
    expect(await promote()).toMatchObject({ status: 'promoted', method: 'checked-out-ff', tip: integrationTip });
    expect(git(['rev-parse', 'HEAD'])).toBe(integrationTip);
    // A fresh regeneration: the landing's source plus James's uncommitted local edit, not the committed copy.
    expect(await read(OUT)).toBe('src=item\nlocal=edited\n');
    expect(await read('local.txt')).toBe('edited\n');
    expect(await exists(backupDir())).toBe(false);
  });

  it('lands an untracked generated file the landing adds', async () => {
    await build({ listBase: list([OUT, EXTRA]), listItem: list([OUT, EXTRA]) });
    await write(EXTRA, 'my own untracked copy\n');
    expect(await promote()).toMatchObject({ status: 'promoted', tip: integrationTip });
    expect(await read(EXTRA)).toBe('extra item\n');
    expect(await exists(backupDir())).toBe(false);
  });

  it('lands a generated file together with a Markdown register through the merge helper', async () => {
    await build({ itemExtra: { 'register.md': withRow('LT-ITEM') } });
    await dirtyOut('staged'); await write('register.md', withRow('LT-OURS'));
    const result = await promote();
    expect(result).toMatchObject({ status: 'promoted', mergedPaths: ['register.md'] });
    const merged = await read('register.md');
    expect(merged).toContain('LT-OURS'); expect(merged).toContain('LT-ITEM');
    expect(git(['diff', '--name-only'])).toContain('register.md'); // still James's uncommitted edit
    expect(await read(OUT)).toBe('src=item\nlocal=edited\n');
    expect(await exists(backupDir())).toBe(false);
  });

  it.each(['unstaged', 'staged'] as const)('still blocks a generated file plus code (%s), leaving every edit untouched', async (variant) => {
    await build({ itemExtra: { 'source.ts': 'item\n' } });
    const ours = await dirtyOut(variant); await write('source.ts', 'my code edit\n');
    const before = git(['status', '--porcelain=v1']);
    const result = await promote();
    expect(result).toMatchObject({ status: 'blocked', reason: expect.stringContaining('source.ts') });
    expect(git(['rev-parse', 'HEAD'])).toBe(baseTip);
    expect(await read(OUT)).toBe(ours);
    expect(await read('source.ts')).toBe('my code edit\n');
    expect(git(['status', '--porcelain=v1'])).toBe(before);
    expect(await exists(backupDir())).toBe(false);
  });

  it('treats a file as generated only when both the base and the landing list it', async () => {
    await build({ listBase: list([EXTRA]), listItem: list([OUT]) });
    const ours = await dirtyOut('unstaged');
    expect(await promote()).toMatchObject({ status: 'blocked', reason: expect.stringContaining(OUT) });
    expect(await read(OUT)).toBe(ours);
  });

  it.each([null, 'not json'])('gives a repository without a usable list no special handling (%s)', async (content) => {
    await build({ listBase: content, listItem: content });
    const ours = await dirtyOut('unstaged');
    expect(await promote()).toMatchObject({ status: 'blocked' });
    expect(git(['rev-parse', 'HEAD'])).toBe(baseTip);
    expect(await read(OUT)).toBe(ours);
  });

  it('refuses a generated list that names a path outside the repository', async () => {
    const bad = list(['../outside.txt']);
    await build({ listBase: bad, listItem: bad });
    await dirtyOut('unstaged');
    expect(await promote()).toMatchObject({ status: 'blocked', reason: expect.stringContaining('not a valid list') });
  });

  it('blocks a generated file James deleted, rather than guessing', async () => {
    await build(); await rm(join(repo, OUT));
    expect(await promote()).toMatchObject({ status: 'blocked', reason: expect.stringContaining('generated file') });
    expect(await exists(OUT)).toBe(false);
    expect(git(['rev-parse', 'HEAD'])).toBe(baseTip);
  });

  it('blocks a landing that deletes the generated file, leaving the root copy alone', async () => {
    await build({ itemRemoves: [OUT] });
    const ours = await dirtyOut('unstaged');
    expect(await promote()).toMatchObject({ status: 'blocked', reason: expect.stringContaining('deletes this generated file') });
    expect(await read(OUT)).toBe(ours);
    expect(git(['rev-parse', 'HEAD'])).toBe(baseTip);
    expect(await exists(backupDir())).toBe(false);
  });

  it('aborts untouched when the generated file changes between the check and the reset', async () => {
    await build(); await dirtyOut('unstaged');
    hook.beforeManifest = async () => { await write(OUT, 'edited again\n'); };
    expect(await promote()).toMatchObject({ status: 'blocked', reason: expect.stringContaining('changed while Harness checked') });
    expect(await read(OUT)).toBe('edited again\n');
    expect(git(['rev-parse', 'HEAD'])).toBe(baseTip);
  });

  it('keeps a generator failure from undoing a landing that already happened', async () => {
    await build({ listBase: list([OUT], ['no-such-script']), listItem: list([OUT], ['no-such-script']) });
    await dirtyOut('unstaged');
    expect(await promote()).toMatchObject({ status: 'promoted', tip: integrationTip });
    expect(await read(OUT)).toBe('src=item\nlocal=base\n'); // the committed copy
    expect(await exists(backupDir())).toBe(false);
  });
});

describe('generated files: rollback and crash windows', () => {
  it.each(['unstaged', 'staged', 'both'] as const)('undo puts back the %s copy exactly, index included', async (variant) => {
    await build(); const ours = await dirtyOut(variant);
    const prepared = await prepare([{ path: OUT, status: STATUS[variant] }]);
    expect(prepared.ok).toBe(true); if (!prepared.ok) return;
    expect(await read(OUT)).toBe('src=base\nlocal=base\n'); // set aside, so the fast-forward can run
    expect(status(OUT)).toBe('');
    await prepared.undo();
    expect(await read(OUT)).toBe(ours);
    expect(status(OUT)).toBe(RESTORED[variant]);
    if (variant === 'both') expect(git(['show', `:${OUT}`])).toBe('worktree copy'); // the staged copy becomes the working one
    expect(await exists(backupDir())).toBe(false);
  });

  it('undo puts back an untracked generated file', async () => {
    await build({ listBase: list([OUT, EXTRA]), listItem: list([OUT, EXTRA]) });
    await write(EXTRA, 'my own untracked copy\n');
    const prepared = await prepare([{ path: EXTRA, status: '??' }]);
    expect(prepared.ok).toBe(true); if (!prepared.ok) return;
    expect(await exists(EXTRA)).toBe(false);
    await prepared.undo();
    expect(await read(EXTRA)).toBe('my own untracked copy\n');
  });

  it('restores the root after a fast-forward failure', async () => {
    await build(); const ours = await dirtyOut('staged');
    const result = await promoteIntegrationBranch(repo, 'main', 'integration/item', integrationTip, {
      dirtyRootPolicy: 'block-overlap', resolveDirtyOverlap: { prepare: async (input) => {
        const prepared = await createDocumentOverlapResolver({ itemId: 'item-1' }).prepare(input);
        await write('src.txt', 'an edit made after the set-aside\n'); // the fast-forward refuses to overwrite it
        return prepared;
      } },
    });
    expect(result).toMatchObject({ status: 'blocked' });
    expect(git(['rev-parse', 'HEAD'])).toBe(baseTip);
    expect(await read(OUT)).toBe(ours);
    expect(status(OUT)).toBe('M ');
    expect(await exists(backupDir())).toBe(false);
  });

  it.each(['unstaged', 'staged', 'both'] as const)('recovers a %s copy when the crash came after the set-aside and before the fast-forward', async (variant) => {
    await build(); const ours = await dirtyOut(variant);
    expect((await prepare([{ path: OUT, status: STATUS[variant] }])).ok).toBe(true);
    await recoverInterruptedDocumentMerges(recoveryStore());
    expect(await read(OUT)).toBe(ours);
    expect(status(OUT)).toBe(RESTORED[variant]);
    expect(await exists(backupDir())).toBe(false);
    expect(git(['rev-parse', 'HEAD'])).toBe(baseTip);
  });

  it('recovers an untracked copy when the crash came after the set-aside', async () => {
    await build({ listBase: list([OUT, EXTRA]), listItem: list([OUT, EXTRA]) });
    await write(EXTRA, 'my own untracked copy\n');
    expect((await prepare([{ path: EXTRA, status: '??' }])).ok).toBe(true);
    await recoverInterruptedDocumentMerges(recoveryStore());
    expect(await read(EXTRA)).toBe('my own untracked copy\n');
    expect(await exists(backupDir())).toBe(false);
  });

  it('closes the backup when the crash came after the fast-forward and before the rebuild', async () => {
    await build(); await dirtyOut('staged');
    expect((await prepare([{ path: OUT, status: 'M ' }])).ok).toBe(true);
    git(['merge', '--ff-only', 'integration/item']);
    const store = recoveryStore(); await recoverInterruptedDocumentMerges(store);
    expect(await read(OUT)).toBe('src=item\nlocal=base\n');
    expect(await exists(backupDir())).toBe(false);
    expect(store.getItem('item-1')?.detail).toBe('Merge blocked.');
  });

  it('puts the committed copy back when a crash cut the rebuild short', async () => {
    await build(); await dirtyOut('unstaged');
    expect((await prepare([{ path: OUT, status: ' M' }])).ok).toBe(true);
    git(['merge', '--ff-only', 'integration/item']);
    await write(OUT, 'src=ite'); // half-written by the generator
    expect(await recoverDocumentMergeForItem(repo, 'item-1')).toEqual({ ok: true, mergedPaths: [] });
    expect(await read(OUT)).toBe('src=item\nlocal=base\n');
    expect(await exists(backupDir())).toBe(false);
  });

  it('keeps the backup when a generated copy was changed after the set-aside', async () => {
    await build(); await dirtyOut('unstaged');
    expect((await prepare([{ path: OUT, status: ' M' }])).ok).toBe(true);
    await write(OUT, 'something else\n');
    const store = recoveryStore(); await recoverInterruptedDocumentMerges(store);
    expect(await read(OUT)).toBe('something else\n');
    expect(store.getItem('item-1')?.detail).toContain('Harness kept a copy of your edits');
    expect(await read(`${backupDir()}/ours-0`)).toBe(ourOut);
  });

  it('writes a backup of both the generated file and the register before touching either', async () => {
    await build({ itemExtra: { 'register.md': withRow('LT-ITEM') } });
    await dirtyOut('both'); await write('register.md', withRow('LT-OURS'));
    const prepared = await prepare([{ path: OUT, status: 'MM' }, { path: 'register.md', status: ' M' }]);
    expect(prepared.ok).toBe(true);
    const manifest = JSON.parse(await read(`${backupDir()}/manifest.json`));
    expect(manifest.entries.map((entry: { path: string; kind: string }) => [entry.path, entry.kind])).toEqual([[OUT, 'generated'], ['register.md', 'document']]);
    expect(await read(`${backupDir()}/ours-0`)).toBe('worktree copy\n');
    expect(await read(`${backupDir()}/ours-1`)).toBe(withRow('LT-OURS'));
  });

  it('still reads a backup written before generated files were handled', async () => {
    await build({ itemExtra: { 'register.md': withRow('LT-ITEM') } });
    await write('register.md', withRow('LT-OURS'));
    expect((await prepare([{ path: 'register.md', status: ' M' }])).ok).toBe(true);
    const manifestPath = join(repo, backupDir(), 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    for (const entry of manifest.entries) delete entry.kind;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await recoverInterruptedDocumentMerges(recoveryStore());
    expect(await read('register.md')).toBe(withRow('LT-OURS'));
    expect(await exists(backupDir())).toBe(false);
  });
});
