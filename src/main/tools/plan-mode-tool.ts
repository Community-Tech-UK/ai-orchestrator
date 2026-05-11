/**
 * Plan-mode tool primitives — plan_enter, plan_exit, plan_approve.
 *
 * Exposes the existing InstanceManager-owned PlanModeManager as callable agent
 * tools so debate coordinators and orchestration agents can explicitly enter/
 * exit plan mode instead of encoding it implicitly.  Mirrors opencode's
 * plan.ts + plan-enter.txt / plan-exit.txt convention (claude3.md §12).
 *
 * The factory delegates to the *real* PlanModeManager owned by each
 * Instance's lifecycle (via InstanceManager.{enterPlanMode,exitPlanMode,
 * approvePlan}) rather than creating a parallel one — this ensures the tools
 * mutate the same state the IPC handlers and lifecycle observe.
 *
 * When plan_enter is called:
 *   - The instance transitions to planMode.state = 'planning'.
 *   - The derive-subagent-permission layer automatically injects a write-deny
 *     rule for any child agents spawned while in planning state.
 *
 * When plan_exit is called:
 *   - Requires planMode.state = 'approved' (the plan was acknowledged).
 *   - Transitions back to planMode.enabled = false.
 *   - Passes through an optional `force` flag for coordinator overrides.
 *
 * Usage: call `createPlanModeTools(instanceManager)` at startup; the returned
 * `tools` array can be exposed to in-process agent code or adapted to any
 * outbound tool catalog.
 */

import { z } from 'zod';
import { defineTool } from './define-tool';
import type { Instance } from '../../shared/types/instance.types';

/**
 * The subset of InstanceManager the tools need.  Kept narrow so tests can
 * provide a stub without dragging in the full manager.
 */
export interface PlanModeToolDeps {
  enterPlanMode(instanceId: string): Instance;
  exitPlanMode(instanceId: string, force?: boolean): Instance;
  approvePlan(instanceId: string, planContent?: string): Instance;
}

export function createPlanModeTools(deps: PlanModeToolDeps) {
  const planEnterTool = defineTool({
    id: 'plan_enter',
    description:
      'Enter plan mode for the current instance. While in plan mode the agent ' +
      'should reason about the plan without making any file writes. Child agents ' +
      'spawned in this state automatically inherit a write-deny permission rule. ' +
      'Call plan_exit once the plan has been presented and approved.',
    args: z.object({
      instanceId: z.string().describe('The instance to enter plan mode for.'),
    }),
    safety: { isConcurrencySafe: false, isReadOnly: false, isDestructive: false },
    execute(args) {
      const instance = deps.enterPlanMode(args.instanceId);
      return { ok: true, planMode: instance.planMode };
    },
  });

  const planExitTool = defineTool({
    id: 'plan_exit',
    description:
      'Exit plan mode for the current instance. The plan must have been approved ' +
      '(planMode.state = "approved") unless force=true is passed. After this call ' +
      'the agent may resume normal write operations.',
    args: z.object({
      instanceId: z.string().describe('The instance to exit plan mode for.'),
      force: z
        .boolean()
        .optional()
        .describe(
          'If true, exit plan mode even if the plan has not been approved. ' +
          'Only for coordinator use.',
        ),
    }),
    safety: { isConcurrencySafe: false, isReadOnly: false, isDestructive: false },
    execute(args) {
      const instance = deps.exitPlanMode(args.instanceId, args.force ?? false);
      return { ok: true, planMode: instance.planMode };
    },
  });

  const planApproveTool = defineTool({
    id: 'plan_approve',
    description:
      'Approve the current plan for an instance in plan mode. Transitions ' +
      'planMode.state from "planning" to "approved". Call plan_exit afterward ' +
      'to resume normal execution.',
    args: z.object({
      instanceId: z.string().describe('The instance whose plan to approve.'),
      planContent: z
        .string()
        .optional()
        .describe('Optional updated plan text to persist with the approval.'),
    }),
    safety: { isConcurrencySafe: false, isReadOnly: false, isDestructive: false },
    execute(args) {
      const instance = deps.approvePlan(args.instanceId, args.planContent);
      return { ok: true, planMode: instance.planMode };
    },
  });

  return {
    planEnterTool,
    planExitTool,
    planApproveTool,
    tools: [planEnterTool, planExitTool, planApproveTool],
  };
}

let cached: ReturnType<typeof createPlanModeTools> | null = null;

/**
 * Register the plan-mode tool factory once at startup with a live
 * InstanceManager.  Subsequent calls return the cached tools.
 */
export function registerPlanModeTools(deps: PlanModeToolDeps): ReturnType<typeof createPlanModeTools> {
  if (!cached) cached = createPlanModeTools(deps);
  return cached;
}

export function getPlanModeTools(): ReturnType<typeof createPlanModeTools> | null {
  return cached;
}

export function _resetPlanModeToolsForTesting(): void {
  cached = null;
}
