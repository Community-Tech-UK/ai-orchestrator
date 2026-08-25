import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCopilotSpawnEnv,
  COPILOT_STRIPPED_AUTH_ENV_VARS,
  mergeSpawnEnv,
} from './adapter-spawn-helpers';
import type { UnifiedSpawnOptions } from './adapter-factory.types';

/**
 * WS-C7 — `mergeSpawnEnv`'s `filterEnv` branch, which a contained-execution
 * spawn relies on to keep host secrets out of the child process. See
 * adapter-factory.ts `createCliAdapter` for how `filterEnv` gets set (folded
 * in for every provider when the spawning instance is registered as
 * contained via `contained-execution-scoping.ts`).
 */
describe('mergeSpawnEnv', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env['FAKE_API_KEY'] = 'sk-test-should-never-leak';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('without filterEnv, merges base + options.env unfiltered (current/standard behaviour)', () => {
    const options: UnifiedSpawnOptions = { env: { MY_VAR: '1' } };
    const merged = mergeSpawnEnv(options, { BASE_VAR: '2' });
    expect(merged).toEqual({ BASE_VAR: '2', MY_VAR: '1' });
    // Never reads process.env at all when filterEnv is unset.
    expect(merged['FAKE_API_KEY']).toBeUndefined();
  });

  it('with filterEnv, derives the environment from getSafeEnv() and drops the seeded secret', () => {
    const options: UnifiedSpawnOptions = { filterEnv: true };
    const merged = mergeSpawnEnv(options);
    expect(merged['FAKE_API_KEY']).toBeUndefined();
    // Safe system vars still make it through so the child process is usable.
    expect(merged['PATH']).toBeDefined();
  });

  it('with filterEnv, still folds in benign base + options.env values on top', () => {
    const options: UnifiedSpawnOptions = { filterEnv: true, env: { MY_VAR: '1' } };
    const merged = mergeSpawnEnv(options, { BASE_VAR: '2' });
    expect(merged['MY_VAR']).toBe('1');
    expect(merged['BASE_VAR']).toBe('2');
    expect(merged['FAKE_API_KEY']).toBeUndefined();
  });

  it('with filterEnv, filters secrets in caller-supplied options.env too (fresh-eyes finding)', () => {
    // A future caller (e.g. an automation's action.env) must not be able to
    // reintroduce a blocked secret into a contained child process.
    const options: UnifiedSpawnOptions = {
      filterEnv: true,
      env: { OPENAI_API_KEY: 'sk-inline-secret', MY_VAR: '1' },
    };
    const merged = mergeSpawnEnv(options, { GH_TOKEN: 'ghp-inline-secret' });
    expect(merged['OPENAI_API_KEY']).toBeUndefined();
    expect(merged['GH_TOKEN']).toBeUndefined();
    expect(merged['MY_VAR']).toBe('1');
  });
});

/**
 * Copilot account routing: an ambient GitHub token variable outranks Copilot's
 * stored OAuth credentials, so leaving one in the child environment would
 * silently defeat profile selection — the child would authenticate as whoever
 * the token belongs to, whatever profile home it was handed.
 */
describe('buildCopilotSpawnEnv', () => {
  it('removes every ambient GitHub token variable at construction', () => {
    const parent: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      COPILOT_GITHUB_TOKEN: 'placeholder',
      GH_TOKEN: 'placeholder',
      GITHUB_TOKEN: 'placeholder',
      GITHUB_COPILOT_GITHUB_TOKEN: 'placeholder',
      GITHUB_COPILOT_API_TOKEN: 'placeholder',
      GITHUB_TOKEN_VARNAME: 'GITHUB_TOKEN',
    };
    const env = buildCopilotSpawnEnv(parent);
    for (const key of COPILOT_STRIPPED_AUTH_ENV_VARS) {
      expect(env[key], key).toBeUndefined();
    }
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('leaves GH_HOST alone — COPILOT_GH_HOST outranks it and the adapter sets that', () => {
    const env = buildCopilotSpawnEnv({ GH_HOST: 'ghe.example.com' });
    expect(env['GH_HOST']).toBe('ghe.example.com');
  });

  it('preserves the NODE_OPTIONS openssl-ca workaround', () => {
    expect(buildCopilotSpawnEnv({ NODE_OPTIONS: '--max-old-space-size=4096' })['NODE_OPTIONS'])
      .toBe('--max-old-space-size=4096 --use-openssl-ca');
    expect(buildCopilotSpawnEnv({})['NODE_OPTIONS']).toBe('--use-openssl-ca');
  });
});
