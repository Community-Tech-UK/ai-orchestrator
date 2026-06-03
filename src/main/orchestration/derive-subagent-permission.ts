/**
 * Subagent permission derivation.
 *
 * When an orchestration coordinator spawns a child/subagent instance, the
 * parent's deny rules must be forwarded so the child cannot bypass restrictions
 * that were deliberately set on the parent (e.g. Plan Mode file-write deny,
 * external-directory rules, yolo-mode restrictions).
 *
 * Inspired by opencode:src/agent/subagent-permissions.ts and the recommendation
 * in claude3.md §3.
 *
 * Usage:
 *   const rules = deriveSubagentRules({ parentSessionId, parentManager, subagentRole });
 *   for (const rule of rules) {
 *     manager.addSessionRule(subagentSessionId, rule);
 *   }
 */

import type { PermissionRule, PermissionScope, PermissionAction } from '../security/permission-manager';
import type { PermissionManager } from '../security/permission-manager';
import { getLogger } from '../logging/logger';

const logger = getLogger('DeriveSubagentPermission');

/** Scopes where subagents are default-denied unless the parent explicitly allows. */
const SUBAGENT_DEFAULT_DENY_SCOPES: PermissionScope[] = [
  'bash_dangerous',
  'environment_access',
  'secret_access',
];

export interface SubagentPermissionContext {
  /**
   * Instance ID of the parent agent. Session rules are stored and evaluated
   * under the requesting instance id (see PermissionManager.gatherRules), so the
   * parent's forwarded denies must be read with the SAME key — its instance id,
   * not a provider session id.
   */
  parentInstanceId: string;
  /** The shared PermissionManager instance. */
  permissionManager: PermissionManager;
  /**
   * Whether the parent has Plan Mode active (deny all file writes).
   * When true, the derived rules will also deny file writes for the child.
   */
  parentPlanModeActive?: boolean;
  /**
   * Extra working-directory restrictions from the parent (external_directory).
   * Any deny rules scoped to these directories are forwarded verbatim.
   */
  parentExternalDirectories?: string[];
  /**
   * When true, impose the stricter subagent default-denies (secrets, env,
   * dangerous bash) REGARDLESS of the parent's own grants. Off by default: the
   * baseline forwards only the parent's actual denies (child ≤ parent) so
   * existing child workflows that legitimately use env/bash are not broken.
   * Enable to give subagents less trust than their parent.
   */
  includeDefaultDenies?: boolean;
}

/**
 * Derives the set of permission rules to apply to a newly-spawned subagent
 * so that it inherits its parent's deny constraints.
 *
 * Returns Omit<PermissionRule, 'id' | 'source'> objects ready to pass to
 * `permissionManager.addSessionRule(subagentSessionId, rule)`.
 */
