import { describe, expect, it } from 'vitest';
import {
  collectClaudeAtImportPaths,
  nativeOwnedInstructionPaths,
  omitNativeOwnedInstructionStack,
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
        { path: '/Users/james/.claude/CLAUDE.md', kind: 'claude', loaded: true, applied: true },
        { path: '/proj/CLAUDE.md', kind: 'claude', loaded: true, applied: true },
        { path: '/proj/AGENTS.md', kind: 'agents', loaded: true, applied: true },
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
        { path: '/proj/CLAUDE.md', kind: 'claude', loaded: true, applied: true },
        { path: '/proj/AGENTS.md', kind: 'agents', loaded: true, applied: true },
      ],
      readFile: () => null,
    });
    expect([...owned]).toEqual(['/proj/AGENTS.md']);
  });

  it('skips nothing when the provider is empty or unknown', () => {
    const sources = [
      { path: '/proj/AGENTS.md', kind: 'agents' as const, loaded: true, applied: true },
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
          { path: '/proj/CLAUDE.md', kind: 'claude', loaded: true, applied: true, reason: undefined },
          { path: '/proj/AGENTS.md', kind: 'agents', loaded: true, applied: true, reason: undefined },
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
