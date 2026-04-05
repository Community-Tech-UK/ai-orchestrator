// src/main/security/bash-validation/types.ts

/** Permission mode derived from instance context */
export type PermissionMode = 'read_only' | 'workspace_write' | 'prompt' | 'allow';

/** Command intent classification */
export type CommandIntent =
  | 'read_only'
  | 'write'
  | 'destructive'
  | 'network'
  | 'process_management'
  | 'package_management'
  | 'system_admin'
  | 'unknown';

/** Result from a single submodule */
export type SubmoduleResult =
  | { action: 'allow' }
  | { action: 'warn'; message: string; submodule: string }
  | { action: 'block'; reason: string; submodule: string };

/** Evasion flags detected by EvasionDetector */
export interface EvasionFlags {
  hasVariableExpansion: boolean;
  hasCommandSubstitution: boolean;
  hasHexOctalEscape: boolean;
  hasBase64Decode: boolean;
  hasPipeToShell: boolean;
  hasEvalExec: boolean;
  hasWrapperCommand: boolean;
  hasStringSplitting: boolean;
  hasBraceExpansion: boolean;
  hasGlobAsCommand: boolean;
  hasIfsManipulation: boolean;
  hasQuoteInsertion: boolean;
  hasEmptySubstitution: boolean;
  hasArithmeticExpansion: boolean;
  hasTrapDebug: boolean;
  hasEnvInjection: boolean;
}

/** Context passed to all validators */
export interface ValidationContext {
  mode: PermissionMode;
  workspacePath: string;
  instanceDepth: number;
  yoloMode: boolean;
  instanceId: string;
}

/** Parsed command structure from CommandParser */
export interface ParsedCommand {
  raw: string;
  segments: CommandSegment[];
}

export interface CommandSegment {
  mainCommand: string;
  rawSegment: string;
  arguments: string[];
  pipes: string[];
  redirects: string[];
  backgrounded: boolean;
}

/** Full pipeline result — backward-compatible with existing BashValidationResult */
export interface BashValidationResult {
  valid: boolean;
  risk: 'safe' | 'warning' | 'dangerous' | 'blocked';
  message?: string;
  command: string;
  intent: CommandIntent;
  evasionFlags: EvasionFlags;
  submoduleResults: SubmoduleResult[];
  details?: {
    mainCommand: string;
    arguments: string[];
    pipes: string[];
    redirects: string[];
    warnings: string[];
    blockedPatterns: string[];
  };
}

/** Interface that all validator submodules implement */
export interface BashValidatorSubmodule {
  readonly name: string;
  validate(
    raw: string,
    parsed: ParsedCommand,
    context: ValidationContext,
  ): SubmoduleResult;
}

/** Empty evasion flags (all false) */
export function emptyEvasionFlags(): EvasionFlags {
  return {
    hasVariableExpansion: false,
    hasCommandSubstitution: false,
    hasHexOctalEscape: false,
    hasBase64Decode: false,
    hasPipeToShell: false,
    hasEvalExec: false,
    hasWrapperCommand: false,
    hasStringSplitting: false,
    hasBraceExpansion: false,
    hasGlobAsCommand: false,
    hasIfsManipulation: false,
    hasQuoteInsertion: false,
    hasEmptySubstitution: false,
    hasArithmeticExpansion: false,
    hasTrapDebug: false,
    hasEnvInjection: false,
  };
}

/** Default ValidationContext for backward-compatible calls without context */
export function defaultValidationContext(): ValidationContext {
  return {
    mode: 'prompt',
    workspacePath: process.cwd(),
    instanceDepth: 0,
    yoloMode: false,
    instanceId: 'unknown',
  };
}
