import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { IPC_CHANNELS } from '@contracts/channels';
import { RuntimeProviderListPayloadSchema, RuntimeProviderSendPayloadSchema } from '@contracts/schemas/plugin';
import { ProviderRuntimeEventEnvelopeSchema } from '@contracts/schemas/provider-runtime-events';
import type { RuntimeProviderList, RuntimeProviderReply } from '../../../shared/types/runtime-provider-session.types';
import type { InstanceManager } from '../../instance/instance-manager';
import { getOrchestratorPluginManager } from '../../plugins/plugin-manager';
import { PROVIDER_RESPONSE_IDLE_TIMEOUT_MS } from '../../plugins/plugin-worker-host';
import { getProviderInstanceManager } from '../../providers/provider-instance-manager';
import { registerValidatedIpcHandler, type EnsureTrustedSender } from '../validated-handler';

/** Explicit one-message sessions. They do not enter the built-in CLI lifecycle. */
export function registerRuntimeProviderSessionHandlers(deps: {
  instanceManager: InstanceManager;
  ensureTrustedSender: EnsureTrustedSender;
}): void {
  const options = { ensureTrustedSender: deps.ensureTrustedSender };
  const load = async (workingDirectory: string): Promise<RuntimeProviderList> => {
    if (!path.isAbsolute(workingDirectory) || !(await stat(workingDirectory)).isDirectory()) {
      throw new Error('Choose an existing working folder.');
    }
    const result = await getOrchestratorPluginManager().listPlugins(workingDirectory, deps.instanceManager);
    const scopedProviders = new Set(result.plugins.filter((plugin) => plugin.loadReport.ready)
      .flatMap((plugin) => plugin.providerIds));
    return {
      providers: getProviderInstanceManager().getEnabledProviders()
        .filter((config): config is typeof config & { type: `plugin:${string}` } => scopedProviders.has(config.type) && config.type.startsWith('plugin:'))
        .map((config) => ({ provider: config.type, name: config.name })),
      failures: result.plugins.filter((plugin) => plugin.slot === 'provider' && !plugin.loadReport.ready)
        .map((plugin) => plugin.loadReport.error ?? 'A provider package could not be activated.'),
    };
  };
  registerValidatedIpcHandler(
    IPC_CHANNELS.RUNTIME_PROVIDER_LIST, RuntimeProviderListPayloadSchema,
    async ({ workingDirectory }) => ({ success: true, data: await load(workingDirectory) }), options,
  );
  registerValidatedIpcHandler(
    IPC_CHANNELS.RUNTIME_PROVIDER_SEND, RuntimeProviderSendPayloadSchema,
    async ({ workingDirectory, provider, message }): Promise<{ success: true; data: RuntimeProviderReply }> => {
      const available = await load(workingDirectory);
      if (!available.providers.some((choice) => choice.provider === provider)) {
        throw new Error('This provider is no longer available. Refresh the provider list.');
      }
      return getOrchestratorPluginManager().withProviderSession(workingDirectory, async () => {
        const adapter = getProviderInstanceManager().createProvider(provider);
        let content = '';
        let complete!: () => void;
        let fail!: (error: Error) => void;
        const turn = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
        const timeout = setTimeout(() => fail(new Error('The provider has not responded for five minutes.')), PROVIDER_RESPONSE_IDLE_TIMEOUT_MS);
        const subscription = adapter.events$.subscribe({
          next: (envelope) => {
            const parsed = ProviderRuntimeEventEnvelopeSchema.safeParse(envelope);
            if (!parsed.success || parsed.data.provider !== provider) {
              fail(new Error('The provider returned an invalid response.'));
              return;
            }
            const { event } = parsed.data;
            timeout.refresh();
            if (event.kind === 'output' && (!event.messageType || event.messageType === 'assistant')) {
              if (content.length + event.content.length > 1000000) {
                fail(new Error('The provider response exceeded the message size limit.'));
              } else {
                content += event.content;
              }
            } else if (event.kind === 'complete') {
              complete();
            } else if (event.kind === 'error' || event.kind === 'exit') {
              fail(new Error('The provider stopped before finishing its answer.'));
            } else if (event.kind === 'tool_use') {
              fail(new Error('This one-message session does not support tools.'));
            }
          },
          error: () => fail(new Error('The provider connection failed.')),
        });
        try {
          await Promise.all([turn, (async () => {
            if (adapter.capabilities.permissionPrompts || adapter.capabilities.subAgents) {
              throw new Error('This provider needs a session with tool approval support.');
            }
            await adapter.initialize({ workingDirectory, instanceId: randomUUID(), sessionId: randomUUID() });
            if (adapter.getCapabilities().toolExecution) {
              throw new Error('This one-message session does not support tools.');
            }
            await adapter.sendMessage(message);
          })()]);
          if (!content) throw new Error('The provider returned no assistant message.');
          return { success: true, data: { content } };
        } finally {
          clearTimeout(timeout);
          try { await adapter.terminate(); }
          finally { subscription.unsubscribe(); }
        }
      });
    }, options,
  );
}
