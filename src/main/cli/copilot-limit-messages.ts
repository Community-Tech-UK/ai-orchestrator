import { parseResetHintFromText } from '../instance/instance-provider-limit-detection';

export type CopilotLimitKind = 'rate' | 'model-rate' | 'weekly-rate' | 'session-spend' | 'monthly-credits' | 'additional-usage';
export interface CopilotLimitMatch {
  kind: CopilotLimitKind;
  action: 'park' | 'recycle';
  quotaVisible: boolean;
  resetAtHint: number | null;
}

const YOU = String.raw`you(?:['’]ve|\s+have)\s+`;
const URL = String.raw`https?:\/\/[^\s()]+`;
const CLOCK = String.raw`(?:\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?|[0-2]?\d:[0-5]\d)`;
const DURATION = String.raw`\d+\s*(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?)(?:\s+(?:and\s+)?\d+\s*(?:hours?|hrs?|minutes?|mins?|seconds?|secs?))*`;
const WHEN = String.raw`(?:in\s+${DURATION}|(?:at\s+)?(?:${CLOCK}|\d{4}-\d{2}-\d{2}T[^\s]+|[a-z]+\s+\d{1,2}(?:st|nd|rd|th)?,?\s+(?:\d{4}\s+)?${CLOCK}))`;
// Unknown provider reset formats still park using the conservative fallback horizon.
// Accept one reset statement only. Repeating an unknown-format branch lets it
// swallow later reset prefixes and causes exponential backtracking on rejection.
const UNKNOWN_WHEN = String.raw`(?:(?!\byour\s+(?:limit|quota)\s+resets?\b)[^.!?\n]){1,100}`;
const RESET = String.raw`(?:\s+your\s+(?:limit|quota)\s+resets?\s+(?:${WHEN}|${UNKNOWN_WHEN})\.?)?`;
const LEAD = String.raw`(?:(?:internal\s+error|error):\s*)?`;
const entries: readonly { kind: CopilotLimitKind; head: string; tail: string }[] = [
  { kind: 'rate', head: `${YOU}hit\\s+your\\s+(?:session\\s+)?rate\\s+limit`,
    tail: String.raw`(?:\s+please\s+wait\s+for\s+your\s+limit\s+to\s+reset(?:\s+or\s+switch\s+to\s+auto\s+model\s+to\s+continue)?\.?)?` },
  { kind: 'model-rate', head: `${YOU}hit\\s+the\\s+rate\\s+limit\\s+for\\s+this\\s+model`,
    tail: String.raw`(?:\s+please\s+switch\s+models\s+or\s+wait\s+for\s+your\s+limit\s+to\s+reset\.?)?` },
  { kind: 'weekly-rate', head: `${YOU}reached\\s+your\\s+weekly\\s+rate\\s+limit`,
    tail: String.raw`(?:\s+learn\s+more\s*\(${URL}\)\.?)?` },
  { kind: 'session-spend', head: `${YOU}reached\\s+the\\s+spending\\s+limit\\s+for\\s+this\\s+session`,
    tail: String.raw`(?:\s+start\s+a\s+new\s+session\s+to\s+continue\.?)?` },
  { kind: 'monthly-credits', head: `${YOU}run\\s+out\\s+of\\s+your\\s+(?:included\\s+)?ai\\s+credits(?:\\s+for\\s+the\\s+month)?`,
    tail: String.raw`(?:\s+manage\s+budget:\s*${URL})?` },
  { kind: 'monthly-credits', head: `${YOU}exceeded\\s+your\\s+monthly\\s+quota`,
    tail: String.raw`(?:\s*\(request\s+id:[^()\n]*\)\.?)?` },
  { kind: 'additional-usage', head: `${YOU}reached\\s+your\\s+additional\\s+usage\\s+limit\\s+for\\s+your\\s+plan`,
    tail: String.raw`(?:\s+go\s+to\s+${URL}\s+for\s+more\s+details\.?)?` },
];

/** Non-capturing sources for strict whole-message final-output classification. */
export const COPILOT_LIMIT_WHOLE_SOURCES = entries.map(({ head, tail }) => `${LEAD}${head}\\.?${tail}${RESET}`);
/** Shared chat/loop ledger source so either runtime preserves the same blind gate. */
export const COPILOT_RATE_LIMIT_SOURCE = 'copilot-rate-limit';
const tailPatterns = COPILOT_LIMIT_WHOLE_SOURCES.map((source) => new RegExp(`(?:^|\\s)${source}\\s*$`, 'iu'));
const wholePatterns = COPILOT_LIMIT_WHOLE_SOURCES.map((source) => new RegExp(`^${source}\\s*$`, 'iu'));
const mentions = entries.map(({ head }) => new RegExp(`\\b${head}\\b`, 'iu'));

/** Suppress the broad legacy detector when these words are quoted or followed by more work. */
export function containsCopilotLimitNotice(text: string | null | undefined): boolean {
  return Boolean(text && mentions.some((pattern) => pattern.test(text)));
}

/** Copilot can append the notice after useful text; it must still end the reply. */
export function matchCopilotLimitNotice(text: string, opts: { whole?: boolean } = {}): CopilotLimitMatch | null {
  // ACP wraps JSON-RPC error messages; that frame is transport data, never model output.
  const notice = text.trim().replace(/^ACP session\/prompt failed:\s*/i, '').replace(/\s+\(-\d+\)$/, '');
  const patterns = opts.whole ? wholePatterns : tailPatterns;
  const index = patterns.findIndex((pattern) => pattern.test(notice));
  if (index === -1) return null;
  const kind = entries[index].kind;
  const quotaVisible = kind === 'monthly-credits' || kind === 'additional-usage';
  const matched = patterns[index].exec(notice)?.[0] ?? notice;
  const now = Date.now();
  return { kind, action: kind === 'session-spend' ? 'recycle' : 'park', quotaVisible,
    resetAtHint: parseResetHintFromText(matched, now)
      ?? (!quotaVisible && kind !== 'session-spend' ? now + (kind === 'weekly-rate' ? 6 : 1) * 3600_000 : null),
  };
}
