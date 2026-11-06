import { describe, expect, it } from 'vitest';
import { omitNativeOwnedInstructionStack, type NativeInstructionSource } from './native-instruction-ownership';

describe('Google global instruction diet', () => {
  it.each(['gemini', 'antigravity'])('replaces only the global Claude source with a safety digest for %s', (provider) => {
    const result = omitNativeOwnedInstructionStack({
      mergedContent: 'Lengthy global Claude rules\n\n---\n\nProject-specific rules\n\n---\n\nNative Gemini rules',
      sources: [
        { path: '/home/.claude/CLAUDE.md', kind: 'claude', scope: 'user', loaded: true, applied: true },
        { path: '/repo/CLAUDE.md', kind: 'claude', scope: 'project', loaded: true, applied: true },
        { path: '/repo/GEMINI.md', kind: 'gemini', scope: 'project', loaded: true, applied: true },
      ] as NativeInstructionSource[],
    }, provider, () => null);
    expect(result.mergedContent).not.toContain('Lengthy global Claude rules');
    expect(result.mergedContent).toContain('Project-specific rules');
    expect(result.mergedContent).not.toContain('windows-pc');
    expect(result.mergedContent).not.toContain('Mac');
    expect(result.mergedContent).not.toContain('branches/worktrees');
    expect(result.mergedContent).toContain('current user and project instructions');
    expect(result.mergedContent).toContain('Never expose secrets');
    expect(result.sources[0].reason).toContain('safety digest');
    expect(result.sources[0].reason).not.toContain('native CLI already loads');
  });
});
