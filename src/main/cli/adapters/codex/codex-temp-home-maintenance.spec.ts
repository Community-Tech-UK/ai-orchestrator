import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ schedule: vi.fn(), unschedule: vi.fn(), registerCleanup: vi.fn(), sweep: vi.fn() }));
vi.mock('../../../tasks/jitter-scheduler', () => ({ getJitterScheduler: () => ({ schedule: state.schedule, unschedule: state.unschedule }) }));
vi.mock('../../../util/cleanup-registry', () => ({ registerCleanup: state.registerCleanup }));
vi.mock('./codex-home-manager', () => ({ sweepStaleCodexTempHomes: state.sweep }));
import { initializeCodexTempHomeMaintenance } from './codex-temp-home-maintenance';

describe('Codex temporary-home maintenance', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it('schedules one hourly sweep and unregisters it during shutdown', () => {
    initializeCodexTempHomeMaintenance();
    initializeCodexTempHomeMaintenance();
    expect(state.schedule).toHaveBeenCalledTimes(1);
    const task = state.schedule.mock.calls[0]![0];
    expect(task).toMatchObject({ intervalMs: 60 * 60 * 1000, maxCatchUp: 1 });
    task.handler();
    expect(state.sweep).toHaveBeenCalledTimes(1);
    state.registerCleanup.mock.calls[0]![0]();
    expect(state.unschedule).toHaveBeenCalledWith('codex-temp-home-maintenance');
  });
});
