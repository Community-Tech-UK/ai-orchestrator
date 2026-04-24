import { describe, expect, it } from 'vitest';
import type { AgentToolPermissions } from '../../../../shared/types/agent.types';
import {
  attachToolFilterMetadata,
  buildToolPermissionConfig,
} from '../tool-permission-config';

const buildPermissions = (overrides: Partial<AgentToolPermissions> = {}): AgentToolPermissions => ({
  read: 'allow',
  write: 'allow',
  bash: 'allow',
  web: 'allow',
  task: 'allow',
  ...overrides,
});

describe('buildToolPermissionConfig', () => {
  it('adds denied agent tools and print-mode-incompatible tools to disallowed tools', () => {
    const config = buildToolPermissionConfig(buildPermissions({ write: 'deny' }), {
      allowedToolsPolicy: 'allow-all',
    });

    expect(config.allowedTools).toBeUndefined();
    expect(config.disallowedTools).toEqual(expect.arrayContaining([
      'Edit',
      'Write',
      'NotebookEdit',
      'AskUserQuestion',
      'EnterPlanMode',
      'ExitPlanMode',
    ]));
    expect(config.disallowedToolsForSpawn).toBe(config.disallowedTools);
    expect(config.toolFilter.isBlanketDenied('Write')).toBe(true);
  });

  it('uses standard allowed tools for non-yolo respawn flows only', () => {
    const nonYolo = buildToolPermissionConfig(buildPermissions(), {
      allowedToolsPolicy: 'standard-unless-yolo',
      yoloMode: false,
    });
    const yolo = buildToolPermissionConfig(buildPermissions(), {
      allowedToolsPolicy: 'standard-unless-yolo',
      yoloMode: true,
    });

    expect(nonYolo.allowedTools).toContain('Read');
    expect(nonYolo.allowedTools).toContain('Bash');
    expect(yolo.allowedTools).toBeUndefined();
  });

  it('attaches tool filters to instance metadata without replacing other metadata', () => {
    const target: { metadata?: Record<string, unknown> } = {
      metadata: { existing: true },
    };
    const config = buildToolPermissionConfig(buildPermissions({ bash: 'deny' }), {
      allowedToolsPolicy: 'allow-all',
    });

    attachToolFilterMetadata(target, config.toolFilter);

    expect(target.metadata?.['existing']).toBe(true);
    expect(target.metadata?.['toolFilter']).toBe(config.toolFilter);
  });
});
