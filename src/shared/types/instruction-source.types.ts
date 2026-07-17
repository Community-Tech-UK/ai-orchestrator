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
  /**
   * WS12 instruction trust gate: pin verdict for project-sourced files
   * ('approved' | 'changed' | 'unknown'); undefined for exempt scopes
   * (user-global / AIO-owned) or when the gate is off.
   */
  trust?: 'approved' | 'changed' | 'unknown';
  /** WS12 content-scanner sha256 of the loaded content (approval anchor). */
  sha256?: string;
  /** WS12 scanner findings (advisory; `critical` blocks in enforce mode). */
  scanFindings?: Array<{
    ruleId: string;
    severity: 'info' | 'warn' | 'critical';
    message: string;
    line: number;
    excerpt: string;
  }>;
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
