/**
 * Orchestration IPC Handlers - Phase 6 features
 * Handles workflows, review agents, hooks, and skills
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../shared/types/ipc.types';
import type { InstanceManager } from '../instance/instance-manager';
import {
  validateIpcPayload,
  WorkflowGetTemplatePayloadSchema,
  WorkflowStartPayloadSchema,
  WorkflowGetExecutionPayloadSchema,
  WorkflowGetByInstancePayloadSchema,
  WorkflowCompletePhasePayloadSchema,
  WorkflowSatisfyGatePayloadSchema,
  WorkflowSkipPhasePayloadSchema,
  WorkflowCancelPayloadSchema,
  WorkflowGetPromptAdditionPayloadSchema,
  ReviewGetAgentPayloadSchema,
  ReviewStartSessionPayloadSchema,
  ReviewGetSessionPayloadSchema,
  ReviewGetIssuesPayloadSchema,
  ReviewAcknowledgeIssuePayloadSchema,
  HooksListPayloadSchema,
  HooksGetPayloadSchema,
  HooksCreatePayloadSchema,
  HooksUpdatePayloadSchema,
  HooksDeletePayloadSchema,
  HooksEvaluatePayloadSchema,
  HooksImportPayloadSchema,
  HooksExportPayloadSchema,
  HookApprovalsListPayloadSchema,
  HookApprovalsUpdatePayloadSchema,
  HookApprovalsClearPayloadSchema,
  SkillsDiscoverPayloadSchema,
  SkillsGetPayloadSchema,
  SkillsLoadPayloadSchema,
  SkillsUnloadPayloadSchema,
  SkillsLoadReferencePayloadSchema,
  SkillsLoadExamplePayloadSchema,
  SkillsMatchPayloadSchema,
} from '@contracts/schemas';
import type { ReviewAgentConfig } from '../../shared/types/review-agent.types';
import { getWorkflowManager } from '../workflows/workflow-manager';
import { getHookEngine } from '../hooks/hook-engine';
import { getHookManager } from '../hooks/hook-manager';
import { getSkillRegistry } from '../skills/skill-registry';
import {
  builtInReviewAgents,
  getReviewAgentById
} from '../agents/review-agents';
import { getReviewCoordinator } from '../agents/review-coordinator';
import {
  HookEvent,
  HookContext,
  HookRule
} from '../../shared/types/hook.types';
import { serializeLoadedSkill } from '../../shared/types/skill.types';

export function registerOrchestrationHandlers(instanceManager: InstanceManager): void {
  // ============================================
  // Workflow Handlers (6.1)
  // ============================================

  // List all workflow templates
  ipcMain.handle(
    IPC_CHANNELS.WORKFLOW_LIST_TEMPLATES,
    async (): Promise<IpcResponse> => {
      try {
        const templates = getWorkflowManager().listTemplates();
        return { success: true, data: templates };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'WORKFLOW_LIST_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get a specific workflow template
  ipcMain.handle(
    IPC_CHANNELS.WORKFLOW_GET_TEMPLATE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(WorkflowGetTemplatePayloadSchema, payload, 'WORKFLOW_GET_TEMPLATE');
        const template = getWorkflowManager().getTemplate(validated.templateId);
        if (!template) {
          return {
            success: false,
            error: {
              code: 'WORKFLOW_TEMPLATE_NOT_FOUND',
              message: `Template not found: ${validated.templateId}`,
              timestamp: Date.now()
            }
          };
        }
        return { success: true, data: template };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'WORKFLOW_GET_TEMPLATE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Start a workflow
  ipcMain.handle(
    IPC_CHANNELS.WORKFLOW_START,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(WorkflowStartPayloadSchema, payload, 'WORKFLOW_START');
        const execution = getWorkflowManager().startWorkflow(
          validated.instanceId,
          validated.templateId
        );
        return { success: true, data: execution };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'WORKFLOW_START_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get workflow execution
  ipcMain.handle(
    IPC_CHANNELS.WORKFLOW_GET_EXECUTION,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(WorkflowGetExecutionPayloadSchema, payload, 'WORKFLOW_GET_EXECUTION');
        const execution = getWorkflowManager().getExecution(
          validated.executionId
        );
        if (!execution) {
          return {
            success: false,
            error: {
              code: 'WORKFLOW_EXECUTION_NOT_FOUND',
              message: `Execution not found: ${validated.executionId}`,
              timestamp: Date.now()
            }
          };
        }
        return { success: true, data: execution };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'WORKFLOW_GET_EXECUTION_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get workflow execution by instance
  ipcMain.handle(
    IPC_CHANNELS.WORKFLOW_GET_BY_INSTANCE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(WorkflowGetByInstancePayloadSchema, payload, 'WORKFLOW_GET_BY_INSTANCE');
        const execution = getWorkflowManager().getExecutionByInstance(
          validated.instanceId
        );
        return { success: true, data: execution || null };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'WORKFLOW_GET_BY_INSTANCE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Complete a phase
  ipcMain.handle(
    IPC_CHANNELS.WORKFLOW_COMPLETE_PHASE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(WorkflowCompletePhasePayloadSchema, payload, 'WORKFLOW_COMPLETE_PHASE');
        const execution = await getWorkflowManager().completePhase(
          validated.executionId,
          validated.phaseData
        );
        return { success: true, data: execution };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'WORKFLOW_COMPLETE_PHASE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Satisfy a gate
  ipcMain.handle(
    IPC_CHANNELS.WORKFLOW_SATISFY_GATE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(WorkflowSatisfyGatePayloadSchema, payload, 'WORKFLOW_SATISFY_GATE');
        const execution = getWorkflowManager().satisfyGate(
          validated.executionId,
          validated.response
        );
        return { success: true, data: execution };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'WORKFLOW_SATISFY_GATE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Skip a phase
  ipcMain.handle(
    IPC_CHANNELS.WORKFLOW_SKIP_PHASE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(WorkflowSkipPhasePayloadSchema, payload, 'WORKFLOW_SKIP_PHASE');
        const execution = getWorkflowManager().skipPhase(validated.executionId);
        return { success: true, data: execution };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'WORKFLOW_SKIP_PHASE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Cancel a workflow
  ipcMain.handle(
    IPC_CHANNELS.WORKFLOW_CANCEL,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(WorkflowCancelPayloadSchema, payload, 'WORKFLOW_CANCEL');
        getWorkflowManager().cancelWorkflow(validated.executionId);
        return { success: true, data: null };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'WORKFLOW_CANCEL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get system prompt addition for current phase
  ipcMain.handle(
    IPC_CHANNELS.WORKFLOW_GET_PROMPT_ADDITION,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(WorkflowGetPromptAdditionPayloadSchema, payload, 'WORKFLOW_GET_PROMPT_ADDITION');
        const addition = getWorkflowManager().getSystemPromptAddition(
          validated.executionId
        );
        return { success: true, data: addition };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'WORKFLOW_GET_PROMPT_ADDITION_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // Review Agent Handlers (6.2)
  // ============================================

  // List all review agents
  ipcMain.handle(
    IPC_CHANNELS.REVIEW_LIST_AGENTS,
    async (): Promise<IpcResponse> => {
      try {
        return { success: true, data: builtInReviewAgents };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REVIEW_LIST_AGENTS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get a specific review agent
  ipcMain.handle(
    IPC_CHANNELS.REVIEW_GET_AGENT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ReviewGetAgentPayloadSchema, payload, 'REVIEW_GET_AGENT');
        const agent = getReviewAgentById(validated.agentId);
        if (!agent) {
          return {
            success: false,
            error: {
              code: 'REVIEW_AGENT_NOT_FOUND',
              message: `Agent not found: ${validated.agentId}`,
              timestamp: Date.now()
            }
          };
        }
        return { success: true, data: agent };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REVIEW_GET_AGENT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Start a review session (runs agents and aggregates results)
  ipcMain.handle(
    IPC_CHANNELS.REVIEW_START_SESSION,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ReviewStartSessionPayloadSchema, payload, 'REVIEW_START_SESSION');
        const instance = instanceManager.getInstance(validated.instanceId);
        if (!instance) {
          return {
            success: false,
            error: {
              code: 'REVIEW_INSTANCE_NOT_FOUND',
              message: `Instance not found: ${validated.instanceId}`,
              timestamp: Date.now()
            }
          };
        }

        const agents = validated.agentIds
          .map((id) => getReviewAgentById(id))
          .filter(Boolean) as ReviewAgentConfig[];
        if (agents.length !== validated.agentIds.length) {
          const missing = validated.agentIds.filter((id) => !getReviewAgentById(id));
          return {
            success: false,
            error: {
              code: 'REVIEW_AGENT_NOT_FOUND',
              message: `Unknown review agent(s): ${missing.join(', ')}`,
              timestamp: Date.now()
            }
          };
        }

        const coordinator = getReviewCoordinator();
        const sessionId = await coordinator.startReview(validated.files || [], agents, {
          parallel: true,
          confidenceThreshold: 0,
          instanceId: validated.instanceId,
          workingDirectory: instance.workingDirectory,
          diffOnly: Boolean(validated.diffOnly),
        });

        return { success: true, data: { sessionId } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REVIEW_START_SESSION_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get review session status/summary
  ipcMain.handle(
    IPC_CHANNELS.REVIEW_GET_SESSION,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ReviewGetSessionPayloadSchema, payload, 'REVIEW_GET_SESSION');
        const session = getReviewCoordinator().getReview(validated.sessionId);
        if (!session) {
          return {
            success: false,
            error: {
              code: 'REVIEW_SESSION_NOT_FOUND',
              message: `Session not found: ${validated.sessionId}`,
              timestamp: Date.now()
            }
          };
        }
        // IPC-friendly serialization (Map -> Array).
        const serialized = {
          ...session,
          results: Array.from(session.results.values())
        };
        return { success: true, data: serialized };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REVIEW_GET_SESSION_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get issues for a review session
  ipcMain.handle(
    IPC_CHANNELS.REVIEW_GET_ISSUES,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ReviewGetIssuesPayloadSchema, payload, 'REVIEW_GET_ISSUES');
        const issues = getReviewCoordinator().getIssuesByAgent(
          validated.sessionId,
          validated.agentId,
          validated.severity
        );
        return { success: true, data: issues };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REVIEW_GET_ISSUES_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Acknowledge an issue (toggle)
  ipcMain.handle(
    IPC_CHANNELS.REVIEW_ACKNOWLEDGE_ISSUE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ReviewAcknowledgeIssuePayloadSchema, payload, 'REVIEW_ACKNOWLEDGE_ISSUE');
        const updated = getReviewCoordinator().acknowledgeIssue(
          validated.sessionId,
          validated.issueId,
          validated.acknowledged
        );
        if (!updated) {
          return {
            success: false,
            error: {
              code: 'REVIEW_ISSUE_NOT_FOUND',
              message: `Issue not found: ${validated.issueId}`,
              timestamp: Date.now()
            }
          };
        }
        return { success: true, data: updated };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'REVIEW_ACKNOWLEDGE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // Hook Handlers (6.3)
  // ============================================

  // List hooks
  ipcMain.handle(
    IPC_CHANNELS.HOOKS_LIST,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(HooksListPayloadSchema, payload, 'HOOKS_LIST');
        const hookEngine = getHookEngine();
        let rules = hookEngine.getAllRules();

        // Filter by event
        if (validated?.event) {
          rules = rules.filter(
            (r) => r.event === validated.event || r.event === 'all'
          );
        }

        // Filter by source
        if (validated?.source) {
          rules = rules.filter((r) => r.source === validated.source);
        }

        return { success: true, data: rules };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'HOOKS_LIST_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // List hook approvals
  ipcMain.handle(
    IPC_CHANNELS.HOOK_APPROVALS_LIST,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(HookApprovalsListPayloadSchema, payload, 'HOOK_APPROVALS_LIST');
        const hookManager = getHookManager();
        const hooks = hookManager.getAllHooks();

        const approvals = hooks
          .filter((hook) => hook.approvalRequired)
          .filter((hook) => (validated?.pendingOnly ? !hook.approved : true))
          .map((hook) => {
            const handlerType = hook.handler.type;
            let handlerSummary: string | undefined;
            if (handlerType === 'command') {
              handlerSummary = hook.handler.command;
            } else if (handlerType === 'prompt') {
              handlerSummary = hook.handler.prompt;
            }

            return {
              id: hook.id,
              name: hook.name,
              event: hook.event,
              enabled: hook.enabled,
              approvalRequired: Boolean(hook.approvalRequired),
              approved: Boolean(hook.approved),
              handlerType,
              handlerSummary
            };
          });

        return { success: true, data: approvals };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'HOOK_APPROVALS_LIST_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Update hook approval
  ipcMain.handle(
    IPC_CHANNELS.HOOK_APPROVALS_UPDATE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(HookApprovalsUpdatePayloadSchema, payload, 'HOOK_APPROVALS_UPDATE');
        const hookManager = getHookManager();
        const updated = hookManager.approveHook(
          validated.hookId,
          validated.approved
        );
        if (!updated) {
          return {
            success: false,
            error: {
              code: 'HOOK_APPROVAL_NOT_FOUND',
              message: `Hook not found: ${validated.hookId}`,
              timestamp: Date.now()
            }
          };
        }
        return { success: true, data: updated };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'HOOK_APPROVAL_UPDATE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Clear hook approvals
  ipcMain.handle(
    IPC_CHANNELS.HOOK_APPROVALS_CLEAR,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(HookApprovalsClearPayloadSchema, payload, 'HOOK_APPROVALS_CLEAR');
        const hookManager = getHookManager();
        const hookIds = validated?.hookIds
          ? validated.hookIds
          : hookManager
              .getAllHooks()
              .filter((hook) => hook.approvalRequired)
              .map((hook) => hook.id);

        let cleared = 0;
        for (const hookId of hookIds) {
          const updated = hookManager.approveHook(hookId, false);
          if (updated) {
            cleared += 1;
          }
        }

        return { success: true, data: { cleared } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'HOOK_APPROVALS_CLEAR_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get a specific hook
  ipcMain.handle(
    IPC_CHANNELS.HOOKS_GET,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(HooksGetPayloadSchema, payload, 'HOOKS_GET');
        const rule = getHookEngine().getRule(validated.ruleId);
        if (!rule) {
          return {
            success: false,
            error: {
              code: 'HOOK_NOT_FOUND',
              message: `Hook not found: ${validated.ruleId}`,
              timestamp: Date.now()
            }
          };
        }
        return { success: true, data: rule };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'HOOKS_GET_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Create a hook
  ipcMain.handle(
    IPC_CHANNELS.HOOKS_CREATE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(HooksCreatePayloadSchema, payload, 'HOOKS_CREATE');
        const rule: HookRule = {
          id: `hook-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          ...validated.rule,
          event: validated.rule.event as HookEvent | 'all',
          conditions: validated.rule.conditions.map((c) => ({
            field: c.field,
            operator: c.operator as
              | 'regex_match'
              | 'contains'
              | 'not_contains'
              | 'equals'
              | 'starts_with'
              | 'ends_with',
            pattern: c.pattern
          })),
          source: 'user',
          createdAt: Date.now()
        };

        getHookEngine().registerRule(rule);
        return { success: true, data: rule };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'HOOKS_CREATE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Update a hook
  ipcMain.handle(
    IPC_CHANNELS.HOOKS_UPDATE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(HooksUpdatePayloadSchema, payload, 'HOOKS_UPDATE');
        // Transform the payload updates to match HookRule types
        const updates: Partial<HookRule> = {
          ...validated.updates,
          conditions: validated.updates.conditions?.map((c) => ({
            field: c.field,
            operator: c.operator as
              | 'regex_match'
              | 'contains'
              | 'not_contains'
              | 'equals'
              | 'starts_with'
              | 'ends_with',
            pattern: c.pattern
          }))
        };
        const updated = getHookEngine().updateRule(validated.ruleId, updates);
        if (!updated) {
          return {
            success: false,
            error: {
              code: 'HOOK_NOT_FOUND',
              message: `Hook not found: ${validated.ruleId}`,
              timestamp: Date.now()
            }
          };
        }
        return { success: true, data: updated };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'HOOKS_UPDATE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Delete a hook
  ipcMain.handle(
    IPC_CHANNELS.HOOKS_DELETE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(HooksDeletePayloadSchema, payload, 'HOOKS_DELETE');
        const deleted = getHookEngine().removeRule(validated.ruleId);
        return { success: true, data: deleted };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'HOOKS_DELETE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Evaluate hooks for a context
  ipcMain.handle(
    IPC_CHANNELS.HOOKS_EVALUATE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(HooksEvaluatePayloadSchema, payload, 'HOOKS_EVALUATE');
        const context: HookContext = {
          ...validated.context,
          event: validated.context.event as HookEvent
        };
        const result = getHookEngine().evaluate(context);
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'HOOKS_EVALUATE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Import hooks
  ipcMain.handle(
    IPC_CHANNELS.HOOKS_IMPORT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(HooksImportPayloadSchema, payload, 'HOOKS_IMPORT');
        const result = getHookEngine().importRules(
          validated.rules as HookRule[],
          validated.overwrite
        );
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'HOOKS_IMPORT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Export hooks
  ipcMain.handle(
    IPC_CHANNELS.HOOKS_EXPORT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(HooksExportPayloadSchema, payload, 'HOOKS_EXPORT');
        const rules = getHookEngine().exportRules(validated?.source);
        return { success: true, data: rules };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'HOOKS_EXPORT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // Skill Handlers (6.4)
  // ============================================

  // Discover skills
  ipcMain.handle(
    IPC_CHANNELS.SKILLS_DISCOVER,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SkillsDiscoverPayloadSchema, payload, 'SKILLS_DISCOVER');
        const skills = await getSkillRegistry().discoverSkills(
          validated.searchPaths
        );
        return { success: true, data: skills };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SKILLS_DISCOVER_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // List skills
  ipcMain.handle(IPC_CHANNELS.SKILLS_LIST, async (): Promise<IpcResponse> => {
    try {
      const skills = getSkillRegistry().listSkills();
      return { success: true, data: skills };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'SKILLS_LIST_FAILED',
          message: (error as Error).message,
          timestamp: Date.now()
        }
      };
    }
  });

  // Get a specific skill
  ipcMain.handle(
    IPC_CHANNELS.SKILLS_GET,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SkillsGetPayloadSchema, payload, 'SKILLS_GET');
        const skill = getSkillRegistry().getSkill(validated.skillId);
        if (!skill) {
          return {
            success: false,
            error: {
              code: 'SKILL_NOT_FOUND',
              message: `Skill not found: ${validated.skillId}`,
              timestamp: Date.now()
            }
          };
        }
        return { success: true, data: skill };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SKILLS_GET_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Load a skill
  ipcMain.handle(
    IPC_CHANNELS.SKILLS_LOAD,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SkillsLoadPayloadSchema, payload, 'SKILLS_LOAD');
        const loaded = await getSkillRegistry().loadSkill(validated.skillId);
        return { success: true, data: serializeLoadedSkill(loaded) };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SKILLS_LOAD_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Unload a skill
  ipcMain.handle(
    IPC_CHANNELS.SKILLS_UNLOAD,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SkillsUnloadPayloadSchema, payload, 'SKILLS_UNLOAD');
        getSkillRegistry().unloadSkill(validated.skillId);
        return { success: true, data: null };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SKILLS_UNLOAD_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Load a skill reference
  ipcMain.handle(
    IPC_CHANNELS.SKILLS_LOAD_REFERENCE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SkillsLoadReferencePayloadSchema, payload, 'SKILLS_LOAD_REFERENCE');
        const content = await getSkillRegistry().loadReference(
          validated.skillId,
          validated.referencePath
        );
        return { success: true, data: content };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SKILLS_LOAD_REFERENCE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Load a skill example
  ipcMain.handle(
    IPC_CHANNELS.SKILLS_LOAD_EXAMPLE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SkillsLoadExamplePayloadSchema, payload, 'SKILLS_LOAD_EXAMPLE');
        const content = await getSkillRegistry().loadExample(
          validated.skillId,
          validated.examplePath
        );
        return { success: true, data: content };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SKILLS_LOAD_EXAMPLE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Match skills for text
  ipcMain.handle(
    IPC_CHANNELS.SKILLS_MATCH,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SkillsMatchPayloadSchema, payload, 'SKILLS_MATCH');
        const matches = getSkillRegistry().matchTrigger(validated.text);
        return { success: true, data: matches };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SKILLS_MATCH_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get skill memory usage
  ipcMain.handle(
    IPC_CHANNELS.SKILLS_GET_MEMORY,
    async (): Promise<IpcResponse> => {
      try {
        const memory = getSkillRegistry().getMemoryUsage();
        return { success: true, data: memory };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SKILLS_GET_MEMORY_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );
}
