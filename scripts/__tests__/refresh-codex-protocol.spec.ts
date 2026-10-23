import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { refreshCodexProtocol } = require('../refresh-codex-protocol.js');

describe('Codex protocol build lifecycle', () => {
  it('reports a missing CLI as unverified and lets offline builds use the committed snapshot', () => {
    const run = vi.fn(() => ({ error: Object.assign(new Error('missing'), { code: 'ENOENT' }) }));
    const warn = vi.fn();
    expect(refreshCodexProtocol({ run, warn })).toBe('unverified');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not verified'));
    expect(run).toHaveBeenCalledOnce();
  });

  it('regenerates on every CLI bump, including a patch bump', () => {
    const run = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: 'codex-cli 0.162.2\n' })
      .mockReturnValueOnce({ status: 0 });
    const readSnapshot = () => 'export const CODEX_APP_SERVER_PROTOCOL_VERSION = "codex-cli 0.162.1" as const;';
    expect(refreshCodexProtocol({ run, readSnapshot })).toBe('regenerated');
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][1]).toContain('scripts/generate-codex-app-server-protocol.ts');
  });

  it('skips regeneration when the exact CLI version matches', () => {
    const run = vi.fn(() => ({ status: 0, stdout: 'codex-cli 0.163.0\n' }));
    const readSnapshot = () => 'export const CODEX_APP_SERVER_PROTOCOL_VERSION = "codex-cli 0.163.0" as const;';
    expect(refreshCodexProtocol({ run, readSnapshot })).toBe('current');
    expect(run).toHaveBeenCalledOnce();
  });

  it('fails the build when a detected CLI bump cannot regenerate its snapshot', () => {
    const run = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: 'codex-cli 0.164.0\n' })
      .mockReturnValueOnce({ status: 1 });
    expect(() => refreshCodexProtocol({ run, readSnapshot: () => '' })).toThrow('regeneration failed');
  });
});
