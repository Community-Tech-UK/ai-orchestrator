/** Queue-owned integration truth lives in the replaceable Status block. */
import { readFile } from 'node:fs/promises';
import { changeDocumentFile, documentFileIdentity } from './plan-queue-document-mutation';
import { locateStatus } from './plan-queue-plan-extract';

function statusBlock(content: string): string {
  const status = locateStatus(content);
  return status ? status.visible.slice(status.heading + 1, status.end).join(status.eol) : '';
}

/** Where a new Status section goes when there is none: after any `---` front matter and the first `# ` title. */
function newStatusIndex(lines: readonly string[]): number {
  let index = 0;
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((line, i) => i > 0 && ['---', '...'].includes(line.trim()));
    if (close > 0) index = close + 1;
  }
  let first = index;
  while (first < lines.length && lines[first].trim() === '') first += 1;
  return first < lines.length && /^#[ \t]/.test(lines[first]) ? first + 1 : index;
}

/** Sets the "On main:" line as the first line of the Status block, in the document's own newline style. */
export function replaceOnMainLine(content: string, status: string): string {
  const located = locateStatus(content);
  const line = `On main: ${status}`;
  if (!located) {
    const lines = content.split(/\r?\n/);
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const at = newStatusIndex(lines);
    const after = lines.slice(at);
    return [...lines.slice(0, at), '', '## Status', '', line, ...(after[0] === '' ? [] : ['']), ...after].join(eol);
  }
  const { lines, visible, eol, heading, end } = located;
  const rest = lines.slice(heading + 1, end).filter((text, i) => !/^On main:/i.test(visible[heading + 1 + i]));
  while (rest.length && rest[0].trim() === '') rest.shift();
  // Keep the blank line before the next heading, or the final newline when Status is the last section.
  if (!rest.length && (end < lines.length || lines[lines.length - 1] === '')) rest.push('');
  return [...lines.slice(0, heading + 1), '', line, ...rest, ...lines.slice(end)].join(eol);
}

export function closingWouldHideUnlandedWork(content: string, landingBranch: string): boolean {
  return otherUnlandedBranches(content, landingBranch).length > 0;
}

/** Remove code spans before tokenising prose so delimiters inside refs stay literal. */
function splitReferences(line: string): { quoted: string[]; unquoted: string } {
  const quoted: string[] = [];
  const prose: string[] = [];
  let cursor = 0;
  while (cursor < line.length) {
    const open = line.indexOf('`', cursor);
    if (open < 0) { prose.push(line.slice(cursor)); break; }
    prose.push(line.slice(cursor, open));
    let start = open + 1;
    while (line[start] === '`') start += 1;
    const fence = line.slice(open, start);
    const close = line.indexOf(fence, start);
    if (close < 0) { prose.push(line.slice(open)); break; }
    // Git forbids ASCII spaces, but permits Unicode whitespace in ref names.
    // Strip only the ASCII padding used around edge backticks by our writer.
    quoted.push(line.slice(start, close).replace(/^ +| +$/g, ''));
    prose.push(' ');
    cursor = close + fence.length;
  }
  return { quoted, unquoted: prose.join('') };
}

/** Unquoted branch names are only recognised in the queue's own forms; anything else needs backticks. */
const QUEUE_BRANCH_RE = /^(?:queue|refs\/heads)\/\S+$/;

function unlandedBranches(content: string): string[] {
  const line = /^On main:\s*no\b[^\r\n]*/im.exec(statusBlock(content))?.[0] ?? '';
  const { quoted, unquoted } = splitReferences(line);
  const proseTokens = Array.from(unquoted, char => char.charCodeAt(0) <= 32 ? ' ' : char).join('');
  const proseRefs = proseTokens.split(/[ (),;`]+/).map(ref => ref.replace(/^[`'"]+|[`'".]+$/g, '')).filter(ref => QUEUE_BRANCH_RE.test(ref));
  const refs = [...quoted, ...proseRefs].filter(ref => ref && Array.from(ref).every(char => char.charCodeAt(0) > 32 && char !== '\u007f' && char !== ':') && !ref.startsWith('/'));
  return [...new Set(refs)];
}

/** The branches a Status line names as holding unlanded work, other than the one now landing. */
export function otherUnlandedBranches(content: string, landingBranch: string): string[] {
  return unlandedBranches(content).filter(branch => branch !== landingBranch);
}

function branchReference(branch: string): string {
  if (QUEUE_BRANCH_RE.test(branch) && !/[\s(),;`'"]/.test(branch)) return branch;
  const longestRun = (branch.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0);
  const fence = '`'.repeat(longestRun + 1);
  const padded = branch.startsWith('`') || branch.endsWith('`') ? ` ${branch} ` : branch;
  return `${fence}${padded}${fence}`;
}

/** A step job's landing says so, since the plan as a whole is not on main until its other steps are: unless it `finishesPlan`. */
export function landedIntegrationStatus(content: string, branch: string, commit: string, step?: number | null, finishesPlan = false): string {
  const remaining = unlandedBranches(content).filter(other => other !== branch);
  if (remaining.length) return `no (${remaining.map(branchReference).join(', ')}); latest landed commit: ${commit}`;
  return step == null || finishesPlan ? `yes (${commit})` : `Step ${step} landed (${commit}); the other steps may still be open`;
}

/** A committed document cannot embed its own hash; its Git version identifies that landing. */
export function closedIntegrationContent(content: string, commit = 'this landing commit'): string {
  return locateStatus(content) ? replaceOnMainLine(content, `yes (${commit})`) : content;
}

export async function updatePlanIntegrationStatus(documentPath: string, branch: string, commit: string, step?: number | null, finishesPlan = false): Promise<void> {
  const identity = documentFileIdentity(documentPath);
  const bytes = await readFile(documentPath);
  const content = bytes.toString('utf8');
  const updated = replaceOnMainLine(content, landedIntegrationStatus(content, branch, commit, step, finishesPlan));
  if (content !== updated) changeDocumentFile(identity, bytes, updated);
}
