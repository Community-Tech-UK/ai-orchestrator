import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { buildBrowserGatewayMcpConfigJson } from '../../browser-gateway/browser-mcp-config';
import { buildCodememMcpConfig } from '../../codemem/mcp-config';
import { buildComputerUseMcpConfigJson } from '../../desktop-gateway/desktop-mcp-config';
import { buildOrchestratorToolsMcpConfig } from '../../mcp/orchestrator-tools-mcp-config';
import type { InstanceStatus, OutputMessage } from '../../../shared/types/instance.types';
import {
  HARNESS_MCP_SERVER_NAMES,
  HarnessMcpStartupRecovery,
  findFailedHarnessMcpServers,
} from './harness-mcp-startup-recovery';

const BROWSER_FAILED = [
  { name: 'browser-gateway', status: 'failed' },
  { name: 'orchestrator', status: 'connected' },
];
const ALL_CONNECTED = [
  { name: 'browser-gateway', status: 'connected' },
  { name: 'orchestrator', status: 'connected' },
];

describe('findFailedHarnessMcpServers', () => {
  it('reports only failed servers that Harness injected', () => {
    expect(findFailedHarnessMcpServers([
      { name: 'browser-gateway', status: 'failed' },
      { name: 'codemem', status: 'connected' },
      { name: 'harness-computer-use', status: 'pending' },
      { name: 'fal-ai', status: 'failed' },
    ])).toEqual(['browser-gateway']);
  });

  it('names exactly the servers the Harness MCP config builders write', () => {
    const shared = { aioMcpCliPath: '/aio-mcp', socketPath: '/s.sock', instanceId: 'i', exists: () => true };
    const configs = [
      buildBrowserGatewayMcpConfigJson(shared),
      buildOrchestratorToolsMcpConfig(shared),
      buildCodememMcpConfig(shared),
      buildComputerUseMcpConfigJson(shared),
    ];
    const names = configs.flatMap((json) => Object.keys(
      (JSON.parse(json ?? '{}') as { mcpServers: Record<string, unknown> }).mcpServers,
    ));
    expect(new Set(names)).toEqual(HARNESS_MCP_SERVER_NAMES);
  });
});

