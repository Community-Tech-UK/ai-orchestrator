/**
 * The pure rules for a team's saved Linear settings: which statuses to offer, what each team check says, whether a team
 * is ready for a Linear run, and whether a provider may see a team's ticket text. No call to Linear is made here, so
 * every rule is tested on its own and the service only has to fetch the facts.
 *
 * Sentences are fixed words plus the team key and the status names James saved. Nothing Linear returned on the call
 * being checked is used as a sentence, because a run's reason can be read by sessions.
 */
import type {
  PlanQueueLinearOfferedStatuses,
  PlanQueueLinearStatus,
  PlanQueueLinearTeam,
  PlanQueueLinearTeamCheck,
  PlanQueueLinearTeamCheckLine,
} from '@contracts/schemas/plan-queue';
import { canonicalProvider } from '../../../shared/utils/plan-queue-provider-id';
import type { LinearStatus, LinearTeam } from './linear-result-schemas';

const findByName = (statuses: readonly LinearStatus[], name: string, kind: string): PlanQueueLinearStatus | null => {
  const found = statuses.find((status) => status.type === kind && status.name.trim().toLowerCase() === name.toLowerCase());
  return found ? { id: found.id, name: found.name, kind: found.type } : null;
};

/**
 * What the panel offers for a team, and James confirms (Decision 5): started is "In Progress", handed back is "Todo",
 * landed is "Ready for QA/Test" where the team has it and otherwise "In Review", and done is "Done". A name that exists
 * with the wrong kind is not offered, so an offer always passes the schema's kind rules.
 */
export function offerTeamStatuses(statuses: readonly LinearStatus[]): PlanQueueLinearOfferedStatuses {
  return {
    startedStatus: findByName(statuses, 'In Progress', 'started'),
    handBackStatus: findByName(statuses, 'Todo', 'unstarted'),
    landedStatus: findByName(statuses, 'Ready for QA/Test', 'started') ?? findByName(statuses, 'In Review', 'started'),
    doneStatus: findByName(statuses, 'Done', 'completed'),
  };
}

/** What a live read found for one saved team. `members` is `null` when the connector did not list them. */
export interface LiveTeamFacts {
  team: LinearTeam | undefined;
  statuses: readonly LinearStatus[];
  members: readonly string[] | null;
}

type StatusRole = 'startedStatus' | 'handBackStatus' | 'landedStatus' | 'doneStatus';
const STATUS_LINES: readonly { id: PlanQueueLinearTeamCheckLine['id']; role: StatusRole; words: string }[] = [
  { id: 'started', role: 'startedStatus', words: 'work started' },
  { id: 'handBack', role: 'handBackStatus', words: 'handed back' },
  { id: 'landed', role: 'landedStatus', words: 'code landed' },
  { id: 'done', role: 'doneStatus', words: 'done' },
];

/** Linear's visibility words that mean the team is not open to the whole workspace. Anything else is not guessed at. */
const PRIVATE_VISIBILITY: ReadonlySet<string> = new Set(['private', 'restricted']);
const OPEN_VISIBILITY = 'public';

/**
 * Every check for one saved team, and whether the team is ready. A team with no allowed provider is not ready, and one
 * of James's own teams is not ready until the connector has said it is private.
 */
export function checkTeamFacts(entry: PlanQueueLinearTeam, facts: LiveTeamFacts, userId: string): PlanQueueLinearTeamCheck {
  const lines: PlanQueueLinearTeamCheckLine[] = [];
  const reasons: string[] = [];
  const problem = (line: PlanQueueLinearTeamCheckLine): void => {
    lines.push(line);
    if (line.result !== 'ok') reasons.push(line.text);
  };

  if (!facts.team) {
    problem({ id: 'team', result: 'problem', text: `${entry.teamKey} is no longer in Linear.` });
    return finish(entry, lines, reasons);
  }
  lines.push({ id: 'team', result: 'ok', text: `${entry.teamKey} is still in Linear.` });

  for (const { id, role, words } of STATUS_LINES) {
    const saved = entry[role];
    if (!saved) continue;
    const live = facts.statuses.find((status) => status.id === saved.id);
    if (!live) {
      problem({ id, result: 'problem', text: `The "${words}" status "${saved.name}" is no longer in this team.` });
    } else if (live.type !== saved.kind) {
      problem({ id, result: 'problem', text: `The "${words}" status "${saved.name}" has changed to a different kind in Linear.` });
    } else {
      // A renamed status keeps its id and is still the same status.
      lines.push({ id, result: 'ok', text: `The "${words}" status "${saved.name}" is still there.` });
    }
  }

  if (entry.ownership === 'own') {
    const visibility = facts.team.visibility;
    if (visibility === undefined || (!PRIVATE_VISIBILITY.has(visibility) && visibility !== OPEN_VISIBILITY)) {
      problem({ id: 'private', result: 'cannot-be-checked', text: 'Linear did not say whether this team is private, so it cannot be checked and counts as not confirmed private.' });
    } else if (visibility === OPEN_VISIBILITY) {
      problem({ id: 'private', result: 'problem', text: 'Linear reports this team as open to the whole workspace, but it is saved as one of your own private teams.' });
    } else {
      lines.push({ id: 'private', result: 'ok', text: 'Linear reports this team as private.' });
    }

    if (facts.members === null) {
      // Not a reason to stop: whether the connector can list members is not guaranteed.
      lines.push({ id: 'members', result: 'cannot-be-checked', text: 'Linear did not list this team\'s members, so it cannot be checked whether you are the only one.' });
    } else {
      const others = facts.members.filter((member) => member !== userId).length;
      if (others > 0) {
        problem({ id: 'members', result: 'problem', text: `${others === 1 ? '1 other person is' : `${others} other people are`} a member of this team, so it is not private to you.` });
      } else if (!facts.members.includes(userId)) {
        problem({ id: 'members', result: 'problem', text: 'You are not listed as a member of this team.' });
      } else {
        lines.push({ id: 'members', result: 'ok', text: 'You are the only member.' });
      }
    }
  }
  return finish(entry, lines, reasons);
}

function finish(entry: PlanQueueLinearTeam, lines: PlanQueueLinearTeamCheckLine[], reasons: string[]): PlanQueueLinearTeamCheck {
  // An empty list means no provider: it never means "any".
  if (entry.providers.length === 0) reasons.push('No provider is allowed to see this team\'s ticket text.');
  return { teamId: entry.teamId, lines, ready: reasons.length === 0, reasons };
}

/** The reasons a team with no saved entry is not ready. */
export const NO_SAVED_RULES_REASON = 'This team has no saved rules. Set them up on the Plan Queue page first.';

/**
 * Whether a provider may be sent a team's ticket text. Compared through the same aliasing the routing uses, so a saved
 * `openai` and a session on `codex` are one provider. An empty list allows none.
 */
export function isProviderAllowedForTeam(entry: Pick<PlanQueueLinearTeam, 'providers'>, provider: string): boolean {
  const wanted = canonicalProvider(provider);
  return entry.providers.some((allowed) => canonicalProvider(allowed) === wanted);
}
