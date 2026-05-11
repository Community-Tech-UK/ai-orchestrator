import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  defineTool,
  type NotifierPlugin,
  type OrchestratorHooks,
  type ProviderCapabilities,
  type ProviderConfig,
  type ProviderSessionOptions,
  type ProviderStatus,
  type SystemMessageConfig,
  type TrackerPlugin,
  type ToolContext,
  type ToolModule,
} from '@sdk';

describe('SDK exports', () => {
  it('exports tool authoring helpers', async () => {
    const legacyTool: ToolModule = {
      description: 'Legacy tool',
      execute: async (_args, _ctx: ToolContext) => 'ok',
    };

    const tool = defineTool({
      description: 'Typed tool',
      args: z.object({
        query: z.string(),
      }),
      execute: async ({ query }) => query.toUpperCase(),
    });

    expect(legacyTool.description).toBe('Legacy tool');
    await expect(tool.execute({ query: 'sdk' }, { instanceId: 'inst-1', workingDirectory: '/tmp' }))
      .resolves
      .toBe('SDK');
  });

  it('exports plugin hook types', () => {
    const hooks: OrchestratorHooks = {
      'instance.created': ({ instanceId, workingDirectory }) => {
        expect(instanceId).toBe('inst-1');
        expect(workingDirectory).toBe('/tmp/project');
      },
    };

    hooks['instance.created']?.({
      id: 'inst-1',
      instanceId: 'inst-1',
      workingDirectory: '/tmp/project',
    });
  });

  it('exports expanded plugin hook types (16 events)', () => {
    const hooks: OrchestratorHooks = {
      'instance.created': ({ instanceId }) => { void instanceId; },
      'instance.stateChanged': ({ previousState, newState }) => { void previousState; void newState; },
      'tool.execute.before': (payload) => { payload.skip = true; },
      'tool.execute.after': ({ durationMs }) => { void durationMs; },
      'session.created': ({ sessionId }) => { void sessionId; },
      'orchestration.debate.round': ({ round, totalRounds }) => { void round; void totalRounds; },
      'orchestration.consensus.vote': ({ confidence }) => { void confidence; },
      'permission.ask': (payload) => { payload.decision = 'allow'; },
      'config.loaded': ({ config }) => { void config; },
    };
    // All 16 events should be valid keys
    expect(Object.keys(hooks)).toHaveLength(9); // We defined 9 of 16 in this test
  });

  it('exports slot runtime contracts for non-hook plugins', async () => {
    const tracker: TrackerPlugin = {
      track: async (event) => {
        expect(event.event).toBe('reaction.ci.failing');
      },
    };
    const notifier: NotifierPlugin = {
      notify: async (notification) => {
        expect(notification.message).toBe('CI is failing');
      },
    };

    await tracker.track({
      event: 'reaction.ci.failing',
      timestamp: Date.now(),
      instanceId: 'inst-1',
    });
    await notifier.notify({
      event: 'reaction.ci.failing',
      message: 'CI is failing',
      timestamp: Date.now(),
    });
  });

  it('exports provider config and status types', () => {
    const config: ProviderConfig = {
      type: 'openai-compatible',
      name: 'Test Provider',
      enabled: true,
    };

    const status: ProviderStatus = {
      type: config.type,
      available: true,
      authenticated: true,
    };

    const caps: ProviderCapabilities = {
      toolExecution: true,
      streaming: true,
      multiTurn: true,
      vision: false,
      fileAttachments: true,
      functionCalling: false,
      builtInCodeTools: false,
    };

    const opts: ProviderSessionOptions = {
      workingDirectory: '/tmp/project',
      model: 'gpt-4o',
      systemMessageConfig: {
        mode: 'customize',
        sections: {
          tone: { action: 'replace', content: 'Be concise.' },
        },
      } satisfies SystemMessageConfig,
    };

    expect(config.type).toBe('openai-compatible');
    expect(status.available).toBe(true);
    expect(caps.streaming).toBe(true);
    expect(opts.systemMessageConfig?.mode).toBe('customize');
  });
});
