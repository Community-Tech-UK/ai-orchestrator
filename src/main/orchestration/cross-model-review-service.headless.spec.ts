import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CrossModelReviewService } from './cross-model-review-service';
import type { ReviewExecutionHost } from '../review/review-execution-host';
import type { ReviewResult } from '../../shared/types/cross-model-review.types';
import type { ProviderQuotaSnapshot } from '../../shared/types/provider-quota.types';
import type { LocalReviewerLimits } from '../review/local-reviewer';

const localReviewState = vi.hoisted(() => ({
  enabled: false,
  selectorId: '',
  qualityModel: '',
  modelByProvider: {} as Record<string, string>,
  quotaSnapshot: null as ProviderQuotaSnapshot | null,
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../util/cleanup-registry', () => ({
  registerCleanup: vi.fn(),
}));

vi.mock('../pause/pause-coordinator', () => ({
  getPauseCoordinator: () => ({
    isPaused: () => false,
    on: vi.fn(),
    removeListener: vi.fn(),
  }),
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({
      crossModelReviewEnabled: true,
      crossModelReviewDepth: 'structured',
      crossModelReviewMaxReviewers: 2,
      crossModelReviewProviders: [],
      crossModelReviewTimeout: 30,
      crossModelReviewTypes: ['code', 'plan', 'architecture'],
      crossModelReviewModelByProvider: localReviewState.modelByProvider,
      crossModelReviewLocalEnabled: localReviewState.enabled,
      crossModelReviewLocalSelectorId: localReviewState.selectorId,
      crossModelReviewLocalTimeout: 120,
      crossModelReviewLocalMaxToolRounds: 12,
      auxiliaryLlmQualityModel: localReviewState.qualityModel,
    }),
  }),
}));

vi.mock('../core/system/provider-quota-service', () => ({
  getProviderQuotaService: () => ({ getSnapshot: () => localReviewState.quotaSnapshot }),
}));

vi.mock('../cli/cli-detection', () => ({
  CliDetectionService: {
    getInstance: () => ({
      detectAll: vi.fn().mockResolvedValue({ available: [] }),
    }),
  },
}));

function reviewerJson(issue: string): string {
  return JSON.stringify({
    correctness: { reasoning: 'The diff misses a null guard.', score: 2, issues: [issue] },
    completeness: { reasoning: 'ok', score: 4, issues: [] },
    security: { reasoning: 'ok', score: 4, issues: [] },
    consistency: { reasoning: 'ok', score: 4, issues: [] },
    overall_verdict: 'CONCERNS',
    summary: 'One correctness concern.',
  });
}

// An existing directory — the headless path validates cwd before dispatch,
// so fake paths like '/repo' would silently fall back to process.cwd().
const REPO_CWD = process.cwd();
const MISSING_REMOTE_WINDOWS_CWD = 'C:\\__aio_missing_remote_node_workspace__\\repo';

