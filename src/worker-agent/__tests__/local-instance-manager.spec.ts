import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalInstanceManager } from '../local-instance-manager';

describe('LocalInstanceManager', () => {
  let manager: LocalInstanceManager;

  beforeEach(() => {
    manager = new LocalInstanceManager(['/tmp/allowed']);
  });

  it('starts with zero instances', () => {
    expect(manager.getInstanceCount()).toBe(0);
    expect(manager.getAllInstanceIds()).toEqual([]);
  });

  it('rejects spawn for invalid working directory', async () => {
    await expect(
      manager.spawn({
        instanceId: 'test-1',
        cliType: 'claude',
        workingDirectory: '/etc/not-allowed',
        systemPrompt: 'test',
      }),
    ).rejects.toThrow('not in allowed working directories');
  });

  it('rejects spawn beyond capacity', async () => {
    const smallManager = new LocalInstanceManager(['/tmp'], 0);
    await expect(
      smallManager.spawn({
        instanceId: 'test-1',
        cliType: 'claude',
        workingDirectory: '/tmp',
        systemPrompt: 'test',
      }),
    ).rejects.toThrow('at capacity');
  });
});
