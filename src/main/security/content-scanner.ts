/**
 * Fable WS12 — lightweight injection-shape scanner for project-sourced
 * instruction/config content.
 *
 * Rule engine over lines/content with a comment/string-strip pre-pass for
 * code-ish rules. Initial rules follow the openclaw-derived set from the
 * plan: "ignore previous instructions"-family phrases, pipe-to-shell install
 * commands, oversized base64/hex blobs, `process.env` + network-send
 * co-occurrence (for skill/plugin JS), and credential-file path references.
 *
 * Findings feed the instruction-trust approval surface and Doctor's
 * instruction diagnostics; `critical` findings block a file in enforce mode.
 * Purely advisory in warn mode — scanning never mutates the scanned file.
 */

export type ContentScanSeverity = 'info' | 'warn' | 'critical';

export interface ContentScanFinding {
  ruleId: string;
  severity: ContentScanSeverity;
  message: string;
  /** 1-indexed line of the first match. */
  line: number;
  /** Short redacted excerpt of the matching line. */
  excerpt: string;
}

const MAX_EXCERPT_CHARS = 120;
const BLOB_MIN_CHARS = 200;
/** Window (in lines) for the env-read + network-send co-occurrence rule. */
const ENV_NET_WINDOW = 8;

function excerptOf(line: string): string {
  const trimmed = line.trim();
  return trimmed.length <= MAX_EXCERPT_CHARS ? trimmed : `${trimmed.slice(0, MAX_EXCERPT_CHARS)}…`;
}

/**
 * Strip code comments and string literals so structural rules (env+network)
 * don't fire on documentation examples. Deliberately simple — a lexer is
 * overkill for an advisory scanner.
 */
export function stripCommentsAndStrings(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');
}

interface LineRule {
  ruleId: string;
  severity: ContentScanSeverity;
  message: string;
  pattern: RegExp;
}

const LINE_RULES: LineRule[] = [
  {
    ruleId: 'instruction-override',
    severity: 'critical',
    message: 'Instruction-override phrasing ("ignore previous instructions" family)',
    pattern: /\b(ignore|disregard|forget)\s+(all\s+|any\s+|your\s+)?(previous|prior|earlier|above|system)\s+(instructions?|prompts?|rules?|context)\b/i,
  },
  {
    ruleId: 'instruction-override',
    severity: 'critical',
    message: 'Instruction-override phrasing (role/system reset)',
    pattern: /\byou\s+are\s+no\s+longer\b|\bnew\s+system\s+prompt\s*:|\boverride\s+(the\s+)?system\s+prompt\b/i,
  },
  {
    ruleId: 'pipe-to-shell',
    severity: 'critical',
    message: 'Pipe-to-shell install command (curl/wget piped into a shell)',
    pattern: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/i,
  },
  {
    ruleId: 'exfil-hint',
    severity: 'warn',
    message: 'Instruction to send data to an external destination',
    pattern: /\b(send|post|upload|exfiltrate|forward)\b[^\n.]{0,60}\b(to\s+https?:\/\/|to\s+[a-z0-9-]+\.[a-z]{2,}\/)/i,
  },
  {
    ruleId: 'credential-path',
    severity: 'warn',
    message: 'Reference to a credential/secret file path',
    // `.env` must be a FILE reference — `(?<!process)(?<!\w)` keeps
    // `process.env`/`import.meta.env` prose from firing this rule.
    pattern: /(~\/\.aws\/credentials|~\/\.ssh\/id_[a-z0-9]+|\.npmrc\b[^\n]*_authToken|~\/\.netrc\b|\/etc\/shadow\b|(?<!process)(?<!\w)\.env\b[^\n]{0,30}\b(read|cat|send|upload|include)\b|\b(read|cat|send|upload|include)\b[^\n]{0,30}(?<!process)(?<!\w)\.env\b)/i,
  },
];

function findBlobFindings(lines: string[]): ContentScanFinding[] {
  const findings: ContentScanFinding[] = [];
  const base64Run = new RegExp(`[A-Za-z0-9+/=]{${BLOB_MIN_CHARS},}`);
  const hexRun = new RegExp(`(?:[0-9a-fA-F]{2}){${Math.ceil(BLOB_MIN_CHARS / 2)},}`);
  for (let i = 0; i < lines.length; i++) {
    const compact = lines[i].replace(/\s+/g, '');
    if (base64Run.test(compact) || hexRun.test(compact)) {
      findings.push({
        ruleId: 'opaque-blob',
        severity: 'warn',
        message: `Opaque base64/hex blob (> ${BLOB_MIN_CHARS} chars) — cannot be reviewed by reading`,
        line: i + 1,
        excerpt: excerptOf(`${lines[i].slice(0, 60)}…`),
      });
    }
  }
  return findings;
}

function findEnvNetworkFindings(content: string, lines: string[]): ContentScanFinding[] {
  // Run on comment/string-stripped content so docs mentioning process.env
  // in prose or examples don't co-fire with a nearby URL.
  const stripped = stripCommentsAndStrings(content).split('\n');
  const envLines: number[] = [];
  const netLines: number[] = [];
  const envRe = /\bprocess\.env\b|\bos\.environ\b/;
  const netRe = /\bfetch\s*\(|\bhttps?\.request\b|\baxios\.|\bXMLHttpRequest\b|\bnet\.connect\b|\bcurl\s+/;
  for (let i = 0; i < stripped.length; i++) {
    if (envRe.test(stripped[i])) envLines.push(i);
    if (netRe.test(stripped[i])) netLines.push(i);
  }
  const findings: ContentScanFinding[] = [];
  for (const envLine of envLines) {
    const near = netLines.find((n) => Math.abs(n - envLine) <= ENV_NET_WINDOW);
    if (near !== undefined) {
      findings.push({
        ruleId: 'env-network-cooccurrence',
        severity: 'critical',
        message: `Environment read within ${ENV_NET_WINDOW} lines of a network send`,
        line: envLine + 1,
        excerpt: excerptOf(lines[envLine] ?? ''),
      });
      break; // one finding per file is enough signal
    }
  }
  return findings;
}

/**
 * Scan instruction/config content for injection-shaped patterns. Returns
 * findings ordered by line. Never throws; a scanner failure yields [].
 */
export function scanContent(content: string): ContentScanFinding[] {
  try {
    const lines = content.split('\n');
    const findings: ContentScanFinding[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < lines.length; i++) {
      for (const rule of LINE_RULES) {
        if (rule.pattern.test(lines[i])) {
          const key = `${rule.ruleId}:${rule.message}`;
          if (seen.has(key)) continue; // first occurrence per rule variant
          seen.add(key);
          findings.push({
            ruleId: rule.ruleId,
            severity: rule.severity,
            message: rule.message,
            line: i + 1,
            excerpt: excerptOf(lines[i]),
          });
        }
      }
    }

    findings.push(...findBlobFindings(lines));
    findings.push(...findEnvNetworkFindings(content, lines));
    return findings.sort((a, b) => a.line - b.line);
  } catch {
    return [];
  }
}

/** Highest severity across findings, or null when clean. */
export function maxScanSeverity(findings: readonly ContentScanFinding[]): ContentScanSeverity | null {
  if (findings.some((f) => f.severity === 'critical')) return 'critical';
  if (findings.some((f) => f.severity === 'warn')) return 'warn';
  if (findings.length > 0) return 'info';
  return null;
}
