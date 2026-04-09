import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  BaseProvider,
  defineTool,
  type OrchestratorHooks,
  type ProviderAttachment,
  type ProviderCapabilities,
  type ProviderConfig,
  type ProviderSessionOptions,
  type ProviderStatus,
  type ToolContext,
  type ToolModule,
} from '@sdk';

class TestProvider extends BaseProvider {
  getType() {
    return 'openai-compatible' as const;
  }

  getCapabilities(): ProviderCapabilities {
    return {
      toolExecution: true,
      streaming: true,
      multiTurn: true,
      vision: false,
      fileAttachments: true,
      functionCalling: false,
      builtInCodeTools: false,
    };
  }

  async checkStatus(): Promise<ProviderStatus> {
    return {
      type: this.getType(),
      available: true,
      authenticated: true,
    };
  }

  async initialize(_options: ProviderSessionOptions): Promise<void> {
    this.isActive = true;
  }

  async sendMessage(_message: string, _attachments?: ProviderAttachment[]): Promise<void> {}

  async terminate(): Promise<void> {
    this.isActive = false;
  }
}

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

  it('exports provider extension points', async () => {
    const config: ProviderConfig = {
      type: 'openai-compatible',
      name: 'Test Provider',
      enabled: true,
    };

    const provider = new TestProvider(config);
    expect(provider.getType()).toBe('openai-compatible');
    await provider.initialize({ workingDirectory: '/tmp/project' });
    expect(provider.isRunning()).toBe(true);
    await provider.terminate();
    expect(provider.isRunning()).toBe(false);
  });
});
