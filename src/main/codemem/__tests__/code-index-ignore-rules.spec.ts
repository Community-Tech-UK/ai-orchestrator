import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCodeIndexIgnoreRules } from '../code-index-ignore-rules';

async function put(root: string, relativePath: string, content = 'x\n'): Promise<void> {
  await mkdir(dirname(join(root, relativePath)), { recursive: true });
  await writeFile(join(root, relativePath), content);
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('loadCodeIndexIgnoreRules', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'codemem-ignore-rules-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('follows nested .gitignore files and .git/info/exclude in a git work tree', async () => {
    git(root, 'init', '-q');
    await put(root, 'src/meetings.ts');
    await put(root, 'apps/web/.gitignore', '/dist-xa\n');
    await put(root, 'apps/web/dist-xa/find-meetings/friday/index.html');
    await put(root, 'apps/web/src/app.ts');
    await put(root, 'runner-copy/apps/desk/main.ts');
    await writeFile(join(root, '.git/info/exclude'), 'runner-copy/\n');

    const rules = await loadCodeIndexIgnoreRules(root);

    expect(rules.ignores('apps/web/dist-xa/')).toBe(true);
    expect(rules.ignores('apps/web/dist-xa/find-meetings/friday/index.html')).toBe(true);
    expect(rules.ignores('runner-copy/')).toBe(true);
    expect(rules.ignores('runner-copy/apps/desk/main.ts')).toBe(true);
    expect(rules.ignores('apps/web/')).toBe(false);
    expect(rules.ignores('apps/web/src/app.ts')).toBe(false);
    expect(rules.ignores('src/meetings.ts')).toBe(false);
    // Built-in rules still apply.
    expect(rules.ignores('node_modules/')).toBe(true);
    expect(rules.ignores('.gitignore')).toBe(true);
  });

  it('keeps tracked files that match an ignore pattern, as git does', async () => {
    git(root, 'init', '-q');
    await put(root, '.gitignore', '*.gen.ts\n');
    await put(root, 'src/tracked.gen.ts');
    await put(root, 'src/untracked.gen.ts');
    git(root, 'add', '-f', 'src/tracked.gen.ts');

    const rules = await loadCodeIndexIgnoreRules(root);

    expect(rules.ignores('src/tracked.gen.ts')).toBe(false);
    expect(rules.ignores('src/untracked.gen.ts')).toBe(true);
  });

  it('matches paths relative to a workspace inside a larger repository', async () => {
    git(root, 'init', '-q');
    await put(root, 'apps/web/.gitignore', '/dist-xa\n');
    await put(root, 'apps/web/dist-xa/index.html');
    await put(root, 'apps/web/src/app.ts');

    const rules = await loadCodeIndexIgnoreRules(join(root, 'apps'));

    expect(rules.ignores('web/dist-xa/index.html')).toBe(true);
    expect(rules.ignores('web/src/app.ts')).toBe(false);
  });

  it('indexes a workspace its enclosing repository ignores, using its own root .gitignore', async () => {
    git(root, 'init', '-q');
    await put(root, '.gitignore', '_work/\n');
    const workspace = join(root, '_work', 'project');
    await put(workspace, '.gitignore', 'generated/\n');
    await put(workspace, 'src/app.ts');
    await put(workspace, 'generated/out.ts');

    const rules = await loadCodeIndexIgnoreRules(workspace);

    expect(rules.ignores('src/app.ts')).toBe(false);
    expect(rules.ignores('generated/')).toBe(true);
  });

  it('uses only the root .gitignore outside git', async () => {
    await put(root, '.gitignore', 'generated/\n');
    await put(root, 'generated/out.ts');
    await put(root, 'src/app.ts');

    const rules = await loadCodeIndexIgnoreRules(root);

    expect(rules.ignores('generated/')).toBe(true);
    expect(rules.ignores('src/app.ts')).toBe(false);
  });
});
