/**
 * Safety-mandate critic (claude2_todo #20).
 *
 * A pure, dependency-free critic that scans free-form agent output / a proposed
 * plan (and optionally an explicit command list) for safety objections:
 *
 *   - **destructive**     — irreversible data/branch/infra-destroying operations
 *   - **credential**      — touching secrets / keys / credential material
 *   - **missing-evidence**— the text *claims completion* but shows no sign that
 *                           tests / lint / build were run to back the claim
 *
 * `destructive` and unbacked completion claims are **blocking** objections;
 * `credential` and bare irreversible-verb mentions are **warnings**. The result
 * exposes `approved` (no blocking objections) so callers can use it as a
 * pre-execution gate (debate/verify) or a post-iteration advisory (loop).
 *
 * Kept pure (regex heuristics, no I/O) so it is trivially unit-testable and
 * reusable across the debate, verify, and loop surfaces. It complements — does
 * not replace — the per-command `bash-validation` pipeline, which classifies a
 * single parsed command; this critic works at the plan/output prose level and
 * adds the *missing-evidence* axis the command validators don't cover.
 */

export type ObjectionKind = 'destructive' | 'credential' | 'irreversible' | 'missing-evidence';
export type ObjectionSeverity = 'blocking' | 'warning';

export interface SafetyObjection {
  kind: ObjectionKind;
  severity: ObjectionSeverity;
  /** Human-readable explanation of the concern. */
  message: string;
  /** The matched fragment that triggered the objection (truncated). */
  match?: string;
}

export interface SafetyCritiqueInput {
  /** Free-form text: a plan, the agent's emitted output, an iteration excerpt. */
  text: string;
  /** Optional explicit commands the agent intends to / did run. */
  commands?: string[];
  /**
   * Whether verification evidence (tests / lint / build actually run) is known
   * to be present. When omitted, the critic infers it from the text. When
   * explicitly `false` and the text claims completion, a blocking
   * missing-evidence objection is raised.
   */
  hasVerificationEvidence?: boolean;
}

export interface SafetyCritique {
  /** All objections, blocking first. */
  objections: SafetyObjection[];
  /** Just the blocking subset (empty ⇒ safe to proceed). */
  blocking: SafetyObjection[];
  /** True when there are no blocking objections. */
  approved: boolean;
  /** One-line summary suitable for a log/advisory line. */
  summary: string;
}

interface Pattern {
  re: RegExp;
  kind: ObjectionKind;
  severity: ObjectionSeverity;
  message: string;
}

/** Irreversible / data-destroying operations. Blocking. */
const DESTRUCTIVE_PATTERNS: Pattern[] = [
  { re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r\b/i, kind: 'destructive', severity: 'blocking', message: 'recursive force-delete (rm -rf)' },
  { re: /\bgit\s+push\s+.*(?:--force\b|--force-with-lease\b|\s-f\b)/i, kind: 'destructive', severity: 'blocking', message: 'force push (rewrites remote history)' },
  { re: /\bgit\s+reset\s+--hard\b/i, kind: 'destructive', severity: 'blocking', message: 'git reset --hard (discards uncommitted work)' },
  { re: /\bgit\s+clean\s+-[a-z]*f/i, kind: 'destructive', severity: 'blocking', message: 'git clean -f (deletes untracked files)' },
  { re: /\bgit\s+branch\s+-D\b/i, kind: 'destructive', severity: 'blocking', message: 'force-delete git branch' },
  { re: /\bdrop\s+(?:table|database|schema)\b/i, kind: 'destructive', severity: 'blocking', message: 'SQL DROP (destroys schema/data)' },
  { re: /\bdelete\s+from\s+\w+(?!.*\bwhere\b)/i, kind: 'destructive', severity: 'blocking', message: 'unscoped SQL DELETE (no WHERE)' },
  { re: /\btruncate\s+table\b/i, kind: 'destructive', severity: 'blocking', message: 'SQL TRUNCATE (empties a table)' },
  { re: /\bdd\s+if=/i, kind: 'destructive', severity: 'blocking', message: 'dd (raw disk write)' },
  { re: /\bmkfs\b/i, kind: 'destructive', severity: 'blocking', message: 'mkfs (formats a filesystem)' },
  { re: /\bchmod\s+-R\s+0?777\b/i, kind: 'destructive', severity: 'blocking', message: 'chmod -R 777 (removes all permission protection)' },
  { re: /\bterraform\s+destroy\b/i, kind: 'destructive', severity: 'blocking', message: 'terraform destroy (tears down infrastructure)' },
  { re: /\bkubectl\s+delete\b/i, kind: 'destructive', severity: 'blocking', message: 'kubectl delete (removes cluster resources)' },
  { re: /\b(?:drop|wipe|purge|delete|destroy)\s+(?:the\s+)?(?:entire\s+)?(?:database|production|prod\b|all\s+data)/i, kind: 'destructive', severity: 'blocking', message: 'destroys a database / production / all data' },
];

