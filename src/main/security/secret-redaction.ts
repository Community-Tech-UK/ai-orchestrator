/**
 * Secret Redaction - Mask and redact sensitive information
 */

import { DetectedSecret, detectSecretsInContent, detectSecretsInEnvContent, detectSecretsInKeyValue } from './secret-detector';

/**
 * Redaction options
 */
export interface RedactionOptions {
  /** Replacement character for redacted content */
  maskChar?: string;
  /** Number of characters to show at start (for partial redaction) */
  showStart?: number;
  /** Number of characters to show at end (for partial redaction) */
  showEnd?: number;
  /** Whether to completely mask or show partial */
  fullMask?: boolean;
  /** Custom redaction label */
  label?: string;
}

const DEFAULT_OPTIONS: Required<RedactionOptions> = {
  maskChar: '*',
  showStart: 4,
  showEnd: 4,
  fullMask: false,
  label: '[REDACTED]',
};

/**
 * Redact a single value
 */
export function redactValue(value: string, options?: RedactionOptions): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (opts.fullMask || value.length < (opts.showStart + opts.showEnd + 4)) {
    return opts.label;
  }

  const start = value.slice(0, opts.showStart);
  const end = value.slice(-opts.showEnd);
  const maskLength = Math.min(value.length - opts.showStart - opts.showEnd, 12);
  const mask = opts.maskChar.repeat(maskLength);

  return `${start}${mask}${end}`;
}

/**
 * Redact detected secrets in content.
 * Use redactSecretsWithOptions when you need custom masking behaviour;
 * use redactSecrets (from secret-detector) for the simple label-based variant.
 */
export function redactSecretsWithOptions(
  content: string,
  secrets: DetectedSecret[],
  options?: RedactionOptions
): string {
  if (secrets.length === 0) {
    return content;
  }

  // Sort by position descending so we can replace without index shifting
  const sorted = [...secrets].sort((a, b) => b.startIndex - a.startIndex);

  let result = content;
  for (const secret of sorted) {
    // Use the length of the redactedValue field as a proxy for the original value length
    const redacted = redactValue(secret.redactedValue, options);
    result = result.slice(0, secret.startIndex) + redacted + result.slice(secret.endIndex);
  }

  return result;
}

/**
 * Redact secrets in .env file content
 */
export function redactEnvContent(content: string, options?: RedactionOptions): string {
  const secrets = detectSecretsInEnvContent(content);
  const lines = content.split('\n');

  for (const secret of secrets) {
    if (secret.line !== undefined) {
      const lineIndex = secret.line - 1;
      const line = lines[lineIndex];
      const match = line.match(/^([^=]+)=(.*)$/);
      if (match) {
        const [, name, value] = match;
        const redacted = redactValue(value.replace(/^["']|["']$/g, ''), options);
        lines[lineIndex] = `${name}=${redacted}`;
      }
    }
  }

  return lines.join('\n');
}

/**
 * Redact all secrets in arbitrary content
 */
export function redactAllSecrets(content: string, options?: RedactionOptions): string {
  const secrets = detectSecretsInContent(content);
  return redactSecretsWithOptions(content, secrets, options);
}

/**
 * Create a redacted copy of environment variables
 */
export function redactEnvVars(
  env: Record<string, string | undefined>,
  options?: RedactionOptions
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;

    // Check if this is a sensitive key
    const secret = detectSecretsInKeyValue(key, value);

    if (secret) {
      result[key] = redactValue(value, options);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Redact sensitive patterns in log output
 */
export function redactLogOutput(logContent: string, options?: RedactionOptions): string {
  let result = logContent;

  // Redact common secret patterns in logs
  const patterns = [
    // API keys in URLs
    /([?&](api[_-]?key|token|access[_-]?token|secret)=)[^&\s]+/gi,
    // Authorization headers
    /(authorization:\s*(bearer|basic)\s+)[^\s]+/gi,
    // Password in URLs
    /:\/\/([^:]+):([^@]+)@/gi,
  ];

  for (const pattern of patterns) {
    result = result.replace(pattern, (match, prefix) => {
      if (prefix) {
        return prefix + (options?.label || '[REDACTED]');
      }
      return options?.label || '[REDACTED]';
    });
  }

  // Also run general secret detection
  const secrets = detectSecretsInContent(result);
  result = redactSecretsWithOptions(result, secrets, options);

  return result;
}

/**
 * Create an audit record for secret access
 */
export interface SecretAccessRecord {
  timestamp: number;
  action: 'read' | 'expose' | 'redact';
  secretType: string;
  secretName: string;
  filePath?: string;
  instanceId?: string;
  decision: 'allowed' | 'denied' | 'redacted';
}

/**
 * Audit log for tracking secret access
 */
class SecretAuditLog {
  private records: SecretAccessRecord[] = [];
  private maxRecords = 1000;

  /**
   * Record a secret access attempt
   */
  record(entry: Omit<SecretAccessRecord, 'timestamp'>): void {
    this.records.push({
      ...entry,
      timestamp: Date.now(),
    });

    // Trim if over max
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }
  }

  /**
   * Get recent records
   */
  getRecords(limit = 100): SecretAccessRecord[] {
    return this.records.slice(-limit);
  }

  /**
   * Get records for a specific instance
   */
  getRecordsByInstance(instanceId: string, limit = 50): SecretAccessRecord[] {
    return this.records
      .filter(r => r.instanceId === instanceId)
      .slice(-limit);
  }

  /**
   * Clear all records
   */
  clear(): void {
    this.records = [];
  }

  /**
   * Export records to JSON
   */
  export(): string {
    return JSON.stringify(this.records, null, 2);
  }
}

// Singleton audit log
let auditLog: SecretAuditLog | null = null;

/**
 * Get the secret audit log instance
 */
export function getSecretAuditLog(): SecretAuditLog {
  if (!auditLog) {
    auditLog = new SecretAuditLog();
  }
  return auditLog;
}
