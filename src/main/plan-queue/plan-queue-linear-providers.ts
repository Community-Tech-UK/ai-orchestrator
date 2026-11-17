/**
 * Which providers may see the tickets of a Linear run. James saves, for each Linear team, the providers allowed to
 * receive its ticket text (`planQueueLinearTeams`). A run's list is the providers that EVERY team with a ticket in the
 * run allows, read live each time it is needed, so a change James makes takes effect at the next session and stops
 * nothing that is running.
 *
 * Three places enforce it, each with the same fixed-words refusal that names the provider's label and a team key and
 * nothing else from Linear:
 *  1. `assertRoutingAllowed`: when a run's routing is chosen (Start) and when it is changed (`set-routing`);
 *  2. `assertProviderAllowed`: when any session is created (`spawnQueueInstance`), for every role;
 *  3. `checkerExclusions`: automatic checker choice leaves out every provider the list does not hold, so the queue does
 *     not keep choosing a checker the session check would refuse.
 *
 * This file is outside the Linear folder on purpose: it reads the saved settings and the ticket table, never Linear.
 */
import type { PlanQueueRouteChoice, PlanQueueRouting } from '@contracts/schemas/plan-queue';
import { getSettingsManager } from '../core/config/settings-manager';
import { getPlanQueueLinearTicketStore } from './plan-queue-linear-ticket-store-singleton';
import { canonicalProvider, planQueueProviderChoices, PlanQueueRoutingError, type PlanQueueParentRoute } from './plan-queue-routing';
import type { PlanQueueRun } from './plan-queue.types';

/** A Linear team with a ticket in the run. The key is the prefix of the ticket's short address (`COM` in `COM-12`). */
export interface LinearRunTeam {
  teamId: string;
  teamKey: string;
}

export interface LinearProviderDeps {
  /** The saved per-team rules, read live. */
  readTeams(): readonly { teamId: string; providers: readonly string[] }[];
  /** Every team with a ticket in this run. */
  teamsOfRun(runId: string): readonly LinearRunTeam[];
}

/** Thrown when a session or a routing would send a team's ticket text to a provider the team does not allow. */
export class PlanQueueProviderNotAllowed extends PlanQueueRoutingError {
  constructor(message: string) {
    super(message);
    this.name = 'PlanQueueProviderNotAllowed';
  }
}

const NO_TICKETS_REFUSAL = 'This Linear run has no tickets, so no provider is allowed for it.';

const labelOf = (provider: string): string => planQueueProviderChoices().find((choice) => choice.id === provider)?.label ?? provider.slice(0, 50);

const notAllowed = (provider: string, teamKey: string): string =>
  `${labelOf(provider)} is not allowed to see tickets from the ${teamKey} team. Choose another provider, or allow this one for the ${teamKey} team on the Plan Queue page.`;

const notNamed = (teamKey: string): string =>
  `This session has no named provider, so Harness cannot check it against the providers allowed for the ${teamKey} team. Choose a provider for the run on the Plan Queue page.`;

export class LinearProviderPolicy {
  constructor(private readonly deps: LinearProviderDeps) {}

  /** The teams with a ticket in this run, by key. */
  teamsOf(runId: string): LinearRunTeam[] {
    return [...this.deps.teamsOfRun(runId)].sort((a, b) => a.teamKey.localeCompare(b.teamKey) || a.teamId.localeCompare(b.teamId));
  }

  /** The providers one team allows, as ids the routing uses. A team with no entry, or an empty list, allows none. */
  private allowedByTeam(teamId: string): Set<string> {
    const saved = this.deps.readTeams().find((team) => team.teamId === teamId);
    return new Set((saved?.providers ?? []).map(canonicalProvider));
  }

