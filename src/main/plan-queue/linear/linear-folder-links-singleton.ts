/**
 * The app's one folder-link service, wired to the real settings. Kept apart from the service so its tests never load the
 * app's singletons. Saves go through the settings manager, which checks the key's schema again.
 */
import { getSettingsManager } from '../../core/config/settings-manager';
import { LinearFolderLinkService, realLinearFolderLinkDependencies } from './linear-folder-links';

let instance: LinearFolderLinkService | null = null;

export function getLinearFolderLinkService(): LinearFolderLinkService {
  instance ??= new LinearFolderLinkService(realLinearFolderLinkDependencies({
    readLinks: () => getSettingsManager().getAll().planQueueLinearFolderLinks ?? [],
    saveLinks: (links) => {
      getSettingsManager().set('planQueueLinearFolderLinks', links);
    },
  }));
  return instance;
}

export function _resetLinearFolderLinkServiceForTesting(): void {
  instance = null;
}
