import { execFile, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reserveRemoteDefectIdentifiers, RemoteDefectReservationRequestSchema } from './remote-defect-reservation';

const execFileAsync = promisify(execFile);
const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'remote-lt-'));
  folders.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  mkdirSync(join(root, 'docs/plans'), { recursive: true });
  mkdirSync(join(root, 'scripts/lib'), { recursive: true });
  cpSync(resolve('scripts/next-lt-id.mjs'), join(root, 'scripts/next-lt-id.mjs'));
  cpSync(resolve('scripts/lib/lt-id-reservation.mjs'), join(root, 'scripts/lib/lt-id-reservation.mjs'));
  writeFileSync(join(root, 'docs/plans/livetest-remediation-register.md'), '## Remediation Index\n| ID | Status |\n| --- | --- |\n| LT-050 | root-only evidence |\n');
  return root;
}

describe('coordinator allocation for a remote worker', () => {
  it('uses the coordinator ledger and serializes against ordinary local reservations', async () => {
    const root = repository();
    const local = execFileAsync(process.execPath, [join(root, 'scripts/next-lt-id.mjs'), '--reserve'], { cwd: root });
    const [first, second, { stdout }] = await Promise.all([reserveRemoteDefectIdentifiers(root, 2), reserveRemoteDefectIdentifiers(root, 2), local]);
    const expected = ['LT-051', 'LT-052', 'LT-053', 'LT-054', 'LT-055'];
    expect([...first, ...second, stdout.trim()].sort()).toEqual(expected);
    expect(readdirSync(join(root, '.git/aio-lt-reservations')).sort()).toEqual(expected);
  });

  it('fails closed on an invalid authoritative register without claiming an identifier', async () => {
    const root = repository();
    writeFileSync(join(root, 'docs/plans/livetest-remediation-register.md'), 'invalid');
    await expect(reserveRemoteDefectIdentifiers(root, 1)).rejects.toThrow(/No LT IDs found/);
    expect(existsSync(join(root, '.git/aio-lt-reservations'))
      ? readdirSync(join(root, '.git/aio-lt-reservations')) : []).toEqual([]);
  });

  it('fails closed when the coordinator checkout has no allocator', async () => {
    const root = repository();
    rmSync(join(root, 'scripts/lib/lt-id-reservation.mjs'));
    await expect(reserveRemoteDefectIdentifiers(root, 1)).rejects.toThrow(/Cannot find module|ERR_MODULE_NOT_FOUND/);
  });

  it('allocates from the root checkout when the run works in a linked worktree', async () => {
    const root = repository();
    // No hooks or signing from the developer's global git settings may run in the fixture.
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      '-c', `core.hooksPath=${join(root, 'no-hooks')}`, ...args], { cwd: root });
    git('add', '.');
    git('commit', '-q', '--no-verify', '--no-gpg-sign', '-m', 'fixture');
    const linked = mkdtempSync(join(tmpdir(), 'remote-lt-linked-'));
    folders.push(linked);
    git('worktree', 'add', '-q', '--detach', join(linked, 'checkout'));
    writeFileSync(join(linked, 'checkout/scripts/lib/lt-id-reservation.mjs'), "throw new Error('worktree allocator must not run');\n");
    expect(await reserveRemoteDefectIdentifiers(join(linked, 'checkout'), 1)).toEqual(['LT-051']);
    expect(readdirSync(join(root, '.git/aio-lt-reservations'))).toEqual(['LT-051']);
  });

  it('rejects repeated identifiers from the allocator', async () => {
    const root = repository();
    writeFileSync(join(root, 'scripts/lib/lt-id-reservation.mjs'),
      "export const reservationAuthority = () => ({});\nexport const reserveIdentifier = () => 'LT-051';\n");
    await expect(reserveRemoteDefectIdentifiers(root, 2)).rejects.toThrow(/invalid or repeated/);
  });

  it('fails when the allocator stops before answering', async () => {
    const root = repository();
    writeFileSync(join(root, 'scripts/lib/lt-id-reservation.mjs'),
      'export const reservationAuthority = () => process.exit(3);\nexport const reserveIdentifier = () => \'LT-051\';\n');
    await expect(reserveRemoteDefectIdentifiers(root, 1)).rejects.toThrow(/stopped \(exit 3\)/);
  });

  it('accepts only a bounded request, without paths, commands or completion claims', () => {
    expect(RemoteDefectReservationRequestSchema.safeParse({ item_id: 'job', reserve_defect_ids: 2 }).success).toBe(true);
    for (const value of [0, 9, -1, 1.5, '1']) {
      expect(RemoteDefectReservationRequestSchema.safeParse({ item_id: 'job', reserve_defect_ids: value }).success).toBe(false);
    }
    expect(RemoteDefectReservationRequestSchema.safeParse({ item_id: 'job', reserve_defect_ids: 1, cwd: '/tmp/elsewhere' }).success).toBe(false);
    expect(RemoteDefectReservationRequestSchema.safeParse({ item_id: 'job', reserve_defect_ids: 1, summary: 'done' }).success).toBe(false);
  });
});
