/**
 * The app's one team-rules service, wired to the real settings. Kept apart from the service so its tests never load the
 * app's singletons. Saves go through the settings manager, which checks the key's schema again.
 */
import { getSettingsManager } from '../../core/config/settings-manager';
import { LinearTeamRuleService, type LinearTeamReadiness } from './linear-team-rules';

let instance: LinearTeamRuleService | null = null;

export function getLinearTeamRuleService(): LinearTeamRuleService {
  instance ??= new LinearTeamRuleService({
    readTeams: () => getSettingsManager().getAll().planQueueLinearTeams ?? [],
    saveTeams: (teams) => {
      getSettingsManager().set('planQueueLinearTeams', teams);
    },
    readLinks: () => getSettingsManager().getAll().planQueueLinearFolderLinks ?? [],
    readConnection: () => getSettingsManager().getAll().planQueueLinearConnection ?? null,
    readRoutingProviders: () => {
      const routing = getSettingsManager().getAll().planQueueRouting;
      return [...(routing?.workers ?? []), ...(routing?.verifiers ?? []), ...(routing?.stepUp ? [routing.stepUp] : [])]
        .map((choice) => choice.provider);
    },
    now: () => Date.now(),
  });
  return instance;
}

/** For the Linear run source (7.3): is this team ready for a Linear run, and if not, why. */
export function isLinearTeamReady(teamId: string): Promise<LinearTeamReadiness> {
  return getLinearTeamRuleService().isTeamReady(teamId);
}

export function _resetLinearTeamRuleServiceForTesting(): void {
  instance = null;
}
