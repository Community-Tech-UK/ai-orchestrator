import { describe, it, expect } from 'vitest';
import { resolveFastMode } from '../resolve-fast-mode';

describe('resolveFastMode (precedence)', () => {
  const byProvider = { claude: true, codex: false };

  it('explicit config override wins over everything', () => {
    expect(
      resolveFastMode({
        configOverride: false,
        provider: 'claude',
        defaultFastModeByProvider: byProvider,
        defaultFastMode: true,
      }),
    ).toBe(false);
    expect(
      resolveFastMode({
        configOverride: true,
        provider: 'codex',
        defaultFastModeByProvider: byProvider,
        defaultFastMode: false,
      }),
    ).toBe(true);
  });

  it('per-provider remembered wins over the global default', () => {
    expect(
      resolveFastMode({
        provider: 'claude',
        defaultFastModeByProvider: byProvider,
        defaultFastMode: false,
      }),
    ).toBe(true);
    expect(
      resolveFastMode({
        provider: 'codex',
        defaultFastModeByProvider: byProvider,
        defaultFastMode: true,
      }),
    ).toBe(false);
  });

  it('falls back to the global default when no per-provider entry exists', () => {
    expect(
      resolveFastMode({
        provider: 'copilot',
        defaultFastModeByProvider: byProvider,
        defaultFastMode: true,
      }),
    ).toBe(true);
  });

  it('defaults to false when nothing is configured', () => {
    expect(resolveFastMode({ provider: 'claude' })).toBe(false);
    expect(resolveFastMode({ provider: 'claude', defaultFastModeByProvider: {} })).toBe(false);
  });

  it('treats configOverride=false as an explicit choice (not a fall-through)', () => {
    // Distinct from `undefined`: an explicit false must not fall through to a
    // truthy per-provider/global default.
    expect(
      resolveFastMode({
        configOverride: false,
        provider: 'claude',
        defaultFastModeByProvider: { claude: true },
        defaultFastMode: true,
      }),
    ).toBe(false);
  });

  it('ignores the per-provider map when provider is empty', () => {
    expect(
      resolveFastMode({
        provider: '',
        defaultFastModeByProvider: { '': true },
        defaultFastMode: false,
      }),
    ).toBe(false);
  });
});
