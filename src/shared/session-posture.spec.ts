import { describe, it, expect } from 'vitest';
import { describePostureSentence, postureFromInstance } from './session-posture';
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
});
