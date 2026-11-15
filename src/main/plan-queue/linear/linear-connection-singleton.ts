/**
 * The app's one Linear connection service, wired to the real settings, connector list and notices. Kept apart from the
 * service so its tests never load the app's singletons.
 */
import { getSettingsManager } from '../../core/config/settings-manager';
import { getOrchestratorMcpRepository } from '../../mcp/mcp-multi-provider-singletons';
import { getNotificationService } from '../../notifications/notification-service';
import { LinearConnectionService } from './linear-connection-service';

let instance: LinearConnectionService | null = null;

export function getLinearConnectionService(): LinearConnectionService {
  if (!instance) {
    instance = new LinearConnectionService({
      readConnection: () => getSettingsManager().getAll().planQueueLinearConnection ?? null,
      saveConnection: (connection) => {
        getSettingsManager().set('planQueueLinearConnection', connection);
      },
      listConnectors: () => getOrchestratorMcpRepository().list().map((entry) => entry.record),
      getConnector: (id) => getOrchestratorMcpRepository().get(id)?.record ?? null,
      notify: ({ title, body, fingerprint }) => {
        getNotificationService().notify({
          kind: 'linear-connection',
          title,
          body,
          fingerprintFields: fingerprint,
        });
      },
      schedule: (run, delayMs) => {
        const timer = setTimeout(run, delayMs);
        timer.unref();
        return () => clearTimeout(timer);
      },
      now: () => Date.now(),
    });
  }
  return instance;
}

export function _resetLinearConnectionServiceForTesting(): void {
  instance?.dispose();
  instance = null;
}