/** Bare irreversible verbs (without a clearly-destructive command). Warning. */
const IRREVERSIBLE_PATTERNS: Pattern[] = [
  { re: /\bgit\s+filter-branch\b|\bfilter-repo\b/i, kind: 'irreversible', severity: 'warning', message: 'history rewrite (filter-branch/filter-repo)' },
  { re: /\bforce[- ]push(?:ing|ed)?\b/i, kind: 'irreversible', severity: 'warning', message: 'force push mentioned' },
  { re: /\b(?:permanently|irreversibl[ey])\b/i, kind: 'irreversible', severity: 'warning', message: 'explicitly irreversible action' },
];

/** Secrets / credential material. Warning (surfacing, not auto-blocking). */
const CREDENTIAL_PATTERNS: Pattern[] = [
  { re: /(?:^|[\s/"'`=])\.env(?:\.[a-z]+)?\b/i, kind: 'credential', severity: 'warning', message: 'touches a .env file' },
  { re: /\bid_rsa\b|\bid_ed25519\b|[\w/.-]+\.pem\b/i, kind: 'credential', severity: 'warning', message: 'touches an SSH/TLS private key' },
  { re: /\b(?:aws_secret_access_key|aws_access_key_id)\b/i, kind: 'credential', severity: 'warning', message: 'references AWS credentials' },
  { re: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|password|passphrase|credential)s?\s*[=:]/i, kind: 'credential', severity: 'warning', message: 'assigns a secret/credential value' },
  { re: /(?:^|[\s"'`])~?\/?\.ssh\//i, kind: 'credential', severity: 'warning', message: 'accesses the ~/.ssh directory' },
];

/** Phrases that assert the work is finished. */
const COMPLETION_CLAIM_RE =
  /\b(?:task\s+complete|all\s+done|done\b|completed?\b|finished\b|implemented\b|fixed\b|it\s+(?:now\s+)?works|ready\s+to\s+(?:merge|ship)|good\s+to\s+go)\b/i;

/** Signs that verification actually happened. */
const EVIDENCE_RE =
  /\b(?:test|tests|pytest|vitest|jest|jasmine|lint|eslint|tsc|typecheck|type-check|build|compiles?|passing|passed|green|coverage|npm\s+run|cargo\s+test|go\s+test)\b/i;

const MAX_MATCH = 120;

function truncate(s: string): string {
  const t = s.trim();
  return t.length > MAX_MATCH ? `${t.slice(0, MAX_MATCH)}…` : t;
}

function scan(text: string, patterns: Pattern[]): SafetyObjection[] {
  const out: SafetyObjection[] = [];
  for (const p of patterns) {
    const m = p.re.exec(text);
    if (m) {
      out.push({ kind: p.kind, severity: p.severity, message: p.message, match: truncate(m[0]) });
    }
  }
  return out;
}

/** True when `text` asserts the work is complete/finished. */
export function claimsCompletion(text: string): boolean {
  return COMPLETION_CLAIM_RE.test(text ?? '');
}

/** True when `text` shows any sign that verification (test/lint/build) ran. */
export function mentionsVerification(text: string): boolean {
  return EVIDENCE_RE.test(text ?? '');
}

/**
 * Critique the safety of a proposed plan / agent output. Pure; safe to call on
 * untrusted text. De-duplicates objections by (kind+message) so a phrase
 * matched in both `text` and `commands` is reported once.
 */
export function critiqueSafety(input: SafetyCritiqueInput): SafetyCritique {
  const text = input.text ?? '';
  const haystacks = [text, ...(input.commands ?? [])];

  const collected: SafetyObjection[] = [];
  for (const h of haystacks) {
    collected.push(...scan(h, DESTRUCTIVE_PATTERNS));
    collected.push(...scan(h, IRREVERSIBLE_PATTERNS));
    collected.push(...scan(h, CREDENTIAL_PATTERNS));
  }

  // Missing-evidence: the text claims completion but nothing indicates the
  // claim was verified. Caller-supplied `hasVerificationEvidence` wins over
  // text inference.
  const hasEvidence = input.hasVerificationEvidence ?? mentionsVerification(text);
  if (claimsCompletion(text) && !hasEvidence) {
    collected.push({
      kind: 'missing-evidence',
      severity: 'blocking',
      message: 'claims the work is complete but cites no test/lint/build evidence',
    });
  }

  // De-dup by kind+message (keep the first match).
  const seen = new Set<string>();
  const objections: SafetyObjection[] = [];
  for (const o of collected) {
    const key = `${o.kind}:${o.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      objections.push(o);
    }
  }
  // Blocking first, then warnings — stable within each group.
  objections.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'blocking' ? -1 : 1));

  const blocking = objections.filter((o) => o.severity === 'blocking');
  const approved = blocking.length === 0;
  const summary = approved
    ? objections.length === 0
      ? 'no safety objections'
      : `${objections.length} non-blocking safety warning(s)`
    : `${blocking.length} blocking safety objection(s): ${blocking.map((o) => o.message).join('; ')}`;

  return { objections, blocking, approved, summary };
}
