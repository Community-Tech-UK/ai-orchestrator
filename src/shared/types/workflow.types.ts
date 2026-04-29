/**
 * Workflow Types - Structured workflow system with phases and gates
 * Based on validated patterns from Claude Code feature-dev plugin
 */

export type WorkflowPhaseStatus =
  | 'pending'
  | 'active'
  | 'awaiting_confirmation' // Blocked on user
  | 'completed'
  | 'skipped'
  | 'failed';

export type GateType =
  | 'none' // Auto-advance
  | 'completion' // Must complete required actions
  | 'user_confirmation' // User must acknowledge
  | 'user_selection' // User must choose from options
  | 'user_approval'; // Explicit approval required

export interface WorkflowPhase {
  id: string;
  name: string;
  description: string;
  order: number;

  // Prompt injection
  systemPromptAddition: string;

  // Gate configuration
  gateType: GateType;
  gatePrompt?: string; // What to ask user at gate
  gateOptions?: string[]; // Options for user_selection gates

  // Agent configuration
  agents?: {
    count: number; // How many to spawn (2-3 for parallel)
    agentType: string; // Agent profile to use
    prompts: string[]; // Different prompts per agent (for diversity)
    parallel: boolean; // Run in parallel or sequential
  };

  // Iteration control
  maxIterations?: number;
  requiredActions?: string[]; // Actions that must complete
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: 'development' | 'review' | 'debugging' | 'custom';

  // Trigger configuration
  triggerPatterns: string[];
  autoTrigger: boolean; // Auto-start on pattern match

  phases: WorkflowPhase[];

  // Metadata
  estimatedDuration: string;
  requiredAgents: string[];
}

export interface WorkflowExecution {
  id: string;
  instanceId: string;
  templateId: string;

  // State
  currentPhaseId: string;
  phaseStatuses: Record<string, WorkflowPhaseStatus>;
  phaseData: Record<string, PhaseData>; // Collected data per phase

  // Gate state
  pendingGate?: {
    phaseId: string;
    gateType: GateType;
    gatePrompt: string;
    options?: string[];
    submittedAt: number;
  };

  // Timing
  startedAt: number;
  completedAt?: number;

  // Metrics
  agentInvocations: number;
  totalTokens: number;
  totalCost: number;

  /**
   * Set when this execution was auto-completed by the transition policy
   * (for example when another workflow superseded it). Additive; absent means
   * manual completion or in-progress.
   */
  transitionAutoCompletion?: {
    reason: 'superseded' | 'manual-cancel' | 'restore-cleanup';
    supersededBy?: string;
  };
}

export interface PhaseData {
  agentResults?: AgentResult[];
  userResponse?: string;
  selectedOption?: string;
  collectedFiles?: string[];
  errors?: string[];
}

export interface AgentResult {
  agentId: string;
  prompt: string;
  response: string;
  duration: number;
  tokens: number;
}

// Events emitted by the workflow system
export type WorkflowEventType =
  | 'workflow:started'
  | 'workflow:completed'
  | 'workflow:cancelled'
  | 'workflow:phase-changed'
  | 'workflow:gate-pending'
  | 'workflow:gate-satisfied'
  | 'workflow:gate-rejected'
  | 'workflow:agents-launching'
  | 'workflow:agents-completed'
  | 'workflow:invoke-agent';

export interface WorkflowEvent {
  type: WorkflowEventType;
  execution: WorkflowExecution;
  template?: WorkflowTemplate;
  phase?: WorkflowPhase;
  results?: AgentResult[];
  response?: { approved?: boolean; selection?: string; answer?: string };
}

// Helper functions
export function createWorkflowExecution(
  instanceId: string,
  templateId: string,
  template: WorkflowTemplate
): WorkflowExecution {
  const firstPhase = template.phases[0];

  return {
    id: `wf-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    instanceId,
    templateId,
    currentPhaseId: firstPhase.id,
    phaseStatuses: Object.fromEntries(
      template.phases.map((p) => [p.id, p.order === 0 ? 'active' : 'pending'])
    ) as Record<string, WorkflowPhaseStatus>,
    phaseData: {},
    startedAt: Date.now(),
    agentInvocations: 0,
    totalTokens: 0,
    totalCost: 0,
  };
}

export function isWorkflowComplete(execution: WorkflowExecution): boolean {
  return execution.completedAt !== undefined;
}

export function getPhaseProgress(execution: WorkflowExecution, template: WorkflowTemplate): {
  current: number;
  total: number;
  percentage: number;
} {
  const currentPhase = template.phases.find((p) => p.id === execution.currentPhaseId);
  const currentIndex = currentPhase ? currentPhase.order : 0;
  const total = template.phases.length;

  return {
    current: currentIndex + 1,
    total,
    percentage: Math.round(((currentIndex + 1) / total) * 100),
  };
}

/**
 * Source of a workflow start request. The transition policy uses this to apply
 * stricter rules for suggestions and background automation than explicit user
 * starts.
 */
export type WorkflowStartSource =
  | 'slash-command'
  | 'nl-suggestion'
  | 'automation'
  | 'manual-ui'
  | 'restore';

/**
 * Outcome of evaluating a requested workflow start against current state.
 */
export type WorkflowTransitionPolicy =
  | { kind: 'allow' }
  | { kind: 'allowWithOverlap'; maxConcurrent?: number }
  | { kind: 'autoCompleteCurrent' }
  | { kind: 'deny'; reason: string; suggestedAction?: string };

export interface WorkflowTransitionInputs {
  current: {
    execution: WorkflowExecution;
    template: WorkflowTemplate;
  } | null;
  requested: {
    template: WorkflowTemplate;
    instanceId: string;
  };
  source: WorkflowStartSource;
}

export type NlWorkflowSize = 'small' | 'medium' | 'large';
export type NlWorkflowSignal =
  | 'mentions-multiple-files'
  | 'mentions-three-or-more-children'
  | 'workflow-keyword-review'
  | 'workflow-keyword-audit'
  | 'workflow-keyword-refactor'
  | 'workflow-keyword-debug'
  | 'workflow-keyword-feature'
  | 'orchestration-mention'
  | 'no-orchestration-mention';

export interface NlWorkflowSuggestion {
  size: NlWorkflowSize;
  surface: 'slash-command' | 'template-confirm' | 'preflight-modal';
  suggestedRef: string | null;
  matchedSignals: NlWorkflowSignal[];
  estimatedChildCount?: number;
  estimatedProviderImpact?: 'none' | 'low' | 'medium' | 'high';
}
