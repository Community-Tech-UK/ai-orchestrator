/**
 * Tool Error Classifier
 *
 * Classifies tool execution errors into telemetry-safe categories.
 * Inspired by Claude Code's classifyToolError() pattern.
 */

export enum ToolErrorCategory {
  FILESYSTEM = 'filesystem',
  PERMISSION = 'permission',
  TIMEOUT = 'timeout',
  VALIDATION = 'validation',
  PROCESS = 'process',
  NETWORK = 'network',
  UNKNOWN = 'unknown',
}

export interface ClassifiedError {
  category: ToolErrorCategory;
  code?: string;
  telemetrySafe: boolean;
  telemetryMessage: string;
  originalMessage: string;
}

const FS_ERROR_CODES = new Set(['ENOENT', 'EEXIST', 'EISDIR', 'ENOTDIR', 'EMFILE', 'ENFILE', 'ENOSPC', 'EROFS', 'EBUSY']);
const PERMISSION_CODES = new Set(['EACCES', 'EPERM']);
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH']);

export function classifyToolError(error: unknown): ClassifiedError {
  const err = error instanceof Error ? error : new Error(String(error));
  const originalMessage = err.message;
  const code = (err as NodeJS.ErrnoException).code;
  const name = err.name || err.constructor?.name;

  if (code && PERMISSION_CODES.has(code)) {
    return { category: ToolErrorCategory.PERMISSION, code, telemetrySafe: true, telemetryMessage: code, originalMessage };
  }
  if (code && FS_ERROR_CODES.has(code)) {
    return { category: ToolErrorCategory.FILESYSTEM, code, telemetrySafe: true, telemetryMessage: code, originalMessage };
  }
  if (code && NETWORK_CODES.has(code)) {
    return { category: ToolErrorCategory.NETWORK, code, telemetrySafe: true, telemetryMessage: code, originalMessage };
  }
  if (originalMessage.toLowerCase().includes('timed out') || originalMessage.toLowerCase().includes('timeout')) {
    return { category: ToolErrorCategory.TIMEOUT, telemetrySafe: true, telemetryMessage: 'timeout', originalMessage };
  }
  if (name === 'ZodError' || originalMessage.includes('Invalid tool arguments')) {
    return { category: ToolErrorCategory.VALIDATION, telemetrySafe: true, telemetryMessage: 'validation_error', originalMessage };
  }
  if (originalMessage.includes('SIGKILL') || originalMessage.includes('SIGTERM') || originalMessage.includes('exited with code')) {
    return { category: ToolErrorCategory.PROCESS, telemetrySafe: true, telemetryMessage: 'process_error', originalMessage };
  }
  return { category: ToolErrorCategory.UNKNOWN, telemetrySafe: true, telemetryMessage: 'Error', originalMessage };
}
