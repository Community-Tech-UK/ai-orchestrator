/** Read-only by default. Apply is explicit, uses git mv, and never commits. */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyScratchManifest, scratchInventory, scratchManifestForReview, writeScratchReview } from './lib/retire-scratch';
export { applyScratchCleanup, protectedScratchNames, scratchInventory, writeScratchReview } from './lib/retire-scratch';
export type { ScratchEntry } from './lib/retire-scratch';

const DAY = 86_400_000;
const INDEX = 'docs/_archive/INDEX.md';
const GENERATED = 'docs/generated/architecture-inventory.json';
const GROUPS = [
  'superpowers plans', 'superpowers specs and verifications', 'closed plans, specs and designs',
  'closed live tests', 'legacy completed folder', 'other docs', 'top-level closed docs',
];
const INDEX_HEADER = '# Retired documents\n\nSame file name and sub-path as before; top-level docs live under `_root/`. Nothing is deleted.\n\nRestore: `git mv docs/_archive/<path> docs/<path>` (for `_root/<name>`, restore to `<name>`).\nHistory: `git log --follow -- docs/_archive/<path>`.\nSearch: `rg --no-ignore <word> docs/_archive`.\n';
export interface Doc {
  path: string;
  date: string;
  heading: string;
  bytes: number;
  group: number;
  reason?: string;
}
export interface Inventory {
  now: Date;
  cutoffDays: number;
  candidates: Doc[];
  held: Doc[];
  untracked: Doc[];
  review: Doc[];
}
export interface ApplyOptions {
  now: Date;
  cutoffDays: number;
  all?: boolean;
  groups?: number[];
  requireCleanIndex?: boolean;
}
function git(root: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
  });
}
const nulList = (text: string) => text.split('\0').filter(Boolean);
export const isClosed = (path: string) => /[._-]completed\.md$/i.test(path) || /superseded/i.test(path);
export function destination(path: string): string {
  return path.startsWith('docs/') ? `docs/_archive/${path.slice(5)}` : `docs/_archive/_root/${path}`;
}
export function parseAsOf(text: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('--as-of needs YYYY-MM-DD');
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new Error('Invalid --as-of date');
  return date;
}
function dateLabel(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function inScope(path: string): boolean {
  return (!path.includes('/') || path.startsWith('docs/'))
    && !path.split('/').includes('_archive')
    && !/^docs\/(runbooks|generated|llm)\//.test(path);
}
function group(path: string): number {
  if (!path.includes('/')) return 7;
  if (path.startsWith('docs/superpowers/plans/')) return 1;
  if (path.startsWith('docs/superpowers/')) return 2;
  if (path.startsWith('docs/plans/completed/')) return 5;
  if (path.startsWith('docs/plans/')) return /livetest/i.test(path) ? 4 : 3;
  return 6;
}
function changes(root: string): Map<string, string> {
  const entries = nulList(git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
  const result = new Map<string, string>();
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i].slice(0, 2);
    result.set(entries[i].slice(3), status);
    if (/[RC]/.test(status)) result.set(entries[++i], status);
  }
  return result;
}
function lastCommits(root: string, docs: string[]): Map<string, string> {
  const result = new Map<string, string>();
  const wanted = new Set(docs);
  let date = '';
  for (const line of git(root, ['log', '--cc', '--format=@@C@@%cI', '--name-only', '--no-renames']).split('\n')) {
    if (line.startsWith('@@C@@')) date = line.slice(5);
    else if (wanted.has(line) && !result.has(line)) result.set(line, date);
  }
  for (const path of docs) {
    if (!result.has(path)) result.set(path, git(root, ['log', '-1', '--format=%cI', '--', path]).trim());
  }
  return result;
}
/** Links may use bare names; prose/code references must contain a slash. */
function references(text: string): string[] {
  const links = [...text.matchAll(/\]\(<?([^\n)]+?\.md)(?:#[^\s)]*)?(?:\s+"[^"\n]*")?>?\)/gi)].map((m) => m[1]);
  const paths = [...text.matchAll(/(?:[\w.@+-]+\/)+[\w.+@-]+\.md\b/g)].map((m) => m[0]);
  return [...links, ...paths];
}
function readText(root: string, path: string): string | null {
  try {
    if (!lstatSync(resolve(root, path)).isFile()) return null;
    const data = readFileSync(resolve(root, path));
    return data.includes(0) ? null : data.toString('utf8');
  } catch { return null; }
}
function checkWritableFile(root: string, path: string): void {
  const target = resolve(root, path);
  let parent = dirname(target);
  while (parent !== resolve(root)) {
    try { if (!lstatSync(parent).isDirectory()) throw new Error(`Destination parent is not a real directory: ${parent}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    parent = dirname(parent);
  }
  try { if (!lstatSync(target).isFile()) throw new Error(`Destination is not a regular file: ${path}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export function inventory(root: string, now = new Date(), cutoffDays = 30): Inventory {
  if (!Number.isFinite(cutoffDays) || cutoffDays < 0) throw new Error('Invalid cutoff days');
  const tracked = nulList(git(root, ['ls-files', '-z']));
  const docs = tracked.filter((p) => /\.md$/i.test(p));
  const untracked = nulList(git(root, ['ls-files', '-z', '--others', '--exclude-standard', '*.md']));
  const dates = lastCommits(root, docs);
  const statuses = changes(root);
  const pins = new Map<string, string>();
  const known = new Set([...docs, ...untracked]);
  for (const path of [...tracked, ...untracked]) {
    if (path.startsWith('docs/generated/') || /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(path)) continue;
    if (/\.md$/i.test(path) && isClosed(path)) continue;
    const text = readText(root, path);
    if (text === null) continue;
    for (const raw of references(text)) {
      if (/^[a-z]+:\/\//i.test(raw)) continue;
      let ref: string;
      try { ref = decodeURIComponent(raw); } catch { continue; }
      for (const target of [posix.normalize(posix.join(posix.dirname(path), ref)), posix.normalize(ref)]) {
        if (known.has(target) && !pins.has(target)) { pins.set(target, path); break; }
      }
    }
  }
  const report: Inventory = { now, cutoffDays, candidates: [], held: [], untracked: [], review: [] };
  for (const path of [...docs, ...untracked].sort()) {
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(resolve(root, path)); } catch { continue; }
    const text = stat.isFile() ? readText(root, path) ?? '' : '';
    const doc: Doc = { path, date: dates.get(path) ?? '', heading: /^#+\s+(.+)$/m.exec(text)?.[1] ?? '', bytes: stat.size, group: group(path) };
    if (!dates.has(path)) {
      if (isClosed(path) || stat.mtimeMs < now.getTime() - 14 * DAY) report.untracked.push({ ...doc, reason: 'not committed; yours to decide, never touched' });
      continue;
    }
    if (isClosed(path)) {
      const reason = !inScope(path) ? 'out of scope or archived'
        : !stat.isFile() ? 'not a regular file'
        : statuses.has(path) ? 'local change (staged or unstaged)'
        : pins.has(path) ? `cited by ${pins.get(path)}`
        : !doc.date || Date.parse(doc.date) >= now.getTime() - cutoffDays * DAY ? 'too recent' : undefined;
      (reason ? report.held : report.candidates).push({ ...doc, reason });
    } else if (inScope(path) && stat.isFile() && !statuses.has(path) && !pins.has(path)
      && !/(?:readme|_(?:plan|spec|spec_planned|livetest|report|prompt)\.md$|prompt_)/i.test(path)
      && doc.date && Date.parse(doc.date) < now.getTime() - 90 * DAY) report.review.push(doc);
  }
  // The legacy README is the only non-closed doc movable, and only with its entire folder.
  const legacy = 'docs/plans/completed/README.md';
  const siblings = [...docs, ...untracked].filter((p) => p.startsWith('docs/plans/completed/') && p !== legacy);
  if (docs.includes(legacy) && !statuses.has(legacy) && !pins.has(legacy) && lstatSync(resolve(root, legacy)).isFile() && siblings.length > 0
    && siblings.every((p) => report.candidates.some((d) => d.path === p))) {
    report.candidates.push({ path: legacy, date: dates.get(legacy) ?? '', heading: 'Legacy completed folder', bytes: lstatSync(resolve(root, legacy)).size, group: 5 });
  }
  return report;
}
function escapeCell(text: string): string { return text.replace(/[\r\n]/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|'); }
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const totalBytes = (docs: readonly { bytes: number }[]) => docs.reduce((sum, d) => sum + d.bytes, 0);
function lines(docs: Doc[]): string {
  return docs.map((d) => `- ${d.path} | ${d.date.slice(0, 10) || 'uncommitted'} | ${escapeCell(d.heading)}${d.reason ? ` | ${d.reason}` : ''}`).join('\n') || '- None';
}
export function writeReview(root: string, report: Inventory): string {
  const output = resolve(root, `_scratch/retire-docs/${dateLabel(report.now)}.md`);
  checkWritableFile(root, output);
  mkdirSync(dirname(output), { recursive: true });
  const sections = GROUPS.map((label, i) => {
    const docs = report.candidates.filter((d) => d.group === i + 1);
    return `## Group ${i + 1}: ${label} (${docs.length}, ${size(totalBytes(docs))})\n\n${lines(docs)}`;
  });
  writeFileSync(output, `# Document retirement review\n\n${report.candidates.length} eligible documents (${size(totalBytes(report.candidates))}), strictly older than ${report.cutoffDays} days as of ${report.now.toISOString()}.\n\nAnswer by group number. This list grants no authority to move files.\n\n${sections.join('\n\n')}\n\n## Held back\n\n${lines(report.held)}\n\n## Reference documents: review only, never moved\n\n${lines(report.review)}\n\n## Untracked: yours to decide, never touched\n\n${lines(report.untracked)}\n`);
  return output;
}
export function checkSummary(root: string, report: Inventory): string {
  const headers = (readText(root, INDEX) ?? '').match(/^## Batch \d{4}-\d{2}-\d{2}/gm) ?? [];
  const last = headers.map((h) => h.slice(9)).sort().at(-1);
  const due = report.candidates.length >= 25 || (last && parseAsOf(last).getTime() < report.now.getTime() - 35 * DAY);
  return `Docs: ${report.candidates.length} closed docs are past the ${report.cutoffDays}-day cutoff and can move (${size(totalBytes(report.candidates))}). Last batch: ${last ?? 'never'}.${due ? ' due.' : ''} Run npm run docs:retire.`;
}
export function applyRetirement(root: string, options: ApplyOptions): { moved: Doc[]; pathsFile?: string; unrelatedStaged: number } {
  if (!options.all && !options.groups?.length) throw new Error('--apply needs --groups or --all');
  if (options.groups?.some((g) => !Number.isInteger(g) || g < 1 || g > 7)) throw new Error('Invalid groups; use 1 to 7');
  const report = inventory(root, options.now, options.cutoffDays);
  const moved = report.candidates.filter((d) => options.all || options.groups?.includes(d.group));
  const status = changes(root);
  const staged = [...status].filter(([, s]) => s[0] !== ' ' && s[0] !== '?');
  if (options.requireCleanIndex && staged.length) throw new Error('The index must be clean');
  for (const path of [INDEX, GENERATED]) if (status.has(path)) throw new Error(`Refusing changed ${path}`);
  const pathsFile = resolve(root, `_scratch/retire-docs/${dateLabel(options.now)}-paths.txt`);
  checkWritableFile(root, INDEX);
  checkWritableFile(root, pathsFile);
  for (const doc of moved) {
    if (status.has(doc.path)) throw new Error(`Refusing changed ${doc.path}`);
    const dest = destination(doc.path);
    let parent = dirname(resolve(root, dest));
    while (parent !== resolve(root)) {
      try { if (!lstatSync(parent).isDirectory()) throw new Error(`Destination parent is not a real directory: ${parent}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      parent = dirname(parent);
    }
    // lstat detects dangling symlinks too; existsSync alone does not.
    try { lstatSync(resolve(root, dest)); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
    throw new Error(`Destination exists: ${dest}`);
  }
  if (!moved.length) return { moved, unrelatedStaged: staged.length };
  const paths: string[] = [];
  for (const doc of moved) {
    const dest = destination(doc.path);
    mkdirSync(dirname(resolve(root, dest)), { recursive: true });
    git(root, ['mv', '--', doc.path, dest]);
    paths.push(doc.path, dest);
  }
  mkdirSync(dirname(resolve(root, INDEX)), { recursive: true });
  const previous = existsSync(resolve(root, INDEX)) ? readFileSync(resolve(root, INDEX), 'utf8') : INDEX_HEADER;
  writeFileSync(resolve(root, INDEX), `${previous}\n## Batch ${dateLabel(options.now)}\n\n| Original path | Last commit | Heading |\n|---|---|---|\n${moved.map((d) => `| ${escapeCell(d.path)} | ${d.date.slice(0, 10)} | ${escapeCell(d.heading.slice(0, 80))} |`).join('\n')}\n`);
  git(root, ['add', '--', INDEX]);
  paths.push(INDEX);
  mkdirSync(dirname(pathsFile), { recursive: true });
  // NUL-delimited literal pathspecs support spaces, quotes and wildcard-like filenames.
  writeFileSync(pathsFile, paths.map((p) => `:(literal)${p}\0`).join(''));
  return { moved, pathsFile, unrelatedStaged: staged.length };
}
function print(message: string): void { process.stdout.write(`${message}\n`); }
function main(): void {
  const args = process.argv.slice(2);
  const value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const known = new Set(['--as-of', '--cutoff-days', '--groups', '--apply', '--all', '--check', '--require-clean-index', '--scratch', '--manifest']);
  for (let i = 0; i < args.length; i++) {
    if (!known.has(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
    if (['--as-of', '--cutoff-days', '--groups', '--manifest'].includes(args[i])) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${args[i]}`);
      i++;
    }
  }
  if (args.includes('--check') && args.includes('--apply')) throw new Error('--check and --apply are exclusive');
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const now = value('--as-of') ? parseAsOf(value('--as-of')!) : new Date();
  const cutoffDays = value('--cutoff-days') === undefined ? 30 : Number(value('--cutoff-days'));
  if (args.includes('--manifest') && (!args.includes('--scratch') || !args.includes('--apply'))) throw new Error('--manifest requires --scratch --apply');
  if (args.includes('--scratch')) {
    if (args.includes('--apply')) {
      if (!value('--manifest')) throw new Error('--scratch --apply requires --manifest from the exact approved review');
      const result = applyScratchManifest(root, value('--manifest')!, now);
      print(`Deleted ${result.deleted.length} disposable entries (${size(totalBytes(result.deleted))}). Refused ${result.refused.length}.`);
      if (result.refused.length) process.exitCode = 1;
      for (const entry of result.refused) print(`Refused ${entry.path}: changed, protected, linked, too recent or unreadable; review again`);
    } else {
      const entries = scratchInventory(root, now);
      print(`${entries.length} disposable entries (${size(totalBytes(entries))}) are past their age limit.`);
      const review = writeScratchReview(root, entries, now);
      const manifest = scratchManifestForReview(review);
      print(`Review: ${review}`);
      print(`Manifest: ${manifest}`);
      print(`After approval: npm run docs:retire -- --scratch --apply --manifest '${manifest.replace(/'/g, "'\\''")}'`);
    }
    return;
  }
  if (args.includes('--apply')) {
    const report = inventory(root, now, cutoffDays);
    for (const d of report.held.filter((d) => d.reason?.startsWith('local change'))) print(`Skipped ${d.path}: ${d.reason}`);
    const result = applyRetirement(root, { now, cutoffDays, all: args.includes('--all'), groups: value('--groups')?.split(',').map(Number), requireCleanIndex: args.includes('--require-clean-index') });
    print(`Moved ${result.moved.length} docs. Left ${result.unrelatedStaged} unrelated staged paths unchanged.`);
    if (result.pathsFile) print(`Review staged paths, then: git commit --only --pathspec-from-file='${result.pathsFile.replace(/'/g, "'\\''")}' --pathspec-file-nul -m 'docs: retire ${result.moved.length} closed docs'`);
  } else {
    const report = inventory(root, now, cutoffDays);
    print(checkSummary(root, report));
    if (!args.includes('--check')) print(`Review: ${writeReview(root, report)}`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error((e as Error).message); process.exitCode = 1; }
}
