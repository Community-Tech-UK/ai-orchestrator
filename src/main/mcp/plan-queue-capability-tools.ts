import { z } from 'zod';
import { PlanQueueReportCapabilityGapArgsSchema, PlanQueueReportCapabilityProbeArgsSchema,
  PlanQueueReportCapabilityCheckArgsSchema, PlanQueueCapabilityControlArgsSchema } from '@contracts/schemas/plan-queue';

export const CAPABILITY_TOOL_SPECS = {
  plan_queue_report_capability_gap: {
    description: 'Assigned queue triage, worker or checker only: record a missing test ability after investigating the available tools and safe alternatives. Give item_id, or run_id and document_path for triage. Evidence must be redacted, bounded and recent. The coordinator derives authority and source identity; a report never grants permissions. Technical gaps create a linked bounded repair plan; keep original acceptance open and end the turn. No nested repairs.',
    inputSchema: z.toJSONSchema(PlanQueueReportCapabilityGapArgsSchema),
  },
  plan_queue_report_capability_probe: {
    description: 'Current independent checker of a capability repair only: attest the new runtime control on the reviewed checkpoint using a durable, ignored relative JSON receipt. The receipt has launch (the actual AIO_DEV_APP_RECEIPT object), runtime {application,version,isPackaged} read back from the running app, operation, result and observedAt. Build with dev-app start --checked-tree <checkpoint tree>; the coordinator validates its source tree, time, digest and location. Evidence is retained before worktree cleanup. This never passes the originating check.',
    inputSchema: z.toJSONSchema(PlanQueueReportCapabilityProbeArgsSchema),
  },
  plan_queue_report_capability_check: {
    description: 'Current independent checker of an original item only: record that one exact originating check now passes after its linked capability repair. Give the exact check text from plan_queue_status, repair_id and concrete evidence. This resolves only that check after ordinary PASS and landing; remaining checks and genuine human boundaries stay open.',
    inputSchema: z.toJSONSchema(PlanQueueReportCapabilityCheckArgsSchema),
  },
  plan_queue_authorize_capability_repairs: {
    description: 'Owning parent session only: authorise implementation of capability repair plans in this run’s own repository when the existing user task includes repairing missing test abilities. Use run_id and the canonical repository path. Also retries a waiting preflight for an unstarted repair. Cross-project scope and additional permissions are never inferred. Capture and design already work without this; this enables automatic implementation under the original routing and account restrictions.',
    inputSchema: z.toJSONSchema(PlanQueueCapabilityControlArgsSchema),
  },
} as const;
