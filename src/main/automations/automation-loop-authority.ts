import { detectConvergeUntilCleanIntent } from '../../shared/utils/loop-intent';
import type { AutomationAction } from '../../shared/types/automation.types';
import { refuseAutomationAuthority } from './automation-execution-authority';

/** Raw nested runtime options are not part of the scheduled-loop contract. */
export function assertAutomationLoopShape(action: AutomationAction): void {
  if (!action.loop || !action.executionAuthority) return;
  if (detectConvergeUntilCleanIntent(action.prompt).matched) {
    refuseAutomationAuthority('the requested independent reviewer cannot enforce the saved limits');
  }
  const supported = new Set(['verifyCommand', 'isolateWorkspace', 'maxIterations', 'maxCostCents', 'loopRecipe']);
  if (Object.keys(action.loop).some(key => !supported.has(key))) refuseAutomationAuthority('unknown nested loop configuration');
  if (action.forceNodeId || action.executionProfile === 'contained') refuseAutomationAuthority('this loop cannot enforce remote or contained execution');
}
