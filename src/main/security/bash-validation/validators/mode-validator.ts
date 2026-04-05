// src/main/security/bash-validation/validators/mode-validator.ts
import type { BashValidatorSubmodule, ValidationContext, SubmoduleResult } from '../types';
import type { ParsedCommand } from '../types';
import { ReadOnlyValidator } from './read-only-validator';

export class ModeValidator implements BashValidatorSubmodule {
  readonly name = 'ModeValidator';
  private readOnlyValidator = new ReadOnlyValidator();

  validate(raw: string, parsed: ParsedCommand, context: ValidationContext): SubmoduleResult {
    // YOLO mode bypasses all checks
    if (context.yoloMode) {
      return { action: 'allow' };
    }

    // Delegate to ReadOnlyValidator in read_only mode
    if (context.mode === 'read_only') {
      return this.readOnlyValidator.validate(raw, parsed, context);
    }

    // workspace_write mode: warn on system paths, allow workspace writes
    if (context.mode === 'workspace_write') {
      const systemPaths = ['/etc/', '/usr/', '/var/', '/boot/', '/sys/', '/proc/', '/dev/', '/sbin/', '/lib/', '/opt/'];
      const warnings: string[] = [];

      for (const segment of parsed.segments) {
        for (const arg of segment.arguments) {
          for (const sysPath of systemPaths) {
            if (arg.includes(sysPath)) {
              warnings.push(`Writing to system path: ${sysPath}`);
              break;
            }
          }
        }
        for (const redirect of segment.redirects) {
          for (const sysPath of systemPaths) {
            if (redirect.includes(sysPath)) {
              warnings.push(`Redirecting to system path: ${sysPath}`);
              break;
            }
          }
        }
      }

      if (warnings.length > 0) {
        return {
          action: 'warn',
          message: warnings.join('; '),
          submodule: this.name,
        };
      }

      return { action: 'allow' };
    }

    // prompt and allow modes always allow
    return { action: 'allow' };
  }
}
