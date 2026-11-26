/** Ask-first disposable cleanup. Every deletion revalidates the reviewed generation. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const DAY = 86_400_000;
const PROTECTED = ['oct-phases', 'oct-audit'];
const NAMESPACES = ['_scratch', '.aio-review'] as const;
interface Snapshot { repo: string; repoId: string; namespaceId: string; generation: string }
export interface ScratchEntry {
  path: string;
  bytes: number;
  files: number;
  newestAt: number;
  kind: 'scratch' | 'review';
  /** Inventory-issued generation; entries without it are refused by the executor. */
  snapshot?: Snapshot;
}
interface Manifest { version: 1; repo: string; repoId: string; reviewedAt: number; entries: ScratchEntry[] }
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const nulList = (text: string) => text.split('\0').filter(Boolean);
function git(root: string, args: string[], input?: string): string {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: root, encoding: 'utf8', input, maxBuffer: 128 * 1024 * 1024,
  });
}
function identity(stat: Stats): string { return `${stat.dev}:${stat.ino}`; }
function generation(stat: Stats): string {
  return `${identity(stat)}:${stat.mode}:${stat.nlink}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.birthtimeMs}`;
}
function repoRoot(root: string): string {
  if (!lstatSync(root).isDirectory()) throw new Error('Repository root must be a real directory, never a link');
  const physical = realpathSync(root);
  if (realpathSync(git(physical, ['rev-parse', '--show-toplevel']).trim()) !== physical) throw new Error('Repository root mismatch');
  return physical;
}
function namespaceRoot(root: string, namespace: string): string {
  const full = join(root, namespace);
  if (!lstatSync(full).isDirectory() || realpathSync(full) !== full) throw new Error(`Linked or non-directory cleanup root: ${namespace}`);
  return full;
}
function namespace(entry: ScratchEntry): typeof NAMESPACES[number] {
  const parts = entry.path.split('/');
  if (parts.length !== 2 || !parts[1] || ['.', '..'].includes(parts[1]) || parts[1].includes('\\') || parts[1].includes('\0')
    || !NAMESPACES.includes(parts[0] as typeof NAMESPACES[number])
    || entry.kind !== (parts[0] === '_scratch' ? 'scratch' : 'review')) throw new Error(`Forbidden cleanup namespace: ${entry.path}`);
  return parts[0] as typeof NAMESPACES[number];
}
/** Read active Markdown every time; reference changes cannot inherit old deletion authority. */
function protection(root: string): { tracked: string[]; texts: string[] } {
  const tracked = nulList(git(root, ['ls-files', '-z']));
  const docs = [...tracked, ...nulList(git(root, ['ls-files', '-z', '--others', '--exclude-standard', '*.md']))];
  const texts: string[] = [];
  for (const path of new Set(docs)) {
    if (!/\.md$/i.test(path) || /_completed\.md$/i.test(path)) continue;
    const full = join(root, path);
    if (!lstatSync(full).isFile()) throw new Error(`Cannot inspect active reference: ${path}`);
    texts.push(readFileSync(full, 'utf8'));
  }
  return { tracked, texts };
}
export function protectedScratchNames(root: string): Set<string> {
  const names = new Set(PROTECTED);
  for (const text of protection(repoRoot(root)).texts) {
    for (const match of text.matchAll(/_scratch\/([\w.@+-]+)/g)) names.add(match[1]);
  }
  return names;
}
function assertProtected(entry: ScratchEntry, current: ReturnType<typeof protection>): void {
  if ((entry.kind === 'scratch' && PROTECTED.includes(entry.path.split('/')[1]))
    || current.texts.some(text => text.includes(entry.path) || text.includes(encodeURI(entry.path)))) throw new Error(`Protected reference: ${entry.path}`);
  if (current.tracked.some(path => path === entry.path || path.startsWith(`${entry.path}/`))) throw new Error(`Tracked cleanup entry: ${entry.path}`);
}
/** Includes directory mtimes (even empty directories), identities, and file contents. No links are traversed. */
function scan(root: string, entry: ScratchEntry, cutoff: number): { bytes: number; files: number; newestAt: number; generation: string; paths: string[] } {
  const ns = namespace(entry);
  const parent = namespaceRoot(root, ns);
  const parentId = identity(lstatSync(parent));
  const paths: string[] = [];
  const generations: string[] = [];
  const stamps = new Map<string, string>();
  let bytes = 0, files = 0, newestAt = 0;
  function visit(path: string): void {
    const full = join(root, path);
    const before = lstatSync(full);
    if (before.isSymbolicLink() || (!before.isFile() && !before.isDirectory()) || realpathSync(full) !== full) throw new Error(`Linked or uncertain cleanup path: ${path}`);
    if (entry.kind === 'review' && !before.isFile()) throw new Error('Review entries must be regular files');
    if (before.mtimeMs >= cutoff) throw new Error(`Cleanup entry is too recent: ${path}`);
    const stamp = generation(before);
    stamps.set(path, stamp);
    paths.push(path); newestAt = Math.max(newestAt, before.mtimeMs);
    let content = '';
    if (before.isDirectory()) {
      for (const name of readdirSync(full).sort()) visit(`${path}/${name}`);
    } else {
      const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (generation(fstatSync(fd)) !== stamp) throw new Error(`Changed cleanup file: ${path}`);
        const digest = createHash('sha256');
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let count: number;
        while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, count));
        content = digest.digest('hex');
        if (generation(fstatSync(fd)) !== stamp) throw new Error(`Changed cleanup file: ${path}`);
      } finally { closeSync(fd); }
      bytes += before.size; files++;
    }
    if (generation(lstatSync(full)) !== stamp) throw new Error(`Changed cleanup entry: ${path}`);
    generations.push(JSON.stringify([path, stamp, content]));
  }
  visit(entry.path);
  for (const [path, stamp] of stamps) {
    if (generation(lstatSync(join(root, path))) !== stamp) throw new Error(`Cleanup changed during scan: ${path}`);
  }
  if (identity(lstatSync(namespaceRoot(root, ns))) !== parentId) throw new Error('Cleanup ancestor changed');
  return { bytes, files, newestAt, generation: hash(generations.join('\n')), paths };
}
function assertIgnored(root: string, paths: string[]): void {
  let ignored: string;
  try { ignored = git(root, ['check-ignore', '-z', '--stdin'], paths.map(path => `${path}\0`).join('')); }
  catch (error) {
    if ((error as { status?: number }).status !== 1) throw error;
    ignored = (error as { stdout: string }).stdout;
  }
  const accepted = new Set(nulList(ignored));
  if (paths.some(path => !accepted.has(path))) throw new Error('Cleanup requires every path to be effectively Git-ignored and untracked');
}
function capture(root: string, entry: ScratchEntry, now: Date, current: ReturnType<typeof protection>): ScratchEntry {
  const ns = namespace(entry);
  assertProtected(entry, current);
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid cleanup time');
  const stats = scan(root, entry, now.getTime() - (ns === '_scratch' ? 30 : 14) * DAY);
  if (!Number.isFinite(now.getTime()) || stats.newestAt >= now.getTime() - (ns === '_scratch' ? 30 : 14) * DAY) throw new Error(`Cleanup entry is too recent: ${entry.path}`);
  assertIgnored(root, stats.paths);
  return { path: entry.path, kind: entry.kind, bytes: stats.bytes, files: stats.files, newestAt: stats.newestAt,
    snapshot: { repo: root, repoId: identity(lstatSync(root)), namespaceId: identity(lstatSync(namespaceRoot(root, ns))), generation: stats.generation } };
}
function unchanged(root: string, entry: ScratchEntry, now: Date, current: ReturnType<typeof protection>): void {
  const fresh = capture(root, entry, now, current);
  if (!entry.snapshot || JSON.stringify(fresh) !== JSON.stringify(entry)) throw new Error(`Stale or changed review: ${entry.path}; review again`);
}
export function scratchInventory(root: string, now = new Date()): ScratchEntry[] {
  root = repoRoot(root);
  const current = protection(root);
  const entries: ScratchEntry[] = [];
  for (const ns of NAMESPACES) {
    let full: string;
    try { full = namespaceRoot(root, ns); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const name of readdirSync(full).sort()) {
      const entry: ScratchEntry = { path: `${ns}/${name}`, kind: ns === '_scratch' ? 'scratch' : 'review', bytes: 0, files: 0, newestAt: 0 };
      try { entries.push(capture(root, entry, now, current)); }
      catch { /* Uncertain, protected, nonignored, linked and recent entries never become eligible. */ }
    }
  }
  return entries;
}
export function writeScratchReview(root: string, entries: ScratchEntry[], now = new Date()): string {
  root = repoRoot(root);
  const current = protection(root);
  for (const entry of entries) unchanged(root, entry, now, current);
  const manifest: Manifest = { version: 1, repo: root, repoId: identity(lstatSync(root)), reviewedAt: now.getTime(), entries };
  const data = JSON.stringify(manifest, null, 2) + '\n';
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'retire-docs-scratch-'));
  const path = join(directory, `manifest-${hash(data)}.json`);
  writeFileSync(path, data, { flag: 'wx', mode: 0o600 });
  const review = join(directory, 'review.md');
  const command = `npm run docs:retire -- --scratch --apply --manifest '${path.replace(/'/g, "'\\''")}'`;
  writeFileSync(review, `# Disposable-folder sweep review\n\nRepository: ${root}\n\nExactly ${entries.length} reviewed entries. Nothing is deleted by this review. Deletion cannot be undone.\n\nProtected: ${PROTECTED.join(', ')}, active Markdown references, tracked and nonignored paths. Scratch must be over 30 days old; review files over 14 days. Empty directory times count. Any changed entry requires another review.\n\n${entries.map(e => `- ${e.path} | ${e.files} files | ${e.bytes} bytes | newest ${new Date(e.newestAt).toISOString()}`).join('\n') || '- None'}\n\nManifest: ${path}\n\nAfter approving this exact list, run:\n\n${command}\n`, { flag: 'wx', mode: 0o600 });
  return review;
}
export function scratchManifestForReview(review: string): string {
  const files = readdirSync(dirname(review)).filter(name => /^manifest-[a-f0-9]{64}\.json$/.test(name));
  if (files.length !== 1) throw new Error('Ambiguous scratch review manifest');
  return join(dirname(review), files[0]);
}
function readManifest(root: string, path: string, now: Date): Manifest {
  path = resolve(path);
  const directory = dirname(path);
  const expected = /^manifest-([a-f0-9]{64})\.json$/.exec(basename(path));
  if (!expected || dirname(directory) !== realpathSync(tmpdir()) || !basename(directory).startsWith('retire-docs-scratch-')
    || !lstatSync(directory).isDirectory() || realpathSync(directory) !== directory || !lstatSync(path).isFile()) throw new Error('Invalid or linked scratch manifest; use the exact reviewed manifest');
  const data = readFileSync(path, 'utf8');
  if (hash(data) !== expected[1]) throw new Error('Scratch manifest changed; review again');
  const manifest = JSON.parse(data) as Manifest;
  if (manifest.version !== 1 || manifest.repo !== root || manifest.repoId !== identity(lstatSync(root))
    || !Number.isFinite(manifest.reviewedAt) || manifest.reviewedAt > now.getTime() || !Array.isArray(manifest.entries)
    || new Set(manifest.entries.map(e => e.path)).size !== manifest.entries.length) throw new Error('Scratch manifest repository, time or schema mismatch');
  return manifest;
}
export function applyScratchCleanup(root: string, entries: readonly ScratchEntry[], now = new Date()): { deleted: ScratchEntry[]; refused: ScratchEntry[] } {
  const deleted: ScratchEntry[] = [], refused: ScratchEntry[] = [];
  for (const entry of entries) {
    try {
      const physical = repoRoot(root);
      unchanged(physical, entry, now, protection(physical));
      assertProtected(entry, protection(physical));
      // Git runs subprocesses. Recheck physical identity/content after those checks,
      // with no subprocess or asynchronous boundary between this scan and rm.
      const ns = namespace(entry);
      const final = scan(physical, entry, now.getTime() - (ns === '_scratch' ? 30 : 14) * DAY);
      if (!entry.snapshot || final.generation !== entry.snapshot.generation
        || identity(lstatSync(physical)) !== entry.snapshot.repoId
        || identity(lstatSync(namespaceRoot(physical, ns))) !== entry.snapshot.namespaceId) throw new Error('Cleanup changed during protection recheck');
      rmSync(join(physical, entry.path), { recursive: true });
      deleted.push(entry);
    } catch { refused.push(entry); }
  }
  return { deleted, refused };
}
export function applyScratchManifest(root: string, path: string, now = new Date()): ReturnType<typeof applyScratchCleanup> {
  root = repoRoot(root);
  const manifest = readManifest(root, path, now);
  // Validate the complete approved batch before the first deletion, then revalidate per entry.
  const current = protection(root);
  for (const entry of manifest.entries) unchanged(root, entry, now, current);
  return applyScratchCleanup(root, manifest.entries, now);
}
