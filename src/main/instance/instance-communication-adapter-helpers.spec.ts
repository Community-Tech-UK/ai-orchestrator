import { describe, expect, it } from 'vitest';

import type { CliAdapter } from '../cli/adapters/adapter-factory';
import { isStatelessExecAdapter } from './instance-communication-adapter-helpers';

function fakeAdapter(name: string): CliAdapter {
  return {
    getName: () => name,
  } as unknown as CliAdapter;
}

describe('instance communication adapter helpers', () => {
  it('classifies Antigravity as a stateless exec adapter', () => {
    expect(isStatelessExecAdapter(fakeAdapter('antigravity-cli'))).toBe(true);
  });

  it('does not classify ACP-backed adapters as stateless just because their name includes a stateless provider', () => {
    expect(isStatelessExecAdapter(fakeAdapter('copilot-acp'))).toBe(false);
  });
});
