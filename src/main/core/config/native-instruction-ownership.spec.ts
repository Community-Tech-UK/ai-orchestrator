import { describe, expect, it } from 'vitest';
import {
  collectClaudeAtImportPaths,
  nativeOwnedInstructionPaths,
  omitNativeOwnedInstructionStack,
  removeParagraphsLoadedNatively,
} from './native-instruction-ownership';

describe('native-instruction-ownership', () => {
  it('resolves Claude @imports including ~/ and relative paths', () => {
    const imports = collectClaudeAtImportPaths(
      '/proj/CLAUDE.md',
      '@AGENTS.md\n@~/work/global.md\n@https://example.com/skip\n@not a path\n',
      '/Users/james',
    );
    expect(imports).toEqual([
      '/proj/AGENTS.md',
      '/Users/james/work/global.md',
    ]);
  });

  it('Claude owns CLAUDE.md files plus their @import closure', () => {
    const files = new Map<string, string>([
      ['/Users/james/.claude/CLAUDE.md', '@AGENTS.md\n'],
      ['/Users/james/.claude/AGENTS.md', 'global agents'],
      ['/proj/CLAUDE.md', '@docs/angular-conventions.md\n'],
      ['/proj/docs/angular-conventions.md', 'conventions'],
      ['/proj/AGENTS.md', 'project agents'],
    ]);
    const owned = nativeOwnedInstructionPaths({
      provider: 'claude',
      sources: [
        { path: '/Users/james/.claude/CLAUDE.md', kind: 'claude', scope: 'project', loaded: true, applied: true },
        { path: '/proj/CLAUDE.md', kind: 'claude', scope: 'project', loaded: true, applied: true },
        { path: '/proj/AGENTS.md', kind: 'agents', scope: 'project', loaded: true, applied: true },
      ],
      readFile: (filePath) => files.get(filePath) ?? null,
      homeDir: '/Users/james',
    });

    expect(owned.has('/Users/james/.claude/CLAUDE.md')).toBe(true);
    expect(owned.has('/Users/james/.claude/AGENTS.md')).toBe(true);
    expect(owned.has('/proj/CLAUDE.md')).toBe(true);
    expect(owned.has('/proj/docs/angular-conventions.md')).toBe(true);
    expect(owned.has('/proj/AGENTS.md')).toBe(false);
  });

  it('Codex skips AGENTS.md and keeps CLAUDE.md', () => {
    const owned = nativeOwnedInstructionPaths({
      provider: 'codex',
      sources: [
        { path: '/proj/CLAUDE.md', kind: 'claude', scope: 'project', loaded: true, applied: true },
        { path: '/proj/AGENTS.md', kind: 'agents', scope: 'project', loaded: true, applied: true },
      ],
      readFile: () => null,
    });
    expect([...owned]).toEqual(['/proj/AGENTS.md']);
  });

  it('skips nothing when the provider is empty or unknown', () => {
    const sources = [
      { path: '/proj/AGENTS.md', kind: 'agents' as const, scope: 'project' as const, loaded: true, applied: true },
    ];
    expect(nativeOwnedInstructionPaths({
      provider: '',
      sources,
      readFile: () => null,
    }).size).toBe(0);
    expect(nativeOwnedInstructionPaths({
      provider: 'grok',
      sources,
      readFile: () => null,
    }).size).toBe(0);
  });

  it('rebuilds mergedContent after dropping native-owned parts', () => {
    const omitted = omitNativeOwnedInstructionStack(
      {
        mergedContent: 'claude file\n\n---\n\nagents file',
        sources: [
          { path: '/proj/CLAUDE.md', kind: 'claude', scope: 'project', loaded: true, applied: true, reason: undefined },
          { path: '/proj/AGENTS.md', kind: 'agents', scope: 'project', loaded: true, applied: true, reason: undefined },
        ],
      },
      'claude',
      () => null,
    );
    expect(omitted.mergedContent).toBe('agents file');
    expect(omitted.sources[0]?.applied).toBe(false);
    expect(omitted.sources[0]?.reason).toMatch(/native CLI already loads/i);
    expect(omitted.sources[1]?.applied).toBe(true);
  });
});


it('OpenCode owns root and nested AGENTS files but keeps Claude and global Harness rules', () => {
  const owned = nativeOwnedInstructionPaths({ provider: 'opencode', readFile: () => null, sources: [
    { path: '/proj/AGENTS.md', kind: 'agents', scope: 'project', loaded: true, applied: true },
    { path: '/proj/src/AGENTS.md', kind: 'agents', scope: 'path-specific', loaded: true, applied: true },
    { path: '/proj/CLAUDE.md', kind: 'claude', scope: 'project', loaded: true, applied: true },
    { path: '/home/.claude/CLAUDE.md', kind: 'claude', scope: 'user', loaded: true, applied: true },
  ] });
  expect([...owned]).toEqual(['/proj/AGENTS.md', '/proj/src/AGENTS.md']);
});

