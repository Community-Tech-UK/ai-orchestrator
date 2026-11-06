import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { CliMessage, CliResponse } from '../../cli/adapters/base-cli-adapter';
import type { UnifiedSpawnOptions } from '../../cli/adapters/adapter-factory.types';
const observed = vi.hoisted(() => ({ args: [] as string[][], messages: [] as CliMessage[], options: [] as UnifiedSpawnOptions[] }));
vi.mock('../../cli/adapters/claude-cli-adapter', async importOriginal => {
    const actual = await importOriginal<typeof import('../../cli/adapters/claude-cli-adapter')>();
    class InertClaude extends actual.ClaudeCliAdapter {
        override async sendMessage(message: CliMessage): Promise<CliResponse> {
            observed.args.push(this.buildArgs(message)); observed.messages.push(message);
            return { id: 'inert-review-response', role: 'assistant', content: 'Inert synthesis', usage: { inputTokens: 10, outputTokens: 2, cost: 0.01 } };
        }
        override async terminate(): Promise<void> {}
    }
    return { ...actual, ClaudeCliAdapter: InertClaude };
});
vi.mock('../../cli/adapters/adapter-factory', async importOriginal => {
    const actual = await importOriginal<typeof import('../../cli/adapters/adapter-factory')>();
    return { ...actual, resolveCliType: vi.fn(async () => 'claude') };
});
vi.mock('../../instance/lifecycle/copilot-route-preflight', () => ({ attachCopilotRoute: async (_provider: string, options: UnifiedSpawnOptions) => options }));
vi.mock('../../instance/lifecycle/account-route-preflight', () => ({ attachAccountRoute: async (_provider: string, options: UnifiedSpawnOptions) => options }));
vi.mock('../../cli/adapters/account-pool/account-adapter-guards', async importOriginal => {
    const actual = await importOriginal<typeof import('../../cli/adapters/account-pool/account-adapter-guards')>();
    return { ...actual, resolveClaudeAccountSpawnEnv: () => ({ env: {}, envRemove: [] }) };
});
vi.mock('../../core/config/settings-manager', () => ({ getSettingsManager: () => ({ get: () => undefined, getAll: () => ({ defaultCli: 'claude' }) }) }));
vi.mock('../verification-cache', () => ({ getVerificationCache: () => ({ hashPrompt: (s: string) => s, getCached: async () => null, cache: async () => undefined }) }));
vi.mock('../embedding-service', () => ({ getEmbeddingService: () => ({ clusterResponses: async () => [] }) }));
vi.mock('../confidence-analyzer', () => ({ getConfidenceAnalyzer: () => ({ findExplicitConfidence: () => 0.8 }) }));
import { ClaudeCliAdapter } from '../../cli/adapters/claude-cli-adapter';
import { createCliAdapter } from '../../cli/adapters/adapter-factory';
import { ProviderRuntimeService, getProviderRuntimeService, _resetProviderRuntimeServiceForTesting } from '../../providers/provider-runtime-service';
import { invokeProviderOneShot } from '../../compare/council-provider-invoke';
import { MultiVerifyCoordinator } from '../multi-verify-coordinator';
import type { VerificationResult } from '../../../shared/types/verification.types';
function assertReadOnly(args: string[]) {
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,ToolSearch,Skill');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--allowedTools');
}
beforeEach(() => { observed.args.length = 0; observed.messages.length = 0; observed.options.length = 0; MultiVerifyCoordinator._resetForTesting(); _resetProviderRuntimeServiceForTesting(); });
afterEach(() => { MultiVerifyCoordinator._resetForTesting(); _resetProviderRuntimeServiceForTesting(); vi.restoreAllMocks(); });
describe('actual reviewer producers through runtime, factory and Claude argv', () => {
    it.each(['council', 'compare'] as const)('%s limits Claude tools while preserving prompt and budget', async purpose => {
        const runtime = new ProviderRuntimeService({ createAdapter: input => { observed.options.push(input.options); return createCliAdapter(input.cliType, input.options); } });
        const result = await invokeProviderOneShot({ resolveProvider: async () => 'claude', createAdapter: (cliType, options) => runtime.createAdapter({ cliType, options }), now: () => 1000 }, 'claude', 'Review this inert material', { purpose, workingDirectory: '/tmp' });
        expect(result).toMatchObject({ ok: true, answer: 'Inert synthesis', usage: { cost: 0.01 } });
        expect(observed.messages).toEqual([{ role: 'user', content: 'Review this inert material' }]);
        expect(observed.options[0]).toMatchObject({ yoloMode: false, timeout: 60000, maxBudgetUsd: 1, machineSession: expect.any(String) });
        expect(observed.args).toHaveLength(1);
        assertReadOnly(observed.args[0]);
    });
    it('multi-verify merge limits Claude tools through its actual public producer', async () => {
        const runtime = getProviderRuntimeService();
        const create = runtime.createAdapter.bind(runtime);
        vi.spyOn(runtime, 'createAdapter').mockImplementation(input => { observed.options.push(input.options); return create(input); });
        const coordinator = MultiVerifyCoordinator.getInstance();
        coordinator.on('verification:invoke-agent', (payload: { callback: (error: string | null, response?: string, tokens?: number, cost?: number) => void }) => payload.callback(null, 'Overall Confidence: 80%', 2, 0));
        const complete = new Promise<VerificationResult>((resolve, reject) => { coordinator.once('verification:completed', resolve); coordinator.once('verification:error', ({ error }: { error: Error }) => reject(error)); });
        await coordinator.startVerification('inert-review-parent', 'Review this question', { agentCount: 2, timeout: 5000, synthesisStrategy: 'merge', useSemanticClustering: false });
        expect((await complete).synthesizedResponse).toBe('Inert synthesis');
        expect(observed.options[0]).toMatchObject({ timeout: 300000, maxBudgetUsd: 1, yoloMode: false, machineSession: expect.any(String) });
        expect(observed.messages[0].content).toContain('Review this question');
        expect(observed.args).toHaveLength(1);
        assertReadOnly(observed.args[0]);
    });
    it('ordinary Claude factory callers retain acceptEdits', async () => {
        const adapter = createCliAdapter('claude', { workingDirectory: '/tmp', yoloMode: false });
        if (!(adapter instanceof ClaudeCliAdapter)) throw new Error('Expected inert Claude adapter');
        await adapter.sendMessage({ role: 'user', content: 'Ordinary inert work' });
        expect(observed.args[0][observed.args[0].indexOf('--permission-mode') + 1]).toBe('acceptEdits');
        expect(observed.args[0]).not.toContain('--tools');
    });
});
