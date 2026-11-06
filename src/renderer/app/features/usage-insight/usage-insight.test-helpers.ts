/**
 * Builders for "Where your usage went" reports, used only by the renderer specs.
 */

import { isCauseShown, sharePercent } from '../../../../shared/usage-insight/usage-cause-rules';
import {
  USAGE_CAUSE_IDS,
  type UsageCauseId,
  type UsageCauseResult,
  type UsageInsightReport,
} from '../../../../shared/usage-insight/usage-insight.types';

/**
 * `null` means the cause could not be measured. A missing cause is 0%. A fraction such as
 * 9.5 is an exact share whose label rounds up to 10, so it must stay hidden, as in the
 * real calculator.
 */
export function reportWith(
  percents: Partial<Record<UsageCauseId, number | null>>,
  overrides: Partial<UsageInsightReport> = {},
  details: Partial<Record<UsageCauseId, Partial<UsageCauseResult>>> = {},
): UsageInsightReport {
  const causes = USAGE_CAUSE_IDS.map((id): UsageCauseResult => {
    const percent = percents[id] === undefined ? 0 : percents[id];
    if (percent === null) {
      return { id, share: null, percent: null, shown: false, requests: 0, sessions: 0, unavailable: 'effort-not-recorded', ...details[id] };
    }
    const share = percent / 100;
    return {
      id, share, percent: sharePercent(share), shown: isCauseShown(share),
      requests: percent > 0 ? 40 : 0, sessions: percent > 0 ? 3 : 0, ...details[id],
    };
  });
  return {
    generatedAt: 1_000,
    windowStart: 0,
    windowEnd: 1_000,
    scope: { kind: 'all' },
    totals: { requests: 1_200, sessions: 14, harnessSessions: 9 },
    causes,
    coverage: { effortKnown: 1, harnessLinked: 0.8 },
    notes: [],
    ...overrides,
  };
}
