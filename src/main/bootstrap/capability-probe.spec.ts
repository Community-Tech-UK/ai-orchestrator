import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  detectAll: vi.fn(),
  diagnose: vi.fn(),
  getRawDb: vi.fn(),
  remoteConfig: vi.fn(),
  serverRunning: vi.fn(),
  browserDiagnose: vi.fn(),
  toolServers: vi.fn(),
  settings: vi.fn(),
  seatbelt: vi.fn(),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../cli/cli-detection', () => ({
  getCliDetectionService: () => ({
    detectAll: mocks.detectAll,
  }),
}));

vi.mock('../providers/provider-doctor', () => ({
  getProviderDoctor: () => ({
    diagnose: mocks.diagnose,
  }),
}));

vi.mock('../persistence/rlm-database', () => ({
  getRLMDatabase: () => ({
    getRawDb: mocks.getRawDb,
  }),
}));

vi.mock('../remote-node/remote-node-config', () => ({
  getRemoteNodeConfig: () => mocks.remoteConfig(),
}));

vi.mock('../remote-node/worker-node-connection', () => ({
  getWorkerNodeConnectionServer: () => ({ isRunning: () => mocks.serverRunning() }),
}));

vi.mock('../browser-automation/browser-automation-health', () => ({
  getBrowserAutomationHealthService: () => ({
    diagnose: mocks.browserDiagnose,
  }),
}));

// The tool-server manager only matters here for what it says about servers that
// are still connecting, and for the events that say they finished.
vi.mock('../mcp/mcp-manager', async () => {
  const { EventEmitter } = await import('node:events');
  const manager = Object.assign(new EventEmitter(), { getServers: () => mocks.toolServers() });
  return { getMcpManager: () => manager };
});

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => mocks.settings() }),
}));

vi.mock('../sandbox/seatbelt', () => ({
  probeSeatbelt: () => mocks.seatbelt(),
}));

import type { EventEmitter } from 'node:events';
import { getMcpManager } from '../mcp/mcp-manager';
import { CapabilityProbe } from './capability-probe';
import type { StartupCapabilityReport } from '../../shared/types/startup-capability.types';

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function checkOf(report: StartupCapabilityReport, id: string) {
  return report.checks.find((check) => check.id === id);
}

/** Every probed CLI is installed except the ones named. */
function installedExcept(...missing: string[]): void {
  mocks.detectAll.mockResolvedValue({
    available: ['claude', 'codex', 'antigravity', 'copilot', 'cursor']
      .filter((name) => !missing.includes(name))
      .map((name) => ({ name })),
    detected: [],
    unavailable: [],
    timestamp: new Date(),
  });
  mocks.diagnose.mockImplementation(async (providerKey: string) => {
    const gone = missing.some((name) => providerKey.startsWith(name));
    return {
      overall: gone ? 'not-installed' as const : 'healthy' as const,
      probes: gone
        ? [{ name: 'cli_installed', status: 'fail' as const, message: `${providerKey} not found in PATH`, latencyMs: 1, errorKind: 'cli_not_found' as const }]
        : [{ name: 'cli_installed', status: 'pass' as const, message: `${providerKey} found in PATH`, latencyMs: 1 }],
      recommendations: gone ? [`Install ${providerKey}`] : [],
      provider: providerKey,
      timestamp: Date.now(),
    };
  });
}

