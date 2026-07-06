import { BaseCliAdapter, type AdapterRuntimeCapabilities } from '../cli/adapters/base-cli-adapter';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import { getErrorRecoveryManager } from '../core/error-recovery';
import { ErrorCategory } from '../../shared/types/error-recovery.types';
import { classifyContextOverflow, isContextOverflowError } from '../context/ptl-retry';
import { isSessionNotFoundText } from '../cli/adapters/resume-error-classifier';

export function getAdapterRuntimeCapabilities(adapter: CliAdapter): AdapterRuntimeCapabilities {
  if (adapter instanceof BaseCliAdapter) {
    return adapter.getRuntimeCapabilities();
  }
  return {
    supportsResume: false,
    supportsForkSession: false,
    supportsNativeCompaction: false,
    supportsPermissionPrompts: false,
    supportsDeferPermission: false,
    selfManagedAutoCompaction: false,
  };
}

export function isStatelessExecAdapter(adapter: CliAdapter): boolean {
  const runtimeCapabilities = getAdapterRuntimeCapabilities(adapter);
  if (
    runtimeCapabilities.supportsNativeCompaction
    || runtimeCapabilities.supportsPermissionPrompts
    || runtimeCapabilities.supportsDeferPermission
  ) {
    return false;
  }
  const adapterName = adapter.getName().toLowerCase();
  return [
    'antigravity-cli',
    'codex-cli',
    'copilot-cli',
    'cursor-cli',
    'gemini-cli',
  ].includes(adapterName);
}

export function isRecoverableStatelessExecTurnError(adapter: CliAdapter, error: Error): boolean {
  if (!isStatelessExecAdapter(adapter)) {
    return false;
  }

  const errorText = error instanceof Error ? error.message : String(error ?? '');
  if (!errorText.trim()) {
    return true;
  }

  if (isCorruptedSessionMessage(errorText)) {
    return false;
  }

  if (isSessionNotFoundText(errorText)) {
    return false;
  }

  const overflowEvidence = classifyContextOverflow({ errorText });
  if (overflowEvidence.matched) {
    return false;
  }

  const classified = getErrorRecoveryManager().classifyError(error);
  return !(classified.category === ErrorCategory.RESOURCE && classified.technicalDetails?.includes('context'));
}

export function isRecoverableAcpPromptTurnError(errorMessage: string): boolean {
  return /^ACP session\/prompt request timed out after \d+ms(?: without a session\/update)? \(id=.+\)\./.test(errorMessage)
    || errorMessage === 'ACP prompt turn was cancelled by the client.';
}

export function isContextOverflowMessage(content: string): boolean {
  return Boolean(content) && isContextOverflowError(content);
}

export function isCorruptedSessionMessage(content: string): boolean {
  if (!content) return false;
  const lower = content.toLowerCase();
  return (
    lower.includes('user messages must have non-empty content') ||
    lower.includes('must have non-empty content') ||
    lower.includes('messages must have non-empty') ||
    lower.includes('invalid_request_error') && lower.includes('non-empty')
  );
}
