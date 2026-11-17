/**
 * The ticket reader wired to the real settings, connection and ticket table. Kept apart from the reader so its tests
 * never load the app's singletons.
 */
import { getSettingsManager } from '../../core/config/settings-manager';
import { getPlanQueueLinearTicketStore } from '../plan-queue-linear-ticket-store-singleton';
import { getLinearConnectionService } from './linear-connection-singleton';
import { getLinearFolderLinkService } from './linear-folder-links-singleton';
import { isLinearTeamReady } from './linear-team-rules-singleton';
import type { LinearTicketReaderDependencies } from './linear-ticket-reader';

export function realLinearTicketReaderDependencies(): LinearTicketReaderDependencies {
  return {
    readFolder: (folder) => getLinearFolderLinkService().readForFolder(folder),
    isTeamReady: isLinearTeamReady,
    readTeams: () => getSettingsManager().getAll().planQueueLinearTeams ?? [],
    connectionReason: () => getLinearConnectionService().reasonToHold(),
    isHeldByUnfinishedRun: (linearId) => getPlanQueueLinearTicketStore()?.findUnfinishedItem(linearId) !== undefined,
    landedAt: (linearId) => getPlanQueueLinearTicketStore()?.findLatestLandedItem(linearId)?.landedAt ?? null,
  };
}
