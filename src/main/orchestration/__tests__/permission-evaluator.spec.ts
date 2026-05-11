import { describe, it, expect } from 'vitest';
import {
  evaluate,
  isAllowed,
  writeDenyRuleset,
  readOnlyRuleset,
  type PermissionRule,
} from '../permission-evaluator';

describe('permission-evaluator', () => {
  it('evaluate returns ask by default when no rule matches', () => {
    expect(evaluate('write', 'foo.txt', [])).toEqual({
      action: 'ask',
      permission: 'write',
      pattern: '*',
    });
  });

  it('last matching rule wins (project < agent < session)', () => {
    const projectRules: PermissionRule[] = [
      { permission: 'write', pattern: '*', action: 'allow' },
    ];
    const agentRules: PermissionRule[] = [
      { permission: 'write', pattern: '*.env', action: 'deny' },
    ];
    const sessionRules: PermissionRule[] = [
      { permission: 'write', pattern: 'public/*.env', action: 'allow' },
    ];

    expect(
      evaluate('write', 'public/foo.env', projectRules, agentRules, sessionRules).action,
    ).toBe('allow');
    expect(evaluate('write', 'secret.env', projectRules, agentRules, sessionRules).action).toBe(
      'deny',
    );
    expect(evaluate('write', 'index.ts', projectRules, agentRules, sessionRules).action).toBe(
      'allow',
    );
  });

  it('isAllowed returns boolean from evaluate', () => {
    const rules: PermissionRule[][] = [
      [{ permission: 'network', pattern: '*', action: 'deny' }],
    ];
    expect(isAllowed('network', 'example.com', rules)).toBe(false);
    expect(isAllowed('read', 'example.com', rules)).toBe(false); // default ask → not allowed
  });

  it('writeDenyRuleset denies all writes', () => {
    const rs = writeDenyRuleset();
    expect(evaluate('write', 'anything', rs).action).toBe('deny');
  });

  it('readOnlyRuleset denies write + network', () => {
    const rs = readOnlyRuleset();
    expect(evaluate('write', 'a', rs).action).toBe('deny');
    expect(evaluate('network', 'b', rs).action).toBe('deny');
  });

  it('wildcards match substrings', () => {
    const rs: PermissionRule[] = [
      { permission: 'bash:*', pattern: 'rm *', action: 'deny' },
    ];
    expect(evaluate('bash:exec', 'rm -rf /', rs).action).toBe('deny');
    expect(evaluate('bash:exec', 'ls', rs).action).toBe('ask');
  });
});
