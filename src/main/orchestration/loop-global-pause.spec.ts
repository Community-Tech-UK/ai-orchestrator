import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { cleanupLoopCoordinatorSpec } from './loop-coordinator-test-cleanup';
import { getWorkAdmission, WorkAdmission } from '../work-admission/work-admission';

vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ defaultCli: 'claude', loopModelByProvider: {}, auxiliaryLlmRoutingClassificationEnabled: false }), get: () => undefined }) }));
vi.mock('../cli/adapters/adapter-factory', () => ({ resolveCliType: async () => 'claude' }));
vi.mock('./invocation-model-resolver', () => ({ resolveLoopChildModel: async () => 'test-model' }));

describe('global loop controls', () => {
  let coordinator: LoopCoordinator;
  let workspace: string;
  beforeEach(() => { coordinator = new LoopCoordinator(); workspace = mkdtempSync(join(tmpdir(), 'loop-global-pause-')); });
  afterEach(async () => { WorkAdmission._resetForTesting(); await cleanupLoopCoordinatorSpec({ coordinator, workspace }); }, 20_000);

  it('waits without invoking a round during Hold and runs after Release', async () => {
    const admission = getWorkAdmission();
    admission.setGlobalPhase('holding');
    let invoked = 0;
    coordinator.on('loop:invoke-iteration', () => { invoked++; });
    const config = defaultLoopConfig(workspace, 'Check held work');
    config.audit.preflightMode = 'off';
    const state = await coordinator.startLoop('chat-held', config);
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(invoked).toBe(0);
    admission.setGlobalPhase('none');
    await vi.waitFor(() => expect(invoked).toBe(1));
    await coordinator.cancelLoop(state.id);
  }, 20_000);

  it('interrupts restart-paused rounds without booking a failed iteration', async () => {
    let callback: ((result: LoopChildResult | { error: string }) => void) | undefined;
    coordinator.on('loop:invoke-iteration', (payload: unknown) => { callback = (payload as { callback: typeof callback }).callback; });
    coordinator.on('loop:pause-for-restart', () => callback?.({ error: 'interrupted by global pause' }));
    const config = defaultLoopConfig(workspace, 'Pause a working round');
    config.audit.preflightMode = 'off';
    const state = await coordinator.startLoop('chat-busy', config);
    await vi.waitFor(() => expect(callback).toBeDefined());
    await coordinator.pauseForGlobalPause(state.id);
    const paused: LoopState | undefined = coordinator.getLoop(state.id);
    expect(paused?.status).toBe('paused');
    expect(paused?.totalIterations).toBe(0);
    expect(paused?.inFlightIteration).toBeUndefined();
  }, 20_000);
});
