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
- `provider-adapter`
  - `ProviderAdapter`
  - `ProviderAdapterCapabilities`
- `provider-adapter-registry`
  - `PluginProviderAdapterDescriptor`
  - `ProviderAdapterPluginApi`
  - `PluginProviderAdapterFactory`

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

## Provider Adapter Plugin Manifest

Provider adapter plugins must run in worker isolation and register their adapter
through the worker context before the plugin reports ready.

Minimum `plugin.json`:

```json
{
  "name": "acme-cli-provider",
  "version": "1.0.0",
  "slot": "provider",
  "isolation": "worker",
  "capabilities": ["spawn.process"]
}
```

Use `capabilities: ["network"]` for API-only adapters, and add
`filesystem.read` or `filesystem.write` only when the adapter actually needs
workspace file access. Plugin provider ids must use the `plugin:` namespace,
for example `plugin:acme-cli`; built-in ids such as `claude`, `codex`, and
`gemini` are reserved.

```ts
import { EMPTY } from 'rxjs';
import type {
  PluginProviderAdapterDescriptor,
  ProviderAdapter,
  ProviderAdapterPluginApi,
  ProviderConfig,
  SdkPluginContext,
} from '@ai-orchestrator/sdk';

type ProviderPluginContext = SdkPluginContext & {
  providerAdapters: ProviderAdapterPluginApi;
};

const descriptor: PluginProviderAdapterDescriptor = {
  provider: 'plugin:acme-cli',
  displayName: 'Acme CLI',
  isolation: 'worker',
  capabilities: {
    interruption: true,
    permissionPrompts: false,
    sessionResume: true,
    streamingOutput: true,
    usageReporting: true,
    subAgents: false,
  },
  defaultConfig: {
    type: 'plugin:acme-cli',
    name: 'Acme CLI',
    enabled: true,
    defaultModel: 'acme-default',
  },
};

function createAcmeAdapter(config: ProviderConfig): ProviderAdapter {
  return {
    provider: 'plugin:acme-cli',
    capabilities: descriptor.capabilities,
    events$: EMPTY,
    getCapabilities: () => ({
      toolExecution: true,
      streaming: true,
      multiTurn: true,
      vision: false,
      fileAttachments: true,
      functionCalling: true,
      builtInCodeTools: false,
    }),
    checkStatus: async () => ({
      type: 'plugin:acme-cli',
      available: true,
      authenticated: true,
      models: config.models,
    }),
    initialize: async () => undefined,
    sendMessage: async () => undefined,
    terminate: async () => undefined,
    getUsage: () => null,
    getPid: () => null,
    isRunning: () => false,
    getSessionId: () => '',
  };
}

export = (ctx: ProviderPluginContext) => {
  ctx.providerAdapters.registerProviderAdapterFactory('factory:acme-cli', createAcmeAdapter);
  ctx.providerAdapters.registerProviderAdapter(descriptor, 'factory:acme-cli');

  return {
    slot: 'provider' as const,
    create: () => ({}),
  };
};
```

Only registrations that have a live worker bridge are surfaced in provider
lists and Doctor health checks. Descriptor-only registrations are kept internal
until the host bridge succeeds.

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
