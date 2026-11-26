import { z } from 'zod';
import {
  PlanQueueAccountRulesSchema, PlanQueueFolderChecklistsSchema, PlanQueueFoldersSchema, PlanQueueLinearConnectionSchema,
  PlanQueueLinearFolderLinksSchema, PlanQueueLinearTeamsSchema, PlanQueueRoutingSchema,
} from '@contracts/schemas/plan-queue';
import type { ClosedSettingsToolPolicy, OpenSettingsToolPolicy } from './settings-control-policy';

interface PolicyBuilders {
  open: (schema: z.ZodType<unknown>, restartRequired?: boolean) => OpenSettingsToolPolicy;
  readOnly: (restartRequired?: boolean, schema?: z.ZodType<unknown>) => ClosedSettingsToolPolicy;
}

/**
 * Pure policy group for the Plan Queue settings; the facade supplies the shared builders. Every operator-only key here
 * is also in PRIVILEGED_CLI_OPERATOR_ONLY_KEYS (settings-privileged-keys.ts) except `planQueueFolders`.
 */
export function createPlanQueueSettingsPolicy({ open, readOnly }: PolicyBuilders) {
  return {
    planQueueRouting: readOnly(false, PlanQueueRoutingSchema),
    planQueueQuestionsDestination: open(z.enum(['queue-page', 'parent-chat'])),
    planQueueAccountRules: readOnly(false, PlanQueueAccountRulesSchema),
    planQueueFolderChecklists: readOnly(false, PlanQueueFolderChecklistsSchema),
    planQueueFolders: readOnly(false, PlanQueueFoldersSchema),
    planQueueLinearConnection: readOnly(false, PlanQueueLinearConnectionSchema),
    planQueueLinearFolderLinks: readOnly(false, PlanQueueLinearFolderLinksSchema),
    planQueueLinearTeams: readOnly(false, PlanQueueLinearTeamsSchema),
  };
}
