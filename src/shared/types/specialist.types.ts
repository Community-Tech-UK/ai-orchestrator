/**
 * Specialist Types
 * Pre-configured agent profiles for specific domains
 *
 * Based on James's idea for review, security, design, testing specialists
 * Each specialist has focused tools, prompts, and commands
 */

// ============ Specialist Profile ============

export interface SpecialistProfile {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  category: SpecialistCategory;
  systemPromptAddition: string;
  defaultTools: string[]; // Tools always enabled
  restrictedTools: string[]; // Tools never enabled
  suggestedCommands: SpecialistCommand[];
  relatedWorkflows: string[];
  personality?: SpecialistPersonality;
  constraints?: SpecialistConstraints;
}

export type SpecialistCategory =
  | 'security'
  | 'testing'
  | 'design'
  | 'review'
  | 'devops'
  | 'documentation'
  | 'performance'
  | 'accessibility'
  | 'custom';

// ============ Specialist Commands ============

export interface SpecialistCommand {
  name: string;
  description: string;
  prompt: string;
  requiresSelection?: boolean; // Requires selected code/file
  outputFormat?: 'markdown' | 'json' | 'diff' | 'checklist';
}

// ============ Personality & Constraints ============

export interface SpecialistPersonality {
  temperature: number; // 0-1, affects creativity
  thoroughness: 'quick' | 'balanced' | 'thorough';
  communicationStyle: 'concise' | 'detailed' | 'educational';
  riskTolerance: 'conservative' | 'balanced' | 'aggressive';
}

export interface SpecialistConstraints {
  maxTokensPerResponse?: number;
  requireApprovalFor?: string[]; // Actions requiring user approval
  readOnlyMode?: boolean; // No file modifications allowed
  sandboxedExecution?: boolean; // Bash commands run in sandbox
  timeoutMs?: number;
}

// ============ Specialist Instance ============

export interface SpecialistInstance {
  id: string;
  profileId: string;
  profile: SpecialistProfile;
  instanceId: string; // Associated orchestrator instance
  startTime: number;
  status: SpecialistStatus;
  findings: SpecialistFinding[];
  metrics: SpecialistMetrics;
}

export type SpecialistStatus = 'active' | 'paused' | 'completed' | 'error';

// ============ Specialist Findings ============

export interface SpecialistFinding {
  id: string;
  type: FindingType;
  severity: FindingSeverity;
  confidence: number; // 0-100
  title: string;
  description: string;
  file?: string;
  line?: number;
  endLine?: number;
  suggestion?: string;
  codeSnippet?: string;
  references?: string[];
  tags: string[];
  timestamp: number;
}

export type FindingType =
  | 'vulnerability'
  | 'bug'
  | 'code_smell'
  | 'performance'
  | 'accessibility'
  | 'documentation'
  | 'test_gap'
  | 'design_issue'
  | 'suggestion'
  | 'info';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

// ============ Specialist Metrics ============

export interface SpecialistMetrics {
  filesAnalyzed: number;
  linesAnalyzed: number;
  findingsCount: number;
  findingsBySeverity: Record<FindingSeverity, number>;
  tokensUsed: number;
  durationMs: number;
}

// ============ Built-in Specialist IDs ============

export const BUILT_IN_SPECIALISTS = {
  SECURITY: 'specialist-security',
  TESTING: 'specialist-testing',
  DESIGN: 'specialist-design',
  REVIEW: 'specialist-review',
  DEVOPS: 'specialist-devops',
  PERFORMANCE: 'specialist-performance',
  ACCESSIBILITY: 'specialist-accessibility',
  DOCUMENTATION: 'specialist-documentation',
} as const;

export type BuiltInSpecialistId = (typeof BUILT_IN_SPECIALISTS)[keyof typeof BUILT_IN_SPECIALISTS];

// ============ Specialist Registry ============

export interface SpecialistRegistry {
  builtIn: SpecialistProfile[];
  custom: SpecialistProfile[];
  lastUpdated: number;
}

// ============ Specialist Selection ============

export interface SpecialistSelectionContext {
  taskDescription?: string;
  fileTypes?: string[];
  projectType?: string;
  userPreferences?: string[];
}

export interface SpecialistRecommendation {
  profileId: string;
  relevanceScore: number; // 0-1
  reason: string;
}
