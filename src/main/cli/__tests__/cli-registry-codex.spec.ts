import { describe, expect, it } from 'vitest';
import { CLI_REGISTRY } from '../cli-registry';

describe('CLI registry — Codex version parsing', () => {
  it('preserves SemVer prerelease suffixes', () => {
    const match = 'codex-cli 0.144.0-alpha.4'.match(CLI_REGISTRY.codex.versionPattern);

    expect(match?.[1]).toBe('0.144.0-alpha.4');
  });

  it('preserves combined SemVer prerelease and build metadata', () => {
    const match = 'codex-cli 0.144.1-beta.2+desktop.2'.match(CLI_REGISTRY.codex.versionPattern);

    expect(match?.[1]).toBe('0.144.1-beta.2+desktop.2');
  });

  it('does not absorb trailing punctuation into the version', () => {
    const match = 'codex-cli 0.144.0-alpha.4.'.match(CLI_REGISTRY.codex.versionPattern);

    expect(match?.[1]).toBe('0.144.0-alpha.4');
  });
});
