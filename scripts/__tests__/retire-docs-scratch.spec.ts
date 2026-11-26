import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scratchInventory, writeScratchReview, type ScratchEntry } from '../retire-docs';

const cliPath = resolve('scripts/retire-docs.ts');
const tsxPath = resolve('node_modules/tsx/dist/cli.mjs');
const now = new Date('2026-10-11T00:00:00Z');
const old = new Date('2026-08-01T00:00:00Z');
let root: string;
const extra: string[] = [];
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
function write(path: string, text = 'fixture') {
  const full = join(root, path);
  fs.mkdirSync(dirname(full), { recursive: true }); fs.writeFileSync(full, text);
  return full;
}
function age(path: string, when = old) { fs.utimesSync(join(root, path), when, when); }
function entry(path = '_scratch/approved', when = old) {
  write(`${path}/data`); age(`${path}/data`, when); age(path, when);
}
function cli(...args: string[]) {
  return spawnSync(process.execPath, [tsxPath, cliPath, '--scratch', ...args], { cwd: root, encoding: 'utf8' });
}
function guardedCli(...args: string[]) { return guardedCliWithEnv({}, ...args); }
const guardPath = resolve('scripts/__tests__/helpers/retire-scratch-rm-guard.cjs');
function guardedEnvironment(extraEnv: Record<string, string> = {}) {
  return { ...process.env, ...extraEnv, NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} --require=${JSON.stringify(guardPath)}`, AIO_RETIRE_TEST_RM_LOG: join(root, 'rm-calls.log') };
}
function guardedCliWithEnv(extraEnv: Record<string, string>, ...args: string[]) {
  return spawnSync(process.execPath, [tsxPath, cliPath, '--scratch', ...args], {
    cwd: root, encoding: 'utf8', env: guardedEnvironment(extraEnv),
  });
}
function guardedExecutor(entries: ScratchEntry[]) {
  const code = `const { applyScratchCleanup } = require(${JSON.stringify(resolve('scripts/lib/retire-scratch.ts'))}); process.stdout.write(JSON.stringify(applyScratchCleanup(process.cwd(), JSON.parse(process.env.AIO_RETIRE_TEST_ENTRIES), new Date('2026-10-11T00:00:00Z'))));`;
  const result = spawnSync(process.execPath, [tsxPath, '--eval', code], {
    cwd: root, encoding: 'utf8', env: guardedEnvironment({ AIO_RETIRE_TEST_ENTRIES: JSON.stringify(entries) }),
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { deleted: ScratchEntry[]; refused: ScratchEntry[] };
}
function review() {
  const result = cli('--as-of', '2026-10-11');
  expect(result.status, result.stderr).toBe(0);
  const manifest = /^Manifest: (.+)$/m.exec(result.stdout)?.[1];
  expect(manifest, result.stdout).toBeTruthy();
  extra.push(dirname(manifest!));
  return manifest!;
}
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'retire-scratch-safety-'));
  git('init', '-q'); git('config', 'core.hooksPath', '/dev/null');
  write('.gitignore', '_scratch/\n.aio-review/\n');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  for (const path of extra.splice(0)) fs.rmSync(path, { recursive: true, force: true });
});

describe('scratch containment and executor boundaries', () => {
  it.each(['_scratch', '.aio-review'])('refuses linked %s roots without invoking rm', (namespace) => {
    const outside = fs.mkdtempSync(join(tmpdir(), 'retire-scratch-outside-')); extra.push(outside);
    fs.writeFileSync(join(outside, 'data'), 'outside sentinel'); fs.utimesSync(join(outside, 'data'), old, old);
    fs.symlinkSync(outside, join(root, namespace));
    expect(() => scratchInventory(root, now)).toThrow(/link|directory|contain/i);
    const result = guardedExecutor([{ path: `${namespace}/data`, kind: namespace === '_scratch' ? 'scratch' : 'review', bytes: 16, files: 1, newestAt: old.getTime() }]);
    expect(result.deleted).toEqual([]); expect(fs.existsSync(join(root, 'rm-calls.log'))).toBe(false);
    expect(fs.readFileSync(join(outside, 'data'), 'utf8')).toBe('outside sentinel');
  });
  it('rejects non-namespace and fresh empty directory entries without invoking rm', () => {
    write('protected/data'); age('protected/data'); age('protected');
    fs.mkdirSync(join(root, '_scratch/fresh-empty'), { recursive: true });
    const result = guardedExecutor([
      { path: 'protected', kind: 'scratch', bytes: 7, files: 1, newestAt: old.getTime() },
      { path: '_scratch/fresh-empty', kind: 'scratch', bytes: 0, files: 0, newestAt: old.getTime() },
    ]);
    expect(result.deleted).toEqual([]); expect(result.refused).toHaveLength(2); expect(fs.existsSync(join(root, 'rm-calls.log'))).toBe(false);
  });
  it('enforces namespace and empty-directory age even with a reviewed snapshot', () => {
    fs.mkdirSync(join(root, '_scratch/empty'), { recursive: true }); age('_scratch/empty');
    const listed = scratchInventory(root, now); expect(listed).toHaveLength(1);
    write('protected/data'); age('protected/data'); age('protected');
    age('_scratch/empty', new Date('2026-10-10T00:00:00Z'));
    const result = guardedExecutor([listed[0], { ...listed[0], path: 'protected' }]);
    expect(result.refused).toHaveLength(2); expect(fs.existsSync(join(root, 'rm-calls.log'))).toBe(false);
  });
  it('rejects links inside reviewed trees at inventory and execution', () => {
    entry(); const listed = scratchInventory(root, now);
    fs.symlinkSync(join(root, '_scratch/approved/data'), join(root, '_scratch/approved/linked'));
    age('_scratch/approved');
    expect(guardedExecutor(listed).deleted).toEqual([]);
    expect(scratchInventory(root, now)).toEqual([]);
    expect(fs.existsSync(join(root, 'rm-calls.log'))).toBe(false);
  });
  it('intercepts the actual executor rm boundary for a valid reviewed entry', () => {
    entry(); const listed = scratchInventory(root, now);
    expect(guardedExecutor(listed).refused).toHaveLength(1);
    expect(fs.existsSync(join(root, '_scratch/approved/data'))).toBe(true);
    expect(fs.readFileSync(join(root, 'rm-calls.log'), 'utf8').trim().split('\n')).toHaveLength(1);
  });
  it('requires effectively ignored descendants and excludes tracked files', () => {
    entry(); git('add', '-f', '_scratch/approved/data');
    entry('_scratch/unignored');
    // Git requires the ancestors to be unignored before the file exception can apply.
    write('.gitignore', '_scratch/*\n!_scratch/unignored/\n_scratch/unignored/*\n!_scratch/unignored/data\n');
    expect(scratchInventory(root, now)).toEqual([]);
  });
  it('refuses current references and ignores fresh nested empty directories', () => {
    entry(); const listed = scratchInventory(root, now);
    expect(listed.map(e => e.path)).toEqual(['_scratch/approved']);
    write('docs/open_plan.md', '`_scratch/approved`');
    expect(guardedExecutor(listed).deleted).toEqual([]);
    entry('_scratch/empty-child'); fs.mkdirSync(join(root, '_scratch/empty-child/fresh'));
    expect(scratchInventory(root, now).map(e => e.path)).not.toContain('_scratch/empty-child');
  });
});

describe('real CLI review -> explicit manifest -> apply', () => {
  it('requires an explicit manifest and never invents authority from current inventory', () => {
    entry(); const result = cli('--as-of', '2026-10-11', '--apply');
    expect(result.status).toBe(1); expect(result.stderr).toMatch(/manifest/i);
    expect(fs.existsSync(join(root, '_scratch/approved/data'))).toBe(true);
  });
  it('removes only reviewed entries when time passes and unseen entries appear', () => {
    entry(); entry('_scratch/newly-eligible', new Date('2026-09-11T12:00:00Z'));
    const before = git('status', '--porcelain'); const manifest = review();
    entry('_scratch/created-after-review');
    const result = cli('--as-of', '2026-10-12', '--apply', '--manifest', manifest);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(join(root, '_scratch/approved'))).toBe(false);
    expect(fs.existsSync(join(root, '_scratch/newly-eligible/data'))).toBe(true);
    expect(fs.existsSync(join(root, '_scratch/created-after-review/data'))).toBe(true);
    expect(git('status', '--porcelain')).toBe(before);
  });
  it('applies reviewed empty directories and ignored review files, with strict age boundaries', () => {
    fs.mkdirSync(join(root, '_scratch/empty'), { recursive: true }); age('_scratch/empty');
    write('.aio-review/approved.html'); age('.aio-review/approved.html');
    entry('_scratch/boundary', new Date('2026-09-11T00:00:00Z'));
    write('.aio-review/boundary.html'); age('.aio-review/boundary.html', new Date('2026-09-27T00:00:00Z'));
    const manifest = review();
    const result = cli('--as-of', '2026-10-12', '--apply', '--manifest', manifest);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(join(root, '_scratch/empty'))).toBe(false);
    expect(fs.existsSync(join(root, '.aio-review/approved.html'))).toBe(false);
    expect(fs.existsSync(join(root, '_scratch/boundary/data'))).toBe(true);
    expect(fs.existsSync(join(root, '.aio-review/boundary.html'))).toBe(true);
  });
  it('refuses an edit during the Git recheck before reaching the destructive boundary', () => {
    entry(); const manifest = review();
    const result = guardedCliWithEnv({ AIO_RETIRE_TEST_EDIT_ON_GIT: join(root, '_scratch/approved/data'), AIO_RETIRE_TEST_EDIT_AFTER_CHECK: '2' }, '--as-of', '2026-10-12', '--apply', '--manifest', manifest);
    expect(result.status).toBe(1);
    expect(fs.readFileSync(join(root, '_scratch/approved/data'), 'utf8')).toBe('changed');
    expect(fs.existsSync(join(root, 'rm-calls.log'))).toBe(false);
  });
  it('rejects byte-edited and replayed manifests without removing unseen data', () => {
    entry(); const manifest = review();
    const original = fs.readFileSync(manifest, 'utf8');
    fs.writeFileSync(manifest, original.replace('approved', 'unseen'));
    expect(cli('--apply', '--manifest', manifest).status).toBe(1);
    expect(fs.existsSync(join(root, '_scratch/approved/data'))).toBe(true);
    fs.writeFileSync(manifest, original);
    expect(cli('--apply', '--manifest', manifest).status).toBe(0);
    entry();
    expect(cli('--apply', '--manifest', manifest).status).toBe(1);
    expect(fs.existsSync(join(root, '_scratch/approved/data'))).toBe(true);
  });
  it('uses unique receipts per review and binds the receipt to this repository', () => {
    entry(); const first = review(); const second = review(); expect(first).not.toBe(second);
    const another = fs.mkdtempSync(join(tmpdir(), 'retire-other-repo-')); extra.push(another);
    execFileSync('git', ['init', '-q'], { cwd: another });
    const result = spawnSync(process.execPath, [tsxPath, cliPath, '--scratch', '--apply', '--manifest', first], { cwd: another, encoding: 'utf8' });
    expect(result.status).toBe(1); expect(fs.existsSync(join(root, '_scratch/approved/data'))).toBe(true);
  });
  it.each(['edit', 'replace', 'add-empty', 'protect', 'track', 'unignore', 'remove'])(
    'rejects %s after review and leaves all reviewed content intact', (change) => {
      entry(); const manifest = review();
      if (change === 'edit') { write('_scratch/approved/data', 'changed'); age('_scratch/approved/data'); }
      if (change === 'replace') { fs.renameSync(join(root, '_scratch/approved'), join(root, '_scratch/retained')); entry(); }
      if (change === 'add-empty') { fs.mkdirSync(join(root, '_scratch/approved/new-empty')); age('_scratch/approved'); }
      if (change === 'protect') write('docs/new_plan.md', '`_scratch/approved`');
      if (change === 'track') git('add', '-f', '_scratch/approved/data');
      if (change === 'remove') fs.unlinkSync(join(root, '_scratch/approved/data'));
      if (change === 'unignore') write('.gitignore', '.aio-review/\n');
      const result = cli('--as-of', '2026-10-12', '--apply', '--manifest', manifest);
      expect(result.status).toBe(1);
      expect(fs.existsSync(join(root, '_scratch/approved'))).toBe(true);
      if (change !== 'remove') expect(fs.existsSync(join(root, '_scratch/approved/data'))).toBe(true);
    });
  it.each(['_scratch', '.aio-review'])('rejects a changed %s ancestor between review and apply', (namespace) => {
    if (namespace === '_scratch') entry(); else { write('.aio-review/approved.html'); age('.aio-review/approved.html'); }
    const manifest = review();
    fs.renameSync(join(root, namespace), join(root, `${namespace}-retained`));
    fs.symlinkSync(join(root, `${namespace}-retained`), join(root, namespace));
    const result = guardedCli('--as-of', '2026-10-12', '--apply', '--manifest', manifest);
    expect(result.status).toBe(1);
    expect(fs.existsSync(join(root, 'rm-calls.log'))).toBe(false);
    expect(fs.existsSync(join(root, `${namespace}-retained`, namespace === '_scratch' ? 'approved/data' : 'approved.html'))).toBe(true);
  });
  it.each(['_scratch', '.aio-review'])('rejects replaced real %s ancestors even with the original reviewed child', (namespace) => {
    if (namespace === '_scratch') entry(); else { write('.aio-review/approved.html'); age('.aio-review/approved.html'); }
    const manifest = review();
    fs.renameSync(join(root, namespace), join(root, `${namespace}-retained`));
    fs.mkdirSync(join(root, namespace));
    const child = namespace === '_scratch' ? 'approved' : 'approved.html';
    fs.renameSync(join(root, `${namespace}-retained`, child), join(root, namespace, child));
    const result = guardedCli('--as-of', '2026-10-12', '--apply', '--manifest', manifest);
    expect(result.status).toBe(1); expect(fs.existsSync(join(root, 'rm-calls.log'))).toBe(false);
    expect(fs.existsSync(join(root, namespace, child))).toBe(true);
  });
  it('rejects a substituted linked receipt and malformed manifests', () => {
    entry(); const manifest = review();
    const moved = `${manifest}.retained`; fs.renameSync(manifest, moved); fs.symlinkSync(moved, manifest);
    expect(cli('--apply', '--manifest', manifest).status).toBe(1);
    fs.unlinkSync(manifest); fs.writeFileSync(manifest, '{"entries":[]}');
    expect(cli('--apply', '--manifest', manifest).status).toBe(1);
    expect(fs.existsSync(join(root, '_scratch/approved/data'))).toBe(true);
  });
  it('binds helper review generation to unchanged reviewed entries', () => {
    entry(); const listed = scratchInventory(root, now); write('_scratch/approved/data', 'edited'); age('_scratch/approved/data');
    expect(() => writeScratchReview(root, listed, now)).toThrow(/changed|review|stale/i);
  });
});
