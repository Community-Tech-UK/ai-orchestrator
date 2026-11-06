/**
 * Plain-English copy for "Where your usage went".
 *
 * One module so the card, the context bar, the effort picker and the helper
 * controls all say the same thing. Pure strings: safe to import from the
 * renderer, the main process and the preload bridge. No title attributes are
 * built from these; callers bind them with `appTooltip`.
 */

import type {
  UsageCauseId,
  UsageInsightNote,
  UsageInsightReport,
  UsageInsightScope,
  UsageInsightUnsupportedReason,
} from './usage-insight.types';

export interface UsageCauseCopy {
  /** Short heading shown on the card row. */
  title: string;
  /** The single sentence shown under the heading. */
  sentence: string;
  /** How the number was worked out, for the row's tooltip. */
  measure: string;
}

export const CACHE_MISS_ADVICE = 'After a break, Claude reads a long chat again at full price; compacting it first shrinks that re-read.';
export const LONG_CONTEXT_ADVICE = 'Every message in a chat over 150K reads the whole chat again, so a size cap that summarises earlier keeps each message cheaper.';

export const USAGE_CAUSE_COPY: Readonly<Record<UsageCauseId, UsageCauseCopy>> = {
  cacheMiss: {
    title: 'Coming back to a long chat',
    sentence: CACHE_MISS_ADVICE,
    measure: 'Requests that had to read more than 100K tokens fresh instead of from the chat Claude was already holding.',
  },
  longContext: {
    title: 'Very long chats',
    sentence: LONG_CONTEXT_ADVICE,
    measure: 'Requests where the chat Claude read was over 150K tokens.',
  },
  helperHeavy: {
    title: 'Helper-heavy sessions',
    sentence: 'Each helper agent uses its own allowance, so sessions where helpers do most of the work cost the most.',
    measure: 'Sessions where helper agents did at least half of the work.',
  },
  parallelSessions: {
    title: 'Four or more sessions at once',
    sentence: 'Sessions running side by side draw on the same allowance, so it drains faster with four or more at once.',
    measure: 'Requests made in a five-minute stretch when four or more sessions were working. An estimate: the records only hold times, so sessions active within the same five minutes count as running together.',
  },
  longRunning: {
    title: 'Sessions open all day',
    sentence: 'A session kept going for 8 hours or more keeps growing one chat, while a scheduled job starts fresh each time.',
    measure: 'Sessions that were working for 8 hours or more in these 7 days. An estimate: gaps longer than 30 minutes count as 30 minutes.',
  },
  maxEffort: {
    title: 'Max effort',
    sentence: 'Max effort thinks as long as it can on every step, so it uses much more of your allowance; save it for the hardest problems.',
    measure: 'Requests from sessions set to max effort. Only known for sessions Harness started after it began recording the setting.',
  },
  workflows: {
    title: 'Workflows',
    sentence: 'Workflow mode splits every task across many helper agents, and each one uses its own allowance.',
    measure: 'Requests from sessions running in workflow mode. Only known for sessions Harness started after it began recording the setting.',
  },
  alwaysOnContext: {
    title: 'Heavy start-up context',
    sentence: 'Instructions, tool lists and notes load at the start of every session, and over 40K every message pays to read them.',
    measure: 'Sessions whose first request already carried more than 40K tokens.',
  },
  bigToolResults: {
    title: 'Big tool results',
    sentence: 'Long command output and whole files stay in the chat and get read again with every message once they pass 10K.',
    measure: "Requests made while a tool result over 10K tokens was still in the chat. An estimate: a result's size is worked out from its length, at about four characters to a token.",
  },
};

/**
 * Anthropic's own words for the two effort levels that cost the most. The effort
 * picker uses these verbatim (Phase E Step 7, item 8); the card above words the
 * same facts as one sentence.
 */
export const EFFORT_MAX_DESCRIPTION =
  'Thinks as long as it can on every step and uses much more of your allowance. Keep it for the hardest problems.';
export const EFFORT_WORKFLOW_DESCRIPTION =
  'Splits every task across many helper agents; each one uses its own allowance.';

/**
 * Tooltip copy for the controls that already sit next to these costs. Each value
 * is plain text meant for `[appTooltip]`.
 */
export const USAGE_CAUSE_TOOLTIPS = {
  /** The context bar / ring: why a very long chat costs more. */
  contextRing: USAGE_CAUSE_COPY.longContext.sentence,
  /** The context bar / ring: why coming back after a break costs more. */
  contextRingIdle: USAGE_CAUSE_COPY.cacheMiss.sentence,
  /** The effort picker's Max row. */
  effortMax: EFFORT_MAX_DESCRIPTION,
  /** The effort picker's Workflow row. */
  effortWorkflow: EFFORT_WORKFLOW_DESCRIPTION,
  /** The helper-agent limit controls. */
  helperControls: USAGE_CAUSE_COPY.helperHeavy.sentence,
} as const;

export const USAGE_CARD_TITLE = 'Where your usage went';

