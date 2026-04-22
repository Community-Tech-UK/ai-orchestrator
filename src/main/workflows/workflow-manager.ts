/**
 * WorkflowManager - Manages structured workflows with phases and gates
 * Based on validated patterns from Claude Code feature-dev plugin
 */

import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import {
  WorkflowTemplate,
  WorkflowExecution,
  WorkflowPhase,
  GateType,
  PhaseData,
  AgentResult,
  createWorkflowExecution,
} from '../../shared/types/workflow.types';
import { builtInTemplates } from './templates';
import { WorkflowPersistence } from './workflow-persistence';

const logger = getLogger('WorkflowManager');

export class WorkflowManager extends EventEmitter {
  private static instance: WorkflowManager | null = null;
  private templates = new Map<string, WorkflowTemplate>();
  private executions = new Map<string, WorkflowExecution>();
  private instanceExecutions = new Map<string, string>(); // instanceId -> executionId
  private persistence?: WorkflowPersistence;

  setPersistence(persistence: WorkflowPersistence): void {
    this.persistence = persistence;
    this.restoreActiveExecutions();
  }

  private persistExecution(execution: WorkflowExecution): void {
    if (!this.persistence) return;
    try {
      this.persistence.save(execution);
    } catch (err) {
      logger.error('Failed to persist workflow execution', err instanceof Error ? err : undefined);
    }
  }

  private restoreActiveExecutions(): void {
    if (!this.persistence) return;

    try {
      const activeExecutions = this.persistence.loadActive();

      for (const execution of activeExecutions) {
        if (this.executions.has(execution.id)) {
          continue;
        }

        const existingExecutionId = this.instanceExecutions.get(execution.instanceId);
        if (existingExecutionId) {
          const existingExecution = this.executions.get(existingExecutionId);
          if (existingExecution && !existingExecution.completedAt) {
            logger.warn('Skipping persisted workflow restore because instance already has an active execution', {
              instanceId: execution.instanceId,
              existingExecutionId,
              restoredExecutionId: execution.id,
            });
            continue;
          }
        }

        this.executions.set(execution.id, execution);
        this.instanceExecutions.set(execution.instanceId, execution.id);
      }
    } catch (err) {
      logger.error('Failed to restore persisted workflow executions', err instanceof Error ? err : undefined);
    }
  }

