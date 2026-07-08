export const MIN_COOLDOWN_MS = 10_000;
export const MAX_REVIEW_HISTORY = 50;
export const RATE_LIMIT_CHECK_INTERVAL_MS = 30_000;
export const AVAILABILITY_REFRESH_INTERVAL_MS = 5 * 60_000;
export const SUPPORTED_REVIEWER_CLIS = new Set(['antigravity', 'codex', 'copilot', 'cursor']);
export const SUPPORTED_AGENTIC_REVIEWER_CLIS = new Set([
  'claude',
  ...SUPPORTED_REVIEWER_CLIS,
]);

const LEGACY_REVIEWER_CLI_ALIASES: Record<string, string> = {
  gemini: 'antigravity',
};

export function normalizeReviewerCli(cliType: string): string {
  const normalized = cliType.trim().toLowerCase();
  return LEGACY_REVIEWER_CLI_ALIASES[normalized] ?? normalized;
}

function normalizeSupportedReviewerCliList(
  cliTypes: readonly string[],
  supportedClis: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const rawCliType of cliTypes) {
    const cliType = normalizeReviewerCli(rawCliType);
    if (!supportedClis.has(cliType) || seen.has(cliType)) {
      continue;
    }
    seen.add(cliType);
    normalized.push(cliType);
  }
  return normalized;
}

export function normalizeReviewerCliList(cliTypes: readonly string[]): string[] {
  return normalizeSupportedReviewerCliList(cliTypes, SUPPORTED_REVIEWER_CLIS);
}

export function normalizeAgenticReviewerCliList(cliTypes: readonly string[]): string[] {
  return normalizeSupportedReviewerCliList(cliTypes, SUPPORTED_AGENTIC_REVIEWER_CLIS);
}