/** Why a session can't be broken down. The card and the session status card say it the same way. */
export const USAGE_UNSUPPORTED_TEXT: Readonly<Record<UsageInsightUnsupportedReason, string>> = {
  'not-claude': 'This breakdown is only available for Claude sessions.',
  'unknown-instance': "This session isn't open any more, so there's nothing to break down.",
  remote: "This session runs on another computer, so its Claude records aren't stored here.",
};

export const USAGE_OVERLAP_NOTE = "These overlap, so they don't add up to 100%.";

/** Shares are cost-weighted, which is a guide to the allowance and not a reading of it. */
export const USAGE_PROXY_NOTE =
  "Each share is weighted by what its requests would cost at API prices. That points to where your allowance went, but it isn't how Anthropic counts it.";

/** The three causes that are estimates, in the words the reader needs to judge them. */
export const USAGE_ESTIMATES_EXPLAINED =
  "Four or more at once is an estimate: Claude's records only hold times, so sessions active within the same five minutes count as running together. "
  + 'Sessions open all day is an estimate too, because a gap of more than 30 minutes counts as 30 minutes of work. '
  + 'Big tool results are an estimate as well: their size is worked out from their length, at about four characters to a token.';

/** The percent figure with the scope it is a share of. */
export function formatCauseShare(
  percent: number,
  scope: UsageInsightScope,
  options: { atLeast?: boolean; estimate?: boolean } = {},
): string {
  const prefix = options.atLeast ? 'At least ' : '';
  const suffix = options.estimate ? ' (estimate)' : '';
  if (scope.kind === 'session') {
    return percent >= 100 && !options.atLeast
      ? `All of this session's usage${suffix}`
      : `${prefix}${percent}% of this session's usage${suffix}`;
  }
  return `${prefix}${percent}% of your usage in the last 7 days${suffix}`;
}

/** Below this share of usage from Harness-started sessions, the card says how little is known about the rest. */
const HARNESS_COVERAGE_OK = 0.95;

/**
 * What the figures cover and what they leave out. The allowance is shared across every
 * computer and every Claude app, but only this computer's Claude Code records are read.
 */
export function describeUsageCoverage(report: UsageInsightReport): string {
  const { requests, sessions } = report.totals;
  const reach = "Usage from other computers or the Claude apps isn't included.";
  if (report.scope.kind === 'session') {
    return `Counts the ${requests.toLocaleString('en-GB')} ${requests === 1 ? 'request' : 'requests'} recorded on this computer for this session, including helper agents working inside it. ${reach}`;
  }
  const lead = `Counts ${requests.toLocaleString('en-GB')} ${requests === 1 ? 'request' : 'requests'} from ${sessions.toLocaleString('en-GB')} Claude ${sessions === 1 ? 'session' : 'sessions'} recorded on this computer.`;
  const linked = report.coverage.harnessLinked;
  const harness = linked < HARNESS_COVERAGE_OK
    ? ` Only ${Math.round(linked * 100)}% of this usage is from sessions Harness started, so effort and helper details are only known for those.`
    : '';
  return `${lead}${harness} ${reach}`;
}

/** Plain wording for a gap in the evidence. */
export function describeUsageNote(note: UsageInsightNote): string {
  switch (note.code) {
    case 'files-skipped-large':
      return `${note.count} very large ${note.count === 1 ? 'transcript was' : 'transcripts were'} left out to keep this quick.`;
    case 'files-skipped-limit':
      return `${note.count} older ${note.count === 1 ? 'transcript was' : 'transcripts were'} left out because there was too much to read.`;
    case 'requests-trimmed':
      return `${note.count.toLocaleString('en-GB')} of the oldest requests were left out to keep this quick.`;
    case 'lines-skipped':
      return `${note.count.toLocaleString('en-GB')} unreadable ${note.count === 1 ? 'line was' : 'lines were'} skipped.`;
    case 'files-unreadable':
      return `${note.count} ${note.count === 1 ? 'transcript' : 'transcripts'} couldn't be read, so ${note.count === 1 ? 'its' : 'their'} usage is missing.`;
    case 'cost-log-unreadable':
      return `${note.count} day${note.count === 1 ? '' : 's'} of Harness's cost log couldn't be read, so some sessions may be missing their effort and helper details.`;
    case 'session-links-unavailable':
      return "Harness's saved cost history couldn't be read, so helper sessions and effort settings may be missing.";
    case 'prices-approximate':
      return `${note.count.toLocaleString('en-GB')} ${note.count === 1 ? 'request was' : 'requests were'} from a model Harness has no exact price for, so ${note.count === 1 ? 'it is' : 'they are'} counted at the price of the nearest current model.`;
    case 'effort-partly-recorded':
      return `Harness only knows the effort setting for ${note.knownPercent}% of this usage, so max effort and workflows may be higher than shown.`;
    case 'no-claude-usage':
      return 'No Claude usage was found in the last 7 days.';
  }
}
