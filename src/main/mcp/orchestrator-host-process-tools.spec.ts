import { describe, expect, it, vi } from 'vitest';
import {
  createHostProcessForwarderTools,
  createHostProcessToolDefinitions,
  type ListHostProcessesFn,
  type StopLeftoverProcessesFn,
} from './orchestrator-host-process-tools';

const listResult = { processes: [], summary: { totalProcesses: 0, matchingProcesses: 0, cpuCount: 1, loadAverage: [0, 0, 0] } };

function wired(instanceId: string | null = 'inst-7') {
  const listHostProcesses = vi.fn<ListHostProcessesFn>(async () => listResult);
  const stopLeftoverProcesses = vi.fn<StopLeftoverProcessesFn>(async () => ({ results: [], summary: 'Nothing to do.' }));
  const tools = createHostProcessToolDefinitions({ instanceId, listHostProcesses, stopLeftoverProcesses });
  return {
    listHostProcesses,
    stopLeftoverProcesses,
    list: tools.find((t) => t.name === 'list_host_processes')!,
    stop: tools.find((t) => t.name === 'stop_leftover_processes')!,
  };
}

describe('host process tool definitions', () => {
  it('defines the two tools with plain-English descriptions', () => {
    const { list, stop } = wired();
    expect(list.description).toMatch(/cannot run ps or top/);
    expect(list.description).toMatch(/stopRefusal/);
    expect(stop.description).toMatch(/orphaned/);
    expect(stop.description).toMatch(/another live session|owned by another live session/);
  });

  it('passes the calling session id as callerInstanceId and validates args', async () => {
    const { list, stop, listHostProcesses, stopLeftoverProcesses } = wired('inst-7');
    await list.handler({ limit: 5, nameFilter: ' node ', leftoverOnly: true });
    expect(listHostProcesses).toHaveBeenCalledWith({ limit: 5, nameFilter: 'node', leftoverOnly: true, callerInstanceId: 'inst-7' });
    await stop.handler({ pids: [42, 43], force: true });
    expect(stopLeftoverProcesses).toHaveBeenCalledWith({ pids: [42, 43], force: true, callerInstanceId: 'inst-7' });
  });

  it('ignores a caller id smuggled in the arguments', async () => {
    const { list, stop } = wired();
    await expect(list.handler({ callerInstanceId: 'someone-else' })).rejects.toThrow();
    await expect(stop.handler({ pids: [42], callerInstanceId: 'someone-else' })).rejects.toThrow();
  });

  it('rejects out-of-range and malformed arguments', async () => {
    const { list, stop, listHostProcesses, stopLeftoverProcesses } = wired();
    await expect(list.handler({ limit: 0 })).rejects.toThrow();
    await expect(list.handler({ limit: 101 })).rejects.toThrow();
    await expect(list.handler({ limit: 1.5 })).rejects.toThrow();
    await expect(list.handler({ nameFilter: '' })).rejects.toThrow();
    await expect(stop.handler({ pids: [] })).rejects.toThrow();
    await expect(stop.handler({ pids: [1] })).rejects.toThrow();
    await expect(stop.handler({ pids: [-5] })).rejects.toThrow();
    await expect(stop.handler({ pids: [42, 42] })).rejects.toThrow();
    await expect(stop.handler({ pids: Array.from({ length: 101 }, (_, i) => i + 2) })).rejects.toThrow();
    await expect(stop.handler({ pids: ['42'] })).rejects.toThrow();
    await expect(stop.handler({ pids: [42], force: 'yes' })).rejects.toThrow();
    await expect(stop.handler({})).rejects.toThrow();
    expect(listHostProcesses).not.toHaveBeenCalled();
    expect(stopLeftoverProcesses).not.toHaveBeenCalled();
  });

  it('throws an unavailable error when not wired', async () => {
    const tools = createHostProcessToolDefinitions({ instanceId: 'inst-7' });
    await expect(tools[0]!.handler({})).rejects.toThrow('list_host_processes is unavailable');
    await expect(tools[1]!.handler({ pids: [42] })).rejects.toThrow('stop_leftover_processes is unavailable');
  });

  it('refuses to run when the calling session is unknown', async () => {
    const { list, stop, stopLeftoverProcesses } = wired(null);
    await expect(list.handler({})).rejects.toThrow(/calling session could not be identified/);
    await expect(stop.handler({ pids: [42] })).rejects.toThrow(/calling session could not be identified/);
    expect(stopLeftoverProcesses).not.toHaveBeenCalled();
  });
});

describe('host process forwarder tools', () => {
  it('forward to the canonical RPC methods and require object args', async () => {
    const call = vi.fn(async () => ({ ok: true }));
    const [list, stop] = createHostProcessForwarderTools({ call });
    expect(list!.name).toBe('list_host_processes');
    expect(stop!.name).toBe('stop_leftover_processes');
    await list!.handler({});
    await stop!.handler({ pids: [42] });
    expect(call).toHaveBeenNthCalledWith(1, 'orchestrator_tools.list_host_processes', {});
    expect(call).toHaveBeenNthCalledWith(2, 'orchestrator_tools.stop_leftover_processes', { pids: [42] });
    await expect(list!.handler(null as unknown as Record<string, unknown>)).rejects.toThrow('must be an object');
  });

  it('share input schemas with the parent definitions', () => {
    const parent = createHostProcessToolDefinitions({});
    const forwarded = createHostProcessForwarderTools({ call: async () => null });
    expect(forwarded.map((t) => [t.name, t.description, t.inputSchema])).toEqual(
      parent.map((t) => [t.name, t.description, t.inputSchema]),
    );
  });
});