describe('HarnessMcpStartupRecovery', () => {
  let status: InstanceStatus;
  let generation: number;
  let exists: boolean;
  let onHold: boolean;
  let onLoan: boolean;
  let releaseLoan: (instanceId: string) => void;
  let parentId: string | null;
  let scheduled: (() => void)[];
  let notices: OutputMessage[];
  let restartInstance: ReturnType<typeof vi.fn>;
  let recovery: HarnessMcpStartupRecovery;

  async function runScheduled(): Promise<void> {
    const pending = scheduled;
    scheduled = [];
    for (const callback of pending) callback();
    await new Promise((resolve) => setImmediate(resolve));
  }

  beforeEach(() => {
    status = 'busy';
    generation = 1;
    exists = true;
    onHold = false;
    onLoan = false;
    releaseLoan = () => undefined;
    parentId = null;
    scheduled = [];
    notices = [];
    restartInstance = vi.fn(async () => {
      generation += 1;
      return { success: true };
    });
    recovery = new HarnessMcpStartupRecovery({
      getInstance: () => (exists ? { status, adapterGeneration: generation, parentId } : undefined),
      restartInstance,
      emitNotice: (_id, message) => notices.push(message),
      isOnHold: () => onHold,
      isAdapterOnLoan: () => onLoan,
      onAdapterLoanReleased: (listener) => { releaseLoan = listener; },
      schedule: (callback) => scheduled.push(callback),
    });
  });

  it('does nothing when every Harness server connected', async () => {
    recovery.recordStartupStatus('i', generation, ALL_CONNECTED);
    status = 'idle';
    recovery.noteSettled('i');
    await runScheduled();

    expect(notices).toEqual([]);
    expect(restartInstance).not.toHaveBeenCalled();
  });

  it('tells the user at once and restarts only after the turn settles to idle', async () => {
    recovery.recordStartupStatus('i', generation, BROWSER_FAILED);

    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      type: 'system',
      metadata: { source: 'harness-mcp-startup-failed', failedServers: ['browser-gateway'] },
    });
    expect(notices[0].content).toContain('Browser Gateway failed to start');

    await runScheduled();
    expect(restartInstance).not.toHaveBeenCalled();

    status = 'idle';
    recovery.noteSettled('i');
    await runScheduled();
    expect(restartInstance).toHaveBeenCalledTimes(1);
    expect(restartInstance).toHaveBeenCalledWith('i');
  });

  it('restarts straight away when the failure is reported while already idle', async () => {
    status = 'idle';
    recovery.recordStartupStatus('i', generation, BROWSER_FAILED);
    await runScheduled();

    expect(restartInstance).toHaveBeenCalledTimes(1);
  });

  it('does not restart a session that is waiting on the user', async () => {
    recovery.recordStartupStatus('i', generation, BROWSER_FAILED);
    status = 'waiting_for_input';
    recovery.noteSettled('i');
    await runScheduled();
    expect(restartInstance).not.toHaveBeenCalled();

    status = 'idle';
    recovery.noteSettled('i');
    await runScheduled();
    expect(restartInstance).toHaveBeenCalledTimes(1);
  });

  it('waits out a provider-limit park or auth block instead of cancelling it', async () => {
    recovery.recordStartupStatus('i', generation, BROWSER_FAILED);
    status = 'idle';
    onHold = true;
    recovery.noteSettled('i');
    await runScheduled();
    expect(restartInstance).not.toHaveBeenCalled();

    onHold = false;
    recovery.noteSettled('i');
    await runScheduled();
    expect(restartInstance).toHaveBeenCalledTimes(1);
  });

  it('never restarts under a loop borrowing the adapter, and retries when the loan is released', async () => {
    recovery.recordStartupStatus('i', generation, BROWSER_FAILED);
    status = 'idle';
    onLoan = true;
    recovery.noteSettled('i');
    await runScheduled();
    expect(restartInstance).not.toHaveBeenCalled();

    onLoan = false;
    releaseLoan('i');
    await runScheduled();
    expect(restartInstance).toHaveBeenCalledTimes(1);
  });

  it('reports but does not restart an orchestration child', async () => {
    parentId = 'parent';
    status = 'idle';
    recovery.recordStartupStatus('i', generation, BROWSER_FAILED);
    recovery.recordStartupStatus('i', generation, BROWSER_FAILED);
    recovery.noteSettled('i');
    await runScheduled();

    expect(restartInstance).not.toHaveBeenCalled();
    expect(notices).toHaveLength(1);
    expect(notices[0].content).toContain('Restart the session to reconnect them');
  });

  it('notifies once for a repeated init from the same process', async () => {
    recovery.recordStartupStatus('i', generation, BROWSER_FAILED);
    recovery.recordStartupStatus('i', generation, BROWSER_FAILED);

    expect(notices).toHaveLength(1);
  });

  it('skips the restart when the CLI process was already replaced', async () => {
    recovery.recordStartupStatus('i', generation, BROWSER_FAILED);
    generation += 1;
    status = 'idle';
    recovery.noteSettled('i');
    await runScheduled();

    expect(restartInstance).not.toHaveBeenCalled();
  });

  it('restarts once per failure streak, then reports instead of looping', async () => {
    status = 'idle';
    recovery.recordStartupStatus('i', generation, BROWSER_FAILED);
    await runScheduled();
    expect(restartInstance).toHaveBeenCalledTimes(1);

    recovery.recordStartupStatus('i', generation, BROWSER_FAILED);
    recovery.recordStartupStatus('i', generation, BROWSER_FAILED);
    recovery.noteSettled('i');
    await runScheduled();

    expect(restartInstance).toHaveBeenCalledTimes(1);
    expect(notices).toHaveLength(2);
    expect(notices[1].content).toContain('failed to start again after an automatic restart');
  });

  it('starts a new streak after a healthy start', async () => {
    status = 'idle';
    recovery.recordStartupStatus('i', generation, BROWSER_FAILED);
    await runScheduled();
    recovery.recordStartupStatus('i', generation, ALL_CONNECTED);

    recovery.recordStartupStatus('i', generation, BROWSER_FAILED);
    await runScheduled();

    expect(restartInstance).toHaveBeenCalledTimes(2);
  });

  it('survives a restart that throws and does not retry it automatically', async () => {
    restartInstance.mockRejectedValueOnce(new Error('cli missing'));
    status = 'idle';
    recovery.recordStartupStatus('i', generation, BROWSER_FAILED);
    await runScheduled();
    recovery.noteSettled('i');
    await runScheduled();

    expect(restartInstance).toHaveBeenCalledTimes(1);
  });

  it('drops state for a removed instance', async () => {
    recovery.recordStartupStatus('i', generation, BROWSER_FAILED);
    recovery.forget('i');
    status = 'idle';
    recovery.noteSettled('i');
    await runScheduled();

    expect(restartInstance).not.toHaveBeenCalled();
  });

  it('names every failed server in one notice', () => {
    recovery.recordStartupStatus('i', generation, [
      { name: 'browser-gateway', status: 'failed' },
      { name: 'codemem', status: 'failed' },
      { name: 'orchestrator', status: 'failed' },
    ]);

    expect(notices[0].content).toContain('Browser Gateway, Codemem and Harness orchestrator tools failed');
  });
});
