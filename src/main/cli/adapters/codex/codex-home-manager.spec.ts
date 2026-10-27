import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import '../codex-cli-adapter.test-helpers';
import {
  CodexHomeManager,
  getAioCodexSessionsDir,
  stripMcpServers,
  sweepStaleCodexTempHomes,
} from './codex-home-manager';

describe('stripMcpServers', () => {
  it('removes mcp server sections and preserves unrelated config', () => {
    const config = [
      'model = "gpt-5.3-codex"',
      '',
      '[mcp_servers.playwright]',
      'command = "npx"',
      'args = ["playwright"]',
      '',
      '[profiles.default]',
      'approval_policy = "never"',
      '',
      '[mcp_servers.filesystem]',
      'command = "node"',
      '',
      '[history]',
      'persistence = "save-all"',
    ].join('\n');

    expect(stripMcpServers(config)).toBe([
      'model = "gpt-5.3-codex"',
      '',
      '[profiles.default]',
      'approval_policy = "never"',
      '',
      '[history]',
      'persistence = "save-all"',
    ].join('\n'));
  });
});

describe('CodexHomeManager', () => {
  const originalHome = process.env['HOME'];
  const tempRoots: string[] = [];

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env['HOME'];
    } else {
      process.env['HOME'] = originalHome;
    }
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('links auth.json from the account profile home instead of ~/.codex', () => {
    const home = join(tmpdir(), `codex-home-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempRoots.push(home);
    const codexDir = join(home, '.codex');
    const profileHome = join(home, 'profile');
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(profileHome, { recursive: true });
    writeFileSync(join(codexDir, 'auth.json'), '{"auth_mode":"legacy-account"}', 'utf-8');
    writeFileSync(join(codexDir, 'config.toml'), 'model = "gpt-5.3-codex"\n', 'utf-8');
    writeFileSync(join(profileHome, 'auth.json'), '{"auth_mode":"profile-account"}', 'utf-8');
    process.env['HOME'] = home;

    for (const prepare of ['prepareSessionIsolatedHome', 'prepareMcpFreeHome'] as const) {
      const manager = new CodexHomeManager({ authSourceDir: profileHome });
      const generated = manager[prepare]();
      expect(generated).toBeTruthy();
      expect(readFileSync(join(generated!, 'auth.json'), 'utf-8')).toContain('profile-account');
      expect(existsSync(join(generated!, 'config.toml'))).toBe(true);
      manager.cleanup();
    }
  });

  it('leaves no auth.json rather than falling back to ~/.codex when the profile is not signed in', () => {
    const home = join(tmpdir(), `codex-home-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempRoots.push(home);
    const codexDir = join(home, '.codex');
    const profileHome = join(home, 'profile');
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(profileHome, { recursive: true });
    writeFileSync(join(codexDir, 'auth.json'), '{"auth_mode":"legacy-account"}', 'utf-8');
    process.env['HOME'] = home;

    const manager = new CodexHomeManager({ authSourceDir: profileHome });
    const generated = manager.prepareSessionIsolatedHome();
    expect(existsSync(join(generated!, 'auth.json'))).toBe(false);
    manager.cleanup();
  });

  it('keeps user servers alongside the injected Browser Gateway MCP config', () => {
    const home = join(tmpdir(), `codex-home-manager-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempRoots.push(home);
    const codexDir = join(home, '.codex');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, 'auth.json'), '{"token":"existing"}', 'utf-8');
    writeFileSync(join(codexDir, 'config.toml'), [
      'model = "gpt-5.3-codex"',
      '',
      '[mcp_servers.user_server]',
      'command = "user-mcp"',
    ].join('\n'), 'utf-8');
    process.env['HOME'] = home;

    const manager = new CodexHomeManager();
    const generated = manager.prepareHomeWithMcpConfig([
      '[mcp_servers."browser-gateway"]',
      'command = "app"',
      'args = ["browser-mcp-stdio-server.js"]',
    ].join('\n'), 'app-server');

    expect(generated).toBeTruthy();
    expect(existsSync(join(generated!, 'auth.json'))).toBe(true);
    expect(readFileSync(join(generated!, 'config.toml'), 'utf-8')).toBe([
      'model = "gpt-5.3-codex"',
      '',
      '[mcp_servers.user_server]',
      'command = "user-mcp"',
      '',
      '[mcp_servers."browser-gateway"]',
      'command = "app"',
      'args = ["browser-mcp-stdio-server.js"]',
    ].join('\n'));

    manager.cleanup();
    expect(existsSync(generated!)).toBe(false);
  });

  it.each([
    '[mcp_servers.same]\ncommand = "PLACEHOLDER_USER"\n[mcp_servers.same.env]\nOLD = "PLACEHOLDER_VALUE"\n',
    'mcp_servers.same = { command = "PLACEHOLDER_USER" }\n',
    'mcp_servers = { same = { command = "PLACEHOLDER_USER" }, retained = { command = "PLACEHOLDER_RETAINED" } }\n',
  ])('lets injected servers replace a colliding user definition: %s', (userServer) => {
    const original = 'model = "PLACEHOLDER_MODEL"\n' + userServer;
    const home = makeSandboxCodexHome(original);
    const manager = new CodexHomeManager();
    try {
      const generated = manager.prepareHomeWithMcpConfig('[mcp_servers.same]\ncommand = "PLACEHOLDER_HARNESS"', 'app-server');
      expect(generated).not.toBeNull();
      const prepared = readFileSync(join(generated!, 'config.toml'), 'utf8');
      expect(prepared).toContain('PLACEHOLDER_HARNESS');
      expect(prepared).not.toContain('PLACEHOLDER_USER');
      expect(prepared).not.toContain('OLD =');
      if (userServer.includes('retained')) expect(prepared).toContain('PLACEHOLDER_RETAINED');
      expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe(original);
    } finally { manager.cleanup(); }
  });

  function makeSandboxCodexHome(config: string | null): string {
    const home = join(tmpdir(), `codex-home-manager-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempRoots.push(home);
    const codexDir = join(home, '.codex');
    mkdirSync(join(codexDir, 'sessions', '2026', '07'), { recursive: true });
    writeFileSync(join(codexDir, 'sessions', '2026', '07', 'rollout-user.jsonl'), '{}', 'utf-8');
    writeFileSync(join(codexDir, 'history.jsonl'), 'user-history', 'utf-8');
    writeFileSync(join(codexDir, 'state_5.sqlite'), 'user-thread-state', 'utf-8');
    writeFileSync(join(codexDir, 'auth.json'), '{"token":"existing"}', 'utf-8');
    if (config !== null) {
      writeFileSync(join(codexDir, 'config.toml'), config, 'utf-8');
    }
    process.env['HOME'] = home;
    return home;
  }

  it.each([
    ['MCP-free', (manager: CodexHomeManager) => manager.prepareMcpFreeHome()],
    ['session-isolated', (manager: CodexHomeManager) => manager.prepareSessionIsolatedHome()],
    ['injected MCP', (manager: CodexHomeManager) => manager.prepareHomeWithMcpConfig(
      '[mcp_servers.browser]\ncommand = "PLACEHOLDER"', 'app-server',
    )],
  ])('%s homes preserve this session’s shell bridge without widening inherited variables', (_name, prepare) => {
    const config = '[shell_environment_policy]\ninherit = "core"\ninclude_only = ["PATH"]\n';
    const home = makeSandboxCodexHome(config);
    const manager = new CodexHomeManager({ harnessCliEnv: {
      AIO_MCP: 'PLACEHOLDER_BINARY',
      AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET: 'PLACEHOLDER_SOCKET',
      AI_ORCHESTRATOR_INSTANCE_ID: 'PLACEHOLDER_INSTANCE',
      AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY: 'PLACEHOLDER_CAPABILITY',
      UNRELATED_VALUE: 'PLACEHOLDER_UNRELATED',
    } });
    try {
      const generated = prepare(manager);
      expect(generated).toBeTruthy();
      const prepared = readFileSync(join(generated!, 'config.toml'), 'utf-8');
      expect(prepared).toContain('inherit = "core"');
      expect(prepared).toContain('AIO_MCP = "PLACEHOLDER_BINARY"');
      expect(prepared).toContain('AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY = "PLACEHOLDER_CAPABILITY"');
      expect(prepared).not.toContain('UNRELATED_VALUE');
      expect(prepared).toContain('include_only = ["PATH", "AIO_MCP", "AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET", "AI_ORCHESTRATOR_INSTANCE_ID", "AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY"]');
      expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf-8')).toBe(config);
      if (process.platform !== 'win32') expect(statSync(join(generated!, 'config.toml')).mode & 0o777).toBe(0o600);
    } finally {
      manager.cleanup();
    }
  });

  it('creates an isolated home when the user has no existing Codex directory', () => {
    const home = join(tmpdir(), `codex-home-manager-empty-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(home, { recursive: true });
    tempRoots.push(home);
    process.env['HOME'] = home;

    const manager = new CodexHomeManager();
    const generated = manager.prepareMcpFreeHome();

    expect(generated).toBeTruthy();
    expect(readlinkSync(join(generated!, 'sessions'))).toBe(join(home, '.ai-orchestrator', 'codex', 'sessions'));
    expect(readlinkSync(join(generated!, 'state_5.sqlite'))).toBe(
      join(home, '.ai-orchestrator', 'codex', 'state_5.sqlite'),
    );
    manager.cleanup();
  });

  it.each([
    ['MCP-free', (manager: CodexHomeManager) => manager.prepareMcpFreeHome()],
    ['session-isolated', (manager: CodexHomeManager) => manager.prepareSessionIsolatedHome()],
    ['Browser Gateway', (manager: CodexHomeManager) => manager.prepareHomeWithMcpConfig([
      '[mcp_servers."browser-gateway"]',
      'command = "app"',
    ].join('\n'), 'app-server')],
  ])('%s homes keep thread state outside the user Codex database', (_name, prepare) => {
    const home = makeSandboxCodexHome('model = "gpt-5.3-codex"');
    const manager = new CodexHomeManager();

    const generated = prepare(manager);

    expect(generated).toBeTruthy();
    const expectedStatePath = join(home, '.ai-orchestrator', 'codex', 'state_5.sqlite');
    expect(readlinkSync(join(generated!, 'state_5.sqlite'))).toBe(expectedStatePath);
    expect(readFileSync(join(home, '.codex', 'state_5.sqlite'), 'utf-8')).toBe('user-thread-state');

    manager.cleanup();
    expect(existsSync(expectedStatePath)).toBe(true);
  });

  it('redirects session history to the AIO store instead of ~/.codex', () => {
    makeSandboxCodexHome('model = "gpt-5.3-codex"');

    const manager = new CodexHomeManager();
    const generated = manager.prepareMcpFreeHome();

    expect(generated).toBeTruthy();
    // Sessions point at the persistent AIO store, not the user's rollouts.
    expect(readlinkSync(join(generated!, 'sessions'))).toBe(getAioCodexSessionsDir());
    expect(existsSync(join(generated!, 'sessions', '2026', '07', 'rollout-user.jsonl'))).toBe(false);
    expect(readFileSync(join(generated!, 'history.jsonl'), 'utf-8')).toBe('');
    // Non-session entries are still shared.
    expect(readFileSync(join(generated!, 'auth.json'), 'utf-8')).toBe('{"token":"existing"}');
    manager.cleanup();
  });

  it('prepareMcpFreeHome isolates sessions even when there is nothing to strip', () => {
    makeSandboxCodexHome('model = "gpt-5.3-codex"');

    const manager = new CodexHomeManager();
    const generated = manager.prepareMcpFreeHome();

    expect(generated).toBeTruthy();
    // config.toml has no MCP servers, so it is mirrored as-is.
    expect(readFileSync(join(generated!, 'config.toml'), 'utf-8')).toBe('model = "gpt-5.3-codex"');
    expect(readlinkSync(join(generated!, 'sessions'))).toBe(getAioCodexSessionsDir());
    manager.cleanup();
  });

  it('prepareSessionIsolatedHome keeps user MCP servers in config.toml', () => {
    const config = [
      'model = "gpt-5.3-codex"',
      '',
      '[mcp_servers.user_server]',
      'command = "user-mcp"',
    ].join('\n');
    makeSandboxCodexHome(config);

    const manager = new CodexHomeManager();
    const generated = manager.prepareSessionIsolatedHome();

    expect(generated).toBeTruthy();
    expect(readFileSync(join(generated!, 'config.toml'), 'utf-8')).toBe(config);
    expect(readlinkSync(join(generated!, 'sessions'))).toBe(getAioCodexSessionsDir());
    manager.cleanup();
  });

  it('disables Claude callback tools only in the generated session home and preserves other configuration', () => {
    const config = [
      'model = "PLACEHOLDER_MODEL"',
      '[mcp_servers."claude-code"] # keep this comment',
      'command = "/opt/tools/claude"',
      'args = [',
      '  "mcp", "serve",',
      ']',
      'disabled_tools = [',
      '  "ExistingDisabled", "Monitor",',
      ']',
      'enabled_tools = ["Read", "Monitor"]',
      'tool_timeout_sec = 120',
      '[mcp_servers."claude-code".tools.Read]',
      'approval_mode = "prompt"',
      '[mcp_servers.other]',
      'command = "other-mcp"',
      'args = ["mcp", "serve"]',
      '[mcp_servers.not_serve]',
      'command = "claude"',
      'args = ["mcp", "list"]',
    ].join('\n');
    const home = makeSandboxCodexHome(config);
    const manager = new CodexHomeManager();
    try {
      const generated = manager.prepareSessionIsolatedHome();
      const prepared = readFileSync(join(generated!, 'config.toml'), 'utf-8');
      expect(prepared).toContain('"ExistingDisabled", "Monitor", "ScheduleWakeup"');
      expect(prepared).toContain('"CronCreate", "CronDelete", "CronList", "RemoteTrigger", "Workflow", "PushNotification", "SendMessage", "ListAgents", "TaskStop"');
      expect(prepared).toContain('enabled_tools = ["Read", "Monitor"]');
      expect(prepared).toContain('[mcp_servers."claude-code".tools.Read]\napproval_mode = "prompt"');
      expect(prepared.slice(prepared.indexOf('[mcp_servers.other]'))).toBe(config.slice(config.indexOf('[mcp_servers.other]')));
      expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf-8')).toBe(config);
    } finally { manager.cleanup(); }
  });

  it('prepares a home with valid TOML Unicode escapes while still filtering Claude callback tools', () => {
    const unrelated = String.raw`[mcp_servers.other]
command = "node"
args = ["\U0001F600"]
`;
    const config = unrelated + String.raw`[mcp_servers.claude]
command = "cl\u0061ude"
args = ["\U0000006Dcp", "serve"]
`;
    const home = makeSandboxCodexHome(config);
    const manager = new CodexHomeManager();
    try {
      const generated = manager.prepareSessionIsolatedHome();
      expect(generated).not.toBeNull();
      const prepared = readFileSync(join(generated!, 'config.toml'), 'utf-8');
      expect(prepared.startsWith(unrelated)).toBe(true);
      expect(prepared).toContain('disabled_tools = ["Monitor", "ScheduleWakeup"');
      expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf-8')).toBe(config);
    } finally { manager.cleanup(); }
  });

  it('filters both retained user inline servers and injected servers in the composed MCP home', () => {
    const original = '# user comment\nmcp_servers.retained = { command = "claude", args = ["mcp", "serve"], enabled_tools = ["Read", "Monitor"], tool_timeout_sec = 120 }\n';
    const home = makeSandboxCodexHome(original);
    const injected = '[mcp_servers.injected]\ncommand = "claude"\nargs = ["mcp", "serve"]\nenabled_tools = ["Read", "Monitor"]\n';
    const manager = new CodexHomeManager();
    try {
      const generated = manager.prepareHomeWithMcpConfig(injected, 'app-server');
      expect(generated).not.toBeNull();
      const prepared = readFileSync(join(generated!, 'config.toml'), 'utf-8');
      expect(prepared.match(/"Monitor", "ScheduleWakeup"/g)).toHaveLength(2);
      expect(prepared.match(/enabled_tools = \["Read", "Monitor"\]/g)).toHaveLength(2);
      expect(prepared).toContain('# user comment');
      expect(prepared).toContain('tool_timeout_sec = 120');
      expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf-8')).toBe(original);
    } finally { manager.cleanup(); }
  });

  it('prepareMcpFreeHome strips user MCP servers when present', () => {
    makeSandboxCodexHome([
      'model = "gpt-5.3-codex"',
      '',
      '[mcp_servers.user_server]',
      'command = "user-mcp"',
    ].join('\n'));

    const manager = new CodexHomeManager();
    const generated = manager.prepareMcpFreeHome();

    expect(generated).toBeTruthy();
    expect(readFileSync(join(generated!, 'config.toml'), 'utf-8').trim()).toBe('model = "gpt-5.3-codex"');
    manager.cleanup();
  });

  it('cleanup removes the temp home without touching the AIO session store', () => {
    makeSandboxCodexHome('model = "gpt-5.3-codex"');
    const aioSessions = getAioCodexSessionsDir();

    const manager = new CodexHomeManager();
    const generated = manager.prepareMcpFreeHome();
    writeFileSync(join(aioSessions, 'rollout-aio.jsonl'), '{}', 'utf-8');

    manager.cleanup();
    expect(existsSync(generated!)).toBe(false);
    expect(existsSync(join(aioSessions, 'rollout-aio.jsonl'))).toBe(true);
  });
});

describe('sweepStaleCodexTempHomes', () => {
  const sandboxes: string[] = [];

  afterEach(() => {
    for (const dir of sandboxes.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeSandbox(): string {
    const dir = join(tmpdir(), `codex-sweep-spec-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    sandboxes.push(dir);
    return dir;
  }

  function makeAgedDir(base: string, name: string, ageMs: number): string {
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    const aged = new Date(Date.now() - ageMs);
    utimesSync(dir, aged, aged);
    return dir;
  }

  it('removes stale codex temp homes and keeps fresh ones', () => {
    const base = makeSandbox();
    const staleNoMcp = makeAgedDir(base, 'codex-nomcp-abc123', 48 * 60 * 60 * 1000);
    const staleBrowser = makeAgedDir(base, 'codex-browser-mcp-def456', 48 * 60 * 60 * 1000);
    const staleAio = makeAgedDir(base, 'codex-aio-ghi789', 48 * 60 * 60 * 1000);
    const fresh = makeAgedDir(base, 'codex-browser-mcp-fresh', 0);
    const unrelated = makeAgedDir(base, 'some-other-dir', 48 * 60 * 60 * 1000);

    const removed = sweepStaleCodexTempHomes(24 * 60 * 60 * 1000, base, { isCodexIdle: () => true });

    expect(removed).toBe(3);
    expect(existsSync(staleNoMcp)).toBe(false);
    expect(existsSync(staleBrowser)).toBe(false);
    expect(existsSync(staleAio)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  it('preserves an old home whose owner is still alive', () => {
    const base = makeSandbox();
    const active = makeAgedDir(base, 'codex-nomcp-active', 48 * 60 * 60 * 1000);
    writeFileSync(join(active, '.aio-codex-home-owner.json'), JSON.stringify({ pid: process.pid, threadId: 0, createdAt: 1 }));
    const aged = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(active, aged, aged);
    expect(sweepStaleCodexTempHomes(0, base)).toBe(0);
    expect(existsSync(active)).toBe(true);
  });

  it('reclaims a fresh dead-owner home once Codex is stopped, without waiting a day', () => {
    const base = makeSandbox();
    const abandoned = makeAgedDir(base, 'codex-nomcp-abandoned', 0);
    writeFileSync(join(abandoned, '.aio-codex-home-owner.json'), JSON.stringify({ pid: 123, threadId: 0, createdAt: Date.now() }));
    expect(sweepStaleCodexTempHomes(undefined, base, { isProcessAlive: () => false, isCodexIdle: () => true })).toBe(1);
    expect(existsSync(abandoned)).toBe(false);
  });

  it('retains dead-owner and legacy homes while a Codex child may still be using them', () => {
    const base = makeSandbox();
    const abandoned = makeAgedDir(base, 'codex-nomcp-abandoned', 48 * 60 * 60 * 1000);
    writeFileSync(join(abandoned, '.aio-codex-home-owner.json'), JSON.stringify({ pid: 123, threadId: 0, createdAt: 1 }));
    const legacy = makeAgedDir(base, 'codex-nomcp-legacy', 48 * 60 * 60 * 1000);
    expect(sweepStaleCodexTempHomes(undefined, base, { isProcessAlive: () => false, isCodexIdle: () => false })).toBe(0);
    expect(existsSync(abandoned)).toBe(true);
    expect(existsSync(legacy)).toBe(true);
  });

  it('retains unknown owner markers even when old and process inspection says idle', () => {
    const base = makeSandbox();
    const unknown = makeAgedDir(base, 'codex-nomcp-unknown', 48 * 60 * 60 * 1000);
    writeFileSync(join(unknown, '.aio-codex-home-owner.json'), '{malformed');
    const aged = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(unknown, aged, aged);
    expect(sweepStaleCodexTempHomes(0, base, { isCodexIdle: () => true })).toBe(0);
    expect(existsSync(unknown)).toBe(true);
  });

  it('ignores matching non-directory entries', () => {
    const base = makeSandbox();
    const filePath = join(base, 'codex-nomcp-file');
    writeFileSync(filePath, 'not a dir', 'utf-8');
    const aged = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(filePath, aged, aged);

    expect(sweepStaleCodexTempHomes(24 * 60 * 60 * 1000, base, { isCodexIdle: () => true })).toBe(0);
    expect(existsSync(filePath)).toBe(true);
  });

  it('never throws for a missing base directory', () => {
    expect(sweepStaleCodexTempHomes(0, join(tmpdir(), 'codex-sweep-spec-missing'))).toBe(0);
  });
});
