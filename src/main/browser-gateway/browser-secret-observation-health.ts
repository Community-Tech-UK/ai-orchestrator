import type { BrowserExtensionSecretObservationState } from './browser-extension-secret-observation-state';

/**
 * One extension's own report of secret observation protection, from its last
 * `report_inventory` answer. `reported: false` means no such answer has arrived
 * since this app started (a list_targets refresh asks for one) or the extension
 * predates 0.2.34, which does not report it.
 */
export type BrowserSecretObservationHealth =
  | {
      reported: true;
      protectionEnabled: boolean;
      taintedOriginCount: number;
      taintedTabCount: number;
      observedAt: number;
      ageMs: number;
    }
  | { reported: false };

export function toSecretObservationHealth(
  state: BrowserExtensionSecretObservationState | undefined,
  now: number,
): BrowserSecretObservationHealth {
  if (!state) {
    return { reported: false };
  }
  return {
    reported: true,
    protectionEnabled: state.protectionEnabled,
    taintedOriginCount: state.taintedOriginCount,
    taintedTabCount: state.taintedTabCount,
    observedAt: state.observedAt,
    ageMs: Math.max(0, now - state.observedAt),
  };
}

/**
 * Warn when an extension still enforces protection, or still holds taints,
 * after the operator switched the setting off. That is the state in which a
 * read after an agent sign-in comes back blocked.
 */
export function secretObservationWarnings(
  settingEnabled: boolean,
  reports: { name: string; report: BrowserSecretObservationHealth }[],
): string[] {
  if (settingEnabled) {
    return [];
  }
  return reports.flatMap(({ name, report }) => {
    if (!report.reported || (!report.protectionEnabled && report.taintedOriginCount === 0)) {
      return [];
    }
    return [
      `Browser extension on ${name} last reported secret observation protection `
      + `${report.protectionEnabled ? 'ON' : 'off'} with ${report.taintedOriginCount} tainted `
      + 'origin(s), but the Harness setting is off. Reads on those origins stay blocked until a '
      + 'command from this Harness reaches that extension; run browser.list_targets with refresh.',
    ];
  });
}
