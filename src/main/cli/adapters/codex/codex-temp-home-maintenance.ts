import { getJitterScheduler } from '../../../tasks/jitter-scheduler';
import { registerCleanup } from '../../../util/cleanup-registry';
import { sweepStaleCodexTempHomes } from './codex-home-manager';

const TASK_ID = 'codex-temp-home-maintenance';
let scheduled = false;

/** The startup sweep runs in boot order; this owns its hourly follow-up. */
export function initializeCodexTempHomeMaintenance(): void {
  if (scheduled) return;
  getJitterScheduler().schedule({
    id: TASK_ID,
    name: 'Abandoned Codex temporary homes',
    intervalMs: 60 * 60 * 1000,
    jitterPercent: 10,
    maxCatchUp: 1,
    handler: () => { sweepStaleCodexTempHomes(); },
  });
  scheduled = true;
  registerCleanup(() => {
    getJitterScheduler().unschedule(TASK_ID);
    scheduled = false;
  });
}
