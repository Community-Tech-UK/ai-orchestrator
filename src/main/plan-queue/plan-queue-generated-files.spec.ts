import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GENERATED_ARTIFACTS_FILE, loadGeneratedFiles } from './plan-queue-generated-files';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let repo: string;
const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function commit(content: string | null): Promise<string> {
  if (content !== null) { await mkdir(dirname(join(repo, GENERATED_ARTIFACTS_FILE)), { recursive: true }); await writeFile(join(repo, GENERATED_ARTIFACTS_FILE), content); }
  await writeFile(join(repo, 'touch.txt'), `${Math.random()}\n`);
  git(['add', '.']); git(['commit', '-qm', 'c']);
  return git(['rev-parse', 'HEAD']);
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'queue-generated-list-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Queue Test']); git(['config', 'user.email', 'queue@example.invalid']); git(['config', 'commit.gpgsign', 'false']);
});
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

describe('loadGeneratedFiles', () => {
  it("accepts this repository's own list, the one its hook reads", async () => {
    const real = await readFile(join(__dirname, '../../../', GENERATED_ARTIFACTS_FILE), 'utf8');
    const tip = await commit(real);
    const loaded = await loadGeneratedFiles(repo, tip, tip);
    const expected = JSON.parse(real) as { artifacts: string[]; generators: string[] };
    expect([...loaded!.artifacts]).toEqual(expected.artifacts);
    expect(loaded!.generators).toEqual(expected.generators);
  });

  it('keeps only files both tips list, with the landing tip\'s generators', async () => {
    const base = await commit(JSON.stringify({ artifacts: ['a.ts', 'b.ts'], generators: ['gen:old'] }));
    const tip = await commit(JSON.stringify({ artifacts: ['b.ts', 'c.ts'], generators: ['gen:new'] }));
    const loaded = await loadGeneratedFiles(repo, base, tip);
    expect([...loaded!.artifacts]).toEqual(['b.ts']);
    expect(loaded!.generators).toEqual(['gen:new']);
  });

  it('returns null when either tip has no list', async () => {
    const base = await commit(null);
    const tip = await commit(JSON.stringify({ artifacts: ['a.ts'], generators: [] }));
    expect(await loadGeneratedFiles(repo, base, tip)).toBeNull();
    expect(await loadGeneratedFiles(repo, tip, base)).toBeNull();
  });

  it.each([
    ['an absolute path', { artifacts: ['/etc/passwd'], generators: [] }],
    ['a parent path', { artifacts: ['a/../../b'], generators: [] }],
    ['a drive path', { artifacts: ['C:/x'], generators: [] }],
    ['an empty list', { artifacts: [], generators: [] }],
    ['a generator that is not a script name', { artifacts: ['a.ts'], generators: ['x; rm -rf /'] }],
  ])('rejects %s', async (_name, list) => {
    const tip = await commit(JSON.stringify(list));
    await expect(loadGeneratedFiles(repo, tip, tip)).rejects.toThrow('not a valid list');
  });
});
