/**
 * Real implementations behind `aio-mcp copilot-account`.
 *
 * Every value returned is field-picked by hand. The profile records held in
 * settings and the route outcomes produced by the resolver both carry more than
 * this CLI should ever print — and unlike the renderer, this output goes to a
 * terminal that can be piped, pasted into a chat, or captured in a log. The
 * contracts module re-parses these through `.strict()` schemas so a field added
 * upstream fails loudly here rather than leaking quietly.
 */

import type { CopilotAccountCliOperations } from './copilot-account-cli-contracts';
import { getCopilotAccountBindingService } from '../providers/copilot/copilot-account-binding-service';
import { getCopilotAccountRoutingService } from '../providers/copilot/copilot-account-routing-service';
import { buildCopilotAccountDoctorReport } from '../providers/copilot/copilot-account-doctor';
import { getCopilotAccountStore } from '../providers/copilot/copilot-account-store';
import type {
  CopilotInvocationOrigin,
  CopilotRoutingMatcher,
} from '../../shared/types/copilot-account.types';

/** A rule's target as one readable string; no filesystem path is ever a target
 *  except a `path-prefix`, which IS the workspace the user themselves chose. */
function describeMatcher(matcher: CopilotRoutingMatcher): { kind: string; target: string } {
  switch (matcher.type) {
    case 'repository':
      return { kind: 'repository', target: `${matcher.host}/${matcher.owner}/${matcher.repo}` };
    case 'owner':
      return { kind: 'owner', target: `${matcher.host}/${matcher.owner}/*` };
    case 'path-prefix':
      return { kind: 'folder', target: matcher.canonicalPath };
  }
}

export function createDefaultCopilotAccountCliOperations(): CopilotAccountCliOperations {
  return {
    async list() {
      const store = getCopilotAccountStore();
      const bindings = getCopilotAccountBindingService();
      return Promise.all(
        store.listProfiles().map(async (profile) => {
          const binding = await bindings.checkBinding(profile);
          return {
            id: profile.id,
            label: profile.label,
            expectedLogin: profile.expectedLogin,
            host: profile.host,
            accountKind: profile.accountKind,
            scopePolicy: profile.scopePolicy,
            automationPolicy: profile.automationPolicy,
            isDefault: profile.isDefault,
            ...(profile.isLegacy ? { isLegacy: true } : {}),
            bindingState: binding.state,
            ...(binding.observedLogin ? { observedLogin: binding.observedLogin } : {}),
          };
        }),
      );
    },

    async rules() {
      return getCopilotAccountStore()
        .listRules()
        .map((rule) => ({
          id: rule.id,
          profileId: rule.profileId,
          ...describeMatcher(rule.matcher),
          isProtected: rule.isProtected,
        }));
    },

    async route(workingDirectory: string, origin?: string) {
      // The answer DEPENDS on the origin: `automationPolicy` and the provider
      // exclusion list only bite for automatic origins, so a workspace can
      // preview fine as `interactive` and be refused for every automation. The
      // default matches the renderer's own preview, but it is echoed back in
      // the result so the assumption is visible rather than implied.
      const effectiveOrigin = (origin ?? 'interactive') as CopilotInvocationOrigin;
      const outcome = await getCopilotAccountRoutingService().resolveRouteForSpawn({
        workingDirectory,
        origin: effectiveOrigin,
      });
      if (outcome.ok) {
        return {
          ok: true,
          profileId: outcome.route.profileId,
          profileLabel: outcome.route.profileLabel ?? null,
          source: outcome.route.source as string,
          detail: null,
          origin: effectiveOrigin,
        };
      }
      return {
        ok: false,
        profileId: outcome.profileId ?? null,
        profileLabel: null,
        source: outcome.code as string,
        detail: outcome.detail,
        origin: effectiveOrigin,
      };
    },

    async doctor() {
      const report = await buildCopilotAccountDoctorReport();
      return {
        aggregate: report.aggregate,
        nodeId: report.nodeId,
        legacyMigrationInUse: report.legacyMigrationInUse,
        ambientTokenVariablesPresent: [...report.ambientTokenVariablesPresent],
        unreachableRuleIds: [...report.unreachableRuleIds],
        conflictingRuleIds: [...report.conflictingRuleIds],
        warnings: [...report.warnings],
      };
    },
  };
}
