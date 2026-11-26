import { describe, expect, it } from 'vitest';
import { CliAdapterWorkerProxy } from '../spawn-worker/cli-adapter-worker-proxy';
import type { CliSpawnGatewayPort } from '../spawn-worker/cli-spawn-worker-gateway';
import { InstanceStateManager } from '../../instance/instance-state';
import { createInstance } from '../../../shared/types/instance.types';

describe('worker-offloaded Claude native helper ingress', () => {
  it('publishes native starts and progress from gateway stdout through the same instance-update contract', () => {
    let ingress: Parameters<CliSpawnGatewayPort['registerInstance']>[1] | undefined;
    const gateway = { registerInstance: (_id: string, handlers: typeof ingress) => { ingress = handlers; } } as CliSpawnGatewayPort;
    const proxy = new CliAdapterWorkerProxy({ cliType: 'claude', instanceId: 'native-worker', gateway, options: { workingDirectory: '/tmp' } });
    const state = new InstanceStateManager();
    const instance = createInstance({ workingDirectory: '/tmp', provider: 'claude' });
    instance.status = 'busy';
    state.setInstance(instance);
    state.setAdapter(instance.id, proxy);
    try {
      const send = (message: unknown) => ingress!.stdout?.(`${JSON.stringify(message)}\n`);
      send({ type: 'system', subtype: 'task_started', task_type: 'local_agent', task_id: 'native-one', tool_use_id: 'native-tool' });
      expect(state.getInstance(instance.id)).toMatchObject({ nativeHelpers: { running: 1 } });
      send({ type: 'system', subtype: 'task_progress', task_id: 'native-one', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 } });
      expect(state.getInstance(instance.id)).toMatchObject({ nativeHelpers: { running: 1 } });
      send({ type: 'result', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 });
      expect(state.getInstance(instance.id)).toMatchObject({ nativeHelpers: { running: 0 } });
    } finally { state.destroy(); }
  });
});
