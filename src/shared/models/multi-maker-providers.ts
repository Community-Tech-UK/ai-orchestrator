/**
 * Which CLIs serve models from more than one maker AND normally resolve a
 * known model for a session (their catalog supplies a default), so a checker on the same CLI can still be a genuine second
 * opinion (a different family) even when the workers' model was not named.
 *
 * Derived from the app's own model catalog rather than listed by hand, so a
 * catalog change cannot leave the Plan Queue's start check, its panel and its
 * verifier selection disagreeing. OpenCode is deliberately NOT counted: it
 * serves many makers, but it has no static catalog and its session model stays
 * unknown unless named, so a same-CLI checker can only be judged when the
 * workers' OpenCode model is named (then the families are compared directly).
 */

import { PROVIDER_MODEL_LIST } from '../types/provider.types';
import { modelFamily } from './model-family';

let cached: ReadonlySet<string> | null = null;

function multiMakerProviders(): ReadonlySet<string> {
  if (cached) return cached;
  const providers = new Set<string>();
  for (const [provider, models] of Object.entries(PROVIDER_MODEL_LIST)) {
    const families = new Set(models.map((model) => modelFamily(model.id)).filter((family) => family !== 'unknown'));
    if (families.size > 1) providers.add(provider);
  }
  cached = providers;
  return cached;
}

/** True when this CLI id (already canonical: `antigravity`, not `gemini`) serves several makers' models from its catalog. */
export function isMultiMakerProvider(provider: string): boolean {
  return multiMakerProviders().has(provider);
}

/**
 * Can a checker model on the workers' own CLI differ from the workers' model?
 * Named workers' model: the families must differ. Unnamed: only on a
 * catalog multi-maker CLI, where the live model is normally known by
 * verification time (when it is not, an unknown family never counts as a
 * collision, the same rule `sameFamily` applies everywhere else).
 */
export function sameProviderCheckerCanDiffer(
  provider: string,
  checkerModel: string | undefined,
  workerModel: string | undefined | null,
  differentFamily: (a: string, b: string) => boolean,
): boolean {
  if (!checkerModel) return false;
  return workerModel ? differentFamily(checkerModel, workerModel) : isMultiMakerProvider(provider);
}
