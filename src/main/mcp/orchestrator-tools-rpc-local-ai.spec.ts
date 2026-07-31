import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock('../db/better-sqlite3-driver', () => ({
  defaultDriverFactory: vi.fn(() => {
    throw new Error('better-sqlite3 must not be opened by Local AI CLI RPC tests');
  }),
}));

vi.mock('../operator/operator-schema', () => ({
  createOperatorTables: vi.fn(),
}));

vi.mock('../operator/operator-database', () => ({
  defaultOperatorDbPath: () => '/tmp/never-opened.db',
}));

import {
  OrchestratorToolsRpcServer,
  _resetOrchestratorToolsRpcServerForTesting,
} from './orchestrator-tools-rpc-server';

const KNOWN_INSTANCE = 'instance-known';

const config = {
  lifecycle: 'enrolled' as const,
  location: { type: 'worker' as const, nodeId: 'node-1' },
  provider: 'openai-compatible' as const,
  endpointId: 'openai-compatible',
  baseUrl: 'http://100.64.0.2:1234/v1',
  expectedModels: [{ modelId: 'qwen/qwen3.5-9b', required: true }],
  canary: {
    model: 'qwen/qwen3.5-9b',
    timeoutMs: 30_000,
    intervalMs: 600_000,
  },
  endpointCheckIntervalMs: 60_000,
  freshnessLimitMs: 120_000,
  warningLatencyMs: 2_000,
  routingRoles: ['compression' as const],
  fallbackPolicy: 'notify-and-allow' as const,
  slotFallbackPolicies: {},
  recovery: {
    automatic: false,
    maxAttempts: 2,
    cooldownMs: 300_000,
  },
};

