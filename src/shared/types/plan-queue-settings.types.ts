import type {
  PlanQueueAccountRules, PlanQueueFolderChecklist, PlanQueueLinearConnection, PlanQueueLinearFolderLink, PlanQueueLinearTeam, PlanQueueRouting,
} from '@contracts/schemas/plan-queue';

/** Plan Queue settings: where the queue asks for help, and the operator's routing, account, folder and Linear choices. */
export interface PlanQueueSettings {
  planQueueQuestionsDestination: 'queue-page' | 'parent-chat';
  /** Providers and accounts Plan Queue sessions may use. Operator-only, edited on the Plan Queue page. */
  planQueueRouting: PlanQueueRouting;
  /** Accounts Plan Queue sessions and new automation sessions must never use, or should use last. Operator-only, edited on the Plan Queue page; queue sessions read it live, automation runs when they start. */
  planQueueAccountRules: PlanQueueAccountRules;
  /** Saved checklist per project folder; beats the gates a session passes to `plan_queue_start`. Operator-only, edited on the Plan Queue page. */
  planQueueFolderChecklists: PlanQueueFolderChecklist[];
  /** The project folders a session may start a Plan Queue run in from another folder (`plan_queue_start`'s `workspace`). Edited on the Plan Queue page, or by a session James asks through `$AIO_MCP settings set`; closed to `set_setting`. */
  planQueueFolders: string[];
  /** The Harness connector Linear is reached through and the Linear user James confirmed. `null` until he confirms. Operator-only. */
  planQueueLinearConnection: PlanQueueLinearConnection;
  /** Which Linear projects belong to which project folder. Operator-only, edited on the Plan Queue page. */
  planQueueLinearFolderLinks: PlanQueueLinearFolderLink[];
  /** Per Linear team: status mapping and the providers allowed to see its ticket text. Operator-only, edited on the Plan Queue page. */
  planQueueLinearTeams: PlanQueueLinearTeam[];
}
