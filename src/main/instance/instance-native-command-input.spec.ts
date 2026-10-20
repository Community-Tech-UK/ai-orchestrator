import { describe, expect, it } from 'vitest';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import { resolveNativeOpenCodeCommand } from '../commands/provider-native-commands';
import { buildUserMessages } from '../context/compaction-continuity';
import { dispatchNativeOpenCodeCommand } from './instance-native-command-input';
import type { InstanceSendInputOptions } from './instance-input-cancellation';

function fixture() {
  let available = true;
  const adapter = { getAvailableCommands: () => available ? [{ name: 'fixture-native' }] : [] };
  const command = resolveNativeOpenCodeCommand('opencode', adapter, 'acp:opencode:fixture-native', ['example'])!;
  const instance = { provider: 'opencode', requestCount: 3 } as Instance;
  const emitted: OutputMessage[] = [];
  const history: string[] = [];
  return { adapter, command, instance, emitted, history, removeCommand: () => { available = false; },
    context: { instance, command, originalInput: '/fixture-native example', deferredCommit: false,
      getAdapter: () => adapter, recordPromptHistory: () => { history.push('recorded'); }, emitUser: (output: OutputMessage) => { emitted.push(output); } } };
}

describe('resolved native command transcript provenance', () => {
  it.each([false, true])('marks dynamic commands and preserves dispatch admission (deferred: %s)', async deferredCommit => {
    const { context, emitted, history, instance } = fixture();
    const admission: string[] = [];
    await dispatchNativeOpenCodeCommand({ ...context, deferredCommit,
      options: { beforeProviderDispatch: () => { admission.push('before'); },
        assertProviderDispatchCurrent: reason => { admission.push(reason ?? 'current'); } },
      send: async (prompt, options) => {
        expect(prompt).toBe('/fixture-native example');
        expect(options.providerNativeCommandId).toBe('acp:opencode:fixture-native');
        expect(emitted).toHaveLength(deferredCommit ? 0 : 1);
        options.beforeProviderDispatch?.();
        options.assertProviderDispatchCurrent?.('unsupported-attachments');
      },
    });
    expect(admission).toEqual(['before', 'unsupported-attachments']);
    expect(history).toHaveLength(deferredCommit ? 1 : 0);
    expect(instance.requestCount).toBe(deferredCommit ? 4 : 3);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'user', content: '/fixture-native example', metadata: { command: {
      name: 'fixture-native', resolved: true, executionType: 'prompt', providerNativeCommandId: 'acp:opencode:fixture-native',
    } } });
    expect(buildUserMessages(emitted, 200000).count).toBe(0);
  });

  it('does not duplicate an already committed user message on retry', async () => {
    const { context, emitted, history, instance } = fixture();
    await dispatchNativeOpenCodeCommand({ ...context, options: { isRetry: true }, send: async (_prompt, options) => { options.beforeProviderDispatch?.(); } });
    expect(emitted).toHaveLength(0);
    expect(history).toHaveLength(0);
    expect(instance.requestCount).toBe(3);
  });

  it('rejects stale commands before committing deferred history or transcript', async () => {
    const { context, emitted, history, instance, removeCommand } = fixture();
    await expect(dispatchNativeOpenCodeCommand({ ...context, deferredCommit: true,
      send: async (_prompt, options) => { removeCommand(); options.beforeProviderDispatch?.(); },
    })).rejects.toThrow('no longer available');
    expect(emitted).toHaveLength(0);
    expect(history).toHaveLength(0);
    expect(instance.requestCount).toBe(3);
  });

  it('revalidates the session catalog on later provider writes', async () => {
    const { context, removeCommand, emitted, history } = fixture();
    let captured: InstanceSendInputOptions | undefined;
    await dispatchNativeOpenCodeCommand({ ...context, deferredCommit: true,
      send: async (_prompt, options) => { captured = options; options.beforeProviderDispatch?.(); },
    });
    removeCommand();
    expect(() => captured?.assertProviderDispatchCurrent?.('context-overflow')).toThrow('no longer available');
    expect(emitted).toHaveLength(1);
    expect(history).toHaveLength(1);
  });
});
