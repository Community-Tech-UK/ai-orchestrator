import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CrossModelReviewService } from './cross-model-review-service';
import { getWorkAdmission, WorkAdmission } from '../work-admission/work-admission';
import { pauseConsults } from '../work-admission/consult-admission';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ai-orchestrator-test' }, powerMonitor: new EventEmitter() }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ crossModelReviewLocalEnabled: false, crossModelReviewProviders: [], crossModelReviewModelByProvider: {} }) }) }));
vi.mock('../pause/pause-coordinator', () => ({ getPauseCoordinator: () => ({ isPaused: () => false, on: vi.fn(), removeListener: vi.fn() }) }));

afterEach(() => { CrossModelReviewService._resetForTesting(); WorkAdmission._resetForTesting(); vi.restoreAllMocks(); });

describe('consult pause barriers', () => {
  it('tracks and cancels a headless review until its running host has stopped', async () => {
    const service = CrossModelReviewService.getInstance();
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    let finish!: () => void;
    const stopping = new Promise<void>(resolve => { finish = resolve; });
    let signal: AbortSignal | undefined;
    service.setReviewExecutionHost({ getWorkingDirectory: () => process.cwd(), getTaskDescription: () => 'Review',
      dispatchReviewerPrompt: async (_provider, _prompt, _cwd, operationSignal) => {
        signal = operationSignal; markStarted(); await stopping; operationSignal.throwIfAborted(); return '';
      } });
    const review = service.runHeadlessReview({ target: 'HEAD', cwd: process.cwd(), content: 'diff', taskDescription: 'Review', reviewers: ['gemini'] });
    await started;
    getWorkAdmission().setGlobalPhase('collecting');
    let stopped = false;
    const pausing = pauseConsults().then(() => { stopped = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    const stoppedBeforeHost = stopped;
    const abortedBeforeHost = signal?.aborted;
    finish(); await review; await pausing;
    expect(stoppedBeforeHost).toBe(false);
    expect(abortedBeforeHost).toBe(true);
  });
});