describe('CapabilityProbe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform('darwin');

    mocks.getRawDb.mockReturnValue({
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ ok: 1 })),
      })),
    });

    mocks.detectAll.mockResolvedValue({
      available: [
        { name: 'claude' },
        { name: 'codex' },
        { name: 'antigravity' },
        { name: 'copilot' },
        { name: 'cursor' },
      ],
      detected: [],
      unavailable: [],
      timestamp: new Date(),
    });

    mocks.diagnose.mockResolvedValue({
      overall: 'healthy',
      probes: [],
      recommendations: [],
      provider: 'claude-cli',
      timestamp: Date.now(),
    });

    mocks.settings.mockReturnValue({
      defaultCli: 'auto',
      automationDefaultCli: 'auto',
      providerAccountProfiles: [],
      copilotAccountProfiles: [],
    });

    mocks.remoteConfig.mockReturnValue({
      enabled: false,
      serverHost: '127.0.0.1',
      serverPort: 4878,
      namespace: 'default',
      tlsCertPath: undefined,
      tlsKeyPath: undefined,
    });
    mocks.serverRunning.mockReturnValue(false);
    mocks.seatbelt.mockResolvedValue({ supported: true });
    mocks.toolServers.mockReturnValue([]);

    mocks.browserDiagnose.mockResolvedValue({
      status: 'ready',
      checkedAt: Date.now(),
      runtimeAvailable: true,
      nodeAvailable: true,
      inAppConfigured: true,
      inAppConnected: true,
      inAppToolCount: 3,
      configDetected: true,
      configSources: [],
      browserToolNames: ['browser_navigate'],
      warnings: [],
      suggestions: [],
    });
  });

  afterEach(() => {
    setPlatform(ORIGINAL_PLATFORM);
  });

  it('reports ready when core checks pass and at least one provider is available', async () => {
    const probe = new CapabilityProbe();

    const report = await probe.run();

    expect(report.status).toBe('ready');
    expect(report.checks.find((check) => check.id === 'provider.any')).toMatchObject({
      status: 'ready',
      critical: true,
    });
    expect(report.checks.find((check) => check.id === 'native.sqlite')).toMatchObject({
      status: 'ready',
    });
  });

  it('reports failed when sqlite is unavailable and no provider CLI is available', async () => {
    mocks.getRawDb.mockReturnValue({
      prepare: vi.fn(() => ({
        get: vi.fn(() => {
          throw new Error('sqlite load failed');
        }),
      })),
    });
    installedExcept('claude', 'codex', 'antigravity', 'copilot', 'cursor');

    const probe = new CapabilityProbe();
    const report = await probe.run();

    expect(report.status).toBe('failed');
    expect(report.checks.find((check) => check.id === 'provider.any')).toMatchObject({
      status: 'unavailable',
      details: { fix: 'setup' },
    });
    expect(report.checks.find((check) => check.id === 'native.sqlite')).toMatchObject({
      status: 'unavailable',
      details: { fix: 'setup' },
    });
  });

  describe('optional tools that are not installed', () => {
    it('treats a CLI nobody asked for as disabled, and says so in plain words', async () => {
      installedExcept('cursor');

      const report = await new CapabilityProbe().run();

      expect(checkOf(report, 'provider.cursor')).toMatchObject({
        status: 'disabled',
        critical: false,
        summary: "Cursor isn't installed. You only need it to use Cursor.",
        details: { problem: 'not-installed' },
      });
      expect(report.status).toBe('ready');
    });

    it('does not let several uninstalled tools make startup degraded', async () => {
      installedExcept('cursor', 'antigravity', 'copilot', 'codex');

      const report = await new CapabilityProbe().run();

      expect(report.status).toBe('ready');
      for (const id of ['cursor', 'antigravity', 'copilot', 'codex']) {
        expect(checkOf(report, `provider.${id}`)?.status).toBe('disabled');
      }
    });

    it('keeps a missing CLI degraded when it is the default tool', async () => {
      installedExcept('cursor');
      mocks.settings.mockReturnValue({
        defaultCli: 'cursor',
        automationDefaultCli: 'auto',
        providerAccountProfiles: [],
        copilotAccountProfiles: [],
      });

      const report = await new CapabilityProbe().run();

      expect(checkOf(report, 'provider.cursor')).toMatchObject({
        status: 'degraded',
        summary: "Cursor isn't installed, but you've chosen it as a default.",
        details: { problem: 'not-installed', fix: 'setup' },
      });
      expect(report.status).toBe('degraded');
    });

    it('keeps a missing CLI degraded when the user added an account for it', async () => {
      installedExcept('codex');
      mocks.settings.mockReturnValue({
        defaultCli: 'auto',
        automationDefaultCli: 'auto',
        providerAccountProfiles: [{
          id: 'work', provider: 'codex', label: 'Work', expectedIdentity: null, expectedAccountKey: null,
          planLabel: null, priority: 0, enabled: true, automationPolicy: 'allow-routed', isLegacy: false,
          createdAt: 1, updatedAt: 1,
        }],
        copilotAccountProfiles: [],
      });

      const report = await new CapabilityProbe().run();

      expect(checkOf(report, 'provider.codex')).toMatchObject({
        status: 'degraded',
        summary: "Codex isn't installed, but you have a Codex account set up in Harness.",
      });
      expect(report.status).toBe('degraded');
    });

    it('stays quiet about a missing CLI when settings cannot be read', async () => {
      installedExcept('cursor');
      mocks.settings.mockImplementation(() => {
        throw new Error('settings unavailable');
      });

      const report = await new CapabilityProbe().run();

      expect(checkOf(report, 'provider.cursor')?.status).toBe('disabled');
      expect(report.status).toBe('ready');
    });
  });

  describe('installed tools that are not working', () => {
    it('keeps an unused installed tool quiet without claiming its problem is fixed', async () => {
      mocks.diagnose.mockImplementation(async (providerKey: string) => ({
        overall: providerKey === 'claude-cli' ? 'degraded' : 'healthy',
        probes: providerKey === 'claude-cli'
          ? [{ name: 'authenticated', status: 'fail', message: 'Not signed in', latencyMs: 1 }]
          : [],
        recommendations: [], provider: providerKey, timestamp: Date.now(),
      }));

      const report = await new CapabilityProbe().run();

      expect(checkOf(report, 'provider.claude')).toMatchObject({
        status: 'disabled', summary: "Claude isn't signed in.",
        details: { problem: 'not-signed-in', fix: 'accounts' },
      });
      expect(report.status).toBe('ready');
    });

    it('does not infer a missing install or total unavailability from failed checks', async () => {
      mocks.detectAll.mockResolvedValue({ available: [], detected: [], unavailable: [], timestamp: new Date() });
      mocks.diagnose.mockRejectedValue(new Error('doctor crashed'));
      mocks.settings.mockReturnValue({ defaultCli: 'codex', automationDefaultCli: 'auto' });

      const report = await new CapabilityProbe().run();

      expect(checkOf(report, 'provider.codex')).toMatchObject({
        status: 'degraded', summary: "Harness couldn't finish checking Codex.",
        details: { problem: 'check-failed', fix: 'setup' },
      });
      expect(checkOf(report, 'provider.cursor')).toMatchObject({
        status: 'disabled', summary: "Harness couldn't finish checking Cursor.",
        details: { problem: 'check-failed' },
      });
      expect(checkOf(report, 'provider.any')).toMatchObject({
        status: 'degraded', summary: "Harness couldn't finish checking your AI tools.",
      });
      expect(report.status).toBe('degraded');
    });

    it('sends a signed-out tool to Accounts', async () => {
      mocks.settings.mockReturnValue({ defaultCli: 'claude' });
      mocks.diagnose.mockImplementation(async (providerKey: string) => providerKey === 'claude-cli'
        ? {
            overall: 'degraded' as const,
            probes: [
              { name: 'cli_installed', status: 'pass' as const, message: 'claude found in PATH', latencyMs: 1 },
              { name: 'authenticated', status: 'fail' as const, message: 'Not logged in. Run `claude auth login`.', latencyMs: 1 },
            ],
            recommendations: ['Authentication missing.'],
            provider: providerKey,
            timestamp: Date.now(),
          }
        : { overall: 'healthy' as const, probes: [], recommendations: [], provider: providerKey, timestamp: Date.now() });

      const report = await new CapabilityProbe().run();

      expect(checkOf(report, 'provider.claude')).toMatchObject({
        status: 'degraded',
        summary: "Claude isn't signed in.",
        details: { problem: 'not-signed-in', fix: 'accounts' },
      });
      expect(JSON.stringify(checkOf(report, 'provider.claude')?.summary)).not.toContain('claude auth login');
      expect(report.status).toBe('degraded');
    });

    it('sends a tool with two different installs to Setup', async () => {
      mocks.settings.mockReturnValue({ automationDefaultCli: 'codex' });
      mocks.diagnose.mockImplementation(async (providerKey: string) => providerKey === 'codex-cli'
        ? {
            overall: 'degraded' as const,
            probes: [{ name: 'cli_shadow_check', status: 'fail' as const, message: 'Multiple codex installs with different versions', latencyMs: 1 }],
            recommendations: [],
            provider: providerKey,
            timestamp: Date.now(),
          }
        : { overall: 'healthy' as const, probes: [], recommendations: [], provider: providerKey, timestamp: Date.now() });

      const report = await new CapabilityProbe().run();

      expect(checkOf(report, 'provider.codex')).toMatchObject({
        status: 'degraded',
        summary: 'Codex is installed more than once, with different versions.',
        details: { problem: 'needs-attention', fix: 'setup' },
      });
    });

    it('says a tool exists but Harness cannot find it when scanning found it and the lighter lookup did not', async () => {
      mocks.settings.mockReturnValue({ defaultCli: 'cursor' });
      mocks.diagnose.mockImplementation(async (providerKey: string) => providerKey === 'cursor'
        ? {
            overall: 'not-installed' as const,
            probes: [{ name: 'cli_installed', status: 'fail' as const, message: 'cursor-agent not found in PATH', latencyMs: 1, errorKind: 'cli_not_found' as const }],
            recommendations: [],
            provider: providerKey,
            timestamp: Date.now(),
          }
        : { overall: 'healthy' as const, probes: [], recommendations: [], provider: providerKey, timestamp: Date.now() });

      const report = await new CapabilityProbe().run();

      expect(checkOf(report, 'provider.cursor')).toMatchObject({
        status: 'degraded',
        summary: "Cursor is installed, but Harness can't find it.",
        details: { problem: 'needs-attention', fix: 'setup' },
      });
    });

    it('says plainly when the check itself could not finish', async () => {
      mocks.settings.mockReturnValue({ defaultCli: 'copilot' });
      mocks.diagnose.mockImplementation(async (providerKey: string) => {
        if (providerKey === 'copilot') throw new Error('doctor crashed');
        return { overall: 'healthy' as const, probes: [], recommendations: [], provider: providerKey, timestamp: Date.now() };
      });

      const report = await new CapabilityProbe().run();

      expect(checkOf(report, 'provider.copilot')).toMatchObject({
        status: 'degraded',
        summary: "Copilot is installed, but Harness couldn't check it.",
        details: { problem: 'check-failed', fix: 'setup', error: 'doctor crashed' },
      });
    });

    it('does not say no tool is ready when the tools could not be checked', async () => {
      mocks.diagnose.mockRejectedValue(new Error('doctor crashed'));

      const report = await new CapabilityProbe().run();

      expect(checkOf(report, 'provider.any')).toMatchObject({
        status: 'degraded',
        critical: true,
        summary: "Harness couldn't finish checking your AI tools.",
        details: { fix: 'setup', problem: 'check-failed' },
      });
      // A check that could not finish is not a finding. Startup is not "failed",
      // and the composer is not told that nothing can run.
      expect(report.status).toBe('degraded');
    });

    it('still says no tool is ready when every tool was checked and none works', async () => {
      mocks.diagnose.mockImplementation(async (providerKey: string) => ({
        overall: 'unhealthy' as const,
        probes: [{ name: 'authenticated', status: 'fail' as const, message: 'not signed in', latencyMs: 1 }],
        recommendations: [],
        provider: providerKey,
        timestamp: Date.now(),
      }));

      const report = await new CapabilityProbe().run();

      expect(checkOf(report, 'provider.any')).toMatchObject({
        status: 'unavailable',
        summary: expect.stringContaining('No AI tool is ready to use yet.'),
      });
      expect(report.status).toBe('failed');
    });
  });

  describe('hardened mode', () => {
    it('is switched off, in plain words, on a computer that is not a Mac', async () => {
      setPlatform('linux');

      const report = await new CapabilityProbe().run();

      const sandbox = checkOf(report, 'subsystem.sandbox');
      expect(sandbox).toMatchObject({
        status: 'disabled',
        summary: "Hardened mode only works on a Mac, so it's off here.",
      });
      expect(sandbox?.summary).not.toMatch(/Phase A|macOS-only|Seatbelt|sandbox-exec/);
      expect(report.status).toBe('ready');
    });

    it('never makes startup degraded when the Mac cannot run it', async () => {
      mocks.seatbelt.mockResolvedValue({ supported: false, reason: 'sandbox-exec: signal fence' });

      const report = await new CapabilityProbe().run();

      expect(checkOf(report, 'subsystem.sandbox')).toMatchObject({
        status: 'disabled',
        summary: "Hardened mode can't run on this Mac right now, so a session that asks for it won't start.",
        details: { reason: 'sandbox-exec: signal fence' },
      });
      expect(report.status).toBe('ready');
    });

    it('says it works when the live check passes', async () => {
      const report = await new CapabilityProbe().run();

      expect(checkOf(report, 'subsystem.sandbox')).toMatchObject({
        status: 'ready',
        summary: 'Hardened mode works on this Mac.',
      });
    });
  });

  describe('other computers', () => {
    const enabledConfig = {
      enabled: true,
      serverHost: '127.0.0.1',
      serverPort: 4878,
      namespace: 'default',
      tlsCertPath: undefined,
      tlsKeyPath: undefined,
    };

    it('is disabled, and says it is switched off, when remote computers are not enabled', async () => {
      const report = await new CapabilityProbe().run();

      expect(checkOf(report, 'subsystem.remote-nodes')).toMatchObject({
        status: 'disabled',
        label: 'Other computers',
        summary: 'Connecting your other computers is switched off.',
      });
    });

    it('says what you can do now when the switch is on and the server is running', async () => {
      mocks.remoteConfig.mockReturnValue(enabledConfig);
      mocks.serverRunning.mockReturnValue(true);

      const report = await new CapabilityProbe().run();

      expect(checkOf(report, 'subsystem.remote-nodes')).toMatchObject({
        status: 'ready',
        summary: 'Running: other computers can connect on 127.0.0.1:4878.',
      });
      expect(report.status).toBe('ready');
    });

    it('warns "On, but not running yet" when the switch is on but nothing is listening', async () => {
      mocks.remoteConfig.mockReturnValue(enabledConfig);
      mocks.serverRunning.mockReturnValue(false);

      const report = await new CapabilityProbe().run();

      expect(checkOf(report, 'subsystem.remote-nodes')).toMatchObject({
        status: 'degraded',
        summary: "On, but not running yet: Harness isn't listening on 127.0.0.1:4878.",
        details: { fix: 'remote-computers' },
      });
      expect(report.status).toBe('degraded');
    });
  });

  describe('browser tools', () => {
    it('treats unconfigured browser automation as disabled instead of degraded', async () => {
      mocks.browserDiagnose.mockResolvedValue({
        status: 'partial',
        checkedAt: Date.now(),
        runtimeAvailable: true,
        nodeAvailable: true,
        inAppConfigured: false,
        inAppConnected: false,
        inAppToolCount: 0,
        configDetected: false,
        configSources: [],
        browserToolNames: [],
        warnings: ['No browser automation MCP configuration was found in Claude settings or the in-app MCP registry.'],
        suggestions: ['Add the Chrome DevTools MCP server from the MCP page.'],
      });

      const probe = new CapabilityProbe();
      const report = await probe.run();

      expect(report.status).toBe('ready');
      expect(checkOf(report, 'subsystem.browser-automation')).toMatchObject({
        status: 'disabled',
        summary: "Browser tools aren't set up. You only need them if you want agents to use a browser.",
      });
    });

    it('says what you can do now when browser tools are set up and working', async () => {
      const report = await new CapabilityProbe().run();

      expect(checkOf(report, 'subsystem.browser-automation')).toMatchObject({
        status: 'ready',
        summary: 'Running: agents can use the browser tools.',
      });
    });

    it('keeps browser automation degraded when it is configured but not healthy, and says why', async () => {
      mocks.browserDiagnose.mockResolvedValue({
        status: 'partial',
        checkedAt: Date.now(),
        runtimeAvailable: true,
        nodeAvailable: true,
        inAppConfigured: true,
        inAppConnected: false,
        inAppToolCount: 0,
        configDetected: true,
        configSources: [
          {
            path: '/Users/test/.claude/settings.json',
            detected: true,
            serverNames: ['chrome-devtools'],
          },
        ],
        browserToolNames: [],
        warnings: ['A browser automation server is configured in-app but is not currently connected.'],
        suggestions: ['Connect the browser MCP server from the MCP page and rerun the health check.'],
      });

      const probe = new CapabilityProbe();
      const report = await probe.run();

      expect(report.status).toBe('degraded');
      expect(checkOf(report, 'subsystem.browser-automation')).toMatchObject({
        status: 'degraded',
        summary: "On, but not running yet: the browser tool server isn't connected.",
        details: { fix: 'browser' },
      });
    });

    it('names a missing browser or Node.js as the reason', async () => {
      mocks.browserDiagnose.mockResolvedValue({
        status: 'partial',
        checkedAt: Date.now(),
        runtimeAvailable: false,
        nodeAvailable: true,
        inAppConfigured: true,
        inAppConnected: true,
        inAppToolCount: 2,
        configDetected: true,
        configSources: [],
        browserToolNames: [],
        warnings: ['No supported browser runtime was detected on this machine.'],
        suggestions: [],
      });

      const report = await new CapabilityProbe().run();

      expect(checkOf(report, 'subsystem.browser-automation')?.summary).toBe(
        'On, but not running yet: no supported browser (Chrome, Chromium or Edge) was found on this computer.',
      );
    });

    it('reports a failed browser check as degraded without crashing startup', async () => {
      mocks.browserDiagnose.mockRejectedValue(new Error('mcp manager exploded'));

      const report = await new CapabilityProbe().run();

      expect(checkOf(report, 'subsystem.browser-automation')).toMatchObject({
        status: 'degraded',
        summary: "Harness couldn't check the browser tools.",
        details: { error: 'mcp manager exploded', fix: 'browser' },
      });
    });

    /**
     * Tool servers start in the background early in launch, and the startup check
     * runs once. A server caught mid-connect is "still starting", not "failed";
     * calling it failed puts a warning on a normal launch that stays on screen
     * after the server has come up.
     */
    describe('a tool server that is still connecting', () => {
      const notConnected = {
        status: 'partial',
        checkedAt: Date.now(),
        runtimeAvailable: true,
        nodeAvailable: true,
        inAppConfigured: true,
        inAppConnected: false,
        inAppToolCount: 0,
        configDetected: false,
        configSources: [],
        browserToolNames: [],
        warnings: [],
        suggestions: [],
      };
      const connected = {
        ...notConnected,
        status: 'ready',
        inAppConnected: true,
        inAppToolCount: 3,
        browserToolNames: ['browser_navigate'],
      };
      const events = () => getMcpManager() as unknown as EventEmitter;
      let server: { id: string; status: string };

      beforeEach(() => {
        server = { id: 'chrome-devtools', status: 'connecting' };
        mocks.toolServers.mockImplementation(() => [server]);
      });

      afterEach(() => {
        vi.useRealTimers();
        events().removeAllListeners();
      });

      it('waits for it to be fully ready, then reports what it found', async () => {
        mocks.browserDiagnose.mockImplementation(async () => (server.status === 'connected' ? connected : notConnected));

        const running = new CapabilityProbe().run();
        await vi.waitFor(() => expect(events().listenerCount('server:phase')).toBe(1));
        expect(mocks.browserDiagnose).not.toHaveBeenCalled();

        // Connected, but its tools are not listed yet: still not the time to judge.
        server.status = 'connected';
        events().emit('server:phase', 'chrome-devtools', 'initialize', 'succeeded');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(mocks.browserDiagnose).not.toHaveBeenCalled();

        events().emit('server:phase', 'chrome-devtools', 'ready', 'succeeded');
        const report = await running;

        expect(checkOf(report, 'subsystem.browser-automation')).toMatchObject({
          status: 'ready',
          summary: 'Running: agents can use the browser tools.',
        });
        expect(report.status).toBe('ready');
        expect(events().listenerCount('server:phase')).toBe(0);
        expect(events().listenerCount('server:error')).toBe(0);
      });

      it('stops waiting when the server fails, and then says it is not connected', async () => {
        mocks.browserDiagnose.mockResolvedValue(notConnected);

        const running = new CapabilityProbe().run();
        await vi.waitFor(() => expect(events().listenerCount('server:error')).toBe(1));
        server.status = 'error';
        events().emit('server:error', 'chrome-devtools', 'spawn npx ENOENT');
        const report = await running;

        expect(checkOf(report, 'subsystem.browser-automation')).toMatchObject({
          status: 'degraded',
          summary: "On, but not running yet: the browser tool server isn't connected.",
          details: { fix: 'browser' },
        });
      });

      it('gives up after a short wait and says it is still connecting, not that it failed', async () => {
        vi.useFakeTimers();
        mocks.browserDiagnose.mockResolvedValue(notConnected);

        const running = new CapabilityProbe().run();
        await vi.waitFor(() => expect(events().listenerCount('server:phase')).toBe(1));
        await vi.advanceTimersByTimeAsync(3_000);
        const report = await running;

        expect(checkOf(report, 'subsystem.browser-automation')).toMatchObject({
          status: 'degraded',
          summary: 'On, but not running yet: the browser tool server is still connecting.',
          details: { fix: 'browser' },
        });
        expect(events().listenerCount('server:phase')).toBe(0);
        expect(events().listenerCount('server:error')).toBe(0);
      });
    });
  });

  it('treats a provider as installed when the doctor\'s cli_installed probe passes, even if detection missed it', async () => {
    // Reproduce the bug from app.log timestamp 1778679400184: CliDetection
    // missed cursor (its `--version` spawn timed out under fork pressure),
    // but ProviderDoctor's `which cursor-agent` succeeded in the same run.
    // The probe should trust the lighter `which` probe rather than saying
    // Cursor isn't installed when it is on PATH.
    mocks.detectAll.mockResolvedValue({
      available: [
        { name: 'claude' },
        { name: 'codex' },
        { name: 'antigravity' },
        { name: 'copilot' },
        // cursor intentionally absent — detection thinks it's not installed
      ],
      detected: [],
      unavailable: [],
      timestamp: new Date(),
    });

    mocks.diagnose.mockImplementation(async (providerKey: string) => ({
      overall: 'healthy' as const,
      probes: [
        {
          name: 'cli_installed',
          status: 'pass' as const,
          message: `${providerKey} found in PATH`,
          latencyMs: 1,
        },
      ],
      recommendations: [],
      provider: providerKey,
      timestamp: Date.now(),
    }));

    const probe = new CapabilityProbe();
    const report = await probe.run();

    const cursorCheck = report.checks.find((check) => check.id === 'provider.cursor');
    expect(cursorCheck).toBeDefined();
    expect(cursorCheck?.status).toBe('ready');
    expect(cursorCheck?.summary).not.toMatch(/isn't installed/i);
  });

  it('still reports the provider as not installed when both detection and the cli_installed probe fail', async () => {
    mocks.detectAll.mockResolvedValue({
      available: [
        { name: 'claude' },
        { name: 'codex' },
        { name: 'antigravity' },
        { name: 'copilot' },
      ],
      detected: [],
      unavailable: [],
      timestamp: new Date(),
    });

    mocks.diagnose.mockImplementation(async (providerKey: string) => ({
      overall: providerKey === 'cursor' ? 'not-installed' as const : 'healthy' as const,
      probes: providerKey === 'cursor'
        ? [{
            name: 'cli_installed',
            status: 'fail' as const,
            message: 'cursor-agent not found in PATH',
            latencyMs: 1,
            errorKind: 'cli_not_found' as const,
          }]
        : [{
            name: 'cli_installed',
            status: 'pass' as const,
            message: `${providerKey} found in PATH`,
            latencyMs: 1,
          }],
      recommendations: providerKey === 'cursor' ? ['Install Cursor and ensure `cursor-agent` is on PATH'] : [],
      provider: providerKey,
      timestamp: Date.now(),
    }));

    const probe = new CapabilityProbe();
    const report = await probe.run();

    const cursorCheck = report.checks.find((check) => check.id === 'provider.cursor');
    expect(cursorCheck).toMatchObject({
      status: 'disabled',
      summary: "Cursor isn't installed. You only need it to use Cursor.",
      details: { recommendations: ['Install Cursor and ensure `cursor-agent` is on PATH'] },
    });
  });
});
