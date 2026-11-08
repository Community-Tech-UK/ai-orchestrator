/** Small, source-addressed queue briefs. Repository Markdown is data, never instructions. */
import { closeSync, openSync, readSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

export const PLAN_BRIEF_BYTES = 4096;
const PLAN_HEADER_LINES = 40;
const PLAN_HEADER_BYTES = 8192;
const HEADER_READ_BYTES = 16 * 1024;
const PLAN_STATUS_CHARS = 1800;

export interface PlanBrief {
  /** The plan's `## Status` block, bounded. */
  status: string;
  /** Unticked items and "Done when" / acceptance bullets, bounded. */
  acceptance: string;
  /** Set when the brief is for one step of a plan that runs one job per step. */
  step?: PlanStep;
}

/** One `## Step N` section. Lines are 1-based and inclusive: the heading, then everything before the next `##` heading. */
export interface PlanStep {
  number: number;
  startLine: number;
  endLine: number;
  /** The plan's last step: its job writes the as-built summary. */
  last: boolean;
}

/** Heading text that names the Status section: "Status" as a whole word, then anything (`Status (date)`, `Status: x`, `Status — x`). Also used by the plan diet's counter. */
export const STATUS_TEXT_RE = /^status\b/i;
/** A level-2 Status heading line. Match whole lines only. */
export const STATUS_HEADING = String.raw`##[ \t]+${STATUS_TEXT_RE.source.slice(1)}[^\r\n]*`;

/** Ends a bounded extract that was cut short. */
export const BRIEF_TRUNCATED_MARK = '[Brief truncated. Read the source acceptance sections.]';
const NO_STATUS = "No `## Status` heading found; read the plan's opening section for its current state.";

/** `value` cut to `bytes` UTF-8 bytes, ending in `mark` when anything was removed. */
export function bounded(value: string, bytes: number, mark = BRIEF_TRUNCATED_MARK): string {
  if (Buffer.byteLength(value) <= bytes) return value;
  const suffix = `\n${mark}`;
  let prefix = value.slice(0, bytes - Buffer.byteLength(suffix));
  while (Buffer.byteLength(prefix) > bytes - Buffer.byteLength(suffix)) prefix = prefix.slice(0, -1);
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  return prefix + suffix;
}

/** The first 40 lines of a plan: the part triage needs to judge readiness. */
export function extractPlanHeader(content: string): string {
  return bounded(content.split('\n', PLAN_HEADER_LINES).join('\n'), PLAN_HEADER_BYTES);
}

/** Lines outside fenced code blocks; a fenced example is never a heading, item or bullet. */
export function linesOutsideFences(lines: readonly string[]): string[] {
  let fence = '';
  return lines.map(line => {
    const match = /^\s*(`{3,}|~{3,})(.*)/.exec(line);
    if (match && (!fence || match[1][0] === fence[0])) {
      const [, marker, info] = match;
      if (!fence) { fence = marker; return ''; }
      // A closing fence must run at least as long as the opener and carry no
      // info string; a short or suffixed marker is code inside the block.
      if (marker.length >= fence.length && info.trim() === '') fence = '';
      return '';
    }
    return fence ? '' : line;
  });
}

/** Where a document's `## Status` section sits, by line index (end is exclusive). Fenced examples never count. */
export interface StatusLocation {
  lines: string[];
  /** Lines with code-fence content blanked out; same indexes as `lines`. */
  visible: string[];
  /** The document's own newline style. */
  eol: '\r\n' | '\n';
  heading: number;
  end: number;
}

/** The one way to find the Status section: LF or CRLF, outside code fences, up to the next `## ` heading or the end. */
export function locateStatus(content: string): StatusLocation | null {
  const lines = content.split(/\r?\n/);
  const visible = linesOutsideFences(lines);
  const pattern = new RegExp(`^${STATUS_HEADING}$`, 'i');
  const heading = visible.findIndex(line => pattern.test(line));
  if (heading < 0) return null;
  const next = visible.findIndex((line, index) => index > heading && /^##[ \t]/.test(line));
  return { lines, visible, eol: content.includes('\r\n') ? '\r\n' : '\n', heading, end: next < 0 ? lines.length : next };
}

/**
 * A plan's steps in document order, outside code fences. Null when it has fewer than two, or when two share a number
 * (a job could not tell them apart), so such a plan is never split.
 */
export function planSteps(content: string): PlanStep[] | null {
  const visible = linesOutsideFences(content.split(/\r?\n/));
  const headings = visible.flatMap((line, index) => /^##[ \t]/.test(line) ? [index] : []);
  const steps: PlanStep[] = [];
  for (const [position, index] of headings.entries()) {
    const match = /^##[ \t]+Step[ \t]+(\d{1,6})\b/i.exec(visible[index]);
    if (match) steps.push({ number: Number(match[1]), startLine: index + 1, endLine: headings[position + 1] ?? visible.length, last: false });
  }
  if (steps.length < 2 || new Set(steps.map(step => step.number)).size !== steps.length) return null;
  steps[steps.length - 1].last = true;
  return steps;
}

/** `stepNumber`, when given, scopes the open items to that step; a step that is no longer in the plan says so instead. */
export function extractPlan(content: string, stepNumber?: number): PlanBrief {
  const lines = content.split(/\r?\n/);
  const visible = linesOutsideFences(lines);
  const step = stepNumber === undefined ? undefined : planSteps(content)?.find(candidate => candidate.number === stepNumber);
  if (stepNumber !== undefined && !step) {
    const note = `Step ${stepNumber} was not found in this plan. Read the plan and reconcile before you do anything else.`;
    return { status: note, acceptance: note };
  }
  const status = locateStatus(content);
  let acceptance = false;
  const bullets = (step ? visible.slice(step.startLine - 1, step.endLine) : visible).filter(line => {
    if (/^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:Done when|Acceptance(?: criteria)?)[\s:*]/i.test(line)) { acceptance = true; return true; }
    if (/^\s*- \[[xX]\]/.test(line)) return false;
    if (/^\s*- \[ \]/.test(line)) return true;
    if (acceptance && /^\s*(?:[-*]|\d+[.)])\s+/.test(line)) return true;
    if (line.trim()) acceptance = false;
    return false;
  });
  return {
    status: status ? bounded(status.lines.slice(status.heading + 1, status.end).join('\n').trim(), PLAN_STATUS_CHARS) : NO_STATUS,
    acceptance: bounded(bullets.join('\n') || `(No explicit open checklist or acceptance bullets; read the source ${step ? 'step' : 'document'}.)`, PLAN_BRIEF_BYTES),
    ...(step ? { step } : {}),
  };
}

/** The brief for a plan on disk. An unreadable plan still gets a prompt, telling the agent to read the source itself. */
export async function readPlanBrief(documentPath: string, stepNumber?: number | null): Promise<PlanBrief> {
  try { return extractPlan(await readFile(documentPath, 'utf8'), stepNumber ?? undefined); }
  catch (error) {
    return {
      status: `Source brief unavailable: ${error instanceof Error ? error.message : String(error)}`,
      acceptance: 'Read the source document before implementing or claiming acceptance. An unavailable brief is not completion evidence.',
    };
  }
}

/**
 * The header lines triage reads for one plan, or a note to read the source when the file cannot be read.
 * Read synchronously, from the first 16 KB only: triage starts a session straight after, and this adds no wait.
 */
export function readPlanHeader(documentPath: string): string {
  try {
    const fd = openSync(documentPath, 'r');
    try {
      const buffer = Buffer.alloc(HEADER_READ_BYTES);
      return extractPlanHeader(buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, 0)));
    } finally { closeSync(fd); }
  } catch { return '(The header could not be read; inspect the source Status before deciding readiness.)'; }
}
