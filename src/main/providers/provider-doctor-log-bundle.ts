import type { RuntimeLogBundle } from '../../shared/types/provider-doctor.types';

interface ProbeForLogBundle {
  name: string;
  status: string;
  message: string;
}

/** Patterns that look like secrets — matched case-insensitively on each log line. */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bey[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\b/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /password\s*[:=]\s*\S+/gi,
  /token\s*[:=]\s*[A-Za-z0-9._~+/=-]{8,}/gi,
  /api[_-]?key\s*[:=]\s*\S+/gi,
  /secret\s*[:=]\s*\S+/gi,
];

function redactLine(line: string): { text: string; count: number } {
  let text = line;
  let count = 0;
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, () => {
      count++;
      return '[REDACTED]';
    });
    pattern.lastIndex = 0;
  }
  return { text, count };
}

/**
 * Build a redacted runtime-log bundle from failed probes in a diagnosis.
 * Returns undefined when there are no failed probes to bundle.
 */
export function buildRuntimeLogBundle(probes: ProbeForLogBundle[]): RuntimeLogBundle | undefined {
  const failed = probes.filter((p) => p.status === 'fail' || p.status === 'timeout');
  if (failed.length === 0) return undefined;

  const MAX_ENTRIES = 50;
  const MAX_LINE_LEN = 512;

  const entries: string[] = [];
  let totalRedacted = 0;

  for (const probe of failed.slice(0, MAX_ENTRIES)) {
    const raw = `[${probe.name}] ${probe.message}`.slice(0, MAX_LINE_LEN * 2);
    const { text, count } = redactLine(raw);
    entries.push(text.slice(0, MAX_LINE_LEN));
    totalRedacted += count;
  }

  return { entries, redactedCount: totalRedacted };
}
