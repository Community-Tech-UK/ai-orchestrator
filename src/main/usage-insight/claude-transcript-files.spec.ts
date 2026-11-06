import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverTranscriptFiles, resolveClaudeConfigRoots } from './claude-transcript-files';
import { setModified } from './claude-transcript.test-helpers';

describe('resolveClaudeConfigRoots', () => {
  let base: string;
  beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), 'claude-roots-'))); });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('finds the default home and every account profile home', () => {
    const home = join(base, 'home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    const stateRoot = join(base, 'state');
    mkdirSync(join(stateRoot, 'claude-cli-profiles', 'work'), { recursive: true });
    mkdirSync(join(stateRoot, 'claude-cli-profiles', 'personal'), { recursive: true });
    writeFileSync(join(stateRoot, 'claude-cli-profiles', 'stray-file.txt'), '');

    const roots = resolveClaudeConfigRoots({ home, stateRoot, env: {} });
    expect(roots.sort()).toEqual([
      join(home, '.claude'),
      join(stateRoot, 'claude-cli-profiles', 'personal'),
      join(stateRoot, 'claude-cli-profiles', 'work'),
    ].sort());
  });

  it('adds CLAUDE_CONFIG_DIR when set, once even if it is also the default home', () => {
    const home = join(base, 'home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    const custom = join(base, 'custom');
    mkdirSync(custom);
    expect(resolveClaudeConfigRoots({ home, env: { CLAUDE_CONFIG_DIR: custom } }).sort()).toEqual([join(home, '.claude'), custom].sort());
    expect(resolveClaudeConfigRoots({ home, env: { CLAUDE_CONFIG_DIR: join(home, '.claude') } })).toEqual([join(home, '.claude')]);
  });

  it('leaves out homes that do not exist', () => {
    expect(resolveClaudeConfigRoots({ home: join(base, 'nowhere'), env: {} })).toEqual([]);
  });
});

describe('discoverTranscriptFiles', () => {
  let root: string;
  const NOW = Date.parse('2026-10-20T12:00:00Z');
  const DAY = 86_400_000;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'claude-files-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function file(relative: string, modified = NOW - DAY): string {
    const path = join(root, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '{}\n');
    setModified(path, modified);
    return path;
  }

  it('finds sessions, helper agent files beside them, and helper files under a session folder', async () => {
    const main = file('projects/-work-app/aaaa-1111.jsonl');
    const agent = file('projects/-work-app/agent-77.jsonl');
    const nested = file('projects/-work-app/aaaa-1111/subagents/agent-9.jsonl');
    const found = await discoverTranscriptFiles([root], NOW - 7 * DAY);
    expect(found.map((entry) => entry.path).sort()).toEqual([main, agent, nested].sort());
    const byPath = new Map(found.map((entry) => [entry.path, entry.fileSessionId] as const));
    expect(byPath.get(main)).toBe('aaaa-1111');
    expect(byPath.get(agent)).toBe('agent-77');
    expect(byPath.get(nested)).toBe('aaaa-1111');
  });

  it('ignores other files and folders', async () => {
    file('projects/-work-app/notes.txt');
    file('projects/-work-app/aaaa-1111/tool-results/output.jsonl');
    file('history.jsonl');
    expect(await discoverTranscriptFiles([root], NOW - 7 * DAY)).toEqual([]);
  });

  it('leaves out files not touched inside the window and lists the newest first', async () => {
    file('projects/p/old.jsonl', NOW - 8 * DAY);
    const recent = file('projects/p/recent.jsonl', NOW - 2 * DAY);
    const newest = file('projects/p/newest.jsonl', NOW - 1000);
    const found = await discoverTranscriptFiles([root], NOW - 7 * DAY);
    expect(found.map((entry) => entry.path)).toEqual([newest, recent]);
  });

  it('searches every root and copes with a root that has no projects folder', async () => {
    const other = mkdtempSync(join(tmpdir(), 'claude-files-other-'));
    try {
      const one = file('projects/p/a.jsonl');
      mkdirSync(join(other, 'projects', 'q'), { recursive: true });
      const two = join(other, 'projects', 'q', 'b.jsonl');
      writeFileSync(two, '{}\n');
      setModified(two, NOW - DAY);
      const found = await discoverTranscriptFiles([root, other, join(root, 'missing')], NOW - 7 * DAY);
      expect(found.map((entry) => entry.path).sort()).toEqual([one, two].sort());
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('reports size and modified time', async () => {
    const path = file('projects/p/a.jsonl', NOW - DAY);
    const [only] = await discoverTranscriptFiles([root], NOW - 7 * DAY);
    expect(only.path).toBe(path);
    expect(only.size).toBe(3);
    expect(Math.round(only.mtimeMs / 1000)).toBe(Math.round((NOW - DAY) / 1000));
  });
});
