/**
 * James's per-team Linear rules (`planQueueLinearTeams`): the one checked way to save them, the live check of every saved
 * team, and the one function a later step calls to ask whether a team is ready for a Linear run.
 *
 * - Saving checks the whole list against the schema, then asks Linear, for each team, whether the team is there and
 *   whether every chosen status is one of its statuses with the kind that was saved. It saves the whole list or nothing,
 *   with a plain reason per refused row. Saves run one at a time, so two in a row each see the list the other left.
 * - A check reads the saved list when it starts and again when it ends. If a save landed in between, the answer is
 *   about an older entry, so the check runs again on the new list instead of reporting it.
 * - Every read goes through the one Linear call function, so the connection James confirmed is the only one used.
 *   Nothing here writes to Linear.
 */
import {
  PlanQueueLinearTeamSchema,
  PlanQueueLinearTeamsSchema,
  type PlanQueueLinearFolderLink,
  type PlanQueueLinearStatus,
  type PlanQueueLinearTeam,
  type PlanQueueLinearTeamChoice,
  type PlanQueueLinearTeamChoices,
  type PlanQueueLinearTeamCheck,
  type PlanQueueLinearTeamRefusal,
  type PlanQueueLinearTeamsCheck,
  type PlanQueueLinearTeamsSaveResult,
} from '@contracts/schemas/plan-queue';
import type { PlanQueueLinearConnection } from '@contracts/schemas/plan-queue';
import { canonicalProvider, planQueueProviderChoices } from '../plan-queue-routing';
import { callLinearTool, type LinearCallDependencies } from './linear-call';
import { isLinearCallError } from './linear-errors';
import { readAllLinearPages, toLinearPage } from './linear-paging';
import {
  LinearStatusListSchema,
  LinearTeamsPageSchema,
  LinearUsersPageSchema,
  type LinearStatus,
  type LinearTeam,
} from './linear-result-schemas';
import {
  NO_SAVED_RULES_REASON,
  checkTeamFacts,
  offerTeamStatuses,
  type LiveTeamFacts,
} from './linear-team-checks';

const PAGE_SIZE = 50;
/** How many times a check starts over because a save landed while it ran, before it gives up. */
const MAX_CHECK_ATTEMPTS = 3;

export interface LinearTeamRuleDependencies {
  /** The saved list, read live on every call. */
  readTeams(): readonly PlanQueueLinearTeam[];
  /** Writes the whole list through the settings manager and announces the change so the page updates. */
  saveTeams(teams: PlanQueueLinearTeam[]): void;
  /** The saved folder links, which say which teams have a linked project. */
  readLinks(): readonly PlanQueueLinearFolderLink[];
  readConnection(): PlanQueueLinearConnection;
  /** The providers in James's saved Plan Queue routing, as saved. */
  readRoutingProviders(): readonly string[];
  /** Tests pass the fake connector's call dependencies; the app leaves it out. */
  call?: LinearCallDependencies;
  now(): number;
}

/** A team is ready, or it is not and these fixed sentences say why. */
export type LinearTeamReadiness = { ready: true } | { ready: false; reasons: string[] };

