/**
 * @deprecated Use BashValidationPipeline from './bash-validation' instead.
 * This file is preserved for backward compatibility only.
 */
import { BashValidationPipeline, getBashValidationPipeline } from './bash-validation';
import type { BashValidationResult } from './bash-validation';

export type { BashValidationResult };

/** @deprecated Use BashValidationPipeline instead */
export interface BashValidatorConfig {
  blockedCommands: string[];
  warningPatterns: (string | RegExp)[];
  blockedPatterns: (string | RegExp)[];
  allowedCommands: string[];
  maxCommandLength: number;
}

/** @deprecated Use BashValidationPipeline instead */
export class BashValidator {
  private pipeline: BashValidationPipeline;

  constructor(_config?: Partial<BashValidatorConfig>) {
    this.pipeline = new BashValidationPipeline();
  }

  validate(command: string): BashValidationResult {
    return this.pipeline.validate(command);
  }

  /** @deprecated No-op in new pipeline */
  updateConfig(_config: Partial<BashValidatorConfig>): void { /* no-op */ }
  /** @deprecated No-op in new pipeline */
  addBlockedCommand(_command: string): void { /* no-op */ }
  /** @deprecated No-op in new pipeline */
  addBlockedPattern(_pattern: string | RegExp): void { /* no-op */ }
  /** @deprecated No-op in new pipeline */
  addAllowedCommand(_command: string): void { /* no-op */ }
  /** @deprecated Returns empty config in new pipeline */
  getConfig(): BashValidatorConfig {
    return { blockedCommands: [], warningPatterns: [], blockedPatterns: [], allowedCommands: [], maxCommandLength: 10000 };
  }
}

/** @deprecated Use getBashValidationPipeline() instead */
export function getBashValidator(): BashValidator {
  return new BashValidator();
}
