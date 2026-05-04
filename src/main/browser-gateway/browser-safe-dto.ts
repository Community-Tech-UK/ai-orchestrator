import type {
  BrowserAuditEntry,
  BrowserProfile,
  BrowserTarget,
} from '@contracts/types/browser';
import { redactBrowserText } from './browser-redaction';

const REDACTED = '[REDACTED]';
const UNSAFE_KEYS = new Set([
  'debugPort',
  'debugEndpoint',
  'driverTargetId',
  'processId',
]);

export type AgentSafeProfile = Omit<
  BrowserProfile,
  'debugPort' | 'debugEndpoint' | 'processId'
>;

export type AgentSafeTarget = Omit<BrowserTarget, 'driverTargetId'>;

export function redactAgentString(value: string): string {
  return redactBrowserText(value)
    .replace(/wss?:\/\/[^\s"'<>]+/gi, REDACTED)
    .replace(/[^\s"']*browser-profiles\/[^\s"']+/gi, REDACTED)
    .replace(/--remote-debugging-port=\d+/gi, REDACTED)
    .replace(/\bdebugPort\s*[:=]\s*\d+/gi, REDACTED)
    .replace(/\blocalStorage\b[^\s"']*/gi, REDACTED);
}

export function toAgentSafeProfile(profile: BrowserProfile): AgentSafeProfile {
  const { debugPort, debugEndpoint, processId, ...safe } = profile;
  void debugPort;
  void debugEndpoint;
  void processId;
  return safe;
}

export function toAgentSafeTarget(target: BrowserTarget): AgentSafeTarget {
  const { driverTargetId, ...safe } = target;
  void driverTargetId;
  return safe;
}

export function toAgentSafeAudit(entry: BrowserAuditEntry): BrowserAuditEntry {
  return sanitizeValue(entry) as BrowserAuditEntry;
}

export function toAgentSafeHealth<T>(health: T): T {
  return sanitizeValue(health) as T;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactAgentString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }
  if (value && typeof value === 'object') {
    const safe: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) {
        continue;
      }
      safe[key] = sanitizeValue(child);
    }
    return safe;
  }
  return value;
}
