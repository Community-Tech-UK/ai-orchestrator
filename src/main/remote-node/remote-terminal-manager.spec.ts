import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendRpc = vi.fn();
const isNodeConnected = vi.fn(() => true);

vi.mock('./worker-node-connection', () => ({
  getWorkerNodeConnectionServer: () => ({ sendRpc, isNodeConnected }),
}));

import { getWorkerNodeRegistry, WorkerNodeRegistry } from './worker-node-registry';
import { RemoteTerminalManager, getRemoteTerminalManager, RETAINED_OUTPUT_BYTES } from './remote-terminal-manager';

interface OutputEvent {
  sessionId: string;
  data: string;
}
interface ExitEvent {
  sessionId: string;
  exitCode: number | null;
  signal: string | null;
}

describe('RemoteTerminalManager', () => {
  beforeEach(() => {
    sendRpc.mockReset();
    isNodeConnected.mockReset();
    isNodeConnected.mockReturnValue(true);
    RemoteTerminalManager._resetForTesting();
    WorkerNodeRegistry._resetForTesting();
  });

  it('spawns via terminal.create and returns sessionId + pid', async () => {
    sendRpc.mockResolvedValue({ sessionId: 'worker-ignored', pid: 999 });
    const mgr = getRemoteTerminalManager();
    const res = await mgr.spawn({ nodeId: 'win', cwd: '/repo', cols: 80, rows: 24 });

    expect(res.pid).toBe(999);
    expect(res.nodeId).toBe('win');
    expect(sendRpc).toHaveBeenCalledWith(
      'win',
      'terminal.create',
      expect.objectContaining({ sessionId: res.sessionId, cwd: '/repo', cols: 80, rows: 24 }),
    );
    expect(mgr.activeSessionCount()).toBe(1);
  });

  it('rejects spawn when the node is not connected', async () => {
    isNodeConnected.mockReturnValue(false);
    await expect(
      getRemoteTerminalManager().spawn({ nodeId: 'win', cwd: '/repo' }),
    ).rejects.toThrow(/not connected/);
    expect(sendRpc).not.toHaveBeenCalled();
  });

  it('drops the session if create fails', async () => {
    sendRpc.mockRejectedValue(new Error('boom'));
    const mgr = getRemoteTerminalManager();
    await expect(mgr.spawn({ nodeId: 'win', cwd: '/repo' })).rejects.toThrow(/boom/);
    expect(mgr.activeSessionCount()).toBe(0);
  });

  it('forwards registry output only for the matching session+node', async () => {
    sendRpc.mockResolvedValue({ sessionId: 'x', pid: 1 });
    const mgr = getRemoteTerminalManager();
    const { sessionId } = await mgr.spawn({ nodeId: 'win', cwd: '/repo' });

    const outputs: OutputEvent[] = [];
    mgr.on('output', (e: OutputEvent) => outputs.push(e));

    const registry = getWorkerNodeRegistry();
    registry.emit('remote:terminal-output', { nodeId: 'win', sessionId, data: 'hello' });
    registry.emit('remote:terminal-output', { nodeId: 'OTHER', sessionId, data: 'wrong-node' });
    registry.emit('remote:terminal-output', { nodeId: 'win', sessionId: 'ghost', data: 'wrong-session' });

    expect(outputs).toEqual([{ sessionId, data: 'hello' }]);
  });

  it('WS11.7: retains recent output for replay on (re)attach, bounded to the ring size', async () => {
    sendRpc.mockResolvedValue({ sessionId: 'x', pid: 1 });
    const mgr = getRemoteTerminalManager();
    const { sessionId } = await mgr.spawn({ nodeId: 'win', cwd: '/repo' });
    const registry = getWorkerNodeRegistry();

    registry.emit('remote:terminal-output', { nodeId: 'win', sessionId, data: '$ ls\n' });
    registry.emit('remote:terminal-output', { nodeId: 'win', sessionId, data: 'src package.json\n' });
    expect(mgr.getBufferedOutput(sessionId)).toBe('$ ls\nsrc package.json\n');

    // Overflow the ring: the oldest chunks are dropped, total stays bounded.
    const bigChunk = 'y'.repeat(64 * 1024);
    for (let i = 0; i < 8; i++) {
      registry.emit('remote:terminal-output', { nodeId: 'win', sessionId, data: bigChunk });
    }
    const buffered = mgr.getBufferedOutput(sessionId)!;
    expect(buffered.length).toBeLessThanOrEqual(RETAINED_OUTPUT_BYTES);
    expect(buffered).not.toContain('$ ls'); // earliest output rotated out
    expect(buffered.endsWith(bigChunk)).toBe(true); // newest retained

    // Unknown/exited sessions replay nothing.
    expect(mgr.getBufferedOutput('ghost')).toBeNull();
    registry.emit('remote:terminal-exit', { nodeId: 'win', sessionId, exitCode: 0, signal: null });
    expect(mgr.getBufferedOutput(sessionId)).toBeNull();
  });

  it('emits exit, drops the session, and ignores later output', async () => {
    sendRpc.mockResolvedValue({ sessionId: 'x', pid: 1 });
    const mgr = getRemoteTerminalManager();
    const { sessionId } = await mgr.spawn({ nodeId: 'win', cwd: '/repo' });

    const exits: ExitEvent[] = [];
    const outputs: OutputEvent[] = [];
    mgr.on('exit', (e: ExitEvent) => exits.push(e));
    mgr.on('output', (e: OutputEvent) => outputs.push(e));

    const registry = getWorkerNodeRegistry();
    registry.emit('remote:terminal-exit', { nodeId: 'win', sessionId, exitCode: 0, signal: null });
    registry.emit('remote:terminal-output', { nodeId: 'win', sessionId, data: 'late' });

    expect(exits).toEqual([{ sessionId, exitCode: 0, signal: null }]);
    expect(outputs).toEqual([]);
    expect(mgr.activeSessionCount()).toBe(0);
  });

  it('proxies write/resize/kill to the right method and node', async () => {
    sendRpc.mockResolvedValue({ sessionId: 'x', pid: 1 });
    const mgr = getRemoteTerminalManager();
    const { sessionId } = await mgr.spawn({ nodeId: 'win', cwd: '/repo' });

    sendRpc.mockResolvedValue({ ok: true });
    await mgr.write(sessionId, 'ls\r');
    expect(sendRpc).toHaveBeenCalledWith('win', 'terminal.input', { sessionId, data: 'ls\r' });

    await mgr.resize(sessionId, 100, 40);
    expect(sendRpc).toHaveBeenCalledWith('win', 'terminal.resize', { sessionId, cols: 100, rows: 40 });

    await mgr.kill(sessionId, 'SIGTERM');
    expect(sendRpc).toHaveBeenCalledWith('win', 'terminal.kill', { sessionId, signal: 'SIGTERM' });
  });

  it('write throws for an unknown session; kill is idempotent', async () => {
    const mgr = getRemoteTerminalManager();
    await expect(mgr.write('ghost', 'x')).rejects.toThrow(/not found/);
    await expect(mgr.kill('ghost')).resolves.toBeUndefined();
  });
});
