import { describe, expect, it } from 'vitest';
import { omitNativeOwnedInstructionStack, type NativeInstructionSource } from './native-instruction-ownership';

const resolution = () => ({
  mergedContent: 'Lengthy global Claude rules\n\n---\n\nProject-specific rules\n\n---\n\nNative Gemini rules',
  sources: [
    { path: '/home/.claude/CLAUDE.md', kind: 'claude', scope: 'user', loaded: true, applied: true },
    { path: '/repo/CLAUDE.md', kind: 'claude', scope: 'project', loaded: true, applied: true },
    { path: '/repo/GEMINI.md', kind: 'gemini', scope: 'project', loaded: true, applied: true },
  ] as NativeInstructionSource[],
});
/** The global Claude rules stay in full and are not marked as replaced. */
function expectGlobalRulesKept(result: ReturnType<typeof omitNativeOwnedInstructionStack<NativeInstructionSource>>): void {
  expect(result.mergedContent).toContain('Lengthy global Claude rules');
  expect(result.mergedContent).not.toContain('Product safety');
  expect(result.sources[0]).toMatchObject({ path: '/home/.claude/CLAUDE.md', applied: true });
  expect(result.sources[0].reason).toBeUndefined();
}
const ownGeminiFile = (text: string | null) => (filePath: string) => filePath === '/home/.gemini/GEMINI.md' ? text : null;

describe('Google global instruction diet', () => {
  it('replaces only the global Claude source with a safety digest when Gemini has its own GEMINI.md', () => {
    const result = omitNativeOwnedInstructionStack(resolution(), 'gemini', ownGeminiFile('@/home/.agents/AGENTS.md\n'), '/home');
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

  it.each([
    ['there is no GEMINI.md', null],
    ['the GEMINI.md is empty', '  \n'],
  ])('keeps the full global instructions for Gemini when %s', (_label, text) => {
    expectGlobalRulesKept(omitNativeOwnedInstructionStack(resolution(), 'gemini', ownGeminiFile(text), '/home'));
  });

  it('keeps the full global instructions when the session runs on another computer, where the file was not checked', () => {
    expectGlobalRulesKept(omitNativeOwnedInstructionStack(resolution(), 'gemini', ownGeminiFile('@/home/.agents/AGENTS.md\n'), '/home', { remote: true }));
  });

  it('keeps the full global instructions for Antigravity, whose print mode is not known to read GEMINI.md', () => {
    expectGlobalRulesKept(omitNativeOwnedInstructionStack(resolution(), 'antigravity', ownGeminiFile('@/home/.agents/AGENTS.md\n'), '/home'));
  });
});
