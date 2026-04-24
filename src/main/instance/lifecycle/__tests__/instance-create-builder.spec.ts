import { describe, expect, it } from 'vitest';
import type { AgentProfile } from '../../../../shared/types/agent.types';
import type { Instance, InstanceCreateConfig } from '../../../../shared/types/instance.types';
import { buildInstanceRecord } from '../instance-create-builder';

const buildAgent = (overrides: Partial<AgentProfile> = {}): AgentProfile => ({
  id: 'build',
  name: 'Build',
  description: 'Build mode',
  mode: 'build',
  color: '#10b981',
  icon: 'hammer',
  permissions: {
    read: 'allow',
    write: 'allow',
    bash: 'allow',
    web: 'allow',
    task: 'allow',
  },
  builtin: true,
  ...overrides,
});

const buildConfig = (overrides: Partial<InstanceCreateConfig> = {}): InstanceCreateConfig => ({
  workingDirectory: '/repo/project-a',
  ...overrides,
});

describe('buildInstanceRecord', () => {
  it('builds a new initializing root instance with default lifecycle state', () => {
    const instance = buildInstanceRecord(buildConfig({ provider: 'claude' }), buildAgent(), {
      defaultYoloMode: false,
      getParent: () => undefined,
      now: () => 1234,
    });

    expect(instance.id).toMatch(/^c[0-9a-z]{8}$/);
    expect(instance.displayName).toBe('project-a');
    expect(instance.createdAt).toBe(1234);
    expect(instance.status).toBe('initializing');
    expect(instance.contextUsage.used).toBe(0);
    expect(instance.parentId).toBeNull();
    expect(instance.depth).toBe(0);
    expect(instance.agentId).toBe('build');
    expect(instance.abortController).toBeInstanceOf(AbortController);
  });

  it('applies configured parent inheritance before registration', () => {
    const parent = {
      agentId: 'parent-agent',
      depth: 2,
      workingDirectory: '/repo/parent',
      yoloMode: true,
    } as Instance;

    const instance = buildInstanceRecord(
      buildConfig({
        contextInheritance: {
          inheritAgentSettings: true,
          inheritYoloMode: true,
        },
        parentId: 'parent-1',
      }),
      buildAgent({ id: 'child-agent' }),
      {
        defaultYoloMode: false,
        getParent: (id) => id === 'parent-1' ? parent : undefined,
        now: () => 5678,
      },
    );

    expect(instance.parentId).toBe('parent-1');
    expect(instance.depth).toBe(3);
    expect(instance.agentId).toBe('parent-agent');
    expect(instance.yoloMode).toBe(true);
  });
});
