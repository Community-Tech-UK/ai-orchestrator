export type InstructionSourceKind =
  | 'orchestrator'
  | 'claude'
  | 'agents'
  | 'copilot'
  | 'gemini'
  | 'custom';

export type InstructionSourceScope =
  | 'user'
  | 'project'
  | 'path-specific'
  | 'custom';

export interface ResolvedInstructionSource {
  path: string;
  kind: InstructionSourceKind;
  scope: InstructionSourceScope;
  loaded: boolean;
  applied: boolean;
  priority: number;
  label: string;
  reason?: string;
  matchPatterns?: string[];
  matchedPaths?: string[];
}

export interface InstructionResolution {
  projectRoot: string;
  workingDirectory: string;
  contextPaths: string[];
  mergedContent: string;
  sources: ResolvedInstructionSource[];
  warnings: string[];
  timestamp: number;
}

export interface InstructionMigrationDraft {
  outputPath: string;
  content: string;
  warnings: string[];
}
