/**
 * Tests for SelfPermissionGranter — persistent permission writes into the
 * user's Claude CLI settings file.
 *
 * These tests use real filesystem I/O rooted in an OS tmpdir so we can assert
 * on the on-disk shape (including preservation of unknown fields).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SelfPermissionGranter } from '../self-permission-granter';

describe('SelfPermissionGranter', () => {
  let tmpRoot: string;
  let settingsFile: string;
  let auditFile: string;
  let granter: SelfPermissionGranter;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'self-perm-granter-'));
    settingsFile = path.join(tmpRoot, '.claude', 'settings.json');
    auditFile = path.join(tmpRoot, 'audit.log');
    granter = new SelfPermissionGranter({
      settingsFile,
      auditLogFile: auditFile,
      homeDirProvider: () => tmpRoot,
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* intentionally ignored: cleanup */
    }
  });

  function readSettings(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as Record<string, unknown>;
  }

  function readAllowArray(): string[] {
    const s = readSettings();
    const perms = s['permissions'] as { allow?: unknown } | undefined;
    return Array.isArray(perms?.allow) ? (perms!.allow as string[]) : [];
  }

  // ----------------------------------------------------------------
  // Creation + basic happy paths
  // ----------------------------------------------------------------

  it('creates settings.json with the rule when the file is absent', () => {
    const result = granter.grant({
      action: 'edit',
      path: '/Users/test/.claude/settings.json',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rulePattern).toBe('Edit(/Users/test/.claude/settings.json)');
    expect(result.alreadyExisted).toBe(false);
    expect(result.settingsFile).toBe(settingsFile);
    expect(fs.existsSync(settingsFile)).toBe(true);
    expect(readAllowArray()).toEqual(['Edit(/Users/test/.claude/settings.json)']);
  });

  it('appends a rule to an existing settings.json without disturbing other fields', () => {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    const preExisting = {
      env: { FOO: 'bar' },
      includeCoAuthoredBy: false,
      permissions: {
        allow: ['WebFetch'],
        deny: ['Bash(rm -rf /)'],
        defaultMode: 'default',
      },
      statusLine: { type: 'command', command: 'echo hi' },
      enabledPlugins: { 'frontend-design@claude-plugins-official': true },
    };
    fs.writeFileSync(settingsFile, JSON.stringify(preExisting, null, 2), 'utf-8');

    const result = granter.grant({
      toolName: 'Edit',
      path: '/tmp/a.ts',
    });
    expect(result.ok).toBe(true);

    const after = readSettings();
    // Every pre-existing field is preserved
    expect(after['env']).toEqual({ FOO: 'bar' });
    expect(after['includeCoAuthoredBy']).toBe(false);
    expect(after['statusLine']).toEqual({ type: 'command', command: 'echo hi' });
    expect(after['enabledPlugins']).toEqual({
      'frontend-design@claude-plugins-official': true,
    });
    const perms = after['permissions'] as {
      allow: string[];
      deny: string[];
      defaultMode: string;
    };
    expect(perms.allow).toEqual(['WebFetch', 'Edit(/tmp/a.ts)']);
    expect(perms.deny).toEqual(['Bash(rm -rf /)']);
    expect(perms.defaultMode).toBe('default');
  });

  it('is idempotent when the rule is already present', () => {
    const first = granter.grant({ toolName: 'Edit', path: '/tmp/x.ts' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.alreadyExisted).toBe(false);

    const mtimeBefore = fs.statSync(settingsFile).mtimeMs;

    const second = granter.grant({ toolName: 'Edit', path: '/tmp/x.ts' });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.alreadyExisted).toBe(true);
    expect(second.rulePattern).toBe('Edit(/tmp/x.ts)');

    // The mtime comparison can be flaky with coarse-grained filesystems; the
    // stronger guarantee is that the allow array still has exactly one entry.
    expect(readAllowArray()).toEqual(['Edit(/tmp/x.ts)']);
    // Best-effort mtime check
    const mtimeAfter = fs.statSync(settingsFile).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  // ----------------------------------------------------------------
  // Action → ToolName mapping
  // ----------------------------------------------------------------

  it('maps write-family actions to the Write tool', () => {
    for (const action of ['write', 'create', 'new', 'add']) {
      const g = new SelfPermissionGranter({
        settingsFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spgA-')), 's.json'),
        auditLogFile: path.join(tmpRoot, `a-${action}.log`),
        homeDirProvider: () => tmpRoot,
      });
      const r = g.grant({ action, path: '/tmp/new.ts' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.rulePattern).toBe('Write(/tmp/new.ts)');
    }
  });

  it('maps edit-family actions to the Edit tool', () => {
    for (const action of ['edit', 'modify', 'update', 'change', 'overwrite', 'replace', 'patch']) {
      const g = new SelfPermissionGranter({
        settingsFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spgB-')), 's.json'),
        auditLogFile: path.join(tmpRoot, `a-${action}.log`),
        homeDirProvider: () => tmpRoot,
      });
      const r = g.grant({ action, path: '/tmp/e.ts' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.rulePattern).toBe('Edit(/tmp/e.ts)');
    }
  });

  it('maps bash-family actions to the Bash tool and uses the command as pattern', () => {
    const r = granter.grant({ action: 'run', path: 'rm -rf node_modules' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rulePattern).toBe('Bash(rm -rf node_modules)');
  });

  it('prefers an explicit Claude toolName over action', () => {
    const r = granter.grant({ action: 'modify', toolName: 'Write', path: '/tmp/x.ts' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rulePattern).toBe('Write(/tmp/x.ts)');
  });

  it('falls back to Edit when action is unknown but a file path is supplied', () => {
    const r = granter.grant({ action: 'frobulate', path: '/tmp/y.ts' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rulePattern).toBe('Edit(/tmp/y.ts)');
  });

  it('refuses to grant when action is unknown and no path is supplied', () => {
    const r = granter.grant({ action: 'frobulate' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('UNSUPPORTED_ACTION');
  });

  // ----------------------------------------------------------------
  // Scope
  // ----------------------------------------------------------------

  it('writes an exact-path rule by default', () => {
    const r = granter.grant({ toolName: 'Edit', path: '/Users/suas/.claude/settings.json' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rulePattern).toBe('Edit(/Users/suas/.claude/settings.json)');
  });

  it('writes a tree-scoped rule when scopeTree is true', () => {
    const r = granter.grant({
      toolName: 'Edit',
      path: '/Users/suas/.claude/settings.json',
      scopeTree: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rulePattern).toBe('Edit(/Users/suas/.claude/**)');
  });

  it('ignores scopeTree for Bash (uses command verbatim)', () => {
    const r = granter.grant({ toolName: 'Bash', path: 'git status', scopeTree: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rulePattern).toBe('Bash(git status)');
  });

  // ----------------------------------------------------------------
  // Error paths
  // ----------------------------------------------------------------

  it('refuses to overwrite settings.json when it contains invalid JSON', () => {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, '{ this is : not : valid', 'utf-8');

    const r = granter.grant({ toolName: 'Edit', path: '/tmp/x.ts' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('SETTINGS_INVALID_JSON');

    // File was left untouched
    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe('{ this is : not : valid');
  });

  it('refuses to overwrite settings.json when root is not an object', () => {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, '[1,2,3]', 'utf-8');

    const r = granter.grant({ toolName: 'Edit', path: '/tmp/x.ts' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('SETTINGS_NOT_OBJECT');
    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe('[1,2,3]');
  });

  it('treats an empty file as no settings yet', () => {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, '', 'utf-8');

    const r = granter.grant({ toolName: 'Edit', path: '/tmp/x.ts' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(readAllowArray()).toEqual(['Edit(/tmp/x.ts)']);
  });

  it('returns NO_HOME_DIR when no settings path can be resolved', () => {
    const orphan = new SelfPermissionGranter({
      homeDirProvider: () => null,
    });
    const r = orphan.grant({ toolName: 'Edit', path: '/tmp/x.ts' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('NO_HOME_DIR');
  });

  // ----------------------------------------------------------------
  // Audit log
  // ----------------------------------------------------------------

  it('appends an audit entry after a successful grant', () => {
    const r = granter.grant({
      toolName: 'Edit',
      path: '/tmp/a.ts',
      instanceId: 'inst-1',
      requestId: 'req-1',
    });
    expect(r.ok).toBe(true);

    const raw = fs.readFileSync(auditFile, 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry['toolName']).toBe('Edit');
    expect(entry['rulePattern']).toBe('Edit(/tmp/a.ts)');
    expect(entry['instanceId']).toBe('inst-1');
    expect(entry['requestId']).toBe('req-1');
    expect(entry['alreadyExisted']).toBe(false);
    expect(typeof entry['timestamp']).toBe('string');
  });

  it('logs an audit entry with alreadyExisted=true for idempotent calls', () => {
    granter.grant({ toolName: 'Edit', path: '/tmp/dup.ts' });
    granter.grant({ toolName: 'Edit', path: '/tmp/dup.ts' });
    const lines = fs.readFileSync(auditFile, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);
    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(second['alreadyExisted']).toBe(true);
  });

  it('does not throw if the audit log write fails', () => {
    // Point the audit file into a location we do not create (and can't,
    // because one of the ancestors is a file, not a directory).
    fs.writeFileSync(path.join(tmpRoot, 'blocker'), 'x', 'utf-8');
    const weird = new SelfPermissionGranter({
      settingsFile: path.join(tmpRoot, 'ws-settings.json'),
      auditLogFile: path.join(tmpRoot, 'blocker', 'audit.log'),
      homeDirProvider: () => tmpRoot,
    });

    // Must succeed at the grant even though the audit append will fail.
    const r = weird.grant({ toolName: 'Edit', path: '/tmp/z.ts' });
    expect(r.ok).toBe(true);
  });

  // ----------------------------------------------------------------
  // Event emission
  // ----------------------------------------------------------------

  it('emits a "grant" event on successful rule write', () => {
    const seen: unknown[] = [];
    granter.on('grant', (e) => seen.push(e));
    granter.grant({ toolName: 'Write', path: '/tmp/new.ts', instanceId: 'i1' });
    expect(seen.length).toBe(1);
    const ev = seen[0] as Record<string, unknown>;
    expect(ev['rulePattern']).toBe('Write(/tmp/new.ts)');
    expect(ev['toolName']).toBe('Write');
    expect(ev['instanceId']).toBe('i1');
  });

  it('does not emit "grant" on a no-op idempotent call', () => {
    granter.grant({ toolName: 'Edit', path: '/tmp/dup.ts' });
    const seen: unknown[] = [];
    granter.on('grant', (e) => seen.push(e));
    granter.grant({ toolName: 'Edit', path: '/tmp/dup.ts' });
    expect(seen.length).toBe(0);
  });

  // ----------------------------------------------------------------
  // Atomicity sanity — the live file never contains half-written JSON
  // ----------------------------------------------------------------

  it('never leaves a non-temp settings file with unparseable content', () => {
    for (let i = 0; i < 5; i++) {
      granter.grant({ toolName: 'Edit', path: `/tmp/a${i}.ts` });
      // Reading after each write must parse cleanly.
      expect(() => readSettings()).not.toThrow();
    }
    const allow = readAllowArray();
    expect(allow).toEqual([
      'Edit(/tmp/a0.ts)',
      'Edit(/tmp/a1.ts)',
      'Edit(/tmp/a2.ts)',
      'Edit(/tmp/a3.ts)',
      'Edit(/tmp/a4.ts)',
    ]);
  });
});
