import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';

import {
  PluginManifestSchema,
  SkillFrontmatterSchema,
  validateHookPayload,
  HookPayloadSchemas,
} from '../plugin.schemas';

// ============================================
// PluginManifestSchema
// ============================================

describe('PluginManifestSchema', () => {
  const validManifest = {
    name: 'my-plugin',
    version: '1.0.0',
    description: 'A test plugin',
    author: 'Test Author',
    hooks: ['instance.created', 'instance.removed'],
    config: { schema: { timeout: 30 } },
  };

  it('accepts a fully populated manifest', () => {
    const result = PluginManifestSchema.parse(validManifest);
    expect(result.name).toBe('my-plugin');
    expect(result.version).toBe('1.0.0');
    expect(result.description).toBe('A test plugin');
    expect(result.hooks).toEqual(['instance.created', 'instance.removed']);
  });

  it('accepts a minimal manifest with only name and version', () => {
    const result = PluginManifestSchema.parse({ name: 'minimal', version: '0.1.0' });
    expect(result.name).toBe('minimal');
    expect(result.version).toBe('0.1.0');
    expect(result.description).toBeUndefined();
    expect(result.author).toBeUndefined();
    expect(result.hooks).toBeUndefined();
    expect(result.config).toBeUndefined();
  });

  it('rejects missing name', () => {
    expect(() => PluginManifestSchema.parse({ version: '1.0.0' }))
      .toThrow(ZodError);
  });

  it('rejects empty name', () => {
    expect(() => PluginManifestSchema.parse({ name: '', version: '1.0.0' }))
      .toThrow(ZodError);
  });

  it('provides a descriptive error message for missing name', () => {
    try {
      PluginManifestSchema.parse({ version: '1.0.0' });
      expect.unreachable('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ZodError);
    }
  });

  it('rejects missing version', () => {
    expect(() => PluginManifestSchema.parse({ name: 'no-version' }))
      .toThrow(ZodError);
  });

  it('rejects empty version', () => {
    expect(() => PluginManifestSchema.parse({ name: 'empty-ver', version: '' }))
      .toThrow(ZodError);
  });

  it('rejects invalid semver version (no dots)', () => {
    expect(() => PluginManifestSchema.parse({ name: 'bad-ver', version: 'latest' }))
      .toThrow(ZodError);
  });

  it('rejects invalid semver version (only major.minor)', () => {
    expect(() => PluginManifestSchema.parse({ name: 'bad-ver', version: '1.0' }))
      .toThrow(ZodError);
  });

  it('accepts semver with pre-release suffix', () => {
    const result = PluginManifestSchema.parse({ name: 'pre', version: '2.0.0-beta.1' });
    expect(result.version).toBe('2.0.0-beta.1');
  });

  it('accepts a declared plugin slot', () => {
    const result = PluginManifestSchema.parse({
      name: 'slot-plugin',
      version: '1.0.0',
      slot: 'notifier',
    });
    expect(result.slot).toBe('notifier');
  });

  it('rejects invalid hook event names', () => {
    expect(() => PluginManifestSchema.parse({
      name: 'bad-hooks',
      version: '1.0.0',
      hooks: ['nonexistent.hook'],
    })).toThrow(ZodError);
  });

  it('accepts all valid hook event names', () => {
	    const allHooks = [
	      'instance.created', 'instance.removed', 'instance.spawn.before', 'instance.spawn.after',
	      'instance.input.before', 'instance.input.after', 'instance.output', 'instance.stateChanged',
	      'verification.started', 'verification.completed', 'verification.error',
	      'orchestration.debate.round', 'orchestration.consensus.vote',
	      'orchestration.command.received', 'orchestration.command.completed', 'orchestration.command.failed',
	      'orchestration.child.started', 'orchestration.child.progress', 'orchestration.child.completed',
	      'orchestration.child.failed', 'orchestration.child.result.reported',
	      'orchestration.consensus.started', 'orchestration.consensus.completed', 'orchestration.consensus.failed',
	      'tool.execute.before', 'tool.execute.after',
	      'session.created', 'session.resumed', 'session.compacting', 'session.archived', 'session.terminated',
	      'automation.run.started', 'automation.run.completed', 'automation.run.failed',
	      'cleanup.candidate.before', 'cleanup.candidate.after',
	      'permission.ask', 'config.loaded',
	    ];
    const result = PluginManifestSchema.parse({
      name: 'all-hooks',
      version: '1.0.0',
      hooks: allHooks,
    });
    expect(result.hooks).toEqual(allHooks);
  });

  it('rejects a name exceeding 200 characters', () => {
    expect(() => PluginManifestSchema.parse({
      name: 'x'.repeat(201),
      version: '1.0.0',
    })).toThrow(ZodError);
  });
});

// ============================================
// SkillFrontmatterSchema
// ============================================

describe('SkillFrontmatterSchema', () => {
  const validFrontmatter = {
    name: 'code-review',
    description: 'Reviews code for quality and correctness',
    version: '1.0.0',
    author: 'Test',
    category: 'development',
    icon: 'magnifying-glass',
    effort: 'medium',
    preferredModel: 'claude-opus-4-0520',
    triggers: ['review', 'check code'],
  };

  it('accepts a fully populated frontmatter', () => {
    const result = SkillFrontmatterSchema.parse(validFrontmatter);
    expect(result.name).toBe('code-review');
    expect(result.effort).toBe('medium');
    expect(result.triggers).toEqual(['review', 'check code']);
  });

  it('accepts minimal frontmatter with only name and description', () => {
    const result = SkillFrontmatterSchema.parse({
      name: 'minimal-skill',
      description: 'A minimal skill',
    });
    expect(result.name).toBe('minimal-skill');
    expect(result.version).toBeUndefined();
    expect(result.effort).toBeUndefined();
  });

  it('rejects empty name', () => {
    expect(() => SkillFrontmatterSchema.parse({
      name: '',
      description: 'Valid description',
    })).toThrow(ZodError);
  });

  it('rejects missing name', () => {
    expect(() => SkillFrontmatterSchema.parse({
      description: 'Valid description',
    })).toThrow(ZodError);
  });

  it('rejects empty description', () => {
    expect(() => SkillFrontmatterSchema.parse({
      name: 'no-desc',
      description: '',
    })).toThrow(ZodError);
  });

  it('rejects missing description', () => {
    expect(() => SkillFrontmatterSchema.parse({
      name: 'no-desc',
    })).toThrow(ZodError);
  });

  it('rejects invalid effort enum value', () => {
    expect(() => SkillFrontmatterSchema.parse({
      name: 'bad-effort',
      description: 'desc',
      effort: 'extreme',
    })).toThrow(ZodError);
  });

  it('accepts all valid effort values', () => {
    for (const effort of ['low', 'medium', 'high']) {
      const result = SkillFrontmatterSchema.parse({
        name: `skill-${effort}`,
        description: 'desc',
        effort,
      });
      expect(result.effort).toBe(effort);
    }
  });

  it('rejects name exceeding 200 characters', () => {
    expect(() => SkillFrontmatterSchema.parse({
      name: 'x'.repeat(201),
      description: 'desc',
    })).toThrow(ZodError);
  });

  it('rejects description exceeding 5000 characters', () => {
    expect(() => SkillFrontmatterSchema.parse({
      name: 'long-desc',
      description: 'x'.repeat(5001),
    })).toThrow(ZodError);
  });

  it('rejects more than 50 triggers', () => {
    expect(() => SkillFrontmatterSchema.parse({
      name: 'too-many-triggers',
      description: 'desc',
      triggers: Array.from({ length: 51 }, (_, i) => `trigger-${i}`),
    })).toThrow(ZodError);
  });
});

// ============================================
// HookPayloadSchemas & validateHookPayload
// ============================================

describe('HookPayloadSchemas', () => {
  it('has entries for all expected hook events', () => {
	    const expectedEvents = [
	      'instance.created', 'instance.removed', 'instance.spawn.before', 'instance.spawn.after',
	      'instance.input.before', 'instance.input.after', 'instance.output', 'instance.stateChanged',
	      'verification.started', 'verification.completed', 'verification.error',
	      'orchestration.debate.round', 'orchestration.consensus.vote',
	      'orchestration.command.received', 'orchestration.command.completed', 'orchestration.command.failed',
	      'orchestration.child.started', 'orchestration.child.progress', 'orchestration.child.completed',
	      'orchestration.child.failed', 'orchestration.child.result.reported',
	      'orchestration.consensus.started', 'orchestration.consensus.completed', 'orchestration.consensus.failed',
	      'tool.execute.before', 'tool.execute.after',
	      'session.created', 'session.resumed', 'session.compacting', 'session.archived', 'session.terminated',
	      'automation.run.started', 'automation.run.completed', 'automation.run.failed',
	      'cleanup.candidate.before', 'cleanup.candidate.after',
	      'permission.ask', 'config.loaded',
	    ];
    for (const event of expectedEvents) {
      expect(HookPayloadSchemas).toHaveProperty(event);
    }
  });
});

describe('validateHookPayload', () => {
  describe('instance.created', () => {
    it('accepts a valid payload', () => {
      const payload = {
        instanceId: 'inst-1',
        id: 'inst-1',
        workingDirectory: '/home/user/project',
        provider: 'claude',
      };
      const result = validateHookPayload('instance.created', payload);
      expect(result).toEqual(payload);
    });

    it('accepts without optional provider', () => {
      const payload = {
        instanceId: 'inst-1',
        id: 'inst-1',
        workingDirectory: '/home/user/project',
      };
      const result = validateHookPayload('instance.created', payload);
      expect(result).toMatchObject({ instanceId: 'inst-1' });
    });

    it('rejects missing instanceId', () => {
      expect(() => validateHookPayload('instance.created', {
        id: 'inst-1',
        workingDirectory: '/tmp',
      })).toThrow(ZodError);
    });

    it('rejects missing id', () => {
      expect(() => validateHookPayload('instance.created', {
        instanceId: 'inst-1',
        workingDirectory: '/tmp',
      })).toThrow(ZodError);
    });
  });

  describe('instance.removed', () => {
    it('accepts a valid payload', () => {
      const result = validateHookPayload('instance.removed', { instanceId: 'inst-2' });
      expect(result).toEqual({ instanceId: 'inst-2' });
    });

    it('rejects empty instanceId', () => {
      expect(() => validateHookPayload('instance.removed', { instanceId: '' }))
        .toThrow(ZodError);
    });

    it('rejects missing instanceId', () => {
      expect(() => validateHookPayload('instance.removed', {}))
        .toThrow(ZodError);
    });
  });

  describe('tool.execute.before', () => {
    it('accepts a valid payload', () => {
      const payload = {
        instanceId: 'inst-3',
        toolName: 'read_file',
        args: { path: '/etc/hosts' },
      };
      const result = validateHookPayload('tool.execute.before', payload);
      expect(result).toEqual(payload);
    });

    it('accepts with optional skip flag', () => {
      const payload = {
        instanceId: 'inst-3',
        toolName: 'bash',
        args: { command: 'ls' },
        skip: true,
      };
      const result = validateHookPayload('tool.execute.before', payload);
      expect(result).toMatchObject({ skip: true });
    });

    it('rejects missing toolName', () => {
      expect(() => validateHookPayload('tool.execute.before', {
        instanceId: 'inst-3',
        args: {},
      })).toThrow(ZodError);
    });

    it('rejects missing args', () => {
      expect(() => validateHookPayload('tool.execute.before', {
        instanceId: 'inst-3',
        toolName: 'bash',
      })).toThrow(ZodError);
    });
  });

  describe('invalid payloads throw ZodError', () => {
    it('throws ZodError for completely empty payload on instance.created', () => {
      try {
        validateHookPayload('instance.created', {});
        expect.unreachable('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ZodError);
        const zodErr = e as ZodError;
        expect(zodErr.issues.length).toBeGreaterThan(0);
      }
    });

    it('throws ZodError for null payload on instance.removed', () => {
      expect(() => validateHookPayload('instance.removed', null))
        .toThrow(ZodError);
    });

    it('throws ZodError for non-object payload on tool.execute.before', () => {
      expect(() => validateHookPayload('tool.execute.before', 'not an object'))
        .toThrow(ZodError);
    });
  });

  describe('additional hook events', () => {
    it('validates session.created payload', () => {
      const result = validateHookPayload('session.created', {
        instanceId: 'inst-s1',
        sessionId: 'sess-1',
      });
      expect(result).toMatchObject({ sessionId: 'sess-1' });
    });

    it('validates session.compacting payload', () => {
      const result = validateHookPayload('session.compacting', {
        instanceId: 'inst-s2',
        messageCount: 100,
        tokenCount: 50000,
      });
      expect(result).toMatchObject({ messageCount: 100, tokenCount: 50000 });
    });

    it('validates config.loaded payload', () => {
      const result = validateHookPayload('config.loaded', {
        config: { theme: 'dark', maxInstances: 5 },
      });
      expect(result).toMatchObject({ config: { theme: 'dark' } });
    });

    it('validates permission.ask payload', () => {
      const result = validateHookPayload('permission.ask', {
        instanceId: 'inst-p1',
        toolName: 'bash',
        command: 'rm -rf /',
        decision: 'deny',
      });
      expect(result).toMatchObject({ toolName: 'bash', decision: 'deny' });
    });

    it('validates tool.execute.after payload', () => {
      const result = validateHookPayload('tool.execute.after', {
        instanceId: 'inst-t1',
        toolName: 'read_file',
        args: { path: '/tmp/test' },
        result: 'file contents',
        durationMs: 42,
      });
      expect(result).toMatchObject({ toolName: 'read_file', durationMs: 42 });
    });
  });
});
