import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createInstance } from '../../shared/types/instance.types';
import { bindInstanceNativeCommandForwarding } from './instance-native-command-catalog';

describe('native catalog publication boundary', () => {
  it('publishes current incarnation state without persisting the transient invalidation', () => {
    const instance = Object.assign(createInstance({ workingDirectory: '/tmp', provider: 'opencode' }), {
      id: 'selected-fixture', status: 'ready' as const, restartEpoch: 2, adapterGeneration: 4, providerSessionId: 'provider-fixture',
    });
    const owner = Object.assign(new EventEmitter(), { getInstance: (id: string) => id === instance.id ? instance : undefined });
    const communication = new EventEmitter(); const updates: unknown[] = [];
    owner.on('instance:state-update', update => updates.push(update));
    bindInstanceNativeCommandForwarding(communication, owner);
    communication.emit('commands-changed', { instanceId: instance.id });
    expect(updates).toEqual([{ instanceId: 'selected-fixture', status: 'ready', commandsChanged: true,
      restartEpoch: 2, adapterGeneration: 4, providerSessionId: 'provider-fixture' }]);
    expect(instance).not.toHaveProperty('commandsChanged');
  });
  it('does not publish private pending instances, removed sessions or other providers', () => {
    const instance = createInstance({ workingDirectory: '/tmp', provider: 'claude' });
    const owner = Object.assign(new EventEmitter(), { getInstance: (id: string) => id === instance.id ? instance : undefined });
    const communication = new EventEmitter(); const updates: unknown[] = [];
    owner.on('instance:state-update', update => updates.push(update));
    bindInstanceNativeCommandForwarding(communication, owner);
    for (const instanceId of ['private-pending-fixture', 'removed-fixture', instance.id]) communication.emit('commands-changed', { instanceId });
    expect(updates).toEqual([]);
  });
});
