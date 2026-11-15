import { execFileSync } from 'node:child_process';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const cells = line => line.trim().split(/(?<!\\)\|/).slice(1, -1).map(cell => cell.trim());
const tableRule = line => line.trim().startsWith('|') && line.trim().endsWith('|')
  && cells(line).length > 0 && cells(line).every(cell => /^:?-{3,}:?$/.test(cell));

/** Only index rows allocate IDs; detail headings and references do not. */
export function indexMaximum(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(line => /^## Remediation Index\s*$/.test(line));
  if (start < 0) throw new Error('No LT IDs found in the remediation index');
  let maximum = null;
  for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) {
    const header = cells(lines[i]);
    if (header[0] !== 'ID') continue;
    let delimiter = i + 1;
    while (lines[delimiter]?.trim() === '') delimiter++;
    if (!tableRule(lines[delimiter] ?? '') || cells(lines[delimiter]).length !== header.length) {
      throw new Error('Malformed remediation index: missing matching table delimiter');
    }
    const priority = header[1] === 'Priority';
    if (!priority && header[1] !== 'Current status' && header[1] !== 'Status') continue;
    for (i = delimiter + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      if (!line.trimStart().startsWith('|')) { i--; break; }
      let next = i + 1;
      while (lines[next]?.trim() === '') next++;
      if (tableRule(lines[next] ?? '') && cells(lines[next]).length === cells(line).length) { i--; break; }
      const row = cells(line);
      if (!/^LT-\d+(?:[–-]LT-\d+)?(?:\s*,\s*LT-\d+(?:[–-]LT-\d+)?)*$/.test(row[0] ?? '')) {
        throw new Error(`Malformed remediation index: invalid LT ID or table boundary at line ${i + 1}`);
      }
      if (!line.trimEnd().endsWith('|') || row.length < (priority ? 3 : 2)
        || row.length > header.length || row.some(cell => !cell)) {
        throw new Error('Malformed remediation index: incomplete index row');
      }
      for (const match of row[0].matchAll(/LT-(\d+)/g)) {
        const id = BigInt(match[1]);
        if (id < 1n) throw new Error('Malformed remediation index: invalid LT ID');
        if (maximum === null || id > maximum) maximum = id;
      }
    }
  }
  if (maximum === null) throw new Error('No LT IDs found in the remediation index');
  return maximum;
}

export function reservationAuthority(cwd) {
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const common = realpathSync(git(['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const first = git(['--git-dir', common, 'worktree', 'list', '--porcelain', '-z']).split('\0')[0];
  if (!first.startsWith('worktree ')) throw new Error('Cannot resolve authoritative root checkout');
  const root = realpathSync(first.slice(9));
  const expected = join(root, 'docs/plans/livetest-remediation-register.md');
  const register = realpathSync(expected);
  if (register !== expected) throw new Error('Authoritative register must not redirect through a symlink');
  return { register, directory: join(common, 'aio-lt-reservations') };
}

function syncDirectory(directory) {
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Immutable exclusive-create claims are the lock and ledger. Never remove a claim,
 * including one left empty by a crash: the filename alone burns its identifier.
 * There is no stale PID lock to steal and no mutable counter to roll backwards. */
export function reserveIdentifier({ register, directory }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== resolve(directory)) {
    throw new Error('Reservation directory must be a real directory, not a symlink');
  }
  syncDirectory(dirname(directory));
  const deadline = Date.now() + 5000;
  do {
    let maximum = indexMaximum(readFileSync(register, 'utf8'));
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!/^LT-[0-9]+$/.test(entry.name) || !entry.isFile()) {
        throw new Error(`Malformed reservation ledger entry: ${entry.name}; preserve the ledger and inspect it before retrying`);
      }
      const id = BigInt(entry.name.slice(3));
      if (id < 1n) throw new Error('Malformed reservation ledger: identifier must be positive');
      if (id > maximum) maximum = id;
    }
    const identifier = `LT-${String(maximum + 1n).padStart(3, '0')}`;
    let fd;
    try { fd = openSync(join(directory, identifier), 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    try {
      writeFileSync(fd, JSON.stringify({ identifier, pid: process.pid, reservedAt: new Date().toISOString() }) + '\n');
      fsyncSync(fd);
    } finally { closeSync(fd); }
    syncDirectory(directory);
    return identifier;
  } while (Date.now() < deadline);
  throw new Error('Reservation contention exceeded five seconds; retry using the same authoritative root. Never remove reservation files.');
}