it('Copilot owns project native files but never global or .claude rules', () => {
  const owned = nativeOwnedInstructionPaths({ provider: 'copilot', readFile: () => null, sources: [
    { path: '/proj/AGENTS.md', kind: 'agents', scope: 'project', loaded: true, applied: true },
    { path: '/proj/GEMINI.md', kind: 'gemini', scope: 'project', loaded: true, applied: true },
    { path: '/proj/CLAUDE.md', kind: 'claude', scope: 'project', loaded: true, applied: true },
    { path: '/proj/.claude/CLAUDE.md', kind: 'claude', scope: 'project', loaded: true, applied: true },
    { path: '/home/.claude/CLAUDE.md', kind: 'claude', scope: 'user', loaded: true, applied: true },
    { path: '/proj/.github/copilot-instructions.md', kind: 'copilot', scope: 'project', loaded: true, applied: true },
  ] });
  expect([...owned]).toEqual(['/proj/AGENTS.md', '/proj/GEMINI.md', '/proj/CLAUDE.md', '/proj/.github/copilot-instructions.md']);
});


it('removes native Codex paragraphs locally, keeps remote and non-Codex text, and prefers override', () => {
  const globalText = '# Shared rules\n\nUse type-safe code.\n\n# Harness-only rules\n\nVerify the real runtime.';
  const resolution = { mergedContent: globalText, sources: [
    { path: '/home/.claude/CLAUDE.md', kind: 'claude' as const, scope: 'user' as const, loaded: true, applied: true, reason: undefined },
  ] };
  const files = new Map([
    ['/home/.codex/AGENTS.override.md', '# Native rules\n\nUse type-safe code.'],
    ['/home/.codex/AGENTS.md', 'Verify the real runtime.'],
  ]);
  const readFile = (filePath: string) => files.get(filePath) ?? null;
  const local = omitNativeOwnedInstructionStack(resolution, 'codex', readFile, '/home');
  expect(local.mergedContent).not.toContain('Use type-safe code.');
  expect(local.mergedContent).not.toContain('# Shared rules');
  expect(local.mergedContent).toContain('Verify the real runtime.');
  expect(local.mergedContent).toContain('(Paragraphs that Codex already loads from its own AGENTS.md are left out here.)');
  expect(local.sources[0].reason).toContain('Paragraphs');
  expect(omitNativeOwnedInstructionStack(resolution, 'codex', readFile, '/home')).toEqual(local);
  expect(omitNativeOwnedInstructionStack(resolution, 'codex', readFile, '/home', { remote: true })).toEqual(resolution);
  expect(omitNativeOwnedInstructionStack(resolution, 'opencode', readFile, '/home')).toEqual(resolution);
});

it('falls back to native Codex AGENTS.md when no override exists', () => {
  const resolution = { mergedContent: 'Shared paragraph.\n\nHarness paragraph.', sources: [
    { path: '/home/.claude/CLAUDE.md', kind: 'claude' as const, scope: 'user' as const, loaded: true, applied: true },
  ] };
  const result = omitNativeOwnedInstructionStack(resolution, 'codex', (filePath) => filePath === '/home/.codex/AGENTS.md' ? 'Shared paragraph.' : null, '/home');
  expect(result.mergedContent).not.toContain('Shared paragraph.');
  expect(result.mergedContent).toContain('Harness paragraph.');
});

it('preserves a resolution whose internal separators break source/part pairing', () => {
  const resolution = { mergedContent: 'First clause\n\n---\n\nSecond clause\n\n---\n\nNative AGENTS clause', sources: [
    { path: '/proj/CLAUDE.md', kind: 'claude' as const, scope: 'project' as const, loaded: true, applied: true },
    { path: '/proj/AGENTS.md', kind: 'agents' as const, scope: 'project' as const, loaded: true, applied: true },
  ] };
  expect(omitNativeOwnedInstructionStack(resolution, 'codex', () => null)).toEqual(resolution);
});


it('keeps fenced code whole and retains headings with surviving paragraphs', () => {
  const source = '# Rules\n\nShared rule.\n\n## Unique examples\n\n```ts\nconst first = 1;\n\nconst second = 2;\n```\n\nUnique paragraph.';
  expect(removeParagraphsLoadedNatively(source, 'Shared rule.\n\nconst first = 1;')).toBe('# Rules\n\n## Unique examples\n\n```ts\nconst first = 1;\n\nconst second = 2;\n```\n\nUnique paragraph.');
  expect(removeParagraphsLoadedNatively(source, 'Shared rule.\n\n```ts\nconst first = 1;\n\nconst second = 2;\n```')).toBe('# Rules\n\n## Unique examples\n\nUnique paragraph.');
});