export class LinearTeamRuleService {
  /** Saves run one at a time: each is checked against the list the one before it left. */
  private saving: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: LinearTeamRuleDependencies) {}

  // --- Reading Linear for the editor -------------------------------------------------------------------------------

  /** Every team the panel has a row for: those with a linked project and those with saved rules. */
  async choices(): Promise<PlanQueueLinearTeamChoices> {
    const wanted = new Map<string, { key: string; name: string }>();
    for (const link of this.deps.readLinks()) {
      for (const project of link.privateProject ? [link.privateProject, ...link.clientProjects] : link.clientProjects) {
        if (!wanted.has(project.teamId)) wanted.set(project.teamId, { key: project.teamKey, name: project.teamKey });
      }
    }
    for (const saved of this.deps.readTeams()) wanted.set(saved.teamId, { key: saved.teamKey, name: saved.teamName });

    const live = wanted.size === 0 ? [] : await this.listTeams();
    const teams = await Promise.all([...wanted].map(async ([teamId, shown]): Promise<PlanQueueLinearTeamChoice> => {
      const found = live.find((team) => team.id === teamId);
      if (!found) {
        return {
          teamId, teamKey: shown.key, teamName: shown.name, exists: false, statuses: [],
          offered: { startedStatus: null, handBackStatus: null, landedStatus: null, doneStatus: null },
        };
      }
      const statuses = await this.listStatuses(teamId);
      return {
        teamId,
        teamKey: found.key,
        teamName: found.name,
        exists: true,
        statuses: statuses.map(toStatus),
        offered: offerTeamStatuses(statuses),
      };
    }));
    teams.sort((a, b) => a.teamKey.localeCompare(b.teamKey));
    return {
      teams,
      providers: planQueueProviderChoices(),
      routingProviders: [...new Set(this.deps.readRoutingProviders().map(canonicalProvider))]
        .filter((id) => planQueueProviderChoices().some((provider) => provider.id === id)),
    };
  }

  // --- Saving -------------------------------------------------------------------------------------------------------

  /** Checks the whole list and saves all of it, or saves nothing and says why for each refused row. */
  save(rows: readonly unknown[]): Promise<PlanQueueLinearTeamsSaveResult> {
    const run = this.saving.then(() => this.checkAndSave(rows));
    this.saving = run.catch(() => undefined);
    return run;
  }

  private async checkAndSave(rows: readonly unknown[]): Promise<PlanQueueLinearTeamsSaveResult> {
    const refused = new Map<number | null, string[]>();
    const refuse = (index: number | null, reason: string): void => {
      refused.set(index, [...(refused.get(index) ?? []), reason]);
    };

    // A provider is saved under the id the routing uses, so `openai` and `codex` are never two entries.
    const known = new Set(planQueueProviderChoices().map((provider) => provider.id));
    const prepared = rows.map((row, index) => canonicaliseProviders(row, known, (reason) => refuse(index, reason)));

    const whole = PlanQueueLinearTeamsSchema.safeParse(prepared);
    if (!whole.success) {
      for (const issue of whole.error.issues) {
        const [first] = issue.path;
        refuse(typeof first === 'number' ? first : null, plainSchemaReason(issue));
      }
    }

    // Every well-formed row is checked against Linear, so one refusal does not hide the others.
    const wellFormed = prepared.map((row) => PlanQueueLinearTeamSchema.safeParse(row));
    const toCheck = wellFormed.flatMap((parsed, index) => (parsed.success ? [{ index, entry: parsed.data }] : []));
    const live = toCheck.length === 0 ? { teams: [], statuses: new Map<string, LinearStatus[]>() } : await this.readLive(toCheck.map((row) => row.entry.teamId));
    const confirmed = new Map<number, PlanQueueLinearTeam>();
    for (const { index, entry } of toCheck) {
      const result = confirmEntry(entry, live.teams.find((team) => team.id === entry.teamId), live.statuses.get(entry.teamId) ?? []);
      if (result.ok) confirmed.set(index, result.entry);
      else for (const reason of result.reasons) refuse(index, reason);
    }

    if (!whole.success || refused.size > 0) return { saved: false, refused: flatten(refused) };
    // Linear's own spelling of each name is what is saved, not what the page sent.
    const final = PlanQueueLinearTeamsSchema.safeParse(prepared.map((_, index) => confirmed.get(index)));
    if (!final.success) return { saved: false, refused: [{ index: null, reason: 'The rules could not be saved because Linear returned a name that cannot be stored. Nothing was saved.' }] };
    // Every check has finished and passed; this is the one write.
    this.deps.saveTeams(final.data);
    return { saved: true, teams: final.data };
  }

  // --- Checking -----------------------------------------------------------------------------------------------------

  /**
   * Checks every saved team against Linear now: the team is there, each saved status is there with the same kind, one of
   * James's own teams is private, and whether he is its only member. If a save lands while it runs, it runs again on the
   * new list, so it never reports against an entry that has been replaced.
   */
  async checkTeams(): Promise<PlanQueueLinearTeamsCheck> {
    const { checks } = await this.stableCheck(() => this.deps.readTeams());
    return { checkedAt: this.deps.now(), teams: checks };
  }

  /**
   * Whether a team is ready for a Linear run, and if not, why. A team with no saved entry, or with no allowed provider,
   * is not ready; neither is one whose live check finds a problem, or an own team that is not confirmed private. A
   * failed read is reported as not ready, in Harness's own words.
   */
  async isTeamReady(teamId: string): Promise<LinearTeamReadiness> {
    if (!this.deps.readTeams().some((team) => team.teamId === teamId)) return { ready: false, reasons: [NO_SAVED_RULES_REASON] };
    try {
      const { checks } = await this.stableCheck(() => this.deps.readTeams().filter((team) => team.teamId === teamId));
      const check = checks.find((entry) => entry.teamId === teamId);
      if (!check) return { ready: false, reasons: [NO_SAVED_RULES_REASON] };
      return check.ready ? { ready: true } : { ready: false, reasons: check.reasons };
    } catch (error) {
      if (isLinearCallError(error)) return { ready: false, reasons: [error.message] };
      throw error;
    }
  }

  private async stableCheck(selectSaved: () => readonly PlanQueueLinearTeam[]): Promise<{ checks: PlanQueueLinearTeamCheck[] }> {
    for (let attempt = 0; attempt < MAX_CHECK_ATTEMPTS; attempt += 1) {
      const saved = selectSaved();
      const before = JSON.stringify(saved);
      const checks = await this.runChecks(saved);
      if (JSON.stringify(selectSaved()) === before) return { checks };
    }
    throw new Error('The team rules changed while they were being checked. Check again.');
  }

  private async runChecks(saved: readonly PlanQueueLinearTeam[]): Promise<PlanQueueLinearTeamCheck[]> {
    if (saved.length === 0) return [];
    const userId = this.deps.readConnection()?.userId ?? '';
    const teams = await this.listTeams();
    return Promise.all(saved.map(async (entry) => {
      const team = teams.find((candidate) => candidate.id === entry.teamId);
      const statuses = team ? await this.listStatuses(entry.teamId) : [];
      const members = team && entry.ownership === 'own' ? await this.listMembers(entry.teamId) : null;
      const facts: LiveTeamFacts = { team, statuses, members };
      return checkTeamFacts(entry, facts, userId);
    }));
  }

  // --- Linear reads -------------------------------------------------------------------------------------------------

  private async readLive(teamIds: readonly string[]): Promise<{ teams: LinearTeam[]; statuses: Map<string, LinearStatus[]> }> {
    const teams = await this.listTeams();
    const statuses = new Map<string, LinearStatus[]>();
    await Promise.all([...new Set(teamIds)].filter((id) => teams.some((team) => team.id === id)).map(async (id) => {
      statuses.set(id, await this.listStatuses(id));
    }));
    return { teams, statuses };
  }

  private listTeams(): Promise<LinearTeam[]> {
    return readAllLinearPages<LinearTeam>(async (cursor) => {
      const page = await callLinearTool('list_teams', { limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) }, LinearTeamsPageSchema, this.deps.call);
      return toLinearPage(page.teams, page);
    });
  }

  private listStatuses(teamId: string): Promise<LinearStatus[]> {
    return callLinearTool('list_issue_statuses', { team: teamId }, LinearStatusListSchema, this.deps.call);
  }

  /** The ids of a team's members, or null when the connector cannot list them (a tool or answer it does not have). */
  private async listMembers(teamId: string): Promise<string[] | null> {
    try {
      const users = await readAllLinearPages<{ id: string }>(async (cursor) => {
        const page = await callLinearTool('list_users', { team: teamId, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) }, LinearUsersPageSchema, this.deps.call);
        return toLinearPage(page.users, page);
      });
      return users.map((user) => user.id);
    } catch (error) {
      // A sign-in or reach problem is the whole check's problem; only "the connector does not answer this" is a gap.
      if (isLinearCallError(error) && error.code === 'unexpected-result') return null;
      throw error;
    }
  }
}

