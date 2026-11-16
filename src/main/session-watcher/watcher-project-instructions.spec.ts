import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readWatcherProjectInstructions, WATCHER_PROJECT_INSTRUCTIONS_CHARS } from './watcher-project-instructions';

vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));

describe('readWatcherProjectInstructions', () => {
  let root: string;
  let project: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'watcher-instructions-'));
    project = join(root, 'project');
    mkdirSync(project);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('is empty for a folder with no instruction file, one that is not there, or a path that is not absolute', async () => {
    expect(await readWatcherProjectInstructions(project)).toBe('');
    expect(await readWatcherProjectInstructions(join(root, 'missing'))).toBe('');
    writeFileSync(join(project, 'CLAUDE.md'), 'Rules.');
    expect(await readWatcherProjectInstructions('project')).toBe('');
    expect(await readWatcherProjectInstructions('')).toBe('');
  });

  it('never opens an instruction file that is not a plain file, so a pipe cannot hold the read', async () => {
    execFileSync('mkfifo', [join(project, 'CLAUDE.md')]);
    expect(await readWatcherProjectInstructions(project)).toBe('');
  });

  it('reads the folder\'s CLAUDE.md', async () => {
    writeFileSync(join(project, 'CLAUDE.md'), '# Translation project\n\nTranslate every message.\n');
    expect(await readWatcherProjectInstructions(project)).toBe('# Translation project\n\nTranslate every message.');
  });

  it('replaces a line that imports a file inside the folder with that file, one level deep', async () => {
    writeFileSync(join(project, 'CLAUDE.md'), '@AGENTS.md\n');
    writeFileSync(join(project, 'AGENTS.md'), 'Never push.\n@MORE.md');
    writeFileSync(join(project, 'MORE.md'), 'Not read.');
    expect(await readWatcherProjectInstructions(project)).toBe('Never push.\n@MORE.md');
  });

  it('leaves an import from outside the folder, or through a link that leads outside it, as written', async () => {
    writeFileSync(join(root, 'secret.md'), 'Outside the folder.');
    symlinkSync(join(root, 'secret.md'), join(project, 'notes.md'));
    writeFileSync(join(project, 'CLAUDE.md'), `@../secret.md\n@${join(root, 'secret.md')}\n@notes.md\n@everyone`);
    expect(await readWatcherProjectInstructions(project)).toBe(`@../secret.md\n@${join(root, 'secret.md')}\n@notes.md\n@everyone`);
  });

  it('keeps only the start of a long file', async () => {
    writeFileSync(join(project, 'CLAUDE.md'), 'Rule.\n'.repeat(200_000));
    const text = await readWatcherProjectInstructions(project);
    expect(text.length).toBe(WATCHER_PROJECT_INSTRUCTIONS_CHARS);
    expect(text.startsWith('Rule.\nRule.')).toBe(true);
  });
});
