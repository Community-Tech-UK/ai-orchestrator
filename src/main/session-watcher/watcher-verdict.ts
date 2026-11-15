import { z } from 'zod';
import { extractLastJsonPayload } from '../agents/review-json-extract';
import { parseJsonWithRepair } from '../cli/json-parse';

export const WATCHER_VERDICTS = ['carry_on', 'needs_user', 'finished'] as const;
export const WATCHER_STOPS = [
  'asked_to_continue', 'announced_next_step', 'stopped_mid_plan', 'offered_choice', 'asked_for_information',
  'asked_before_outward_step', 'waiting_for_user_action', 'waiting_on_work', 'offered_extra_work', 'work_complete',
  'other',
] as const;
export const WATCHER_BASES = ['planned_work', 'own_proposal', 'own_recommendation', 'user_already_said', 'none'] as const;

export type WatcherVerdictKind = typeof WATCHER_VERDICTS[number];
export type WatcherStop = typeof WATCHER_STOPS[number];
export type WatcherBasis = typeof WATCHER_BASES[number];

/** The judge's output is untrusted and bounded: a longer reply is not a verdict. */
const MAX_RAW_CHARS = 8_000;
const MAX_FIELD_CHARS = 2_000;

/**
 * The three enums are the decision and must be present. The three texts may be
 * left out (small models often drop one): an empty `quote` fails the code's
 * quote check, an empty `question` is replaced by the agent's own closing words,
 * and `reason` is only logged, so a missing text can never widen what is sent.
 * Field limits are generous on purpose: an over-long `reason` is trimmed by the
 * consumer; rejecting it here would turn a usable verdict into `unreliable`.
 */
export const WatcherVerdictSchema = z.object({
  verdict: z.enum(WATCHER_VERDICTS),
  stop: z.enum(WATCHER_STOPS),
  basis: z.enum(WATCHER_BASES),
  quote: z.string().max(MAX_FIELD_CHARS).default(''),
  question: z.string().max(MAX_FIELD_CHARS).default(''),
  reason: z.string().max(MAX_FIELD_CHARS).default(''),
});
export type WatcherVerdict = z.infer<typeof WatcherVerdictSchema>;

/** Why a judge reply was not a verdict. Fixed codes only: the reply itself may echo session text, so it is never kept. */
export type WatcherVerdictError = 'empty' | 'too-long' | 'no-json' | 'not-json' | 'bad-schema';

export type WatcherVerdictParse =
  | { ok: true; verdict: WatcherVerdict; repaired: boolean }
  | { ok: false; error: WatcherVerdictError };

/**
 * Reads one verdict from the judge's reply: the last parseable JSON object that
 * fits the schema, fenced or wrapped in prose, then one repair attempt. Anything
 * else is a failure, which the caller treats as `unreliable` (never as a verdict).
 */
export function parseWatcherVerdict(raw: string): WatcherVerdictParse {
  const text = (raw ?? '').trim();
  if (!text) return { ok: false, error: 'empty' };
  if (text.length > MAX_RAW_CHARS) return { ok: false, error: 'too-long' };

  const payload = extractLastJsonPayload(text, (value) => WatcherVerdictSchema.safeParse(value).success);
  if (payload) return { ok: true, verdict: WatcherVerdictSchema.parse(JSON.parse(payload)), repaired: false };

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0) return { ok: false, error: 'no-json' };
  const repaired = parseJsonWithRepair<unknown>(end > start ? text.slice(start, end + 1) : text.slice(start));
  if (!repaired.ok) return { ok: false, error: 'not-json' };
  const checked = WatcherVerdictSchema.safeParse(repaired.value);
  if (!checked.success) return { ok: false, error: 'bad-schema' };
  return { ok: true, verdict: checked.data, repaired: true };
}
