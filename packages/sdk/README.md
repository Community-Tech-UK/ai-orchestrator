# `@ai-orchestrator/sdk`

Workspace SDK for authoring AI Orchestrator extensions.

## Exports

- `tools`
  - `defineTool()`
  - `ToolContext`
  - `ToolModule`
  - `ToolDefinition`
  - `ToolSafetyMetadata`
- `plugins`
  - `OrchestratorHooks`
  - `PluginModuleDefinition`
  - `PluginHookPayloads`
  - `NotifierPlugin`
  - `TrackerPlugin`
  - `SdkPluginContext`
  - `SdkPluginModule`
- `providers`
  - `BaseProvider`
  - `ProviderConfig`
  - `ProviderStatus`
  - `ProviderSessionOptions`
  - `ProviderAttachment`

## Tool Example

```ts
import { defineTool } from '@ai-orchestrator/sdk';
import { z } from 'zod';

export = defineTool({
  description: 'Echo a string back to the caller',
  args: z.object({
    value: z.string(),
  }),
  execute: async ({ value }) => value,
});
```

## Plugin Example

```ts
import type { SdkPluginModule } from '@ai-orchestrator/sdk';

const plugin: SdkPluginModule = (_ctx) => ({
  'instance.created': ({ instanceId, workingDirectory }) => {
    console.log('instance created', instanceId, workingDirectory);
  },
});

export = plugin;
```

## Notifier Plugin Example

```ts
import type { SdkPluginModule } from '@ai-orchestrator/sdk';

const plugin: SdkPluginModule = {
  slot: 'notifier',
  create: () => ({
    notify: async ({ message, channels }) => {
      console.log('notify', channels, message);
    },
  }),
};

export = plugin;
```

## Provider Example

```ts
import { BaseProvider, type ProviderConfig } from '@ai-orchestrator/sdk';

class ExampleProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  getType() {
    return 'openai-compatible';
  }

  getCapabilities() {
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

  async checkStatus() {
    return {
      type: this.getType(),
      available: true,
      authenticated: true,
    };
  }

  async initialize() {}

  async sendMessage() {}

  async terminate() {}
}
```
