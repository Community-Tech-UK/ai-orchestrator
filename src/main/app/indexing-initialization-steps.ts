import { getSettingsManager } from '../core/config/settings-manager';
import { getRecentDirectoriesManager } from '../core/config/recent-directories-manager';
import { getCodememPrewarmCoordinator } from '../codemem';
import { getCodebaseIndexingAutoCoordinator } from '../indexing';
import { getProjectKnowledgeAutoMirrorCoordinator } from '../memory';
import { getLogger } from '../logging/logger';
import type { AppInitializationStep } from './initialization-steps';

const logger = getLogger('AppInitialization');

export function createCodememPrewarmCoordinatorStep(): AppInitializationStep {
  return {
    name: 'Codemem prewarm coordinator',
    fn: async () => {
      try {
        const settings = getSettingsManager().getAll();
        if (!settings.codememEnabled || !settings.codememIndexingEnabled) {
          logger.info('Codemem prewarm coordinator skipped — codemem disabled');
          return;
        }
        if (settings.codememPrewarmEnabled === false) {
          logger.info('Codemem prewarm coordinator skipped — disabled in settings');
          return;
        }

        const coordinator = getCodememPrewarmCoordinator();
        coordinator.start();

        if (settings.codememPrewarmStartupHint !== false) {
          try {
            const recents = await getRecentDirectoriesManager().getDirectories({
              limit: 1,
              sortBy: 'lastAccessed',
            });
            const mostRecent = recents.find((entry) => !entry.nodeId);
            if (mostRecent) {
              logger.info('Codemem prewarm startup hint', { path: mostRecent.path });
              coordinator.hintActiveWorkspace(mostRecent.path);
            }
          } catch (err) {
            logger.warn('Codemem prewarm startup hint failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } catch (err) {
        logger.warn('Codemem prewarm coordinator failed to start (continuing without prewarm)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

export function createCodebaseAutoIndexCoordinatorStep(): AppInitializationStep {
  return {
    name: 'Codebase auto-index coordinator',
    fn: async () => {
      try {
        const settings = getSettingsManager().getAll();
        if (settings.codebaseAutoIndexEnabled === false) {
          logger.info('Codebase auto-index coordinator skipped — disabled in settings');
          return;
        }

        const coordinator = getCodebaseIndexingAutoCoordinator();
        coordinator.start();

        if (settings.codebaseAutoIndexStartupHint === true) {
          try {
            const recents = await getRecentDirectoriesManager().getDirectories({
              limit: 1,
              sortBy: 'lastAccessed',
            });
            const mostRecent = recents.find((entry) => !entry.nodeId);
            if (mostRecent) {
              logger.info('Codebase auto-index startup hint', { path: mostRecent.path });
              coordinator.hintActiveWorkspace(mostRecent.path);
            }
          } catch (err) {
            logger.warn('Codebase auto-index startup hint failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } catch (err) {
        logger.warn('Codebase auto-index coordinator failed to start', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

export function createProjectKnowledgeAutoMirrorCoordinatorStep(): AppInitializationStep {
  return {
    name: 'Project knowledge auto-mirror coordinator',
    fn: async () => {
      try {
        const settings = getSettingsManager().getAll();
        if (!settings.codememEnabled || !settings.codememIndexingEnabled) {
          logger.info('Project knowledge auto-mirror coordinator skipped — codemem disabled');
          return;
        }
        if (settings.projectKnowledgeAutoMirrorEnabled === false) {
          logger.info('Project knowledge auto-mirror coordinator skipped — disabled in settings');
          return;
        }

        const coordinator = getProjectKnowledgeAutoMirrorCoordinator();
        coordinator.start();

        if (settings.projectKnowledgeAutoMirrorStartupHint !== false) {
          try {
            const recents = await getRecentDirectoriesManager().getDirectories({
              limit: 10,
              sortBy: 'lastAccessed',
            });
            const mostRecentLocal = recents.find((entry) => !entry.nodeId);
            if (mostRecentLocal) {
              logger.info('Project knowledge auto-mirror startup hint', { path: mostRecentLocal.path });
              coordinator.hintActiveWorkspace(mostRecentLocal.path);
            }
          } catch (err) {
            logger.warn('Project knowledge auto-mirror startup hint failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } catch (err) {
        logger.warn('Project knowledge auto-mirror coordinator failed to start', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
