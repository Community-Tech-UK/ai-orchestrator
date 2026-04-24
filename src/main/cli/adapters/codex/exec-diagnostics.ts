export interface CodexDiagnostic {
  category: 'auth' | 'mcp' | 'models' | 'process' | 'sandbox' | 'session' | 'startup' | 'unknown';
  fatal: boolean;
  line: string;
  level: 'error' | 'info' | 'warning';
  /** True when already surfaced to the UI during stderr streaming; close-time emit skips these. */
  streamed?: boolean;
}

export function classifyCodexDiagnostic(line: string): CodexDiagnostic {
  const trimmed = line.trim();
  const lower = trimmed.toLowerCase();
  const hasErrorLevel = /\berror\b/i.test(trimmed);
  const hasWarnLevel = /\bwarn\b/i.test(trimmed);

  if (
    lower.includes('failed to refresh available models')
    || lower.includes('timeout waiting for child process to exit')
  ) {
    return { category: 'models', fatal: false, line: trimmed, level: 'warning' };
  }

  if (
    lower.includes('failed to terminate mcp process group')
    || lower.includes('failed to kill mcp process group')
  ) {
    return { category: 'mcp', fatal: false, line: trimmed, level: 'warning' };
  }

  if (lower.includes('failed to delete shell snapshot')) {
    return { category: 'startup', fatal: false, line: trimmed, level: 'warning' };
  }

  if (lower.includes('state db missing rollout path') || lower.includes('codex_core::rollout')) {
    return { category: 'unknown', fatal: false, line: trimmed, level: 'info' };
  }

  if (
    lower.includes('unauthorized')
    || lower.includes('authentication')
    || lower.includes('forbidden')
    || lower.includes('login required')
  ) {
    return { category: 'auth', fatal: true, line: trimmed, level: 'error' };
  }

  if (
    lower.includes('unknown model')
    || lower.includes('model not found')
    || lower.includes('invalid model')
  ) {
    return { category: 'models', fatal: true, line: trimmed, level: 'error' };
  }

  if (
    lower.includes('session not found')
    || lower.includes('thread not found')
    || lower.includes('no matching session')
  ) {
    return { category: 'session', fatal: true, line: trimmed, level: 'error' };
  }

  if (
    lower.includes('permission denied')
    || lower.includes('sandbox')
    || lower.includes('dangerously-bypass-approvals-and-sandbox')
  ) {
    return {
      category: 'sandbox',
      fatal: hasErrorLevel,
      line: trimmed,
      level: hasErrorLevel ? 'error' : 'warning',
    };
  }

  if (hasWarnLevel) {
    return { category: 'unknown', fatal: false, line: trimmed, level: 'warning' };
  }

  if (hasErrorLevel) {
    return { category: 'process', fatal: false, line: trimmed, level: 'warning' };
  }

  return { category: 'unknown', fatal: false, line: trimmed, level: 'info' };
}