describe('CrossModelReviewService headless review', () => {
  beforeEach(() => {
    CrossModelReviewService._resetForTesting();
    localReviewState.enabled = false;
    localReviewState.selectorId = '';
    localReviewState.qualityModel = '';
    localReviewState.modelByProvider = {};
    localReviewState.quotaSnapshot = null;
  });

  it('runs reviewers through a narrow host without an InstanceManager', async () => {
    const dispatchReviewerPrompt = vi.fn(async (provider: string) => {
      if (provider === 'codex') {
        throw new Error('CLI unavailable');
      }
      return reviewerJson('Add a null check before reading payload.value.');
    });
    const host: ReviewExecutionHost = {
      getWorkingDirectory: () => REPO_CWD,
      getTaskDescription: () => 'Review the local diff.',
      dispatchReviewerPrompt,
    };
    const service = CrossModelReviewService.getInstance();
    service.setReviewExecutionHost(host);

    const result = await service.runHeadlessReview({
      target: 'HEAD',
      cwd: REPO_CWD,
      content: 'diff --git a/src/handler.ts b/src/handler.ts',
      taskDescription: 'Review the local diff.',
      reviewers: ['gemini', 'codex'],
      timeoutSeconds: 30,
    });

    expect(dispatchReviewerPrompt).toHaveBeenCalledWith(
      'antigravity',
      expect.stringContaining('Review the local diff.'),
      REPO_CWD,
      expect.any(AbortSignal),
    );
    expect(result.reviewers).toEqual([
      { provider: 'antigravity', status: 'used' },
      { provider: 'codex', status: 'failed', reason: 'CLI unavailable' },
    ]);
    expect(result.findings).toContainEqual(expect.objectContaining({
      title: 'antigravity correctness concern',
      body: 'Add a null check before reading payload.value.',
      severity: 'medium',
    }));
    expect(result.infrastructureErrors).toEqual([]);
  });

  it('normalizes explicit headless reviewers and excludes the default Claude builder', async () => {
    const dispatchReviewerPrompt = vi.fn(async () => reviewerJson('finding'));
    const service = CrossModelReviewService.getInstance();
    service.setReviewExecutionHost({
      getWorkingDirectory: () => REPO_CWD,
      getTaskDescription: () => 'Review',
      dispatchReviewerPrompt,
    });

    const result = await service.runHeadlessReview({
      target: 'HEAD',
      cwd: REPO_CWD,
      content: 'diff',
      taskDescription: 'Review',
      reviewers: ['claude', 'gemini', 'antigravity'],
    });

    expect(dispatchReviewerPrompt).toHaveBeenCalledTimes(1);
    expect(dispatchReviewerPrompt).toHaveBeenCalledWith(
      'antigravity',
      expect.any(String),
      REPO_CWD,
      expect.any(AbortSignal),
    );
    expect(result.reviewers).toEqual([
      { provider: 'antigravity', status: 'used' },
    ]);
  });

  it('excludes the builder from explicit reviewers after provider alias normalization', async () => {
    const dispatchReviewerPrompt = vi.fn(async () => reviewerJson('finding'));
    const service = CrossModelReviewService.getInstance();
    service.setReviewExecutionHost({
      getWorkingDirectory: () => REPO_CWD,
      getTaskDescription: () => 'Review',
      dispatchReviewerPrompt,
    });

    const result = await service.runHeadlessReview({
      target: 'HEAD',
      cwd: REPO_CWD,
      content: 'diff',
      taskDescription: 'Review',
      primaryProvider: 'gemini',
      reviewers: ['gemini', 'antigravity', 'codex'],
    });

    expect(dispatchReviewerPrompt).toHaveBeenCalledTimes(1);
    expect(dispatchReviewerPrompt).toHaveBeenCalledWith(
      'codex', expect.any(String), REPO_CWD, expect.any(AbortSignal),
    );
    expect(result.reviewers).toEqual([{ provider: 'codex', status: 'used' }]);
  });

  it('truncates an oversized payload before dispatching to the reviewer', async () => {
    // A long loop's cumulative git diff can be hundreds of KB. Shipping it raw
    // overflows the reviewer CLI's context and yields unparseable output. The
    // headless path must bound the payload like the in-session path does.
    let dispatchedPrompt = '';
    const dispatchReviewerPrompt = vi.fn(async (_provider: string, prompt: string) => {
      dispatchedPrompt = prompt;
      return reviewerJson('finding');
    });
    const service = CrossModelReviewService.getInstance();
    service.setReviewExecutionHost({
      getWorkingDirectory: () => '/repo',
      getTaskDescription: () => 'Review',
      dispatchReviewerPrompt,
    });

    const hugeDiff = 'x'.repeat(200_000);
    await service.runHeadlessReview({
      target: 'HEAD',
      cwd: '/repo',
      content: hugeDiff,
      taskDescription: 'Review',
      reviewers: ['gemini'],
    });

    // The 200k-char payload must not be forwarded whole.
    expect(dispatchedPrompt.length).toBeLessThan(hugeDiff.length);
    expect(dispatchedPrompt).toContain('truncated');
  });

  it('redacts a secret-bearing diff before dispatch and surfaces it as a blocking finding', async () => {
    let dispatchedPrompt = '';
    const service = CrossModelReviewService.getInstance();
    service.setReviewExecutionHost({
      getWorkingDirectory: () => REPO_CWD,
      getTaskDescription: () => 'Review',
      dispatchReviewerPrompt: vi.fn(async (_provider: string, prompt: string) => {
        dispatchedPrompt = prompt;
        return reviewerJson('The implementation looks sound.');
      }),
    });
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD';

    const result = await service.runHeadlessReview({
      target: 'HEAD',
      cwd: REPO_CWD,
      content: `diff --git a/.env b/.env\n@@ -1 +1 @@\n+GITHUB_TOKEN=${token}`,
      taskDescription: 'Review',
      reviewers: ['gemini'],
    });

    expect(dispatchedPrompt).toContain('+[REDACTED — potential secret]');
    expect(dispatchedPrompt).not.toContain(token);
    expect(result.findings).toContainEqual(expect.objectContaining({
      title: 'Potential secret redacted before external review',
      severity: 'critical',
      confidence: 1,
    }));
  });

  it('reports the response length when a reviewer returns unparseable output', async () => {
    const service = CrossModelReviewService.getInstance();
    service.setReviewExecutionHost({
      getWorkingDirectory: () => '/repo',
      getTaskDescription: () => 'Review',
      dispatchReviewerPrompt: vi.fn(async () => 'I think this looks fine to me, ship it!'),
    });

    const result = await service.runHeadlessReview({
      target: 'HEAD',
      cwd: '/repo',
      content: 'diff',
      taskDescription: 'Review',
      reviewers: ['gemini'],
    });

    expect(result.reviewers).toEqual([
      { provider: 'antigravity', status: 'failed', reason: expect.stringContaining('unparseable output') },
    ]);
    expect(result.reviewers[0].reason).toMatch(/\d+ chars/);
    expect(result.infrastructureErrors).toHaveLength(1);
  });

  it('falls back from Sonnet to GPT-OSS for a headless review after Gemini quota is exhausted', async () => {
    localReviewState.modelByProvider = { antigravity: 'Gemini 3.5 Flash (Medium)' };
    localReviewState.quotaSnapshot = {
      provider: 'antigravity',
      takenAt: Date.now(),
      source: 'admin-api',
      ok: true,
      windows: [
        {
          kind: 'rolling-window', id: 'antigravity.gemini-5h', label: 'Gemini · 5-hour',
          unit: 'requests', used: 100, limit: 100, remaining: 0, resetsAt: null,
        },
        {
          kind: 'rolling-window', id: 'antigravity.3p-5h', label: 'Claude/GPT · 5-hour',
          unit: 'requests', used: 0, limit: 100, remaining: 100, resetsAt: null,
        },
      ],
    };
    const dispatchReviewerPrompt = vi.fn(async (
      _provider: string,
      _prompt: string,
      _cwd: string,
      _signal: AbortSignal,
      options?: { modelOverride?: string },
    ) => options?.modelOverride === 'GPT-OSS 120B (Medium)'
      ? reviewerJson('GPT-OSS found the missing null guard.')
      : 'not valid json');
    const service = CrossModelReviewService.getInstance();
    service.setReviewExecutionHost({
      getWorkingDirectory: () => REPO_CWD,
      getTaskDescription: () => 'Review',
      dispatchReviewerPrompt,
    });

    const result = await service.runHeadlessReview({
      target: 'HEAD', cwd: REPO_CWD, content: 'diff', taskDescription: 'Review', reviewers: ['antigravity'],
    });

    expect(dispatchReviewerPrompt).toHaveBeenCalledTimes(2);
    expect(dispatchReviewerPrompt.mock.calls.map((call) => call[4]?.modelOverride)).toEqual([
      'Claude Sonnet 4.6 (Thinking)',
      'GPT-OSS 120B (Medium)',
    ]);
    expect(result.reviewers).toEqual([{ provider: 'antigravity', status: 'used' }]);
  });

  it('validates the cwd before dispatch and falls back to process.cwd() for a missing path', async () => {
    const dispatchReviewerPrompt = vi.fn(async () => reviewerJson('finding'));
    const service = CrossModelReviewService.getInstance();
    service.setReviewExecutionHost({
      getWorkingDirectory: () => undefined,
      getTaskDescription: () => 'Review',
      dispatchReviewerPrompt,
    });

    const result = await service.runHeadlessReview({
      target: 'HEAD',
      // A remote-node Windows path — does not exist on this machine. Spawning
      // a reviewer CLI with it would fail with `spawn <cli> ENOENT`.
      cwd: MISSING_REMOTE_WINDOWS_CWD,
      content: 'diff',
      taskDescription: 'Review',
      reviewers: ['gemini'],
    });

    expect(dispatchReviewerPrompt).toHaveBeenCalledWith(
      'antigravity',
      expect.any(String),
      process.cwd(),
      expect.any(AbortSignal),
    );
    expect(result.cwd).toBe(process.cwd());
    expect(result.reviewers).toEqual([{ provider: 'antigravity', status: 'used' }]);
  });

  it('returns stable JSON-shaped results when no reviewers are available', async () => {
    const service = CrossModelReviewService.getInstance();
    service.setReviewExecutionHost({
      getWorkingDirectory: () => '/repo',
      getTaskDescription: () => 'Review',
      dispatchReviewerPrompt: vi.fn(),
    });

    const result = await service.runHeadlessReview({
      target: 'HEAD',
      cwd: '/repo',
      content: 'diff',
      taskDescription: 'Review',
      reviewers: [],
    });

    expect(result.reviewers).toEqual([]);
    expect(result.findings).toEqual([]);
    expect(result.infrastructureErrors).toEqual([]);
    expect(result.summary).toContain('No reviewers available');
  });

  it('surfaces a local-only headless finding as advisory when zero remote reviewers run', async () => {
    const selectorId = 'lm://this-device/ollama/ollama/qwen';
    localReviewState.enabled = true;
    localReviewState.selectorId = '';
    localReviewState.qualityModel = 'qwen';
    const localReview: ReviewResult = {
      reviewerId: 'local:qwen',
      source: 'local',
      reviewType: 'structured',
      scores: {
        correctness: { reasoning: 'missing guard', score: 2, issues: ['payload value lacks a null guard'] },
        completeness: { reasoning: 'ok', score: 4, issues: [] },
        security: { reasoning: 'ok', score: 4, issues: [] },
        consistency: { reasoning: 'ok', score: 4, issues: [] },
      },
      overallVerdict: 'CONCERNS',
      summary: 'One concern.',
      timestamp: 1,
      durationMs: 1,
      parseSuccess: true,
    };
    const service = CrossModelReviewService.getInstance();
    service.setLocalReviewDependenciesForTesting(
      { review: vi.fn().mockResolvedValue({ status: 'used', review: localReview, evidencePaths: ['src/a.ts'] }) },
      { list: () => [{
        selectorId,
        source: 'this-device',
        endpointProvider: 'ollama',
        endpointId: 'ollama',
        modelId: 'qwen',
        displayName: 'Qwen',
        healthy: true,
        loaded: true,
        capabilities: { streaming: true, multiTurn: true, toolUse: 'verified', vision: 'unknown' },
        discoveredAt: 1,
      }] },
    );

    const result = await service.runHeadlessReview({
      target: 'HEAD',
      cwd: REPO_CWD,
      content: 'diff',
      taskDescription: 'Review',
      reviewers: [],
    });

    expect(result.reviewers).toEqual([expect.objectContaining({
      provider: 'local-model',
      source: 'local',
      status: 'used',
      selectorId,
    })]);
    expect(result.findings).toEqual([expect.objectContaining({
      reviewers: ['local:qwen'],
      agreementCount: 1,
      advisory: true,
    })]);
    expect(result.infrastructureErrors).toEqual(['No remote reviewers completed.']);
  });

  it('visibly skips automatic quality fallback when only cloud, worker, or unhealthy matches exist', async () => {
    localReviewState.enabled = true;
    localReviewState.selectorId = '';
    localReviewState.qualityModel = 'qwen';
    const review = vi.fn();
    const service = CrossModelReviewService.getInstance();
    service.setLocalReviewDependenciesForTesting(
      { review },
      { list: () => [
        {
          selectorId: 'lm://this-device/ollama/ollama/qwen%3Acloud', source: 'this-device',
          endpointProvider: 'ollama', endpointId: 'ollama', modelId: 'qwen:cloud',
          displayName: 'Qwen Cloud', healthy: true, loaded: false,
          capabilities: { streaming: true, multiTurn: true, toolUse: 'none', vision: 'unknown' }, discoveredAt: 1,
        },
        {
          selectorId: 'lm://worker-node/node-1/ollama/ollama/qwen', source: 'worker-node', nodeId: 'node-1',
          endpointProvider: 'ollama', endpointId: 'ollama', modelId: 'qwen',
          displayName: 'Qwen Worker', healthy: true, loaded: true,
          capabilities: { streaming: true, multiTurn: true, toolUse: 'verified', vision: 'unknown' }, discoveredAt: 1,
        },
        {
          selectorId: 'lm://this-device/ollama/ollama/qwen%3A32b', source: 'this-device',
          endpointProvider: 'ollama', endpointId: 'ollama', modelId: 'qwen:32b',
          displayName: 'Qwen Offline', healthy: false, loaded: false,
          capabilities: { streaming: true, multiTurn: true, toolUse: 'verified', vision: 'unknown' }, discoveredAt: 1,
        },
      ] },
    );

    const result = await service.runHeadlessReview({
      target: 'HEAD', cwd: REPO_CWD, content: 'diff', taskDescription: 'Review', reviewers: [],
    });

    expect(review).not.toHaveBeenCalled();
    expect(result.reviewers).toEqual([expect.objectContaining({
      provider: 'local-model',
      status: 'skipped',
      reason: expect.stringContaining('quality'),
    })]);
  });

  it('keeps a remote headless result when the local pass fails', async () => {
    const selectorId = 'lm://this-device/ollama/ollama/qwen';
    localReviewState.enabled = true;
    localReviewState.selectorId = selectorId;
    const service = CrossModelReviewService.getInstance();
    service.setReviewExecutionHost({
      getWorkingDirectory: () => REPO_CWD,
      getTaskDescription: () => 'Review',
      dispatchReviewerPrompt: vi.fn(async () => reviewerJson('remote finding')),
    });
    service.setLocalReviewDependenciesForTesting(
      { review: vi.fn().mockResolvedValue({ status: 'failed', reason: 'Local parse failed.' }) },
      { list: () => [{
        selectorId,
        source: 'this-device',
        endpointProvider: 'ollama',
        endpointId: 'ollama',
        modelId: 'qwen',
        displayName: 'Qwen',
        healthy: true,
        loaded: true,
        capabilities: { streaming: true, multiTurn: true, toolUse: 'verified', vision: 'unknown' },
        discoveredAt: 1,
      }] },
    );

    const result = await service.runHeadlessReview({
      target: 'HEAD', cwd: REPO_CWD, content: 'diff', taskDescription: 'Review', reviewers: ['codex'],
    });

    expect(result.reviewers).toEqual([
      { provider: 'codex', status: 'used' },
      expect.objectContaining({ provider: 'local-model', status: 'failed', reason: 'Local parse failed.' }),
    ]);
    expect(result.findings).toEqual([expect.objectContaining({ advisory: false })]);
    expect(result.infrastructureErrors).toEqual([]);
  });

  it('reports infrastructure failure when local fails and no remote reviewer completes', async () => {
    const selectorId = 'lm://this-device/ollama/ollama/qwen';
    localReviewState.enabled = true;
    localReviewState.selectorId = selectorId;
    const service = CrossModelReviewService.getInstance();
    service.setLocalReviewDependenciesForTesting(
      { review: vi.fn().mockResolvedValue({ status: 'failed', reason: 'Local parse failed.' }) },
      { list: () => [{
        selectorId,
        source: 'this-device',
        endpointProvider: 'ollama',
        endpointId: 'ollama',
        modelId: 'qwen',
        displayName: 'Qwen',
        healthy: true,
        loaded: true,
        capabilities: { streaming: true, multiTurn: true, toolUse: 'verified', vision: 'unknown' },
        discoveredAt: 1,
      }] },
    );

    const result = await service.runHeadlessReview({
      target: 'HEAD', cwd: REPO_CWD, content: 'diff', taskDescription: 'Review', reviewers: [],
    });

    expect(result.reviewers).toEqual([expect.objectContaining({
      provider: 'local-model', status: 'failed', reason: 'Local parse failed.',
    })]);
    expect(result.infrastructureErrors).toEqual([
      'local-model: Local parse failed.',
      'No remote reviewers completed.',
    ]);
    expect(result.summary).toBe('Headless review failed before any reviewer completed.');
  });

  it('bridges external cancellation into the local reviewer and removes the listener', async () => {
    const selectorId = 'lm://this-device/ollama/ollama/qwen';
    localReviewState.enabled = true;
    localReviewState.selectorId = selectorId;
    const external = new AbortController();
    const removeListener = vi.spyOn(external.signal, 'removeEventListener');
    const review = vi.fn((_request, _target, limits: LocalReviewerLimits) =>
      new Promise<{ status: 'failed'; reason: string }>((resolve) => {
        limits.signal!.addEventListener('abort', () => {
          resolve({ status: 'failed', reason: 'Local review cancelled.' });
        }, { once: true });
      }),
    );
    const service = CrossModelReviewService.getInstance();
    service.setLocalReviewDependenciesForTesting(
      { review },
      { list: () => [{
        selectorId,
        source: 'this-device',
        endpointProvider: 'ollama',
        endpointId: 'ollama',
        modelId: 'qwen',
        displayName: 'Qwen',
        healthy: true,
        loaded: true,
        capabilities: { streaming: true, multiTurn: true, toolUse: 'verified', vision: 'unknown' },
        discoveredAt: 1,
      }] },
    );

    const pending = service.runHeadlessReview({
      target: 'HEAD', cwd: REPO_CWD, content: 'diff', taskDescription: 'Review',
      reviewers: [], signal: external.signal,
    });
    await vi.waitFor(() => expect(review).toHaveBeenCalledOnce());
    external.abort();

    await expect(pending).resolves.toMatchObject({
      reviewers: [expect.objectContaining({ source: 'local', status: 'failed' })],
    });
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('passes an already-aborted external signal into local review as pre-aborted', async () => {
    const selectorId = 'lm://this-device/ollama/ollama/qwen';
    localReviewState.enabled = true;
    localReviewState.selectorId = selectorId;
    const external = new AbortController();
    external.abort('paused');
    const review = vi.fn((_request, _target, limits: LocalReviewerLimits) => {
      expect(limits.signal!.aborted).toBe(true);
      expect(limits.signal!.reason).toBe('paused');
      return Promise.resolve({ status: 'failed' as const, reason: 'Local review cancelled.' });
    });
    const service = CrossModelReviewService.getInstance();
    service.setLocalReviewDependenciesForTesting(
      { review },
      { list: () => [{
        selectorId,
        source: 'this-device',
        endpointProvider: 'ollama',
        endpointId: 'ollama',
        modelId: 'qwen',
        displayName: 'Qwen',
        healthy: true,
        loaded: true,
        capabilities: { streaming: true, multiTurn: true, toolUse: 'verified', vision: 'unknown' },
        discoveredAt: 1,
      }] },
    );

    await service.runHeadlessReview({
      target: 'HEAD', cwd: REPO_CWD, content: 'diff', taskDescription: 'Review',
      reviewers: [], signal: external.signal,
    });

    expect(review).toHaveBeenCalledOnce();
  });
});
