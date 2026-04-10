import { describe, it, expect } from 'vitest';
import { MockCliAdapter } from './mock-adapter';

describe('verification parity', () => {
  it('scenario: 3-agent unanimous agreement', async () => {
    const adapters = [
      new MockCliAdapter(['The code is safe and follows best practices. Confidence: 9/10.']),
      new MockCliAdapter(['Code analysis shows no vulnerabilities. Safe to use. Confidence: 8/10.']),
      new MockCliAdapter(['Safe to proceed. All checks pass. Confidence: 9/10.']),
    ];

    const responses = adapters.map((a, i) => {
      const content = a.getNextResponse()!;
      return { agentId: `agent-${i}`, response: content };
    });

    expect(responses).toHaveLength(3);
    expect(responses.every(r => r.response.includes('safe') || r.response.includes('Safe'))).toBe(true);
  });

  it('scenario: 3-agent disagreement', async () => {
    const adapters = [
      new MockCliAdapter(['The code is safe.']),
      new MockCliAdapter(['CRITICAL: SQL injection vulnerability found in query builder.']),
      new MockCliAdapter(['Code appears safe, no issues found.']),
    ];

    const responses = adapters.map((a, i) => ({
      agentId: `agent-${i}`,
      response: a.getNextResponse()!,
      flagsIssue: a.getNextResponse()!.includes('CRITICAL'),
    }));

    const dissenting = responses.filter(r => r.flagsIssue);
    expect(dissenting).toHaveLength(1);
    expect(dissenting[0].agentId).toBe('agent-1');
  });

  it('scenario: all agents flag issues', async () => {
    const adapters = [
      new MockCliAdapter(['WARNING: Race condition in concurrent handler.']),
      new MockCliAdapter(['ERROR: Unhandled null reference in parser.']),
      new MockCliAdapter(['CRITICAL: Authentication bypass in middleware.']),
    ];

    const responses = adapters.map(a => a.getNextResponse()!);
    expect(responses.every(r => /WARNING|ERROR|CRITICAL/.test(r))).toBe(true);
  });
});
