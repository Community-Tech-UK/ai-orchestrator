import { describe, expect, it } from 'vitest';
import {
  assertNoWorkspaceSecretRefs,
  assertWorkspaceSecretRefsOnlyInEnv,
} from './reject-workspace-secret-ref';

describe('assertNoWorkspaceSecretRefs', () => {
  it('allows ordinary env values', () => {
    expect(() => assertNoWorkspaceSecretRefs({ API_KEY: 'secret', HOME: '/tmp' })).not.toThrow();
    expect(() => assertNoWorkspaceSecretRefs(undefined)).not.toThrow();
  });

  it('refuses a secret:// env value before any write', () => {
    expect(() => assertNoWorkspaceSecretRefs({ API_KEY: 'secret://github-pat' }))
      .toThrow(/cannot be stored on a global MCP connector \(API_KEY\)/);
  });
});

describe('assertWorkspaceSecretRefsOnlyInEnv', () => {
  it('allows secret-free headers and args', () => {
    expect(() => assertWorkspaceSecretRefsOnlyInEnv({
      headers: { Accept: 'application/json' },
      args: ['--stdio'],
      command: 'npx',
    })).not.toThrow();
  });

  it('refuses a secret:// value outside env', () => {
    expect(() => assertWorkspaceSecretRefsOnlyInEnv({
      headers: { Authorization: 'secret://github-pat' },
    })).toThrow(/only allowed in connector env values/);
  });
});
