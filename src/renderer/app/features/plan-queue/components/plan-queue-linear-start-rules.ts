/**
 * The small rules the Linear Start preview shows, kept apart from the component so each can be tested alone:
 * the priority in words, the providers every ticked team allows, and which providers of the run are not on that list.
 * The main process checks the same thing again at Start and at every session; this is the early, readable version.
 */
import type {
  PlanQueueLinearPreview,
  PlanQueueLinearPreviewProvider,
  PlanQueueLinearPreviewRow,
  PlanQueueRouting,
} from '@contracts/schemas/plan-queue';
import { AUTOMATION_PROVIDER_DEFINITIONS } from '../../../../../shared/types/automation-provider.types';
import { canonicalProvider } from '../../../../../shared/utils/plan-queue-provider-id';

const PRIORITY_WORDS: Readonly<Record<number, string>> = { 0: 'No priority', 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };

/** Linear's priority number in plain words. */
export function linearPriorityWord(priority: number): string {
  return PRIORITY_WORDS[priority] ?? 'No priority';
}

/** The name the app shows for a provider id; an id it does not know is shown as it is. */
export function linearProviderLabel(id: string): string {
  const canonical = canonicalProvider(id);
  return AUTOMATION_PROVIDER_DEFINITIONS.find((provider) => provider.id === canonical)?.label ?? id;
}

/** The ticked rows' teams, once each, with the key the page shows for them. */
export function teamsOfTicked(preview: PlanQueueLinearPreview, ticked: readonly PlanQueueLinearPreviewRow[]): { teamId: string; teamKey: string }[] {
  const teams = new Map<string, string>();
  for (const row of ticked) {
    const project = preview.projects.find((candidate) => candidate.teamId === row.teamId);
    teams.set(row.teamId, project?.teamKey ?? row.identifier.slice(0, row.identifier.lastIndexOf('-')));
  }
  return [...teams].map(([teamId, teamKey]) => ({ teamId, teamKey }));
}

/** The providers every ticked team allows. A team with none saved allows none. Empty when nothing is ticked. */
export function allowedForTicked(preview: PlanQueueLinearPreview, ticked: readonly PlanQueueLinearPreviewRow[]): PlanQueueLinearPreviewProvider[] {
  const teams = teamsOfTicked(preview, ticked);
  if (teams.length === 0) return [];
  const perTeam = teams.map(({ teamId }) => preview.projects.find((project) => project.teamId === teamId)?.allowedProviders ?? []);
  const [first, ...rest] = perTeam;
  return first
    .filter((provider) => rest.every((others) => others.some((other) => canonicalProvider(other.id) === canonicalProvider(provider.id))))
    .map((provider) => ({ id: canonicalProvider(provider.id), label: provider.label }));
}

/**
 * Every provider the run would use: its workers (the starting session's provider when it has none), its step-up choice
 * and its checkers. An empty checker list is automatic choice, which the main process limits itself.
 */
export function providersOfRun(routing: PlanQueueRouting, startingProvider: string | null): string[] {
  const named = routing.workers.length > 0 ? routing.workers.map((choice) => choice.provider) : [startingProvider ?? ''];
  const all = [...named, ...(routing.stepUp ? [routing.stepUp.provider] : []), ...routing.verifiers.map((choice) => choice.provider)];
  return [...new Set(all.filter((provider) => provider.trim()).map(canonicalProvider))];
}

/** The run's providers that are not on the allowed list, by the names the page shows. */
export function providersNotAllowed(runProviders: readonly string[], allowed: readonly PlanQueueLinearPreviewProvider[]): string[] {
  const allowedIds = new Set(allowed.map((provider) => canonicalProvider(provider.id)));
  return runProviders.filter((provider) => !allowedIds.has(provider)).map(linearProviderLabel);
}

/** A comment's time for the page; an unreadable time is left out. */
export function linearCommentTime(iso: string): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? '' : new Date(at).toLocaleString();
}
