import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHome = vi.hoisted(() => ({ dir: '' }));

// PermissionManager.getHomeDir() prefers electron app.getPath('home') and falls
// back to process.env.HOME. Pin both to a temp dir so persistUserRulesToDisk
// never touches the real ~/.orchestrator/permissions.json.
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => mockHome.dir) },
}));
vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { PermissionManager, type PermissionRequest } from './permission-manager';

function bashRequest(command: string, instanceId = 'inst-1'): PermissionRequest {
  return {
    id: `req-${Math.random().toString(36).slice(2)}`,
    instanceId,
    scope: 'bash_execute',
    resource: `bash:${command}`,
    timestamp: Date.now(),
  };
}

// The Daily Peak Spark command that spuriously re-prompted: long + compound +
// full of regex metacharacters (`;`, `|`, `.`, `/`, `*` via globs, `()`).
const COMPOUND =
  'date -u; echo "---"; ls /Users/x/tools/spark/profiles/ 2>/dev/null | tail; ' +
  'echo "--- auto-peak-log tail ---"; tail -25 /Users/x/tools/spark/auto-peak-log.md 2>/dev/null';

describe('PermissionManager — user Bash allow-rules are literal/exact', () => {
  let pm: PermissionManager;
  let prevHome: string | undefined;

  beforeEach(() => {
    mockHome.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-mgr-'));
    prevHome = process.env['HOME'];
    process.env['HOME'] = mockHome.dir;
    PermissionManager._resetForTesting();
    pm = PermissionManager.getInstance();
  });

  afterEach(() => {
    PermissionManager._resetForTesting();
    if (prevHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prevHome;
    try {
      fs.rmSync(mockHome.dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it('stores an "always" Bash decision as a literal rule with the full command', () => {
    pm.recordUserDecision('sess-1', bashRequest(COMPOUND), 'allow', 'always');

    const rule = pm.getRuleSet('user')?.rules.find((r) => r.scope === 'bash_execute');
    expect(rule).toBeDefined();
    expect(rule?.literal).toBe(true);
    expect(rule?.pattern).toBe(`bash:${COMPOUND}`); // full command, not regex-ified, not truncated
  });

  it('allows the exact same compound command on a later run (no spurious re-prompt)', () => {
    pm.recordUserDecision('sess-1', bashRequest(COMPOUND), 'allow', 'always');

    const decision = pm.checkPermission(bashRequest(COMPOUND, 'inst-2'));
    expect(decision.action).toBe('allow');
    expect(decision.matchedRule?.literal).toBe(true); // matched via the literal rule, not mode default
  });

  it('does NOT match a different command (literal is never over-broad)', () => {
    // A regex derived from `ls -la` (old behavior: pattern `bash:ls.*`) would
    // have auto-allowed every `ls`. Literal matching must not.
    pm.recordUserDecision('sess-1', bashRequest('ls -la'), 'allow', 'always');

    const other = pm.checkPermission(bashRequest('ls -la /etc/shadow'));
    expect(other.matchedRule?.literal).not.toBe(true);
  });

  it('matches commands longer than the old 200-char truncation cap', () => {
    const long = `echo ${'x'.repeat(400)}`;
    pm.recordUserDecision('sess-1', bashRequest(long), 'allow', 'always');

    expect(pm.checkPermission(bashRequest(long)).action).toBe('allow');
  });

  it('leaves non-Bash decisions on the heuristic (non-literal) pattern path', () => {
    const req: PermissionRequest = {
      id: 'r-tool',
      instanceId: 'inst-1',
      scope: 'tool_use',
      resource: 'tool:Read',
      timestamp: Date.now(),
    };
    pm.recordUserDecision('sess-1', req, 'allow', 'always');

    const rule = pm.getRuleSet('user')?.rules.find((r) => r.scope === 'tool_use');
    expect(rule?.literal).toBeFalsy();
  });
});
