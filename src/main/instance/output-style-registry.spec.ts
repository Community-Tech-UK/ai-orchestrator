import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// Point the registry's home dir at an empty temp dir so home-level styles never
// leak into these working-directory-scoped tests.
let homeDir: string;
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => homeDir) },
}));

import { OutputStyleRegistry, getOutputStyleRegistry } from './output-style-registry';

let workDir: string;

async function writeStyle(relName: string, body: string): Promise<string> {
  const file = path.join(workDir, '.orchestrator', 'output-styles', relName);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, 'utf-8');
  return file;
}

beforeEach(async () => {
  OutputStyleRegistry._resetForTesting();
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'os-home-'));
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'os-work-'));
});

afterEach(async () => {
  await fs.rm(homeDir, { recursive: true, force: true });
  await fs.rm(workDir, { recursive: true, force: true });
});

describe('OutputStyleRegistry (user .md output styles, A7#29)', () => {
  it('loads a user style with frontmatter (label + mode) and body as the directive', async () => {
    await writeStyle('pirate.md', `---\nlabel: Pirate Mode\nmode: append\ndescription: Arrr\n---\nTalk like a pirate.`);

    const resolved = await getOutputStyleRegistry().resolveUserStyle(workDir, 'pirate');
    expect(resolved).toMatchObject({
      name: 'pirate',
      label: 'Pirate Mode',
      directive: 'Talk like a pirate.',
      mode: 'append',
      source: 'user',
      description: 'Arrr',
    });
    expect(resolved?.filePath?.endsWith(path.join('output-styles', 'pirate.md'))).toBe(true);
  });

  it('supports full-prompt-swap via mode: replace', async () => {
    await writeStyle('oracle.md', `---\nmode: replace\n---\nYou are a terse oracle.`);
    const resolved = await getOutputStyleRegistry().resolveUserStyle(workDir, 'oracle');
    expect(resolved?.mode).toBe('replace');
    expect(resolved?.directive).toBe('You are a terse oracle.');
  });

  it('defaults mode to append and label to the name when frontmatter is absent', async () => {
    await writeStyle('plain.md', 'Be extremely formal.');
    const resolved = await getOutputStyleRegistry().resolveUserStyle(workDir, 'plain');
    expect(resolved).toMatchObject({ name: 'plain', label: 'plain', mode: 'append', directive: 'Be extremely formal.' });
  });

  it('derives nested names with ":" separators', async () => {
    await writeStyle(path.join('team', 'brief.md'), 'Keep it brief.');
    const resolved = await getOutputStyleRegistry().resolveUserStyle(workDir, 'team:brief');
    expect(resolved?.directive).toBe('Keep it brief.');
  });

  it('never shadows a built-in name', async () => {
    await writeStyle('concise.md', 'HIJACKED');
    expect(await getOutputStyleRegistry().resolveUserStyle(workDir, 'concise')).toBeNull();
    // ...and it is excluded from the listing.
    const listed = await getOutputStyleRegistry().listUserStyles(workDir);
    expect(listed.styles.find((s) => s.name === 'concise')).toBeUndefined();
  });

  it('skips files with an empty body', async () => {
    await writeStyle('blank.md', `---\nlabel: Blank\n---\n   \n`);
    expect(await getOutputStyleRegistry().resolveUserStyle(workDir, 'blank')).toBeNull();
  });

  it('returns null for built-in and unknown names', async () => {
    expect(await getOutputStyleRegistry().resolveUserStyle(workDir, 'default')).toBeNull();
    expect(await getOutputStyleRegistry().resolveUserStyle(workDir, 'learning')).toBeNull();
    expect(await getOutputStyleRegistry().resolveUserStyle(workDir, 'does-not-exist')).toBeNull();
  });

  it('lists user styles sorted by name with scan dirs', async () => {
    await writeStyle('zeta.md', 'Z');
    await writeStyle('alpha.md', 'A');
    const { styles, scanDirs } = await getOutputStyleRegistry().listUserStyles(workDir);
    expect(styles.map((s) => s.name)).toEqual(['alpha', 'zeta']);
    expect(scanDirs.some((d) => d.endsWith(path.join('.orchestrator', 'output-styles')))).toBe(true);
  });

  it('caches results until clearCache is called', async () => {
    await writeStyle('one.md', 'first');
    expect((await getOutputStyleRegistry().listUserStyles(workDir)).styles).toHaveLength(1);

    await writeStyle('two.md', 'second');
    // Still cached — the new file is not visible yet.
    expect((await getOutputStyleRegistry().listUserStyles(workDir)).styles).toHaveLength(1);

    getOutputStyleRegistry().clearCache(workDir);
    expect((await getOutputStyleRegistry().listUserStyles(workDir)).styles).toHaveLength(2);
  });
});
