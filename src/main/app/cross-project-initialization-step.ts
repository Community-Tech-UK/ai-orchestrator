/**
 * Cross-project patterns boot step — permission persistence, durable
 * approvals, ACP yolo auto-approve, and plan-mode tools.
 *
 * Extracted from the late-runtime initialization list so that file stays
 * under the hard 700-line cap. Behaviour is unchanged.
 */

import { getLogger } from '../logging/logger';
import { getRLMDatabase } from '../persistence/rlm-database';
import { getDocReviewService } from '../doc-review/doc-review-service';
import { getAgentTreePersistence } from '../session/agent-tree-persistence';
import { getPermissionRegistry } from '../orchestration/permission-registry';
import { getOrchestrationSnapshotManager } from '../orchestration/orchestration-snapshot';
import { getWorkflowManager } from '../workflows/workflow-manager';
import { getPermissionManager } from '../security/permission-manager';
import { PermissionDecisionStore } from '../security/permission-decision-store';
import { WorkflowPersistence } from '../workflows/workflow-persistence';
import { registerAcpYoloAutoApproval } from './permission-auto-approval';
import type { InstanceManager } from '../instance/instance-manager';
import type { AppInitializationStep } from './initialization-steps';

const logger = getLogger('AppInitialization');

export function createCrossProjectPatternsStep(
  instanceManager: InstanceManager,
): AppInitializationStep {
  return {
    name: 'Cross-project patterns',
    fn: () => {
      getAgentTreePersistence().initialize().catch((err) => {
        logger.warn('Agent tree persistence initialization failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });

      try {
        const decisionStore = new PermissionDecisionStore(getRLMDatabase().getRawDb());
        getPermissionManager().setDecisionStore(decisionStore);
      } catch (err) {
        logger.warn('Failed to initialize permission decision store', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      try {
        const workflowPersistence = new WorkflowPersistence(getRLMDatabase().getRawDb());
        getWorkflowManager().setPersistence(workflowPersistence);
      } catch (err) {
        logger.warn('Failed to initialize workflow persistence', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const permissionRegistry = getPermissionRegistry();
      instanceManager.on('instance:removed', (instanceId: string) => {
        permissionRegistry.clearForInstance(instanceId);
        getOrchestrationSnapshotManager().clearForInstance(instanceId);
      });

      // Durable approval store — mirrors PermissionRegistry events into
      // SQLite so pending approvals survive crash/restart and can be
      // audited.  Side-car observer; PermissionRegistry remains the
      // synchronous source of truth.
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { DurableApprovalStore } = require(
          '../orchestration/durable-approval-store',
        ) as typeof import('../orchestration/durable-approval-store');
        const store = new DurableApprovalStore(getRLMDatabase().getRawDb());

        permissionRegistry.on('permission:requested', (req: {
          id: string;
          instanceId: string;
          action: string;
          createdAt: number;
          timeoutMs: number;
          description?: string;
          toolName?: string;
          details?: Record<string, unknown>;
        }) => {
          try {
            store.create({
              approvalId: req.id,
              instanceId: req.instanceId,
              actionKind: req.action,
              payload: {
                description: req.description,
                toolName: req.toolName,
                details: req.details,
              },
              expiresAt: req.createdAt + req.timeoutMs,
            });
          } catch (err) {
            logger.warn('Failed to persist pending approval', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });

        permissionRegistry.on('permission:resolved', (decision: {
          requestId: string;
          granted: boolean;
          decidedBy: string;
        }) => {
          try {
            store.resolve(
              decision.requestId,
              decision.granted ? 'approved' : 'denied',
              decision.decidedBy,
            );
          } catch (err) {
            logger.warn('Failed to persist approval resolution', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });

        // Phase 3: record APPROVED doc-reviews in the same durable store so loop
        // history has an audit trail of who approved which plan and when.
        getDocReviewService().setApprovalRecorder((session) => {
          try {
            store.create({
              approvalId: session.id,
              instanceId: session.instanceId,
              actionKind: 'doc-review',
              payload: { title: session.title, sourcePath: session.sourcePath },
              expiresAt: Date.now(),
            });
            store.resolve(session.id, 'approved', 'user');
          } catch (err) {
            logger.warn('Failed to record doc-review approval', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });

        logger.info('Durable approval store wired to permission registry');
      } catch (err) {
        logger.warn('Failed to initialize durable approval store', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Auto-approve ACP permission requests for instances running in yolo
      // mode. The ACP transport (cursor-agent acp, copilot acp) mediates every
      // tool action through `session/request_permission`, which the adapter
      // forwards to the PermissionRegistry. Unlike Claude's `permission_denial`
      // /`deferred_permission` prompts — already gated through the tool
      // execution gate (which honors yolo) in InstanceManager — ACP requests
      // have NO yolo-aware resolver, so in headless mode they sit unanswered
      // until the 60s timeout fires `deny`. That surfaces as "edit was blocked"
      // even though the user enabled yolo. Mirror the Browser Gateway's
      // autoApproveRequests yolo policy here so the registry resolves them
      // immediately. Registered AFTER the durable-store listeners so the
      // pending row is persisted before this listener emits `permission:resolved`.
      registerAcpYoloAutoApproval(
        permissionRegistry,
        (instanceId) => instanceManager.getInstance(instanceId)?.yoloMode === true,
        (req, err) => {
          logger.warn('Yolo auto-approve for ACP permission request failed', {
            requestId: req.id,
            instanceId: req.instanceId,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );

      // Register plan-mode agent tools bound to the live InstanceManager.
      // The returned ToolDefinitions can be exposed to debate coordinators
      // and orchestration agents that need explicit plan-mode control.
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { registerPlanModeTools } = require(
          '../tools/plan-mode-tool',
        ) as typeof import('../tools/plan-mode-tool');
        registerPlanModeTools({
          enterPlanMode: (id) => instanceManager.enterPlanMode(id),
          exitPlanMode: (id, force) => instanceManager.exitPlanMode(id, force),
          approvePlan: (id, content) => instanceManager.approvePlan(id, content),
        });
        logger.info('Plan-mode tools registered against InstanceManager');
      } catch (err) {
        logger.warn('Failed to register plan-mode tools', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      logger.info('Cross-project patterns initialized');
    },
  };
}
