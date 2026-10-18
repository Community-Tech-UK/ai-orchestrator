import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CrossModelReviewService } from './cross-model-review-service';
import type { ReviewDispatchRequest } from './cross-model-review.types';
import { ProviderRuntimeService } from '../providers/provider-runtime-service';
import { ClaudeCliAdapter } from '../cli/adapters/claude-cli-adapter';
import { CliAdapterWorkerProxy } from '../cli/spawn-worker/cli-adapter-worker-proxy';
import type { CliSpawnGatewayPort, SpawnInstanceRequest } from '../cli/spawn-worker/cli-spawn-worker-gateway';
import type { ProviderRuntimeRegistry } from '../providers/provider-runtime-registry';
import type { UnifiedSpawnOptions } from '../cli/adapters/adapter-factory.types';
import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/types/settings.types';

/**
 * The actual Claude cross-model reviewer's dispatch contract, end to end:
 * `CrossModelReviewService.executeOneReview` → `ProviderRuntimeService` (with
 * spawn-worker offload ENABLED) → the adapter the runtime selects → the argv
 * that adapter actually spawns.
 *
 * History, because the routing half of this contract changed under it:
 *
 * 1. When F4 (the eight-turn backstop) was repaired, the runtime offloaded
 *    Claude to `CliAdapterWorkerProxy`, so this spec proved the caller's
 *    `maxTurns: 8` / `maxBudgetUsd: 1` survived into the worker gateway's
 *    dispatched argv.
 * 2. Phase 2 step 4g (its fresh-review finding "Claude opt-in worker policy/
 *    accounting bypass") deliberately kept every Claude session on the
 *    canonical adapter path until the worker has parity: the worker proxy
 *    launches the provider binary directly and cannot apply the adapter
 *    factory's review policy, Seatbelt refusal or per-turn usage ledger.
 *    `provider-runtime-service.spawn-worker.spec.ts` pins that gate, including
 *    a read-only Claude review case.
 *
 * So the dispatched argv is now built by the canonical Claude adapter (its
 * `--max-turns` backstop is also pinned unit-level in `claude-cli-adapter.spec.ts`
 * and `claude-cli-argv-builder.spec.ts`, and the worker forwarding in
 * `cli-adapter-worker-args.spec.ts`). What only this spec can pin is the whole
 * chain from the real reviewer caller: the resolved caps reach the runtime's
 * adapter creation, they survive into the argv the adapter spawns, and the
 * reviewer never leaks onto the spawn-worker proxy even with the offload
 * setting enabled.
 */
const state = vi.hoisted(() => {
  const verdict = JSON.stringify({
    correctness: { reasoning: 'ok', score: 4, issues: [] },
    completeness: { reasoning: 'ok', score: 4, issues: [] },
    security: { reasoning: 'ok', score: 4, issues: [] },
    consistency: { reasoning: 'ok', score: 4, issues: [] },
    overall_verdict: 'APPROVE', summary: 'Approved.',
  });
  const frames = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: verdict }], usage: { input_tokens: 1, output_tokens: 1 } } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: verdict, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } }),
  ].join('\n') + '\n';
  return { runtime: null as ProviderRuntimeService | null, spawns: [] as string[][], frames };
});
vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('../providers/provider-runtime-service', async importOriginal => ({
  ...await importOriginal<typeof import('../providers/provider-runtime-service')>(),
  getProviderRuntimeService: () => {
    if (!state.runtime) throw new Error('Fixture runtime missing');
    return state.runtime;
  },
}));
vi.mock('../cli/adapters/adapter-factory', async importOriginal => {
  const original = await importOriginal<typeof import('../cli/adapters/adapter-factory')>();
  return {
    ...original,
    resolveCliType: async () => 'claude',
    createCliAdapter: (cliType: Parameters<typeof original.createCliAdapter>[0], options: UnifiedSpawnOptions, executionLocation?: Parameters<typeof original.createCliAdapter>[2]) => {
      const adapter = original.createCliAdapter(cliType, options, executionLocation);
      // The real adapter owns argv building; capture what it would spawn.
      // Version/help probes the adapter may fire first answer with empty
      // output; only the dispatch spawn carries the verdict frames.
      vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ReturnType<typeof spawn> }, 'spawnProcess')
        .mockImplementation((args: string[]) => {
          state.spawns.push([...args]);
          const probe = args.includes('--help') || args.includes('--version');
          return spawn(process.execPath, ['-e', probe
            ? 'process.exit(0);'
            : `process.stdin.once('data',()=>{process.stdout.write(${JSON.stringify(state.frames)},()=>{process.exitCode=0;process.stdin.destroy();});});process.stdin.resume();`],
          { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
        });
      return adapter;
    },
  };
});
// External account/configuration seams are isolated; the real review caller,
// runtime selection, adapter factory, argument builder and parser all execute.
vi.mock('../instance/lifecycle/provider-route-preflight', () => ({
  attachProviderRoutes: async (_cli: string, options: UnifiedSpawnOptions) => options,
}));
vi.mock('../cli/adapters/account-pool/account-adapter-guards', () => ({ resolveClaudeAccountSpawnEnv: () => ({ env: {}, envRemove: [] }) }));
vi.mock('../cli/adapters/claude-env-pack', async importOriginal => ({
  ...await importOriginal<typeof import('../cli/adapters/claude-env-pack')>(),
  resolveClaudeDebugLogging: () => false,
}));
vi.mock('../cli/spawn-worker/cli-spawn-worker-gateway', () => ({ getCliSpawnWorkerGateway: () => { throw new Error('Real worker gateway forbidden by fixture'); } }));
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({ crossModelReviewModelByProvider: { claude: 'haiku' } }),
    get: () => undefined,
  }),
}));
vi.mock('../core/circuit-breaker', () => ({ getCircuitBreakerRegistry: () => ({ getBreaker: () => ({ execute: (run: () => unknown) => run() }) }) }));
vi.mock('../core/system/provider-quota-service', () => ({ getProviderQuotaService: () => ({ getSnapshot: () => null }) }));

