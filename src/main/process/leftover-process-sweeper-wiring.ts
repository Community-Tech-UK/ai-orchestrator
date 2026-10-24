/**
 * Production wiring for the leftover process sweeper: real `ps`, the instance
 * manager's view of sessions, the `leftoverProcessCleanup` setting, desktop
 * notices, and the lineage file in userData (so a post-crash launch can still
 * attribute the previous run's leftovers).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import { getSettingsManager } from '../core/config/settings-manager';
import { getNotificationService } from '../notifications/notification-service';
import { createDefaultHostProcessRuntime } from './host-process-inspector';
import {
  createInstanceManagerHostProcessHooks,
  liveSessionRoots,
  sessionOwnerState,
  type HostProcessInstanceSource,
} from './host-process-instance-hooks';
import { initLeftoverProcessSweeper, type LeftoverSweeperRuntime } from './leftover-process-sweeper';
import type { Instance } from '../../shared/types/instance.types';

const LINEAGE_FILE = 'process-lineage.json';

/** The instance manager slice the sweeper reads; names let notices say which session left a program. */
export type SweeperInstanceSource = Omit<HostProcessInstanceSource, 'getInstance'> & {
  getInstance(id: string): Pick<Instance, 'status' | 'displayName'> | undefined;
};

export function startLeftoverProcessSweeper(source: SweeperInstanceSource): void {
  const host = createDefaultHostProcessRuntime(createInstanceManagerHostProcessHooks(source));
  const lineagePath = path.join(app.getPath('userData'), LINEAGE_FILE);
  const runtime: LeftoverSweeperRuntime = {
    platform: host.platform,
    uid: host.uid,
    harnessPid: host.harnessPid,
    nowMs: () => Date.now(),
    runPs: host.runPs,
    kill: host.kill,
    getOwnerState: (instanceId) => sessionOwnerState(source, instanceId),
    getSessionName: (instanceId) => source.getInstance(instanceId)?.displayName,
    getLiveSessionRoots: () => liveSessionRoots(source),
    getLiveSessionPids: host.getLiveSessionPids,
    getMode: () => getSettingsManager().get('leftoverProcessCleanup') ?? 'stop-cpu-hogs',
    notify: (title, body) => {
      getNotificationService().notify({ kind: 'leftover-processes', title, body, urgency: 'normal' });
    },
    readLineage: () => {
      if (!fs.existsSync(lineagePath)) return null;
      return JSON.parse(fs.readFileSync(lineagePath, 'utf-8')) as unknown;
    },
    writeLineage: (data) => {
      const temporary = `${lineagePath}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(data), 'utf-8');
      fs.renameSync(temporary, lineagePath);
    },
  };
  initLeftoverProcessSweeper(runtime).start();
}
