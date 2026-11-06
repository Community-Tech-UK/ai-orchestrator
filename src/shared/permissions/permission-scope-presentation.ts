/**
 * One list of scope words for every permission card.
 *
 * The command card, the browser card and the permission-registry banner each
 * used to spell out how long an allow lasts in their own words ("Allow once",
 * "Approve once", "Once", "Session", "Autonomous", "Allow unattended"). They now
 * all read it from here, so the same promise is worded the same way wherever
 * it is made. A spec reads the three consumers' source and fails if one starts
 * declaring its own copy of these phrases again.
 *
 * Only the WORDS live here. What a scope actually grants is decided by the
 * backend behind each card; a card must map to a scope only when its backend
 * really behaves that way (for example, the browser's `per_action` grant is
 * consumed by the next action, so it may say "once").
 */

export type PermissionScope = 'once' | 'session' | 'without-asking' | 'always';

export interface PermissionScopeWords {
  /** Short name of the choice, for a picker or a summary. */
  readonly choice: string;
  /** The button that allows exactly this scope. */
  readonly allow: string;
  /** Reads after "Lasts": how long the permission stands. */
  readonly lasts: string;
}

export const PERMISSION_SCOPE_WORDS = {
  once: {
    choice: 'Once',
    allow: 'Allow this once',
    /** The command card can refuse with the same scope; the other cards just say Deny. */
    refuse: "Don't allow",
    lasts: 'just this once',
  },
  session: {
    choice: 'This session',
    allow: 'Allow for this session',
    refuse: 'Block for this session',
    lasts: 'until this session ends',
  },
  'without-asking': {
    choice: 'Without asking (this session)',
    allow: 'Allow without asking (this session)',
    lasts: 'until this session ends, without asking again',
  },
  always: {
    choice: 'Always',
    allow: 'Always allow',
    refuse: 'Always block',
    lasts: 'until you take it back',
  },
} as const satisfies Readonly<Record<PermissionScope, PermissionScopeWords & { readonly refuse?: string }>>;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const YEAR_MS = 365 * DAY_MS;

function counted(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? '' : 's'}`;
}

/**
 * "30 minutes", "24 hours", "7 days", "1 year". Rounds up to a whole minute so
 * the text never promises less than the permission gives, and picks the largest
 * unit that divides evenly so a day stays "24 hours" as the saved-login picker
 * has always said.
 */
export function describePermissionDuration(ms: number): string {
  if (ms >= YEAR_MS && ms % YEAR_MS === 0) return counted(ms / YEAR_MS, 'year');
  if (ms >= 2 * DAY_MS && ms % DAY_MS === 0) return counted(ms / DAY_MS, 'day');
  if (ms >= HOUR_MS && ms % HOUR_MS === 0) return counted(ms / HOUR_MS, 'hour');
  return counted(Math.max(1, Math.ceil(ms / MINUTE_MS)), 'minute');
}

/** Scope words for a permission that lasts a fixed time, such as "Allow for 7 days". */
export function timedScopeWords(durationMs: number): PermissionScopeWords {
  const length = describePermissionDuration(durationMs);
  return {
    choice: `For ${length}`,
    allow: `Allow for ${length}`,
    lasts: `for ${length}`,
  };
}