describe('actual Claude cross-model reviewer dispatch caps and routing', () => {
  afterEach(() => {
    CrossModelReviewService._resetForTesting();
    state.runtime = null;
    state.spawns = [];
    vi.unstubAllEnvs();
  });

  it('carries the actual caller eight-turn and one-dollar caps into the spawned argv and keeps the reviewer off the spawn-worker proxy', async () => {
    vi.stubEnv('AIO_COST_ATTRIBUTION', '0');
    let handler: Parameters<CliSpawnGatewayPort['registerInstance']>[1] | undefined;
    const requests: SpawnInstanceRequest[] = [];
    const gateway: CliSpawnGatewayPort = {
      registerInstance: (_id, callbacks) => { handler = callbacks; },
      unregisterInstance: () => { handler = undefined; },
      spawnInstance: async request => { requests.push(request); return { pid: 4242 }; },
      writeStdin: async () => undefined,
      terminate: async () => undefined,
      sendSignal: () => undefined,
    };
    state.runtime = new ProviderRuntimeService({
      registry: { recordAvailable: vi.fn(), recordUnavailable: vi.fn() } as unknown as ProviderRuntimeRegistry,
      settings: { get: <K extends keyof AppSettings>(key: K): AppSettings[K] =>
        ({ ...DEFAULT_SETTINGS, enableSpawnWorkerOffload: true })[key] },
      spawnWorkerGateway: gateway,
    });
    const create = vi.spyOn(state.runtime, 'createAdapter');
    const request: ReviewDispatchRequest = {
      id: 'review-fixture', instanceId: 'fixture', primaryProvider: 'codex', workingDirectory: '/disposable-fixture',
      content: 'Updated fixture file.', taskDescription: 'Review the change', reviewDepth: 'structured', timestamp: 1,
      classification: { type: 'code', shouldReview: true, isComplex: false, complexityReasons: [],
        codeLineCount: 1, fileCount: 1, stepCount: 0 },
    };
    const service = CrossModelReviewService.getInstance() as unknown as {
      executeOneReview: (request: ReviewDispatchRequest, cli: string, timeout: number, signal: AbortSignal) => Promise<unknown>;
    };
    const result = await service.executeOneReview(request, 'claude', 30, new AbortController().signal);
    expect(result).toMatchObject({ overallVerdict: 'APPROVE' });
    expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      cliType: 'claude', options: expect.objectContaining({ maxTurns: 8, maxBudgetUsd: 1 }),
    }));
    // Phase 2 step 4g: the reviewer stays on the canonical adapter even when
    // spawn-worker offload is enabled — the proxy cannot enforce review policy.
    const adapter = create.mock.results[0].value;
    expect(adapter).toBeInstanceOf(ClaudeCliAdapter);
    expect(adapter).not.toBeInstanceOf(CliAdapterWorkerProxy);
    expect(requests).toHaveLength(0);
    expect(handler).toBeUndefined();
    // Criterion 9.7: the caller's caps survive into the argv actually spawned.
    const dispatches = state.spawns.filter(args => !args.includes('--help') && !args.includes('--version'));
    expect(dispatches).toHaveLength(1);
    const args = dispatches[0];
    expect(args.slice(args.indexOf('--max-turns'), args.indexOf('--max-turns') + 2)).toEqual(['--max-turns', '8']);
    expect(args.slice(args.indexOf('--max-budget-usd'), args.indexOf('--max-budget-usd') + 2)).toEqual(['--max-budget-usd', '1']);
  });
});
