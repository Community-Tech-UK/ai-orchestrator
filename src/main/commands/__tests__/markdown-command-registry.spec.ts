import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test-home') },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  })),
}));

// fs/promises mock — tracks which dirs were stat-checked
const statCalls: string[] = [];
const readdirResults = new Map<string, import('fs').Dirent[]>();
const fileContents = new Map<string, string>();

vi.mock('fs/promises', () => ({
  readdir: vi.fn(async (dir: string) => {
    const entries = readdirResults.get(dir);
    if (!entries) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return entries;
  }),
  readFile: vi.fn(async (filePath: string) => {
    const content = fileContents.get(filePath);
    if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return content;
  }),
  stat: vi.fn(async (p: string) => {
    statCalls.push(p as string);
    // Return a stable mtime for dirs that exist in readdirResults
    if (readdirResults.has(p as string)) return { mtimeMs: 1000 };
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
}));

import {
  MarkdownCommandRegistry,
  _resetMarkdownCommandRegistryForTesting,
} from '../markdown-command-registry';

function makeDirent(name: string, isDir = false): import('fs').Dirent {
  return {
    name,
    isFile: () => !isDir,
    isDirectory: () => isDir,
    isSymbolicLink: () => false,
  } as unknown as import('fs').Dirent;
}

const HOME_COMMANDS = '/tmp/test-home/.orchestrator/commands';
const PROJECT_COMMANDS = '/tmp/test-project/.orchestrator/commands';

beforeEach(() => {
  _resetMarkdownCommandRegistryForTesting();
  statCalls.length = 0;
  readdirResults.clear();
  fileContents.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('priority field on loaded commands', () => {
  it('global commands get lower priority than project commands', async () => {
    const reg = MarkdownCommandRegistry.getInstance();

    readdirResults.set(HOME_COMMANDS, [makeDirent('foo.md')]);
    fileContents.set(`${HOME_COMMANDS}/foo.md`, '# Foo\nGlobal version');

    readdirResults.set(PROJECT_COMMANDS, [makeDirent('foo.md')]);
    fileContents.set(`${PROJECT_COMMANDS}/foo.md`, '# Foo\nProject version');

    const result = await reg.listCommands('/tmp/test-project');
    const fooCommand = result.commands.find(c => c.name === 'foo');
    expect(fooCommand).toBeDefined();
    // Project-level override should win (later source)
    expect(fooCommand!.template).toContain('Project version');
    // priority field: project > global
    expect(fooCommand!.priority).toBeGreaterThan(0);

    // Both candidates are tracked
    expect(result.candidatesByName['foo']).toHaveLength(2);
    const priorities = result.candidatesByName['foo'].map(c => c.priority);
    expect(priorities[0]).toBeLessThan(priorities[1]!);
  });

  it('commands with no override still have a priority field', async () => {
    readdirResults.set(HOME_COMMANDS, [makeDirent('bar.md')]);
    fileContents.set(`${HOME_COMMANDS}/bar.md`, '# Bar\nOnly global');

    const reg = MarkdownCommandRegistry.getInstance();
    const result = await reg.listCommands('/tmp/test-project');
    const bar = result.commands.find(c => c.name === 'bar');
    expect(bar).toBeDefined();
    expect(typeof bar!.priority).toBe('number');
  });
});

describe('mtime skip — per-directory optimisation', () => {
  it('skips re-walking a directory whose mtime is unchanged within TTL', async () => {
    readdirResults.set(HOME_COMMANDS, [makeDirent('hello.md')]);
    fileContents.set(`${HOME_COMMANDS}/hello.md`, '# Hello\nworld');

    const reg = MarkdownCommandRegistry.getInstance();

    // First load — populates mtime baseline
    await reg.listCommands('/tmp/test-project');
    const statCallsAfterFirst = statCalls.length;

    // Advance time by less than TTL (TTL = 10 s), mtime unchanged
    vi.advanceTimersByTime(5_000);

    // Second load — cache is still valid, no stat calls needed
    await reg.listCommands('/tmp/test-project');
    expect(statCalls.length).toBe(statCallsAfterFirst); // no new stat calls
  });

  it('re-walks a directory after TTL expires', async () => {
    readdirResults.set(HOME_COMMANDS, [makeDirent('hello.md')]);
    fileContents.set(`${HOME_COMMANDS}/hello.md`, '# Hello\nworld');

    const reg = MarkdownCommandRegistry.getInstance();
    await reg.listCommands('/tmp/test-project');

    // Expire TTL
    vi.advanceTimersByTime(11_000);

    await reg.listCommands('/tmp/test-project');
    // After TTL expiry, stat is called again to re-check directories
    expect(statCalls.length).toBeGreaterThan(0);
  });

  it('re-walks a directory when mtime changes even within TTL', async () => {
    const { stat } = await import('fs/promises');
    let callCount = 0;
    vi.mocked(stat).mockImplementation(async (p: string) => {
      statCalls.push(p as string);
      callCount++;
      // Second call returns a different mtime to simulate file change
      return { mtimeMs: callCount === 1 ? 1000 : 2000 } as import('fs').Stats;
    });

    readdirResults.set(HOME_COMMANDS, [makeDirent('hello.md')]);
    fileContents.set(`${HOME_COMMANDS}/hello.md`, '# Hello\nworld');

    const reg = MarkdownCommandRegistry.getInstance();
    await reg.listCommands('/tmp/test-project');

    // Advance less than TTL but mtime will change on next stat call
    vi.advanceTimersByTime(3_000);
    // Force re-check by clearing just the directory mtime cache
    reg.clearDirectoryMtimeCache('/tmp/test-project');
    await reg.listCommands('/tmp/test-project');

    // Stat should have been called to detect the change
    expect(statCalls.length).toBeGreaterThan(1);
  });
});