export function deriveSubagentRules(
  ctx: SubagentPermissionContext,
): Array<Omit<PermissionRule, 'id' | 'source'>> {
  const derived: Array<Omit<PermissionRule, 'id' | 'source'>> = [];

  // ── 1. Forward the parent's session-level deny rules ───────────────────────
  // These include Plan Mode rules and any ad-hoc denies the user set during
  // the parent's session. We copy deny actions only; allow/ask rules are not
  // forwarded because the child may legitimately need to ask on its own.
  const parentSessionRules = getParentSessionDenyRules(ctx);
  for (const rule of parentSessionRules) {
    derived.push({
      name: `inherited:${rule.name}`,
      description: `Inherited from parent ${ctx.parentInstanceId}: ${rule.description ?? ''}`,
      scope: rule.scope,
      pattern: rule.pattern,
      action: 'deny',
      priority: rule.priority,
      enabled: true,
      expiresAt: rule.expiresAt,
      conditions: rule.conditions,
    });
  }

  // ── 2. Plan Mode forwarding ────────────────────────────────────────────────
  // If the parent is in Plan Mode (no writes), the child must also be blocked
  // from writing. Without this, a child spawned during planning could bypass it.
  if (ctx.parentPlanModeActive) {
    const writeDenyScopes: PermissionScope[] = [
      'file_write',
      'file_delete',
      'directory_create',
      'directory_delete',
      'git_operation',
    ];
    for (const scope of writeDenyScopes) {
      // Only add if the parent hasn't already forwarded a more specific rule
      const alreadyCovered = derived.some((r) => r.scope === scope && r.action === 'deny');
      if (!alreadyCovered) {
        derived.push({
          name: 'plan-mode:no-writes',
          description: 'Parent is in Plan Mode; writes denied for subagent',
          scope,
          pattern: '**',
          action: 'deny' as PermissionAction,
          priority: 10,
          enabled: true,
        });
      }
    }
    logger.debug('Plan Mode active on parent — forwarded write-deny rules to subagent');
  }

  // ── 3. External-directory restrictions ────────────────────────────────────
  // If the parent is restricted from accessing directories outside the workspace,
  // those restrictions carry to the child so it can't open a backdoor.
  for (const dir of ctx.parentExternalDirectories ?? []) {
    const alreadyCovered = derived.some(
      (r) => r.scope === 'directory_read' && r.pattern === dir && r.action === 'deny',
    );
    if (!alreadyCovered) {
      derived.push({
        name: `external-dir:${dir}`,
        description: `External directory restriction inherited from parent`,
        scope: 'directory_read' as PermissionScope,
        pattern: dir,
        action: 'deny' as PermissionAction,
        priority: 20,
        enabled: true,
      });
    }
  }

  // ── 4. Subagent default denies (opt-in) ────────────────────────────────────
  // When enabled, subagents are given less trust than the parent: they cannot
  // access secrets, environment variables, or execute dangerous shell commands.
  // Off by default so the baseline preserves the child ≤ parent invariant
  // without newly breaking children that legitimately use env/bash.
  if (ctx.includeDefaultDenies) {
    for (const scope of SUBAGENT_DEFAULT_DENY_SCOPES) {
      const alreadyCovered = derived.some((r) => r.scope === scope);
      if (!alreadyCovered) {
        derived.push({
          name: `subagent-default-deny:${scope}`,
          description: `Default deny for ${scope} in subagent context`,
          scope,
          pattern: '**',
          action: 'deny' as PermissionAction,
          priority: 100,
          enabled: true,
        });
      }
    }
  }

  logger.debug(`Derived ${derived.length} permission rule(s) for subagent of ${ctx.parentInstanceId}`);
  return derived;
}

/**
 * Applies derived subagent rules to the given session via the permission manager.
 * Convenience wrapper around deriveSubagentRules + addSessionRule.
 */
export function applySubagentPermissions(
  subagentInstanceId: string,
  ctx: SubagentPermissionContext,
): void {
  const rules = deriveSubagentRules(ctx);
  for (const rule of rules) {
    // Keyed by the child's INSTANCE id so the evaluator (gatherRules, which reads
    // sessionRules by request.instanceId) actually consults these forwarded denies.
    ctx.permissionManager.addSessionRule(subagentInstanceId, rule);
  }
  if (rules.length > 0) {
    logger.info(
      `Applied ${rules.length} derived permission rule(s) to subagent ${subagentInstanceId}`,
    );
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Extracts deny rules from the parent's session rules via the permission manager.
 * Falls back to empty if the manager exposes no such accessor.
 */
function getParentSessionDenyRules(ctx: SubagentPermissionContext): PermissionRule[] {
  try {
    // Session-temporary rules are keyed by instance id (the same key the
    // evaluator reads in gatherRules), so read the parent's denies by its
    // instance id — NOT via getRuleSet, which only holds persistent rule sets.
    return ctx.permissionManager.getSessionDenyRules(ctx.parentInstanceId);
  } catch {
    logger.warn('Could not read parent session rules; proceeding without forwarding');
    return [];
  }
}