  static getInstance(): WorkflowManager {
    if (!this.instance) {
      this.instance = new WorkflowManager();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    WorkflowManager.instance = null;
  }

  private constructor() {
    super();
    this.loadBuiltInTemplates();
  }

  private loadBuiltInTemplates(): void {
    for (const template of builtInTemplates) {
      this.templates.set(template.id, template);
    }
  }

  // ============ Template Management ============

  listTemplates(): WorkflowTemplate[] {
    return Array.from(this.templates.values());
  }

  getTemplate(id: string): WorkflowTemplate | undefined {
    return this.templates.get(id);
  }

  registerTemplate(template: WorkflowTemplate): void {
    this.templates.set(template.id, template);
    this.emit('template:registered', template);
  }

  removeTemplate(id: string): boolean {
    const existed = this.templates.delete(id);
    if (existed) {
      this.emit('template:removed', id);
    }
    return existed;
  }

  // ============ Execution Lifecycle ============

  startWorkflow(instanceId: string, templateId: string): WorkflowExecution {
    // Check if instance already has active workflow
    const existing = this.instanceExecutions.get(instanceId);
    if (existing) {
      const exec = this.executions.get(existing);
      if (exec && !exec.completedAt) {
        throw new Error(`Instance ${instanceId} already has active workflow: ${exec.id}`);
      }
    }

    const template = this.templates.get(templateId);
    if (!template) throw new Error(`Template not found: ${templateId}`);

    const execution = createWorkflowExecution(instanceId, templateId, template);

    this.executions.set(execution.id, execution);
    this.instanceExecutions.set(instanceId, execution.id);
    this.persistExecution(execution);

    this.emit('workflow:started', { execution, template });

    // If first phase has agents, launch them
    const firstPhase = template.phases[0];
    if (firstPhase.agents) {
      // Defer agent launch to allow event listeners to be set up
      setImmediate(() => {
        this.launchPhaseAgents(execution, firstPhase).catch((err) => {
          logger.error('Error launching phase agents', err instanceof Error ? err : undefined);
        });
      });
    }

    return execution;
  }

  // ============ Phase Transitions ============

  async completePhase(
    executionId: string,
    phaseData?: Record<string, unknown>
  ): Promise<WorkflowExecution> {
    const execution = this.executions.get(executionId);
    if (!execution) throw new Error(`Execution not found: ${executionId}`);

    const template = this.templates.get(execution.templateId)!;
    const currentPhase = template.phases.find((p) => p.id === execution.currentPhaseId)!;
    const currentIndex = template.phases.indexOf(currentPhase);

    // Store phase data
    if (phaseData) {
      execution.phaseData[currentPhase.id] = {
        ...execution.phaseData[currentPhase.id],
        ...phaseData,
      } as PhaseData;
    }

    // Check gate requirements
    if (currentPhase.gateType !== 'none' && !this.isGateSatisfied(execution, currentPhase)) {
      execution.phaseStatuses[currentPhase.id] = 'awaiting_confirmation';
      execution.pendingGate = {
        phaseId: currentPhase.id,
        gateType: currentPhase.gateType,
        gatePrompt: currentPhase.gatePrompt || this.defaultGatePrompt(currentPhase.gateType),
        options: currentPhase.gateOptions,
        submittedAt: Date.now(),
      };
      this.emit('workflow:gate-pending', { execution, phase: currentPhase });
      this.persistExecution(execution);
      return execution;
    }

    // Mark current as completed
    execution.phaseStatuses[currentPhase.id] = 'completed';
    execution.pendingGate = undefined;

    // Find next phase
    const nextIndex = currentIndex + 1;
    if (nextIndex >= template.phases.length) {
      execution.completedAt = Date.now();
      this.emit('workflow:completed', execution);
    } else {
      const nextPhase = template.phases[nextIndex];
      execution.currentPhaseId = nextPhase.id;
      execution.phaseStatuses[nextPhase.id] = 'active';
      this.emit('workflow:phase-changed', { execution, phase: nextPhase });

      // Auto-launch agents if configured
      if (nextPhase.agents) {
        await this.launchPhaseAgents(execution, nextPhase);
      }
    }

    this.persistExecution(execution);
    return execution;
  }

  // ============ Gate Handling ============

  satisfyGate(
    executionId: string,
    response: { approved?: boolean; selection?: string; answer?: string }
  ): WorkflowExecution {
    const execution = this.executions.get(executionId);
    if (!execution) throw new Error(`Execution not found: ${executionId}`);
    if (!execution.pendingGate) throw new Error('No pending gate');

    const phase = this.templates
      .get(execution.templateId)!
      .phases.find((p) => p.id === execution.pendingGate!.phaseId)!;

    // Store response in phase data
    execution.phaseData[phase.id] = {
      ...execution.phaseData[phase.id],
      userResponse: response.answer,
      selectedOption: response.selection,
    };

    // Mark gate as satisfied based on type
    switch (execution.pendingGate.gateType) {
      case 'user_confirmation':
        if (!response.answer) throw new Error('Confirmation required');
        break;
      case 'user_selection':
        if (!response.selection) throw new Error('Selection required');
        break;
      case 'user_approval':
        if (!response.approved) {
          this.emit('workflow:gate-rejected', { execution, phase });
          this.persistExecution(execution);
          return execution;
        }
        break;
    }

    execution.pendingGate = undefined;
    this.emit('workflow:gate-satisfied', { execution, phase, response });

    // Continue to complete phase
    this.completePhase(executionId).catch((err) => {
      logger.error('Error completing phase after gate satisfaction', err instanceof Error ? err : undefined);
    });

    this.persistExecution(execution);
    return execution;
  }

  private isGateSatisfied(execution: WorkflowExecution, phase: WorkflowPhase): boolean {
    const data = execution.phaseData[phase.id];

    switch (phase.gateType) {
      case 'none':
        return true;
      case 'completion':
        // Check if required actions are done
        return (
          phase.requiredActions?.every(
            (action) =>
              data?.collectedFiles?.includes(action) ||
              data?.agentResults?.some((r) => r.response.includes(action))
          ) ?? true
        );
      case 'user_confirmation':
      case 'user_selection':
      case 'user_approval':
        return !!data?.userResponse || !!data?.selectedOption;
      default:
        return true;
    }
  }

  private defaultGatePrompt(gateType: GateType): string {
    switch (gateType) {
      case 'user_confirmation':
        return 'Please confirm to proceed to the next phase.';
      case 'user_selection':
        return 'Please select an option to proceed.';
      case 'user_approval':
        return 'Do you approve proceeding with the implementation?';
      default:
        return 'Ready to proceed?';
    }
  }

  // ============ Agent Orchestration ============

  private async launchPhaseAgents(
    execution: WorkflowExecution,
    phase: WorkflowPhase
  ): Promise<void> {
    if (!phase.agents) return;

    const { count, agentType, prompts, parallel } = phase.agents;

    this.emit('workflow:agents-launching', {
      execution,
      phase,
      count,
      parallel,
    });

    const results: AgentResult[] = [];

    if (parallel) {
      // Launch all agents in parallel
      const promises = prompts.slice(0, count).map((prompt, i) =>
        this.invokeAgent(execution, agentType, prompt, i)
      );
      results.push(...(await Promise.all(promises)));
    } else {
      // Launch agents sequentially
      for (let i = 0; i < Math.min(count, prompts.length); i++) {
        const result = await this.invokeAgent(execution, agentType, prompts[i], i);
        results.push(result);
      }
    }

    // Store results
    execution.phaseData[phase.id] = {
      ...execution.phaseData[phase.id],
      agentResults: results,
    };
    execution.agentInvocations += results.length;

    this.emit('workflow:agents-completed', { execution, phase, results });
  }

  private async invokeAgent(
    execution: WorkflowExecution,
    agentType: string,
    prompt: string,
    index: number
  ): Promise<AgentResult> {
    const startTime = Date.now();

    // Emit event for orchestration handler to pick up
    const result = await new Promise<AgentResult>((resolve) => {
      const agentId = `${execution.id}-${agentType}-${index}`;

      this.emit('workflow:invoke-agent', {
        correlationId: `${execution.id}:${agentId}`,
        executionId: execution.id,
        agentId,
        agentType,
        prompt,
        callback: (response: string, tokens: number) => {
          resolve({
            agentId,
            prompt,
            response,
            duration: Date.now() - startTime,
            tokens,
          });
        },
      });
    });

    execution.totalTokens += result.tokens;
    return result;
  }

  // ============ Skip Phase ============

  skipPhase(executionId: string): WorkflowExecution {
    const execution = this.executions.get(executionId);
    if (!execution) throw new Error(`Execution not found: ${executionId}`);

    const template = this.templates.get(execution.templateId)!;
    const currentPhase = template.phases.find((p) => p.id === execution.currentPhaseId)!;
    const currentIndex = template.phases.indexOf(currentPhase);

    // Mark as skipped
    execution.phaseStatuses[currentPhase.id] = 'skipped';
    execution.pendingGate = undefined;

    // Move to next phase
    const nextIndex = currentIndex + 1;
    if (nextIndex >= template.phases.length) {
      execution.completedAt = Date.now();
      this.emit('workflow:completed', execution);
    } else {
      const nextPhase = template.phases[nextIndex];
      execution.currentPhaseId = nextPhase.id;
      execution.phaseStatuses[nextPhase.id] = 'active';
      this.emit('workflow:phase-changed', { execution, phase: nextPhase });
    }

    this.persistExecution(execution);
    return execution;
  }

  // ============ Queries ============

  getExecution(executionId: string): WorkflowExecution | undefined {
    return this.executions.get(executionId);
  }

  getExecutionByInstance(instanceId: string): WorkflowExecution | undefined {
    const executionId = this.instanceExecutions.get(instanceId);
    if (!executionId) return undefined;

    const execution = this.executions.get(executionId);
    if (execution?.completedAt) return undefined; // Only return active

    return execution;
  }

  getAllExecutions(): WorkflowExecution[] {
    return Array.from(this.executions.values());
  }

  getActiveExecutions(): WorkflowExecution[] {
    return Array.from(this.executions.values()).filter((e) => !e.completedAt);
  }

  getCurrentPhase(executionId: string): WorkflowPhase | undefined {
    const execution = this.executions.get(executionId);
    if (!execution) return undefined;

    const template = this.templates.get(execution.templateId);
    return template?.phases.find((p) => p.id === execution.currentPhaseId);
  }

  getSystemPromptAddition(executionId: string): string {
    const phase = this.getCurrentPhase(executionId);
    if (!phase) return '';

    const execution = this.executions.get(executionId)!;
    const template = this.templates.get(execution.templateId)!;

    // Build context from previous phases
    const previousContext = template.phases
      .filter((p) => p.order < phase.order)
      .map((p) => {
        const data = execution.phaseData[p.id];
        if (!data) return '';

        let context = `## ${p.name} (Completed)\n`;
        if (data.agentResults) {
          context += data.agentResults.map((r) => r.response).join('\n\n');
        }
        if (data.userResponse) {
          context += `\nUser response: ${data.userResponse}`;
        }
        if (data.selectedOption) {
          context += `\nSelected: ${data.selectedOption}`;
        }
        return context;
      })
      .filter(Boolean)
      .join('\n\n---\n\n');

    return `${previousContext}\n\n${phase.systemPromptAddition}`;
  }

  cancelWorkflow(executionId: string): void {
    const execution = this.executions.get(executionId);
    if (!execution) return;

    execution.completedAt = Date.now();
    execution.phaseStatuses[execution.currentPhaseId] = 'failed';
    this.persistExecution(execution);

    this.emit('workflow:cancelled', execution);
  }

  // ============ Cleanup ============

  cleanupInstance(instanceId: string): void {
    const executionId = this.instanceExecutions.get(instanceId);
    if (executionId) {
      this.instanceExecutions.delete(instanceId);
      // Keep execution in history for reference
    }
  }
}

// Singleton accessor
let workflowManagerInstance: WorkflowManager | null = null;

export function getWorkflowManager(): WorkflowManager {
  if (!workflowManagerInstance) {
    workflowManagerInstance = WorkflowManager.getInstance();
  }
  return workflowManagerInstance;
}

export function _resetWorkflowManagerForTesting(): void {
  workflowManagerInstance = null;
  WorkflowManager._resetForTesting();
}
