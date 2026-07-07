/**
 * CLI Error Handler — legacy CLI error tag mapping.
 *
 * Error pattern classification has been consolidated into
 * `src/main/core/error-recovery.ts` (`ErrorRecoveryManager`). This module now
 * delegates `classifyError` to that single source of truth.
 *
 * Kept here:
 *  - `CliError` enum
 *  - `classifyError()` for adapters that still emit legacy error tags
 *
 * @deprecated Prefer `ErrorRecoveryManager` (`getErrorRecoveryManager()`) for
 * new code. This module remains for backward compatibility with adapters that
 * still tag emitted errors with the legacy `CliError` enum.
 */

import { getErrorRecoveryManager } from '../core/error-recovery';
import { ErrorCategory } from '../../shared/types/error-recovery.types';

/**
 * CLI error types
 */
export enum CliError {
  NOT_INSTALLED = 'CLI_NOT_INSTALLED',
  NOT_AUTHENTICATED = 'CLI_NOT_AUTHENTICATED',
  TIMEOUT = 'CLI_TIMEOUT',
  PROCESS_CRASH = 'CLI_PROCESS_CRASH',
  PARSE_ERROR = 'CLI_PARSE_ERROR',
  PERMISSION_DENIED = 'CLI_PERMISSION_DENIED',
  NETWORK_ERROR = 'CLI_NETWORK_ERROR',
  RATE_LIMIT = 'CLI_RATE_LIMIT',
  INVALID_INPUT = 'CLI_INVALID_INPUT',
  CONTEXT_OVERFLOW = 'CLI_CONTEXT_OVERFLOW',
  UNKNOWN = 'CLI_UNKNOWN_ERROR',
}

/**
 * Map an `ErrorCategory` from the unified `ErrorRecoveryManager` to the legacy
 * `CliError` enum used by adapters that still emit pre-consolidation tags.
 */
function categoryToCliError(category: ErrorCategory, message: string): CliError {
  const lower = message.toLowerCase();
  switch (category) {
    case ErrorCategory.RATE_LIMITED:
      return CliError.RATE_LIMIT;
    case ErrorCategory.NETWORK:
      return CliError.NETWORK_ERROR;
    case ErrorCategory.AUTH:
      return CliError.NOT_AUTHENTICATED;
    case ErrorCategory.RESOURCE:
      // Resource covers context overflow + memory; only context maps to a
      // legacy CliError tag — memory exhaustion has no CLI-level analogue.
      if (
        lower.includes('context') ||
        lower.includes('token') ||
        lower.includes('too long') ||
        lower.includes('prompt is too long')
      ) {
        return CliError.CONTEXT_OVERFLOW;
      }
      return CliError.UNKNOWN;
    case ErrorCategory.PERMANENT:
      if (lower.includes('not found') || lower.includes('not installed') || lower.includes('enoent')) {
        return CliError.NOT_INSTALLED;
      }
      if (lower.includes('permission') || lower.includes('denied') || lower.includes('eacces') || lower.includes('eperm')) {
        return CliError.PERMISSION_DENIED;
      }
      if (lower.includes('parse') || lower.includes('json')) {
        return CliError.PARSE_ERROR;
      }
      if (lower.includes('invalid') || lower.includes('bad request')) {
        return CliError.INVALID_INPUT;
      }
      return CliError.UNKNOWN;
    case ErrorCategory.TRANSIENT:
      if (lower.includes('timeout') || lower.includes('timed out')) {
        return CliError.TIMEOUT;
      }
      if (lower.includes('crash') || lower.includes('exited') || lower.includes('killed') || lower.includes('sigkill') || lower.includes('sigterm')) {
        return CliError.PROCESS_CRASH;
      }
      return CliError.UNKNOWN;
    case ErrorCategory.UNKNOWN:
    default:
      return CliError.UNKNOWN;
  }
}

/**
 * Classify an error into a CliError type.
 *
 * Delegates pattern matching to `ErrorRecoveryManager` (the single source of
 * truth) and maps the resulting category back to the legacy `CliError` enum
 * for adapters that still emit it.
 */
export function classifyError(error: Error | string): CliError {
  const errObj = typeof error === 'string' ? new Error(error) : error;
  const classified = getErrorRecoveryManager().classifyError(errObj, 'cli-adapter');
  return categoryToCliError(classified.category, classified.technicalDetails ?? errObj.message);
}
