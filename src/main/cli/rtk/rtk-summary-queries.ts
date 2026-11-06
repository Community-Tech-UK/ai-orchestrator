/**
 * SQL for the RTK savings picture (A13, Step 18a).
 *
 * The old numbers summed `saved_tokens` across every row, which counted RTK's
 * byte arithmetic on `rtk proxy`/`rtk fallback` rows that shortened nothing —
 * about 1,000x inflation on the real history (raw 26,154M vs 25.2M capped).
 * These queries count only rows RTK actually shortened and cap each row at a
 * host output limit, so the Savings tab reports a number a person can believe.
 */

/**
 * Per-row savings are capped here. Claude Code's default Bash output limit is
 * 30,000 characters, about 7,500 tokens; Codex and Copilot limits differ, so
 * treat the cap — and everything derived from it — as an estimate.
 */
export const HOST_OUTPUT_CAP_TOKENS = 7_500;

/** Rows RTK ran through unfiltered: nothing was shortened. */
export const RAN_IN_FULL_CLAUSE = "(rtk_cmd LIKE 'rtk proxy%' OR rtk_cmd LIKE 'rtk fallback%')";

// Positive recorded savings distinguish actual shortening from filter routing.
export const SHORTENED_CLAUSE = `NOT ${RAN_IN_FULL_CLAUSE} AND COALESCE(saved_tokens, 0) > 0`;

export const CAPPED_SAVED = `MAX(0, MIN(COALESCE(saved_tokens, 0), ${HOST_OUTPUT_CAP_TOKENS}))`;

/**
 * Totals for one filter window. `filterClause` is `''` or `WHERE ...` with the
 * caller's parameters bound in order.
 */
export function summaryTotalsSql(filterClause: string): string {
  return `SELECT
    COUNT(*) AS commands,
    COALESCE(SUM(CASE WHEN ${RAN_IN_FULL_CLAUSE} THEN 1 ELSE 0 END), 0) AS commandsRanInFull,
    COALESCE(SUM(CASE WHEN ${SHORTENED_CLAUSE} THEN 1 ELSE 0 END), 0) AS commandsFiltered,
    COALESCE(SUM(CASE WHEN ${SHORTENED_CLAUSE} THEN ${CAPPED_SAVED} ELSE 0 END), 0) AS savedTokensCapped,
    CASE WHEN SUM(CASE WHEN ${SHORTENED_CLAUSE} THEN
      COALESCE(output_tokens, 0) + ${CAPPED_SAVED} ELSE 0 END) > 0
      THEN 100.0 * SUM(CASE WHEN ${SHORTENED_CLAUSE} THEN ${CAPPED_SAVED} ELSE 0 END)
        / SUM(CASE WHEN ${SHORTENED_CLAUSE} THEN
          COALESCE(output_tokens, 0) + ${CAPPED_SAVED} ELSE 0 END)
      ELSE 0 END AS weightedReductionPct,
    COALESCE(SUM(input_tokens), 0) AS totalInput,
    COALESCE(SUM(output_tokens), 0) AS totalOutput,
    COALESCE(SUM(saved_tokens), 0) AS totalSaved,
    COALESCE(AVG(savings_pct), 0) AS avgSavingsPct,
    MIN(timestamp) AS firstCommandAt,
    MAX(timestamp) AS lastCommandAt
  FROM commands
  ${filterClause}`;
}

/** Shortened-only totals grouped by the program word (`rtk git …` → `git`). */
export function summaryByProgramSql(filterClause: string): string {
  const shortenedFilter = filterClause
    ? `${filterClause} AND ${SHORTENED_CLAUSE}`
    : `WHERE ${SHORTENED_CLAUSE}`;
  return `SELECT
    substr(rtk_cmd, 5, instr(substr(rtk_cmd, 5) || ' ', ' ') - 1) AS program,
    COUNT(*) AS count,
    COALESCE(SUM(${CAPPED_SAVED}), 0) AS savedTokensCapped
  FROM commands
  ${shortenedFilter}
  GROUP BY program
  ORDER BY savedTokensCapped DESC, count DESC
  LIMIT ?`;
}

/**
 * Compliance counts. `rtk fallback%` is a bypass exactly like `rtk proxy%` —
 * the old query counted it as filtered.
 */
export function complianceSplitSql(filterClause: string): string {
  return `SELECT
    COALESCE(SUM(CASE WHEN ${RAN_IN_FULL_CLAUSE} THEN 1 ELSE 0 END), 0) AS proxied,
    COALESCE(SUM(CASE WHEN ${RAN_IN_FULL_CLAUSE} THEN 0 ELSE 1 END), 0) AS filtered
  FROM commands ${filterClause}`;
}
