/**
 * S3.4 — notices for settings that are internally inconsistent.
 *
 * These are the cases where nothing is broken enough to throw and nothing is
 * wrong enough to be a validation error, but the combination does not do what
 * the operator plainly intends: a quiet-hours window configured with quiet
 * hours switched off, a local reviewer enabled with no model selected. Each of
 * these reads as "the feature is on" from the settings page and does nothing at
 * runtime, which is the exact failure this backlog keeps finding.
 *
 * Distinct from S5's doctor: the doctor checks a value against its OWN declared
 * constraints (range, JSON syntax, path exists). These check a value against
 * ANOTHER value. That is why the shape is a predicate over the whole settings
 * object rather than per-key metadata.
 *
 * **Each notice names the one tab it belongs on.** The catalogue entry describes
 * evaluating notices "over effective settings" with no mention of tabs, and the
 * naive reading is one global banner — which would put "Loop Mode uses its own
 * threshold" on the Keyboard tab, where it means nothing. A notice shows beside
 * the control it is about or it is noise.
 */

/** How much the mismatch matters. Nothing here is fatal, by construction. */
export type HealthNoticeSeverity = 'warning' | 'info';

export interface SettingsHealthNotice {
  id: string;
  severity: HealthNoticeSeverity;
  /** The settings-nav tab id this belongs beside. */
  tab: string;
  /** True when the notice applies to these settings. */
  isActive: (settings: Record<string, unknown>) => boolean;
  /** What is wrong and what to do, in one or two sentences. */
  message: (settings: Record<string, unknown>) => string;
}

const bool = (v: unknown): boolean => v === true;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback);

/** `[]`, `{}`, whitespace and unparseable text all count as "nothing configured". */
function isEmptyJsonList(raw: unknown): boolean {
  const text = str(raw).trim();
  if (!text) return true;
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.length === 0;
    if (parsed && typeof parsed === 'object') return Object.keys(parsed).length === 0;
    return true;
  } catch {
    // Malformed JSON is the doctor's finding, not this one — but it is also
    // certainly not a working endpoint list, so local-first has nothing to use.
    return true;
  }
}

/** The loop's own context-recycle default (`loop.types.ts` `resetAtUtilization`). */
const LOOP_RESET_AT_UTILIZATION = 0.85;

export const SETTINGS_HEALTH_NOTICES: readonly SettingsHealthNotice[] = [
  {
    id: 'quiet-hours-configured-while-disabled',
    severity: 'info',
    tab: 'general',
    // A window that differs from the shipped 22:00–07:00 is a deliberate edit.
    // Flagging the untouched default would tell every fresh install that it has
    // "configured" something it has not.
    isActive: (s) =>
      !bool(s['notificationQuietHoursEnabled'])
      && (num(s['notificationQuietHoursStartHour'], 22) !== 22
        || num(s['notificationQuietHoursEndHour'], 7) !== 7),
    message: (s) =>
      `Quiet hours are set to ${num(s['notificationQuietHoursStartHour'], 22)}:00–`
      + `${num(s['notificationQuietHoursEndHour'], 7)}:00 but quiet hours are switched off, `
      + 'so notifications will still arrive during that window. Turn quiet hours on to use it.',
  },
  {
    id: 'cross-model-review-local-no-selector',
    severity: 'warning',
    tab: 'review',
    // Deliberately NOT gated on the operator having changed anything: both
    // halves are shipped defaults, so this fires on a fresh install — and it is
    // telling the truth. The control is on and currently does nothing.
    isActive: (s) =>
      bool(s['crossModelReviewLocalEnabled']) && str(s['crossModelReviewLocalSelectorId']).trim() === '',
    message: () =>
      'Local cross-model review is enabled but no local model is selected, so no local review runs. '
      + 'Choose a model, or turn local review off.',
  },
  {
    id: 'remote-nodes-no-tls-open-bind',
    severity: 'warning',
    tab: 'remote-nodes',
    // Gated on the feature being on. Warning every installation about TLS for a
    // server nobody started is the "annoying, not earned" failure UX5 exists to
    // avoid — and it would train people to ignore this class of notice.
    isActive: (s) =>
      bool(s['remoteNodesEnabled'])
      && !bool(s['remoteNodesRequireTls'])
      && str(s['remoteNodesServerHost']).trim() === '0.0.0.0',
    message: () =>
      'The remote-node server accepts connections from any address with TLS not required, '
      + 'so enrolment tokens and node traffic cross the network unencrypted. '
      + 'Require TLS, or bind to 127.0.0.1.',
  },
  {
    id: 'auxiliary-local-first-no-endpoints',
    severity: 'warning',
    tab: 'auxiliary-models',
    // Localhost Ollama is itself a local endpoint, so "local-first with nothing
    // local configured" is only true when that is off too.
    isActive: (s) =>
      str(s['auxiliaryLlmRoutingMode']) === 'local-first'
      && !bool(s['auxiliaryLlmUseLocalhostOllama'])
      && isEmptyJsonList(s['auxiliaryLlmEndpointsJson']),
    message: () =>
      'Routing prefers local models, but no local endpoint is configured and localhost Ollama is off, '
      + 'so every auxiliary call falls through to a paid model. '
      + 'Add an endpoint, enable localhost Ollama, or change the routing mode.',
  },
  {
    id: 'loop-uses-its-own-context-threshold',
    severity: 'info',
    tab: 'memory',
    // T3. Always true by design: it is not a misconfiguration, it is a fact the
    // settings page otherwise implies the opposite of.
    isActive: () => true,
    message: (s) =>
      `Loop Mode does not use this threshold. It recycles its own context at `
      + `${Math.round(LOOP_RESET_AT_UTILIZATION * 100)}% utilisation, set per run in the loop panel, `
      + `independently of the ${num(s['contextWarningThreshold'], 80)}% warning here.`,
  },
];

/** Active notices for one tab, in registry order. */
export function activeHealthNotices(
  settings: Record<string, unknown>,
  tab: string,
  registry: readonly SettingsHealthNotice[] = SETTINGS_HEALTH_NOTICES,
): SettingsHealthNotice[] {
  return registry.filter((notice) => notice.tab === tab && notice.isActive(settings));
}

/** Every active notice regardless of tab — for a CLI report or a test. */
export function allActiveHealthNotices(
  settings: Record<string, unknown>,
  registry: readonly SettingsHealthNotice[] = SETTINGS_HEALTH_NOTICES,
): SettingsHealthNotice[] {
  return registry.filter((notice) => notice.isActive(settings));
}
