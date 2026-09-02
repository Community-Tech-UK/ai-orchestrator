/**
 * The cross-model checking policy as it applies to a CLI verification panel.
 *
 * WHY ONLY FAMILY DIVERSITY HERE
 * ------------------------------
 * A verification panel fans several agents at one prompt, so — like consensus —
 * it has no "implementer" to differ from. What it does need is that the agents
 * are genuinely different models. Picking N different CLIs is not sufficient:
 * Copilot and Cursor each front several vendors, so two panel members can share
 * a vendor and produce corroboration that looks independent but isn't.
 *
 * Licence containment is NOT applied, and that is deliberate rather than an
 * omission — but the reason is narrower than it first looks, so state it exactly.
 *
 * The live route is `/verification` → `VERIFICATION_START_CLI` →
 * `CliVerificationCoordinator`, and that coordinator initialises every agent with
 * `process.cwd()` (`cli-verification-extension.ts`), never a user workspace. The
 * dashboard's folder picker feeds a *preflight* check only; it is never sent with
 * the run. So this surface reads no employer workspace and there is nothing to
 * contain.
 *
 * `MultiVerifyCoordinator` is a SEPARATE class whose panel spawn (`runAgent` →
 * the `verification:invoke-agent` handler) resolves
 * `params.workingDirectory || instance?.workingDirectory || process.cwd()` — it
 * genuinely CAN run in a user workspace. It is safe today only because its
 * `verify:start` channel, while present in the generated channel list, is not
 * exposed by any `contextBridge` function and so is unreachable from the
 * renderer. If that channel is ever wired up, this policy must switch to the full
 * `resolveCheckerPlan` treatment and be handed the run's real cwd.
 */

import { getLogger } from '../logging/logger';
import { FAMILY_PREFERENCE, providerModelForFamily } from '../review/checker-plan';
import { resolveReviewerModelOverride } from '../review/reviewer-model-override';
import { modelFamily, type ModelFamily } from '../../shared/models/model-family';

const logger = getLogger('VerificationCheckingPolicy');

/**
 * Assigns each verification agent a model, one agent at a time.
 *
 * PER-OCCURRENCE, not per-CLI name. An earlier version returned a
 * `Map<cliName, model>`, which silently collapsed a panel containing the same
 * CLI twice: both occurrences read the one entry and got the SAME model — the
 * "corroboration that looks independent but isn't" this exists to prevent. The
 * IPC schema for `cliAgents` has no uniqueness constraint, so duplicates are a
 * permitted input even though today's picker cannot produce them.
 *
 * The returned function is stateful and must be called once per agent actually
 * constructed, in construction order. Returning `undefined` means "leave this
 * agent on its own routing".
 *
 * Deliberately conservative: an agent is only re-modelled when its model is
 * POSITIVELY identified as a family the panel already occupies. An
 * unidentifiable model is left alone rather than pinned, so this never quietly
 * takes over routing for a panel that had no collision.
 */
export function createVerificationModelAssigner(): (cli: string) => string | undefined {
  const used = new Set<ModelFamily>();

  return (cli: string): string | undefined => {
    const family = modelFamily(resolveReviewerModelOverride(cli));
    if (family === 'unknown') return undefined;
    if (!used.has(family)) {
      used.add(family);
      return undefined;
    }
    // Collision: this agent would duplicate a vendor already on the panel.
    for (const candidate of FAMILY_PREFERENCE) {
      if (used.has(candidate)) continue;
      const model = providerModelForFamily(cli, candidate);
      if (model) {
        used.add(candidate);
        logger.info('Verification agent re-modelled for family diversity', {
          cli,
          model,
          from: family,
          to: candidate,
        });
        return model;
      }
    }
    return undefined;
  };
}
