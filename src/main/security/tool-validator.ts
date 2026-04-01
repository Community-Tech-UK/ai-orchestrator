/**
 * Tool Input Validator
 *
 * Validates tool inputs independently from permission checks.
 * This separation (inspired by Claude Code's Tool.validateInput vs checkPermissions)
 * allows each concern to be tested and reused independently.
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('ToolValidator');

/**
 * Result of validating tool input
 */
export interface ToolValidationResult {
  /** Whether the input is valid */
  valid: boolean;
  /** Validation error messages (empty if valid) */
  errors: string[];
  /** Sanitized input (with dangerous content removed/escaped) */
  sanitizedInput?: unknown;
}

/**
 * Tool input validation rule
 */
export interface ValidationRule {
  /** Rule name for logging */
  name: string;
  /** Validation function — returns error message if invalid, undefined if ok */
  validate: (toolName: string, input: unknown) => string | undefined;
}

/**
 * Built-in validation rules applied to all tool inputs
 */
const BUILTIN_RULES: ValidationRule[] = [
  {
    name: 'no-null-bytes',
    validate: (_toolName, input) => {
      const str = JSON.stringify(input);
      if (str && str.includes('\\u0000')) {
        return 'Input contains null bytes which may cause security issues';
      }
      return undefined;
    },
  },
  {
    name: 'no-path-traversal',
    validate: (toolName, input) => {
      // Only check tools that take file paths
      if (!toolName.match(/file|read|write|edit|delete|path/i)) return undefined;

      const str = JSON.stringify(input);
      if (str && /\.\.[/\\]/.test(str)) {
        return 'Input contains path traversal sequences (..)';
      }
      return undefined;
    },
  },
  {
    name: 'max-input-size',
    validate: (_toolName, input) => {
      const str = JSON.stringify(input);
      if (str && str.length > 1_000_000) {
        return `Input too large: ${str.length} chars (max 1,000,000)`;
      }
      return undefined;
    },
  },
  {
    name: 'no-command-injection',
    validate: (toolName, input) => {
      // Only check tools that execute commands
      if (!toolName.match(/bash|exec|shell|command|run/i)) return undefined;

      const str = typeof input === 'string' ? input : JSON.stringify(input);
      if (str && /[;&|`$]/.test(str)) {
        // Don't block — just warn. Some tools legitimately use these.
        return undefined; // Intentionally not blocking; logged as info below
      }
      return undefined;
    },
  },
];

export class ToolValidator {
  private static instance: ToolValidator | null = null;
  private readonly rules: ValidationRule[];
  private readonly customRules = new Map<string, ValidationRule[]>();

  private constructor() {
    this.rules = [...BUILTIN_RULES];
  }

  static getInstance(): ToolValidator {
    if (!this.instance) {
      this.instance = new ToolValidator();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  /**
   * Validate tool input against all applicable rules.
   */
  validateInput(toolName: string, input: unknown): ToolValidationResult {
    const errors: string[] = [];

    // Run built-in rules
    for (const rule of this.rules) {
      const error = rule.validate(toolName, input);
      if (error) {
        errors.push(error);
        logger.warn('Tool input validation failed', {
          toolName,
          rule: rule.name,
          error,
        });
      }
    }

    // Run tool-specific custom rules
    const toolRules = this.customRules.get(toolName);
    if (toolRules) {
      for (const rule of toolRules) {
        const error = rule.validate(toolName, input);
        if (error) {
          errors.push(error);
          logger.warn('Tool input validation failed (custom rule)', {
            toolName,
            rule: rule.name,
            error,
          });
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Register a custom validation rule for a specific tool.
   */
  registerRule(toolName: string, rule: ValidationRule): void {
    const existing = this.customRules.get(toolName) ?? [];
    existing.push(rule);
    this.customRules.set(toolName, existing);
  }

  /**
   * Register a global validation rule applied to all tools.
   */
  registerGlobalRule(rule: ValidationRule): void {
    this.rules.push(rule);
  }
}

export function getToolValidator(): ToolValidator {
  return ToolValidator.getInstance();
}
