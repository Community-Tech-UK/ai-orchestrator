/**
 * The app's one Start preview service, wired to the real settings, connection and ticket table. Kept apart from the
 * service so its tests never load the app's singletons.
 */
import { getSettingsManager } from '../../core/config/settings-manager';
import { planQueueProviderChoices } from '../plan-queue-routing';
import { LinearPreviewService } from './linear-preview';
import { readDiscoveryForFolder } from './linear-ticket-reader';
import { realLinearTicketReaderDependencies } from './linear-ticket-reader-singleton';
import { readTicketText } from './linear-ticket-text';

let instance: LinearPreviewService | null = null;

export function getLinearPreviewService(): LinearPreviewService {
  instance ??= new LinearPreviewService({
    discover: (folder, counter) => readDiscoveryForFolder(folder, counter, realLinearTicketReaderDependencies()),
    readText: (identifier, counter) => readTicketText(identifier, counter),
    readTeams: () => getSettingsManager().getAll().planQueueLinearTeams ?? [],
    providerLabel: (id) => planQueueProviderChoices().find((provider) => provider.id === id)?.label ?? id,
    now: () => Date.now(),
  });
  return instance;
}

export function _resetLinearPreviewServiceForTesting(): void {
  instance?._resetForTesting();
  instance = null;
}