  /** The providers every team allows, in the order the app lists providers. Empty when there is no team. */
  allowedProviders(teams: readonly LinearRunTeam[]): string[] {
    if (teams.length === 0) return [];
    const perTeam = teams.map((team) => this.allowedByTeam(team.teamId));
    return planQueueProviderChoices().map((choice) => choice.id).filter((id) => perTeam.every((allowed) => allowed.has(id)));
  }

  /**
   * Refuses unless `provider` is a named provider every team allows. `auto` and no provider are refused: with no name
   * there is nothing to compare, and a session must never start on a provider chosen later.
   */
  assertProviderAllowed(teams: readonly LinearRunTeam[], provider: string | null | undefined): void {
    const ordered = [...teams].sort((a, b) => a.teamKey.localeCompare(b.teamKey) || a.teamId.localeCompare(b.teamId));
    const [first] = ordered;
    if (!first) throw new PlanQueueProviderNotAllowed(NO_TICKETS_REFUSAL);
    const named = provider?.trim() ? canonicalProvider(provider) : null;
    if (!named || named === 'auto') throw new PlanQueueProviderNotAllowed(notNamed(first.teamKey));
    for (const team of ordered) {
      if (!this.allowedByTeam(team.teamId).has(named)) throw new PlanQueueProviderNotAllowed(notAllowed(named, team.teamKey));
    }
  }

  /**
   * Refuses unless every worker choice, the step-up choice and every checker choice is allowed. With no worker choice
   * the run uses the starting session's provider, so that provider must be allowed. No checker choice means automatic
   * choice, which `checkerExclusions` limits.
   */
  assertRoutingAllowed(teams: readonly LinearRunTeam[], routing: PlanQueueRouting, startingSession: PlanQueueParentRoute): void {
    const choices: readonly Pick<PlanQueueRouteChoice, 'provider'>[] = [
      ...(routing.workers.length > 0 ? routing.workers : [{ provider: startingSession.provider ?? '' }]),
      ...(routing.stepUp ? [routing.stepUp] : []),
      ...routing.verifiers,
    ];
    for (const choice of choices) this.assertProviderAllowed(teams, choice.provider);
  }

  /** Every provider the app knows that the run's list does not hold: pass these as the ones automatic choice leaves out. */
  checkerExclusions(teams: readonly LinearRunTeam[]): string[] {
    const allowed = new Set(this.allowedProviders(teams));
    return planQueueProviderChoices().map((choice) => choice.id).filter((id) => !allowed.has(canonicalProvider(id)));
  }
}

function defaultDeps(): LinearProviderDeps {
  return {
    readTeams: () => getSettingsManager().getAll().planQueueLinearTeams ?? [],
    teamsOfRun: (runId) => {
      const store = getPlanQueueLinearTicketStore();
      if (!store) throw new Error('The Linear ticket table is not available, so this run\'s providers cannot be checked.');
      return store.teamsOfRun(runId).map(({ teamId, identifier }) => ({ teamId, teamKey: identifier.slice(0, identifier.lastIndexOf('-')) }));
    },
  };
}

/**
 * The providers automatic checker choice leaves out for this run: a capability repair's frozen exclusions, and for a
 * Linear run every provider its teams do not all allow. Undefined when the run leaves none out.
 */
export function excludedProvidersForRun(run: PlanQueueRun): string[] | undefined {
  const frozen = run.config.capabilityRepairExcludedProviders;
  if (run.kind !== 'tickets') return frozen ? [...frozen] : undefined;
  const policy = getLinearProviderPolicy();
  return [...new Set([...(frozen ?? []), ...policy.checkerExclusions(policy.teamsOf(run.id))])];
}

let current: LinearProviderPolicy | null = null;

/** The app's policy, over the saved settings and the ticket table. */
export function getLinearProviderPolicy(): LinearProviderPolicy {
  current ??= new LinearProviderPolicy(defaultDeps());
  return current;
}

/** Tests put their own policy here; `null` restores the app's. */
export function _setLinearProviderPolicyForTesting(policy: LinearProviderPolicy | null): void {
  current = policy;
}
