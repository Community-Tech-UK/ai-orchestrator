import { describe, expect, it } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG, PlanQueueRouteChoiceSchema, PlanQueueStartArgsSchema } from '@contracts/schemas/plan-queue';
import type { InstanceCreateConfig } from '../../shared/types/instance.types';
import { assertRouteChoice, defaultPlanQueueRoutingDeps, describeRouteChoice, routeChoiceFromArgs, routeQueueSpawn } from './plan-queue-routing';
import { resolveSpawnReasoningEffort } from '../instance/lifecycle/reasoning-effort-resolution';
import type { PlanQueueRun } from './plan-queue.types';
import { selectPlanQueueVerifier } from './plan-queue-verifier-select';

describe('Plan Queue thinking levels', () => {
  it('refuses effort that a provider would silently ignore or remap', () => {
    const deps = { ...defaultPlanQueueRoutingDeps(), isProviderExcluded: () => false,
      readAccountRules: () => ({ never: [], last: [] }), poolProfiles: () => [], copilotProfiles: () => [] };
    for (const [provider, reasoningEffort] of [['codex', 'workflow'], ['claude', 'none'], ['opencode', 'high']] as const) {
      expect(() => assertRouteChoice({ provider, reasoningEffort }, 'worker', deps)).toThrow('thinking level');
    }
  });
  it.each(['high', null] as const)('retains checker effort %s through selection and the verification spawn route', async effort => {
    const choice = PlanQueueRouteChoiceSchema.parse({ provider: 'claude', model: 'sonnet', reasoningEffort: effort });
    const selected = await selectPlanQueueVerifier({ workerProvider: 'codex', workingDirectory: '/repo', choices: [choice] }, {
      listInstalledProviders: async () => ['claude', 'codex'], isProviderExcluded: () => false,
      classifyScope: () => ({ kind: 'none' }), accountRules: { readAccountRules: () => ({ never: [], last: [] }),
        poolProfiles: () => [], copilotProfiles: () => [], copilotProfileFor: () => null },
    });
    expect(selected).toEqual({ ok: true, choice: { provider: 'claude', modelOverride: 'sonnet', reasoningEffort: effort } });
    if (!selected.ok) throw new Error('Checker selection failed');
    const config: InstanceCreateConfig = { displayName: 'checker', workingDirectory: '/repo', reasoningEffort: selected.choice.reasoningEffort,
      metadata: { planQueueRole: 'verifier', planQueueRunId: 'run' } };
    expect(routeQueueSpawn(config, () => null, null, () => false, { never: [], last: [] }).reasoningEffort).toBe(effort);
  });
  it('accepts and maps effort from the advertised MCP route contract', () => {
    const args = PlanQueueStartArgsSchema.parse({ kind: 'plans', workers: [{ provider: 'claude', effort: 'low' }] });
    const choice = routeChoiceFromArgs(args.workers![0]);
    expect(choice).toEqual({ provider: 'claude', reasoningEffort: 'low' });
    expect(PlanQueueRouteChoiceSchema.parse(choice)).toEqual(choice);
    expect(PlanQueueRouteChoiceSchema.safeParse({ provider: 'claude', reasoningEffort: 'invented' }).success).toBe(false);
    expect(describeRouteChoice(choice)).toContain('thinking: low');
    const defaults = PlanQueueStartArgsSchema.parse({ kind: 'plans', workers: [{ provider: 'claude', effort: null }] });
    expect(routeChoiceFromArgs(defaults.workers![0])).toEqual({ provider: 'claude', reasoningEffort: null });
    expect(describeRouteChoice({ provider: 'claude', reasoningEffort: null })).toContain('thinking: provider default');
  });

  it('replaces stale effort and preserves legacy defaults while allowing explicit provider default', () => {
    const config: InstanceCreateConfig = { displayName: 'queue fixture', workingDirectory: '/repo',
      reasoningEffort: 'max', metadata: { planQueueRole: 'worker', planQueueRunId: 'run' } };
    const run: PlanQueueRun = { id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans',
      workspaceCwd: '/repo', status: 'running', config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, routing: { workers: [], verifiers: [] } },
      relaxation: null, workerProvider: 'claude', workerModel: null, startedAt: 1, endedAt: null };
    const choice = PlanQueueRouteChoiceSchema.parse({ provider: 'claude', reasoningEffort: 'low' });
    const route = (worker: typeof choice) => routeQueueSpawn(config, () => run, worker, () => false, { never: [], last: [] });
    expect(route(choice).reasoningEffort).toBe('low');
    expect(resolveSpawnReasoningEffort(route({ provider: 'claude' }), 'claude')).toBe('high');
    const providerDefault = PlanQueueRouteChoiceSchema.parse({ provider: 'claude', reasoningEffort: null });
    expect(resolveSpawnReasoningEffort(route(providerDefault), 'claude')).toBeUndefined();
    expect(config.reasoningEffort).toBe('max');
  });
});
