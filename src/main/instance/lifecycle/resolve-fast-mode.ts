/**
 * Resolve the fast-mode preference for a spawning instance.
 *
 * Fast mode trades some capability for faster output. Each provider maps it to
 * its own knob: Claude sets the CLI `fastMode` settings key (Opus-only, paid
 * tier); Codex requests the `priority` service tier (~1.5x speed). Providers
 * without support ignore the resolved value.
 *
 * Precedence (highest first):
 *   1. explicit config override   — `fastModeOverride` the caller asked for (also
 *      how the per-instance live toggle re-spawns with a definite state)
 *   2. per-provider remembered    — AppSettings.defaultFastModeByProvider[provider],
 *      persisted by the renderer's provider-state.service so the toggle is
 *      remembered across provider switches (mirrors defaultModelByProvider)
 *   3. global default             — AppSettings.defaultFastMode
 *
 * Unlike model resolution there is no "let the provider decide" state — fast
 * mode is simply on or off, so this always returns a definite boolean
 * (defaulting to `false`).
 */
export function resolveFastMode(params: {
  configOverride?: boolean | null;
  provider: string;
  defaultFastModeByProvider?: Record<string, boolean>;
  defaultFastMode?: boolean;
}): boolean {
  if (typeof params.configOverride === 'boolean') {
    return params.configOverride;
  }
  const perProvider = params.provider
    ? params.defaultFastModeByProvider?.[params.provider]
    : undefined;
  if (typeof perProvider === 'boolean') {
    return perProvider;
  }
  return params.defaultFastMode ?? false;
}
