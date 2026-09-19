/**
 * End-to-end cover for `aio-mcp loop`: the real CLI argv parser, the real
 * `OrchestratorToolsRpcClient`, a real Unix socket, the real RPC server, the
 * real dispatch layer, and the real coordinator-facing operations. Only the
 * coordinator and loop store are stubbed.
 *
 * The unit specs each cover one seam; this one exists because the bug being
 * fixed was that no route existed at all between an agent shell and
 * `LoopCoordinator.resumeLoop`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));
vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));
vi.mock('../db/better-sqlite3-driver', () => ({
  defaultDriverFactory: vi.fn(() => {
    throw new Error('better-sqlite3 must not be touched in this test');
  }),
}));
vi.mock('../operator/operator-schema', () => ({ createOperatorTables: vi.fn() }));
vi.mock('../operator/operator-database', () => ({
  defaultOperatorDbPath: () => '/tmp/never-opened.db',
}));
vi.mock('../orchestration/loop-coordinator', () => ({ getLoopCoordinator: vi.fn() }));
vi.mock('../orchestration/loop-store', () => ({ getLoopStore: vi.fn() }));

import { createLoopCliOperations } from '../orchestration/default-loop-cli-operations';
import type { LoopCheckpoint } from '../orchestration/loop-checkpoint';
import type { LoopRunSummary, LoopState } from '../../shared/types/loop.types';
import { runLoopCli } from './loop-cli';
import { OrchestratorToolsRpcClient } from './orchestrator-tools-rpc-client';
import {
  OrchestratorToolsRpcServer,
  _resetOrchestratorToolsRpcServerForTesting,
} from './orchestrator-tools-rpc-server';

const KNOWN_INSTANCE = 'instance-known';
const PARKED_ID = 'loop-1789608176316-f9af53a7';

function parkedRun(): LoopRunSummary {
  return {
    id: PARKED_ID,
    chatId: 'chat-1',
    status: 'provider-limit',
    totalIterations: 0,
    totalTokens: 0,
    totalCostCents: 0,
    startedAt: 1_789_608_178_949,
    endedAt: null,
    endReason: 'Parked on a recorded provider limit from loop-quota',
    workspaceCwd: '/Users/x/work/repo',
    initialPrompt: 'Please work through all the livetests, fix any issues you find.',
    iterationPrompt: null,
  } as LoopRunSummary;
}

describe('aio-mcp loop over a real orchestrator-tools socket', () => {
  let server: OrchestratorToolsRpcServer;
  let tmpDir: string;
  let states: Map<string, LoopState>;
  let stdout: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    if (process.platform === 'win32') return;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-cli-rpc-'));
    states = new Map<string, LoopState>();
    stdout = vi.fn();

    const parkedState = {
      id: PARKED_ID,
      chatId: 'chat-1',
      status: 'provider-limit',
      endedAt: null,
    } as unknown as LoopState;
    const checkpoint: LoopCheckpoint = {
      version: 1,
      loopRunId: PARKED_ID,
      chatId: 'chat-1',
      status: 'provider-limit',
      state: parkedState,
      historyTail: [],
      convergenceNote: null,
      planRegenerationCount: 0,
      pendingContextReset: false,
      updatedAt: 1,
    };

    const coordinator = {
      getActiveLoops: () => [...states.values()],
      getLoop: (id: string) => states.get(id),
      resumeLoop: (id: string) => {
        const state = states.get(id);
        if (!state) return false;
        state.status = 'running';
        return true;
      },
      restoreLoopFromCheckpoint: async (cp: LoopCheckpoint) => {
        states.set(cp.loopRunId, cp.state);
        return cp.state;
      },
    };
    const store = {
      listRuns: () => [parkedRun()],
      getCheckpoint: (id: string) => (id === PARKED_ID ? checkpoint : null),
      upsertRun: vi.fn(),
    };

    server = new OrchestratorToolsRpcServer({
      userDataPath: tmpDir,
      isKnownLocalInstance: (id) => id === KNOWN_INSTANCE,
      toolFactory: () => [],
      registerCleanup: () => undefined,
      loopOperations: createLoopCliOperations({
        getCoordinator: () => coordinator,
        getStore: () => store,
      }),
    });
    await server.start();
  });

  afterEach(async () => {
    if (process.platform === 'win32') return;
    await server.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    _resetOrchestratorToolsRpcServerForTesting();
  });

  function clientFor(instanceId: string): OrchestratorToolsRpcClient {
    return new OrchestratorToolsRpcClient({
      timeoutMs: 5_000,
      env: {
        AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET: server.getSocketPath() ?? '',
        AI_ORCHESTRATOR_INSTANCE_ID: instanceId,
        // Socket traffic is authenticated by instance id AND a per-spawn
        // capability token; mint the real one the parent would hand a child.
        AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY:
          server.getInstanceCapability(KNOWN_INSTANCE) ?? '',
      },
    });
  }

  function cliClient(): OrchestratorToolsRpcClient {
    return clientFor(KNOWN_INSTANCE);
  }

  function text(): string {
    return stdout.mock.calls.map((call) => String(call[0])).join('');
  }

  it('lists the parked loop and then resumes it', async () => {
    if (process.platform === 'win32') return;

    await runLoopCli(['list'], { client: cliClient(), stdout });
    expect(text()).toContain(`resume: aio-mcp loop resume ${PARKED_ID}`);
    expect(states.has(PARKED_ID)).toBe(false);

    stdout.mockClear();
    await runLoopCli(['resume', PARKED_ID], { client: cliClient(), stdout });

    expect(text()).toContain('re-hydrated from its stored checkpoint');
    expect(text()).toContain('provider-limit -> running');
    expect(states.get(PARKED_ID)?.status).toBe('running');
  });

  it('rejects a call from an instance the parent does not know', async () => {
    if (process.platform === 'win32') return;

    const client = clientFor('instance-evil');

    // Either socket gate may reject first (instance id, or the capability
    // token minted for a different instance); both must refuse the resume.
    await expect(runLoopCli(['resume', PARKED_ID], { client, stdout }))
      .rejects.toThrow(/unknown orchestrator-tools instance|capability token/);
    expect(states.has(PARKED_ID)).toBe(false);
  });

  it('surfaces the parent refusal for an unknown loop id', async () => {
    if (process.platform === 'win32') return;

    await expect(runLoopCli(['resume', 'loop-nope'], { client: cliClient(), stdout }))
      .rejects.toThrow(/no stored checkpoint exists/);
  });
});