const toStatus = (status: LinearStatus): PlanQueueLinearStatus => ({ id: status.id, name: status.name, kind: status.type });

/** Rewrites each provider to the id the routing uses; refuses one the queue cannot route to. Other shapes pass through. */
function canonicaliseProviders(row: unknown, known: ReadonlySet<string>, refuse: (reason: string) => void): unknown {
  if (typeof row !== 'object' || row === null) return row;
  const providers = (row as { providers?: unknown }).providers;
  if (!Array.isArray(providers)) return row;
  const mapped = providers.map((provider) => {
    if (typeof provider !== 'string') return provider;
    const id = canonicalProvider(provider);
    if (!known.has(id)) refuse(`"${provider.slice(0, 50)}" is not a provider Plan Queue can use.`);
    return id;
  });
  return { ...row, providers: mapped };
}

type Confirmed = { ok: true; entry: PlanQueueLinearTeam } | { ok: false; reasons: string[] };

/** Checks one row against what Linear lists, and returns it with Linear's own names. */
function confirmEntry(entry: PlanQueueLinearTeam, team: LinearTeam | undefined, statuses: readonly LinearStatus[]): Confirmed {
  if (!team) return { ok: false, reasons: [`${entry.teamKey} is not a team in Linear, so its rules cannot be saved.`] };
  const reasons: string[] = [];
  const confirm = (saved: PlanQueueLinearStatus, words: string): PlanQueueLinearStatus => {
    const live = statuses.find((status) => status.id === saved.id);
    if (!live) {
      reasons.push(`The "${words}" status "${saved.name}" is not one of ${team.key}'s statuses. It may belong to another team or have been deleted.`);
      return saved;
    }
    if (live.type !== saved.kind) {
      reasons.push(`The "${words}" status "${saved.name}" has changed to a different kind in Linear. Choose it again.`);
      return saved;
    }
    return toStatus(live);
  };
  const next: PlanQueueLinearTeam = {
    ...entry,
    teamKey: team.key,
    teamName: team.name,
    startedStatus: confirm(entry.startedStatus, 'work started'),
    handBackStatus: confirm(entry.handBackStatus, 'handed back'),
    landedStatus: confirm(entry.landedStatus, 'code landed'),
    doneStatus: entry.doneStatus ? confirm(entry.doneStatus, 'done') : null,
  };
  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, entry: next };
}

/** The schema's own words for a rule it wrote; a plain sentence for anything else, such as a missing field. */
function plainSchemaReason(issue: { code: string; message: string; path: PropertyKey[] }): string {
  if (issue.code === 'custom') return issue.message;
  if (issue.path.length === 0) return 'The list is too long: at most 50 teams can have rules.';
  const field = issue.path.slice(1).map(String).join(' > ');
  return `This row is incomplete or has a value that cannot be saved${field ? ` (${field})` : ''}.`;
}

function flatten(refused: Map<number | null, string[]>): PlanQueueLinearTeamRefusal[] {
  return [...refused]
    .flatMap(([index, reasons]) => [...new Set(reasons)].map((reason) => ({ index, reason })))
    .sort((a, b) => (a.index ?? -1) - (b.index ?? -1));
}
