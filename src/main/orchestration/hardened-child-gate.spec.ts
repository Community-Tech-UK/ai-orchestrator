import { describe, expect, it } from 'vitest';
import { hardenedChildRefusal } from './hardened-child-gate';

const local = { provider: undefined, executionLocation: { type: 'local' } };

describe('hardenedChildRefusal', () => {
  it('has nothing to say about a command that does not ask for hardened mode, wherever it runs', () => {
    expect(hardenedChildRefusal({ provider: 'gemini', node: 'windows-pc' }, local, 'win32')).toBeUndefined();
    expect(hardenedChildRefusal({ hardened: false, provider: 'gemini' }, local, 'linux')).toBeUndefined();
  });

  it.each(['claude', 'codex', 'antigravity', 'grok', 'opencode', 'cursor', 'copilot'])(
    'accepts %s on a Mac, running locally',
    (provider) => {
      expect(hardenedChildRefusal({ hardened: true, provider } as never, local, 'darwin')).toBeUndefined();
    },
  );

  it('uses the parent\'s provider when the command names none', () => {
    expect(hardenedChildRefusal({ hardened: true }, { provider: 'codex' }, 'darwin')).toBeUndefined();
    expect(hardenedChildRefusal({ hardened: true }, { provider: 'gemini' }, 'darwin')).toMatch(/not supported for Gemini/i);
  });

  it('lets the command\'s own provider win over the parent\'s', () => {
    expect(hardenedChildRefusal({ hardened: true, provider: 'codex' }, { provider: 'gemini' }, 'darwin')).toBeUndefined();
  });

  it('refuses a child that would run on a worker computer, named or inherited, before anything else', () => {
    expect(hardenedChildRefusal({ hardened: true, provider: 'codex', node: 'windows-pc' }, local, 'darwin')).toMatch(/remote instances/);
    expect(hardenedChildRefusal({ hardened: true, provider: 'codex' }, { executionLocation: { type: 'remote' } }, 'darwin')).toMatch(/remote instances/);
    expect(hardenedChildRefusal({ hardened: true, provider: 'nonsense', node: 'n' } as never, local, 'win32')).toMatch(/remote instances/);
  });

  it.each(['win32', 'linux'] as const)('refuses a %s host and says it needs a Mac', (platform) => {
    expect(hardenedChildRefusal({ hardened: true, provider: 'codex' }, local, platform)).toMatch(/needs macOS/);
  });

  it('refuses an unresolved provider rather than guessing', () => {
    expect(hardenedChildRefusal({ hardened: true }, local, 'darwin')).toMatch(/must name its provider/);
    expect(hardenedChildRefusal({ hardened: true, provider: 'auto' }, { provider: 'codex' }, 'darwin')).toMatch(/must name its provider/);
  });

  it('refuses a provider that was never tested inside the jail, naming it', () => {
    expect(hardenedChildRefusal({ hardened: true, provider: 'gemini' }, local, 'darwin')).toMatch(/not supported for Gemini/i);
  });

  it('uses this computer\'s platform when none is given', () => {
    const refusal = hardenedChildRefusal({ hardened: true, provider: 'codex' }, local);
    if (process.platform === 'darwin') expect(refusal).toBeUndefined();
    else expect(refusal).toMatch(/needs macOS/);
  });
});
