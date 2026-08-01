/**
 * IPC channels for Doctor diagnostics, operator artifacts, and CLI update pill state.
 */
export const DIAGNOSTICS_CHANNELS = {
  DIAGNOSTICS_GET_DOCTOR_REPORT: 'diagnostics:get-doctor-report',
  DIAGNOSTICS_GET_SKILL_DIAGNOSTICS: 'diagnostics:get-skill-diagnostics',
  DIAGNOSTICS_GET_INSTRUCTION_DIAGNOSTICS: 'diagnostics:get-instruction-diagnostics',
  DIAGNOSTICS_EXPORT_ARTIFACT_BUNDLE: 'diagnostics:export-artifact-bundle',
  DIAGNOSTICS_REVEAL_BUNDLE: 'diagnostics:reveal-bundle',
  CONTEXT_ATTRIBUTION_GET: 'diagnostics:context-attribution-get',
  CACHE_ANALYTICS_GET: 'diagnostics:cache-analytics-get',
  /** WS-C6: per-instance context-manifest epoch history (observability-only). */
  CONTEXT_MANIFEST_GET: 'context:manifest-for-instance',
  CLI_UPDATE_PILL_GET_STATE: 'cli-update-pill:get-state',
  CLI_UPDATE_PILL_REFRESH: 'cli-update-pill:refresh',
  CLI_UPDATE_PILL_DELTA: 'cli-update-pill:delta',
} as const;
