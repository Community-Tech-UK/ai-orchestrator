import { describe, it, expect } from 'vitest';
import { CAPABILITY_WORDS, capabilityLine, describePostureSentence, postureFromInstance } from './session-posture';
describe('session posture', () => {
  it.each([
    [{ agentId: 'build', yoloMode: true, hardened: true }, 'Acts without asking · edits only inside this folder · web allowed'],
    [{ agentId: 'plan' }, 'Asks before acting · read-only · web allowed'],
    [{ agentId: 'retriever' }, 'Asks before acting · read-only · no web'],
    [{ agentId: 'custom' }, 'Asks before acting · permissions set by the Custom mode'],
  ])('describes the effective built-in permissions', (instance, expected) => {
    expect(describePostureSentence(postureFromInstance(instance))).toBe(expected);
  });
  it('names the remote worker and shows desktop control only when enabled', () => {
    const posture = { ...postureFromInstance({ agentId: 'build' }), nodeName: 'Windows PC', computerUseMode: 'trusted' };
    expect(describePostureSentence(posture)).toMatch(/runs on Windows PC$/);
    expect(describePostureSentence({ ...posture, computerUseEnabled: true })).toContain('desktop control: trusted');
  });
  it('shows the worker by its name when one is known, and says what is filtered or switched off', () => {
    const instance = { agentId: 'build', executionLocation: { type: 'remote', nodeId: 'node-1' }, containedExecution: true, browserToolsMode: 'off' };
    expect(describePostureSentence(postureFromInstance(instance, undefined, () => 'Windows PC')))
      .toBe('Asks before acting · can edit files · web allowed · secrets filtered · no browser tools · runs on Windows PC');
    expect(describePostureSentence(postureFromInstance(instance))).toMatch(/runs on node-1$/);
    expect(describePostureSentence(postureFromInstance({ agentId: 'build', browserToolsMode: 'deferred' }))).not.toContain('browser');
  });
  it('words capability states from one table', () => {
    expect(capabilityLine('Fast', CAPABILITY_WORDS.unavailable('Copilot'))).toBe('Fast: not available for Copilot');
    expect(capabilityLine('Desktop control', CAPABILITY_WORDS['off-in-settings'])).toBe('Desktop control: off in Settings');
    expect(CAPABILITY_WORDS.queued('Auto-approve', 'on')).toBe('Auto-approve → on after this reply');
  });
});