const target = {
  ...config,
  id: 'target-1',
  label: 'node-1: openai-compatible',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const discovery = [{
  identity: {
    location: { type: 'worker' as const, nodeId: 'node-1' },
    provider: 'openai-compatible' as const,
    endpointId: 'openai-compatible',
    baseUrl: 'http://100.64.0.2:1234/v1',
  },
  label: 'windows-pc • openai-compatible',
  models: ['qwen/qwen3.5-9b'],
  healthy: true,
}];

function probe(ok: boolean) {
  return {
    targetId: 'validation-target',
    layer: 'worker' as const,
    checkType: 'functional' as const,
    ok,
    required: true,
    affectedRoles: ['compression' as const],
    checkedAt: 1_700_000_000_000,
    durationMs: 25,
    ...(ok ? {} : { failureCode: 'worker-offline' as const }),
    evidence: { workerConnected: ok },
  };
}

function request(method: string, payload: Record<string, unknown>) {
  return {
    jsonrpc: '2.0' as const,
    id: 1,
    method,
    params: {
      instanceId: KNOWN_INSTANCE,
      payload,
    },
  };
}

function makeHarness(overrides: Record<string, unknown> = {}) {
  const operations = {
    list: vi.fn(async () => []),
    discover: vi.fn(async () => discovery),
    validate: vi.fn(async () => [probe(true)]),
    create: vi.fn(async () => target),
    ...overrides,
  };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-local-ai-rpc-'));
  const server = new OrchestratorToolsRpcServer({
    userDataPath: tmpDir,
    isKnownLocalInstance: (id) => id === KNOWN_INSTANCE,
    toolFactory: () => [],
    registerCleanup: () => undefined,
    localAiGuardOperations: operations,
  });
  return { server, operations, tmpDir };
}

describe('OrchestratorToolsRpcServer Local AI CLI methods', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    _resetOrchestratorToolsRpcServerForTesting();
  });

  it('lists schema-validated target records', async () => {
    const h = makeHarness({ list: vi.fn(async () => [target]) });
    tempDirs.push(h.tmpDir);

    await expect(
      h.server.handleRequest(request('orchestrator_tools.local_ai.list', {})),
    ).resolves.toEqual([target]);
    expect(h.operations.list).toHaveBeenCalledOnce();
  });

  it('discovers schema-validated safe endpoint metadata', async () => {
    const h = makeHarness();
    tempDirs.push(h.tmpDir);

    await expect(
      h.server.handleRequest(request('orchestrator_tools.local_ai.discover', {})),
    ).resolves.toEqual(discovery);
    expect(h.operations.discover).toHaveBeenCalledOnce();
  });

  it('rejects unexpected payload properties before runtime work', async () => {
    const h = makeHarness();
    tempDirs.push(h.tmpDir);

    await expect(
      h.server.handleRequest(request('orchestrator_tools.local_ai.discover', {
        includeSecrets: true,
      })),
    ).rejects.toThrow();
    expect(h.operations.discover).not.toHaveBeenCalled();
  });

  it('validates a strict config through the injected functional probe operation', async () => {
    const h = makeHarness();
    tempDirs.push(h.tmpDir);

    await expect(
      h.server.handleRequest(request('orchestrator_tools.local_ai.validate', { config })),
    ).resolves.toEqual([probe(true)]);
    expect(h.operations.validate).toHaveBeenCalledWith(config);
    expect(h.operations.create).not.toHaveBeenCalled();
  });

  it('fails closed when Local AI runtime operations are unavailable', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-local-ai-rpc-'));
    tempDirs.push(tmpDir);
    const server = new OrchestratorToolsRpcServer({
      userDataPath: tmpDir,
      isKnownLocalInstance: (id) => id === KNOWN_INSTANCE,
      toolFactory: () => [],
      registerCleanup: () => undefined,
    });

    await expect(
      server.handleRequest(request('orchestrator_tools.local_ai.list', {})),
    ).rejects.toThrow('Local AI Guard CLI operations unavailable');
  });

  it.each([
    ['empty', []],
    ['failed required', [probe(false)]],
  ])('refuses enrolment after %s validation without creating a target', async (_label, result) => {
    const h = makeHarness({ validate: vi.fn(async () => result) });
    tempDirs.push(h.tmpDir);

    await expect(
      h.server.handleRequest(request('orchestrator_tools.local_ai.enrol', { config })),
    ).rejects.toThrow('Local AI target validation failed');
    expect(h.operations.create).not.toHaveBeenCalled();
  });

  it.each(['unmanaged', 'paused', 'retired'] as const)(
    'rejects lifecycle %s before enrolment runtime work',
    async (lifecycle) => {
      const h = makeHarness();
      tempDirs.push(h.tmpDir);

      await expect(
        h.server.handleRequest(request('orchestrator_tools.local_ai.enrol', {
          config: { ...config, lifecycle },
        })),
      ).rejects.toThrow('enrolled lifecycle');
      expect(h.operations.list).not.toHaveBeenCalled();
      expect(h.operations.validate).not.toHaveBeenCalled();
      expect(h.operations.create).not.toHaveBeenCalled();
    },
  );

  it('rejects an already managed endpoint before probing or creating', async () => {
    const h = makeHarness({ list: vi.fn(async () => [target]) });
    tempDirs.push(h.tmpDir);

    await expect(
      h.server.handleRequest(request('orchestrator_tools.local_ai.enrol', { config })),
    ).rejects.toThrow('already enrolled');
    expect(h.operations.validate).not.toHaveBeenCalled();
    expect(h.operations.create).not.toHaveBeenCalled();
  });

  it('rechecks duplication after validation before creating', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([target]);
    const h = makeHarness({ list });
    tempDirs.push(h.tmpDir);

    await expect(
      h.server.handleRequest(request('orchestrator_tools.local_ai.enrol', { config })),
    ).rejects.toThrow('already enrolled');
    expect(h.operations.validate).toHaveBeenCalledOnce();
    expect(h.operations.create).not.toHaveBeenCalled();
  });

  it('validates, rechecks, and creates exactly once for a new healthy target', async () => {
    const order: string[] = [];
    const h = makeHarness({
      list: vi.fn(async () => {
        order.push('list');
        return [];
      }),
      validate: vi.fn(async () => {
        order.push('validate');
        return [probe(true)];
      }),
      create: vi.fn(async () => {
        order.push('create');
        return target;
      }),
    });
    tempDirs.push(h.tmpDir);

    await expect(
      h.server.handleRequest(request('orchestrator_tools.local_ai.enrol', { config })),
    ).resolves.toEqual({
      target,
      validation: [probe(true)],
    });
    expect(order).toEqual(['list', 'validate', 'list', 'create']);
    expect(h.operations.create).toHaveBeenCalledWith(config);
  });
});
