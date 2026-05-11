/**
 * Plan-mode tool primitives — plan_enter, plan_exit, plan_approve.
 *
 * Exposes the existing PlanModeManager as callable agent tools so debate
 * coordinators and orchestration agents can explicitly enter/exit plan mode
 * instead of encoding it implicitly.  Mirrors opencode's plan.ts + plan-enter.txt
 * / plan-exit.txt convention (claude3.md §12).
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
 * Usage: call `createPlanModeTools(instanceManager)` at startup and register
 * the returned tools with the ToolRegistry.
 */

import { z } from 'zod';
import { EventEmitter } from 'events';
import { defineTool } from './define-tool';
import { PlanModeManager } from '../instance/lifecycle/plan-mode-manager';
import type { Instance } from '../../shared/types/instance.types';

export interface PlanModeToolDeps {
  getInstance(id: string): Instance | undefined;
}

export function createPlanModeTools(deps: PlanModeToolDeps) {
  const emitter = new EventEmitter();
  const manager = new PlanModeManager({ getInstance: deps.getInstance }, emitter);

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
      const instance = manager.enterPlanMode(args.instanceId);
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
      const instance = manager.exitPlanMode(args.instanceId, args.force ?? false);
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
      const instance = manager.approvePlan(args.instanceId, args.planContent);
      return { ok: true, planMode: instance.planMode };
    },
  });

  return { planEnterTool, planExitTool, planApproveTool, manager, emitter };
}
