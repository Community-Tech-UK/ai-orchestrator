import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  initializeOptions: null as null | {
    listRemoteNodes?: () => Promise<unknown>;
    spawnRemoteInstance?: (args: {
      node?: string;
      prompt: string;
      requiresBrowser?: boolean;
      requiresAndroid?: boolean;
      androidDeviceKind?: 'emulator' | 'physical' | 'any';
    }) => Promise<unknown>;
    updateNodeConfig?: (args: {
      nodeId: string;
      extensionRelay?: { enabled: boolean };
    }) => Promise<unknown>;
    execOnNode?: (args: {
      node: string;
      executable: string;
      args: string[];
      cwd?: string;
      scriptSha256?: string;
      timeoutMs?: number;
    }) => Promise<unknown>;
    resolveContextEvidence?: (instanceId: string) => unknown;
    calendarTools?: {
      authManager?: unknown;
      graphClient?: unknown;
      writableAccountEmails?: readonly string[];
    };
    authorizeCalendarMutation?: (args: {
      instanceId: string;
      method: string;
      payload: Record<string, unknown>;
    }) => Promise<boolean>;
    localAiGuardOperations?: {
      list: () => Promise<unknown>;
      discover: () => Promise<unknown>;
      validate: (config: unknown) => Promise<unknown>;
      create: (config: unknown) => Promise<unknown>;
    };
  },
  settings: {
    graphClientId: 'graph-client-id',
    graphAuthority: 'https://login.microsoftonline.com/common',
    graphScopesJson: '["Calendars.ReadWrite","User.Read"]',
    graphAgentWritableAccountsJson: '["james@communitytech.co.uk"]',
  } as Record<string, unknown>,
  permissionRequest: vi.fn(),
  graphAuthOptions: null as unknown,
  graphClientOptions: null as unknown,
  graphTokenStoreArgs: null as unknown,
  registry: {
    getAllNodes: vi.fn(),
    getNode: vi.fn(),
    selectNode: vi.fn(),
  },
  roster: {
    list: vi.fn(),
  },
  connectionServer: {
    getConnectedNodeIds: vi.fn(),
    isNodeConnected: vi.fn(),
  },
  sendServiceRpc: vi.fn(),
  localAiRuntime: {
    targets: {
      list: vi.fn(),
      findByEndpoint: vi.fn(),
      create: vi.fn(),
    },
    probes: {
      check: vi.fn(),
    },
  },
  discoverLocalAiCandidates: vi.fn(),
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    get: vi.fn((key: string) => captured.settings[key] ?? 3),
    getAll: vi.fn(() => ({
      maxSpawnDepth: 3,
      maxTotalInstances: 20,
      ...captured.settings,
    })),
  }),
}));

vi.mock('../mcp/orchestrator-tools-rpc-server', () => ({
  initializeOrchestratorToolsRpcServer: vi.fn(async (options) => {
    captured.initializeOptions = options;
    return {};
  }),
}));

vi.mock('../operator/operator-database', () => ({
  defaultOperatorDbPath: () => '/tmp/operator.db',
  getOperatorDatabase: () => ({ db: { id: 'operator-db' } }),
}));

vi.mock('../mcp/secret-storage', () => ({
  getMcpSecretStorage: () => ({ id: 'secret-storage' }),
}));

vi.mock('../graph/graph-token-store', () => ({
  GraphTokenStore: class {
    constructor(...args: unknown[]) {
      captured.graphTokenStoreArgs = args;
    }
  },
}));

vi.mock('../graph/graph-auth', () => ({
  GraphAuthManager: class {
    constructor(options: unknown) {
      captured.graphAuthOptions = options;
    }

    connectAccount = vi.fn();
    listAccounts = vi.fn();
    getAccessToken = vi.fn();
  },
}));

vi.mock('../graph/graph-client', () => ({
  GraphClient: class {
    constructor(options: unknown) {
      captured.graphClientOptions = options;
    }
  },
}));

vi.mock('../orchestration/permission-registry', () => ({
  getPermissionRegistry: () => ({ requestPermission: captured.permissionRequest }),
}));

vi.mock('../remote-node', () => ({
  getWorkerNodeConnectionServer: () => captured.connectionServer,
  getRemoteNodeRosterService: () => captured.roster,
  getWorkerNodeRegistry: () => captured.registry,
  isAndroidAutomationReady: (caps: { hasAndroidMcp?: boolean }) => Boolean(caps.hasAndroidMcp),
}));

vi.mock('../remote-node/service-rpc-client', () => ({
  sendServiceRpc: captured.sendServiceRpc,
}));

vi.mock('../automations', () => ({
  getAutomationRunner: vi.fn(),
  getAutomationScheduler: vi.fn(),
  getAutomationStore: vi.fn(),
}));

vi.mock('../automations/automation-create-service', () => ({
  createAutomationWithScheduling: vi.fn(),
  handlePastOneTimeAutomation: vi.fn(),
}));

vi.mock('../automations/automation-events', () => ({
  getAutomationEvents: vi.fn(),
}));

vi.mock('../automations/automation-tool-impl', () => ({
  createAutomationToolImplementations: vi.fn(() => ({
    createAutomation: vi.fn(),
    deleteAutomation: vi.fn(),
    listAutomations: vi.fn(),
    postponeAutomation: vi.fn(),
    updateAutomation: vi.fn(),
  })),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../context-evidence/context-evidence-coordinator', () => ({
  getContextEvidenceCoordinator: () => ({ id: 'coordinator' }),
}));

vi.mock('../local-ai-guard/local-ai-runtime', () => ({
  getLocalAiGuardRuntime: () => captured.localAiRuntime,
}));

vi.mock('../rlm/auxiliary-llm-service', () => ({
  getAuxiliaryLlmService: () => ({
    discoverCandidates: captured.discoverLocalAiCandidates,
  }),
}));

import { createOrchestratorToolsStep } from './orchestrator-tools-step';
import { COORDINATOR_TO_NODE } from '../remote-node/worker-node-rpc';
import {
  _resetCrossSessionMessagingServiceForTesting,
  getCrossSessionMessagingService,
} from '../instance/cross-session-messaging';
import type { AppSettings } from '@shared/types/settings.types';

describe('createOrchestratorToolsStep settings node-config integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetCrossSessionMessagingServiceForTesting();
    getCrossSessionMessagingService({
      getAllInstances: () => [],
      getInstance: () => undefined,
      sendInput: async () => {},
      getSettings: () => ({
        interSessionMessaging: {
          enabled: false,
          allowCrossProject: false,
          maxHops: 3,
          rateLimitPerMinute: 10,
        },
      } as unknown as AppSettings),
    });
    captured.initializeOptions = null;
    captured.graphAuthOptions = null;
    captured.graphClientOptions = null;
    captured.graphTokenStoreArgs = null;
    captured.settings = {
      graphClientId: 'graph-client-id',
      graphAuthority: 'https://login.microsoftonline.com/common',
      graphScopesJson: '["Calendars.ReadWrite","User.Read"]',
      graphAgentWritableAccountsJson: '["james@communitytech.co.uk"]',
    };
    captured.permissionRequest.mockResolvedValue({
      requestId: 'permission-1',
      granted: true,
      decidedBy: 'user',
      decidedAt: Date.now(),
    });
    captured.sendServiceRpc.mockImplementation(async (
      _nodeId: string,
      method: string,
      params: { provider?: string },
    ) => method === COORDINATOR_TO_NODE.PROVIDER_DIAGNOSE
      ? {
          ok: true,
          platform: 'win32',
          identity: { username: 'fixture', homeDirectory: 'C:\\Users\\fixture' },
          provider: {
            provider: params.provider,
            available: true,
            authenticated: true,
          },
        }
      : { ok: true });
    captured.roster.list.mockImplementation(() => captured.registry.getAllNodes());
  });

  it('injects Graph calendar dependencies and requires an explicit user decision per mutation', async () => {
    await startStep();

    expect(captured.graphTokenStoreArgs).toEqual([
      { id: 'operator-db' },
      { id: 'secret-storage' },
    ]);
    expect(captured.graphAuthOptions).toMatchObject({
      clientId: 'graph-client-id',
      authority: 'https://login.microsoftonline.com/common',
      scopes: ['Calendars.ReadWrite', 'User.Read'],
      deviceCodeCallback: expect.any(Function),
    });
    expect(captured.graphClientOptions).toMatchObject({
      tokenProvider: captured.initializeOptions?.calendarTools?.authManager,
    });
    expect(captured.initializeOptions?.calendarTools?.writableAccountEmails).toEqual([
      'james@communitytech.co.uk',
    ]);

    const request = {
      instanceId: 'instance-1',
      method: 'orchestrator_tools.graph_calendar_create_event',
      payload: {
        account: 'james@communitytech.co.uk',
        subject: 'TEST - IGNORE',
        attendees: [{ emailAddress: { address: 'invitee@example.com' } }],
        body: { contentType: 'text', content: 'private content' },
      },
    };
    await expect(
      captured.initializeOptions?.authorizeCalendarMutation?.(request),
    ).resolves.toBe(true);
    expect(captured.permissionRequest).toHaveBeenCalledTimes(1);
    const permission = captured.permissionRequest.mock.calls[0]?.[0];
    expect(permission.description).toContain('may send attendee invitations');
    expect(permission.description).not.toContain('private content');

    captured.permissionRequest.mockResolvedValueOnce({
      requestId: 'permission-2',
      granted: true,
      decidedBy: 'auto_approve',
      decidedAt: Date.now(),
    });
    await expect(
      captured.initializeOptions?.authorizeCalendarMutation?.(request),
    ).resolves.toBe(false);
  });

  it('injects canonical Local AI list, discovery, validation, and create operations', async () => {
    captured.localAiRuntime.targets.list.mockReturnValue([]);
    captured.discoverLocalAiCandidates.mockResolvedValue([]);
    await startStep();

    const operations = captured.initializeOptions?.localAiGuardOperations;
    expect(operations).toMatchObject({
      list: expect.any(Function),
      discover: expect.any(Function),
      validate: expect.any(Function),
      create: expect.any(Function),
    });
    await expect(operations?.list()).resolves.toEqual([]);
    await expect(operations?.discover()).resolves.toEqual([]);
    expect(captured.localAiRuntime.targets.list).toHaveBeenCalledWith({
      includeRetired: false,
    });
    expect(captured.discoverLocalAiCandidates).toHaveBeenCalledOnce();
  });

  it('fails closed when the writable-account setting is malformed', async () => {
    captured.settings['graphAgentWritableAccountsJson'] = 'not-json';

    await startStep();

    expect(captured.initializeOptions?.calendarTools?.writableAccountEmails).toEqual([]);
  });

  it('rejects update_node_config for a disconnected node before sending service RPC', async () => {
    const node = { id: 'node-1', name: 'windows-pc' };
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.registry.getNode.mockReturnValue(node);
    captured.connectionServer.getConnectedNodeIds.mockReturnValue([]);
    captured.connectionServer.isNodeConnected.mockReturnValue(false);
    await startStep();

    await expect(
      captured.initializeOptions?.updateNodeConfig?.({
        nodeId: 'windows-pc',
        extensionRelay: { enabled: true },
      }),
    ).rejects.toThrow(/no worker nodes are currently connected/i);
    expect(captured.sendServiceRpc).not.toHaveBeenCalled();
  });

  it('sends update_node_config through config.update for a connected node', async () => {
    const node = { id: 'node-1', name: 'windows-pc' };
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.registry.getNode.mockReturnValue(node);
    captured.connectionServer.getConnectedNodeIds.mockReturnValue(['node-1']);
    captured.connectionServer.isNodeConnected.mockReturnValue(true);
    captured.sendServiceRpc.mockResolvedValue({ ok: true });
    await startStep();

    const result = await captured.initializeOptions?.updateNodeConfig?.({
      nodeId: 'windows-pc',
      extensionRelay: { enabled: true },
    });

    expect(captured.sendServiceRpc).toHaveBeenCalledWith(
      'node-1',
      COORDINATOR_TO_NODE.CONFIG_UPDATE,
      { extensionRelay: { enabled: true } },
      30_000,
    );
    expect(result).toMatchObject({
      nodeId: 'node-1',
      nodeName: 'windows-pc',
      updatedBlocks: ['extensionRelay'],
      result: { ok: true },
    });
  });

  it('delegates exact argv to node.exec and preserves nonzero/truncation results', async () => {
    const node = makeNode();
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.connectionServer.getConnectedNodeIds.mockReturnValue(['node-1']);
    captured.connectionServer.isNodeConnected.mockReturnValue(true);
    captured.sendServiceRpc.mockResolvedValue({
      exitCode: 7,
      stdout: 'partial output',
      stderr: 'fixture error',
      stdoutTruncated: true,
      stderrTruncated: false,
      durationMs: 321,
    });
    await startStep();

    const result = await captured.initializeOptions?.execOnNode?.({
      node: 'windows-pc',
      executable: 'curl',
      args: ['--fail', 'https://example.test/data'],
      cwd: 'C:\\work',
      scriptSha256: 'b'.repeat(64),
      timeoutMs: 4_000,
    });

    expect(captured.sendServiceRpc).toHaveBeenCalledWith(
      'node-1',
      COORDINATOR_TO_NODE.NODE_EXEC,
      {
        executable: 'curl',
        args: ['--fail', 'https://example.test/data'],
        cwd: 'C:\\work',
        scriptSha256: 'b'.repeat(64),
        timeoutMs: 4_000,
      },
      9_000,
    );
    expect(result).toEqual({
      nodeId: 'node-1', nodeName: 'windows-pc', exitCode: 7,
      stdout: 'partial output', stderr: 'fixture error',
      stdoutTruncated: true, stderrTruncated: false, durationMs: 321,
    });
  });

  it('rejects visible shared-Chrome launch argv before node.exec delegation', async () => {
    const node = makeNode();
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.connectionServer.getConnectedNodeIds.mockReturnValue(['node-1']);
    captured.connectionServer.isNodeConnected.mockReturnValue(true);
    await startStep();

    await expect(captured.initializeOptions?.execOnNode?.({
      node: 'windows-pc',
      executable: 'powershell.exe',
      args: ['-Command', 'Start-Process chrome.exe chrome://extensions'],
    })).rejects.toThrow(/shared Chrome\/session/i);
    expect(captured.sendServiceRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['cmd.exe', ['/c', 'chrome.exe', '--version']],
    ['powershell.exe', ['-Command', 'chrome.exe --version']],
    ['cmd.exe', ['/c', 'msedge.exe', '--version']],
    ['python.exe', ['-c', 'import subprocess; subprocess.run(["chrome.exe"])']],
    ['pwsh.exe', ['-co', 'chrome.exe; #', '-File', 'C:\\work\\repair.ps1']],
    ['powershell.exe', ['-c', 'msedge.exe; #', '-File', 'C:\\work\\repair.ps1']],
    ['pwsh.exe', ['-Command', 'chrome.exe; #', '-File', 'C:\\work\\repair.ps1']],
    ['powershell.exe', ['-cwa', 'msedge.exe; #', '-File', 'C:\\work\\repair.ps1']],
    ['pwsh.exe', ['-CommandWithArgs', 'chrome.exe; #', '-File', 'C:\\work\\repair.ps1']],
    ['powershell.exe', ['-NoProfile', 'Start-Process chrome.exe; #', '-File', 'recovery.ps1']],
    ['powershell.exe', ['–Command', 'Start-Process chrome.exe; #', '-File', 'recovery.ps1']],
    ['powershell.exe', ['-EncodedCommand', 'ZgBpAHgAdAB1AHIAZQA=']],
    ['powershell.exe', ['-ec', 'ZgBpAHgAdAB1AHIAZQA=']],
    ['powershell.exe', ['/EncodedCommand', 'ZgBpAHgAdAB1AHIAZQA=']],
    ['pwsh.exe', ['-enc', 'ZgBpAHgAdAB1AHIAZQA=']],
    ['cmd.exe', ['/c', 'start chr^ome.exe']],
    ['cmd.exe', ['/c', 'powershell.exe -EncodedCommand ZgBpAHgAdAB1AHIAZQA=']],
    ['cmd.exe', ['/c', 'powershell.exe /EncodedCommand ZgBpAHgAdAB1AHIAZQA=']],
    ['env', ['pwsh', '-enc', 'ZgBpAHgAdAB1AHIAZQA=']],
    ['env', ['pwsh', '-ec', 'ZgBpAHgAdAB1AHIAZQA=']],
    ['powershell.exe', ['-Command', 'Start-Process chr`ome.exe']],
    [
      'powershell.exe',
      ['-Command', "Start-Process $env:ComSpec -ArgumentList '/c start https://example.invalid'"],
    ],
    [
      'powershell.exe',
      ['-Command', "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('U3RhcnQtUHJvY2VzcyBjaHJvbWUuZXhl')) | Invoke-Expression"],
    ],
    [
      'node.exe',
      ['-e', "require('node:child_process').spawn('ch' + 'rome.exe')"],
    ],
    ['node.exe', ['-e', "require(['child_', 'process'].join('')).spawn(['chr', 'ome.exe'].join(''))"]],
    ['node.exe', ['-e', "const cp=require('node:child_process');cp['ex'+'ec']('chrome.exe')"]],
    ['node.exe', ['-p', "require('node:child_process').spawn('chrome.exe')"]],
    ['python.exe', ['-c', "__import__('sub'+'process').Popen('ch'+'rome.exe')"]],
    [
      'powershell.exe',
      ['-Command', '[Diagnostics.Process]::Start((-join ([char]99,[char]104,[char]114,[char]111,[char]109,[char]101,[char]46,[char]101,[char]120,[char]101)))'],
    ],
    [
      'python.exe',
      ['-c', "import ctypes; name=''.join(map(chr,[99,104,114,111,109,101,46,101,120,101])); ctypes.windll.shell32.ShellExecuteW(None,'open',name,None,None,1)"],
    ],
    ['node.exe', ['./uninspected-script.js']],
    ['custom-launcher.exe', ['--literal', 'fixture']],
    ['/tmp/curl', ['https://example.invalid/data']],
    ['curl', ['--config', '/tmp/untrusted-curlrc', 'https://example.invalid/data']],
    ['sh', ['-c', 'curl https://example.invalid/data']],
    ['env', ['curl', 'https://example.invalid/data']],
    ['env', ['node', '/tmp/payload.js']],
    ['sh', ['/tmp/launch-browser.sh']],
    ['env', ['python3', '/tmp/payload.py']],
    ['bash', ['/tmp/launch-browser.sh']],
    ['busybox', ['rm', '/tmp/fixture']],
    ['curl', ['http://example.invalid/data']],
    ['curl', ['--location', 'https://example.invalid/data']],
    ['powershell.exe', ['-Command', 'Write-Output payload > C:\\temp\\launch.url']],
    ['rundll32.exe', ['evil.dll,LaunchBrowser']],
    ['powershell.exe', ['-Command', 'Start-Process (Get-Item Env:ComSpec).Value']],
    [
      'powershell.exe',
      ['-Command', "'U3RhcnQtUHJvY2VzcyBjaHJvbWUuZXhl' | ForEach-Object { Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_))) }"],
    ],
    ['powershell.exe', ['-Command', 'Start-Process explorer.exe https://example.invalid']],
    ['rundll32.exe', ['shell32.dll,ShellExec_RunDLL', 'https://example.invalid']],
    ['cmd.exe', ['/c', 'start explorer.exe https://example.invalid']],
    ['cmd.exe', ['/c', 'echo fixture']],
    ['powershell.com', ['-Command', 'Write-Output "fixture"']],
    ['pwsh.exe', ['-Command', 'Write-Output "fixture"']],
    ['echo.exe', ['fixture']],
    ['printf.exe', ['%s', 'fixture']],
    ['open', ['/tmp/a.html']],
    ['xdg-open', ['/tmp/a.html']],
    ['open', ['/tmp/fixture.txt']],
    ['xdg-open', ['/tmp/fixture.txt']],
    ['gio', ['info', '/tmp/fixture.txt']],
    ['explorer.exe', ['C:\\fixture']],
    ['rundll32.exe', ['shell32.dll,Control_RunDLL']],
    ['C:\\work\\sibling.ps1', []],
    ['cmd.exe', ['/c', 'start ch"ro"me.exe']],
    ['open', ['-a', 'Google Chrome']],
    ['zsh', ['-c', 'chrome']],
    ['bash', ['-lc', 'google-chrome --version']],
    ['sh', ['-c', 'msedge.exe --version']],
    ['sh', ['-c', 'chr\\ome --version']],
    ['sh', ['-c', 'chr\\\nome --version']],
    ['sh', ['-c', 'chr\\\r\nome --version']],
    ['sh', ['-c', 'bash -c "chr\\\\ome --version"']],
    ['env', ['bash', '-c', 'chr\\ome --version']],
    ['env', ['-S', '/bin/bash -c chr\\ome --version']],
    ['env', ['-S', '/usr/bin/bash -c chr\\ome --version']],
    ['env', ['-S', '/bin/sh -c chr\\ome --version']],
    ['env', ['-S', 'C:\\tools\\bash.exe -c chr\\ome --version']],
    ['env', ['-S', '/bin/bash --noprofile -c chr\\ome --version']],
    ['env', ['-S', '/usr/bin/sh -x -c chr\\ome --version']],
    ['env', ['-S', 'C:\\tools\\bash.exe --noprofile -c chr\\ome --version']],
    ['env', ['-S', '/bin/bash -O extglob -c chr\\ome --version']],
    ['env', ['bash', '--noprofile', '-c', 'chr\\ome --version']],
    ['/usr/bin/sh', ['-x', '-c', 'chr\\ome --version']],
    ['C:\\tools\\bash.exe', ['--noprofile', '-c', 'chr\\ome --version']],
    ['/bin/bash', ['-O', 'extglob', '-c', 'chr\\ome --version']],
    ['env', ['-S', '/bin/bash -xO extglob -c chr\\ome --version']],
    ['env', ['-S', '/usr/bin/bash -xo errexit -c chr\\ome --version']],
    ['env', ['bash', '-xO', 'extglob', '-c', 'chr\\ome --version']],
    ['/bin/bash', ['-xo', 'errexit', '-c', 'chr\\ome --version']],
    ['C:\\tools\\bash.exe', ['-xO', 'extglob', '-c', 'chr\\ome --version']],
    ['/bin/bash', ['-C', '-c', 'chr\\ome --version']],
    ['env', ['bash', '-C', '-c', 'chr\\ome --version']],
    ['/bin/sh', ['-C', '-c', 'chr\\ome --version']],
    ['env', ['sh', '-C', '-c', 'chr\\ome --version']],
    ['sh', ['-c', '$\'\\x63\\x68\\x72\\x6f\\x6d\\x65\' --version']],
    ['sh', ['-c', 'c$\'hr\'ome --version']],
    ['sh', ['-c', 'chr${AIO_UNSET}ome --version']],
    ['sh', ['-c', '$(printf chr)ome --version']],
    ['sh', ['-c', '`printf chr`ome --version']],
    ['sh', ['-c', 'p$\'wsh\' -EncodedCommand ZgBpAHgAdAB1AHIAZQA=']],
    ['bash', ['-c', 'ch{r,rr}ome --version']],
    ['bash', ['-c', 'p{w,xx}sh -EncodedCommand ZgBpAHgAdAB1AHIAZQA=']],
    ['bash', ['-c', 'ch*ome --version']],
    ['bash', ['-c', 'ch?ome --version']],
    ['bash', ['-c', 'printf fixture# $HOME']],
    ['/usr/bin/bash', ['-c', 'printf fixture# $HOME']],
    ['env', ['bash', '-c', 'printf fixture# $HOME']],
    ['env', ['-S', '/bin/bash -c "printf fixture# $HOME"']],
    ['fish', ['-C', 'chr\\ome --version']],
    ['/usr/bin/fish', ['-C', 'chr\\ome --version']],
    ['env', ['fish', '-C', 'chr\\ome --version']],
    ['env', ['-S', '/usr/bin/fish -C chr\\ome --version']],
    ['fish', ['--init-command=chr\\ome --version']],
    ['/usr/bin/fish', ['--init-command', 'chr\\ome --version']],
    ['env', ['fish', '--init-command=chr\\ome --version']],
    ['env', ['-S', '/usr/bin/fish --init-command=chr\\ome --version']],
    ['sh', ['-c', 'p\\wsh -EncodedCommand ZgBpAHgAdAB1AHIAZQA=']],
    ['dash', ['-c', 'microsoft-edge']],
    ['fish', ['-c', 'msedge']],
    ['ksh', ['-c', 'chromium']],
    ['osascript', ['-e', 'tell application "Google Chrome" to activate']],
    ['cmd.exe', ['/c', 'start msedge.exe']],
    ['explorer.exe', ['microsoft-edge:https://example.test']],
    ['rundll32.exe', ['url.dll,FileProtocolHandler', 'chrome://extensions']],
    ['/usr/bin/microsoft-edge-stable', []],
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['https://example.test']],
    ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', ['--version']],
    ['Google Chrome', ['--version']],
    ['Microsoft Edge', ['--version']],
    ['open', ['-a', 'Microsoft Edge']],
    ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--version']],
    ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', ['--version']],
    ['powershell.exe', ['-NoProfile', '-File', 'C:\\repair-chrome.ps1', 'chrome.exe']],
    ['env', ['bash', '-c', 'chrome https://example.test']],
    ['busybox', ['sh', '-c', 'chrome https://example.test']],
    ['timeout', ['10', 'google-chrome', '--version']],
    ['nice', ['msedge.exe', '--version']],
    ['fixture-runner', ['--browser', 'Microsoft Edge']],
  ])('rejects shell-wrapper shared-browser execution via %s', async (executable, args) => {
    const node = makeNode();
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.connectionServer.getConnectedNodeIds.mockReturnValue(['node-1']);
    captured.connectionServer.isNodeConnected.mockReturnValue(true);
    await startStep();

    await expect(captured.initializeOptions?.execOnNode?.({
      node: 'windows-pc', executable, args,
    })).rejects.toThrow(/shared Chrome\/session/i);
    expect(captured.sendServiceRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['direct attached', 'fish', ['-Cchrome']],
    ['absolute attached', '/usr/bin/fish', ['-Cchrome']],
    ['direct combined attached', 'fish', ['-liCchrome']],
    ['absolute combined attached', '/usr/bin/fish', ['-iCchrome']],
    ['direct combined next argv', 'fish', ['-liC', 'chr\\ome --version']],
    ['env attached', 'env', ['fish', '-Cchrome']],
    ['env absolute combined attached', 'env', ['/usr/bin/fish', '-liCchrome']],
    ['env combined next argv', 'env', ['fish', '-iC', 'chr\\ome --version']],
    ['env -S attached', 'env', ['-S', '/usr/bin/fish -Cchrome']],
    ['env -S combined attached', 'env', ['-S', '/usr/bin/fish -liCchrome']],
    ['direct command attached', 'fish', ['-cchrome']],
    ['env -S command attached', 'env', ['-S', '/usr/bin/fish -icchrome']],
    ['long separate', 'fish', ['--init-command', 'chr\\ome --version']],
    ['long attached', '/usr/bin/fish', ['--init-command=chr\\ome --version']],
    ['env long separate', 'env', ['fish', '--init-command', 'chr\\ome --version']],
    ['env long attached', 'env', ['/usr/bin/fish', '--init-command=chr\\ome --version']],
    ['env -S long separate', 'env', ['-S', '/usr/bin/fish --init-command "chr\\ome --version"']],
    ['env -S long attached', 'env', ['-S', '/usr/bin/fish --init-command=chr\\ome --version']],
  ])('rejects Fish init command execution before spawn: %s', async (
    _caseName,
    executable,
    args,
  ) => {
    const node = makeNode();
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.connectionServer.getConnectedNodeIds.mockReturnValue(['node-1']);
    captured.connectionServer.isNodeConnected.mockReturnValue(true);
    await startStep();

    await expect(captured.initializeOptions?.execOnNode?.({
      node: 'windows-pc', executable, args,
    })).rejects.toThrow(/shared Chrome\/session/i);
    expect(captured.sendServiceRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['direct attached', 'fish', ['-Cprintf fixture']],
    ['absolute combined attached', '/usr/bin/fish', ['-liCprintf fixture']],
    ['direct combined next argv', 'fish', ['-liC', 'printf fixture']],
    ['env attached', 'env', ['fish', '-Cprintf fixture']],
    ['env combined attached', 'env', ['/usr/bin/fish', '-iCprintf fixture']],
    ['env -S attached', 'env', ['-S', '/usr/bin/fish -Cprintf\\ fixture']],
    ['env -S combined next word', 'env', ['-S', '/usr/bin/fish -liC "printf fixture"']],
    ['direct command attached', 'fish', ['-cprintf fixture']],
    ['long separate', 'fish', ['--init-command', 'printf fixture']],
    ['long attached', '/usr/bin/fish', ['--init-command=printf fixture']],
    ['env long separate', 'env', ['fish', '--init-command', 'printf fixture']],
    ['env -S long attached', 'env', ['-S', '/usr/bin/fish --init-command=printf\\ fixture']],
    ['harmless short flags', 'fish', ['-ilN']],
    ['debug value containing C', 'fish', ['-dCchrome']],
    ['debug-output value containing C', '/usr/bin/fish', ['-ioCchrome.log']],
    ['profile value containing C through env', 'env', ['fish', '-pCchrome.prof']],
    ['feature value containing C through env -S', 'env', ['-S', '/usr/bin/fish -fCchrome-feature']],
    ['separate debug value before init command', 'fish', ['-d', 'Cfixture', '-Cprintf fixture']],
    ['Bash uppercase C remains a flag', 'bash', ['-Cx', 'chr\\ome-fixture.sh']],
    ['single-quoted literal command value', 'fish', ['-Cprintf \'%s\' \'$AIO_LITERAL\'']],
    ['escaped literal command value', 'fish', ['-iCprintf \'%s\' \\$AIO_LITERAL']],
  ])('rejects POSIX shell and env wrapper forms wholesale: %s', async (
    _caseName,
    executable,
    args,
  ) => {
    const node = makeNode();
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.connectionServer.getConnectedNodeIds.mockReturnValue(['node-1']);
    captured.connectionServer.isNodeConnected.mockReturnValue(true);
    await startStep();

    await expect(captured.initializeOptions?.execOnNode?.({
      node: 'windows-pc', executable, args,
    })).rejects.toThrow(/shared Chrome\/session/i);
    expect(captured.sendServiceRpc).not.toHaveBeenCalled();
  });

  it.each([
    [
      'direct separate init then command',
      'fish',
      ['-C', 'printf fixture', '-c', 'chr\\ome --version'],
    ],
    [
      'absolute attached init then attached command',
      '/usr/bin/fish',
      ['-Cprintf fixture', '-cchr\\ome --version'],
    ],
    [
      'env repeated init commands',
      'env',
      ['fish', '-C', 'printf fixture', '-C', 'chr\\ome --version'],
    ],
    [
      'env absolute long init then command',
      'env',
      ['/usr/bin/fish', '--init-command=printf fixture', '-c', 'chr\\ome --version'],
    ],
    [
      'env -S long init then command',
      'env',
      ['-S', '/usr/bin/fish --init-command="printf fixture" -c "chr\\ome --version"'],
    ],
    [
      'env -S repeated attached init commands',
      'env',
      ['-S', '/usr/bin/fish -Cprintf\\ fixture -Cchr\\ome'],
    ],
    [
      'direct command then init command',
      'fish',
      ['-c', 'printf fixture', '-C', 'chr\\ome --version'],
    ],
    [
      'direct unsafe third command option',
      'fish',
      ['-Cprintf one', '-cprintf two', '--init-command=chr\\ome --version'],
    ],
    [
      'env value options interleaved before unsafe command',
      'env',
      ['fish', '-Cprintf one', '-d', 'Cfixture', '-pCprofile', '-cchr\\ome'],
    ],
    [
      'env -S command then long init command',
      'env',
      ['-S', '/usr/bin/fish -cprintf\\ fixture --init-command="chr\\ome --version"'],
    ],
  ])('rejects every Fish command-bearing option before spawn: %s', async (
    _caseName,
    executable,
    args,
  ) => {
    const node = makeNode();
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.connectionServer.getConnectedNodeIds.mockReturnValue(['node-1']);
    captured.connectionServer.isNodeConnected.mockReturnValue(true);
    await startStep();

    await expect(captured.initializeOptions?.execOnNode?.({
      node: 'windows-pc', executable, args,
    })).rejects.toThrow(/shared Chrome\/session/i);
    expect(captured.sendServiceRpc).not.toHaveBeenCalled();
  });

  it.each([
    [
      'direct separate init then command',
      'fish',
      ['-C', 'printf init', '-c', 'printf command'],
    ],
    [
      'absolute attached init then attached command',
      '/usr/bin/fish',
      ['-Cprintf init', '-cprintf command'],
    ],
    [
      'env repeated init commands around value options',
      'env',
      ['fish', '-Cprintf one', '-d', 'Cfixture', '-Cprintf two'],
    ],
    [
      'env -S long init then command',
      'env',
      ['-S', '/usr/bin/fish --init-command="printf init" -c "printf command"'],
    ],
    [
      'env -S repeated attached init commands',
      'env',
      ['-S', '/usr/bin/fish -Cprintf\\ one -Cprintf\\ two'],
    ],
  ])('rejects multiple POSIX shell command-bearing options wholesale: %s', async (
    _caseName,
    executable,
    args,
  ) => {
    const node = makeNode();
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.connectionServer.getConnectedNodeIds.mockReturnValue(['node-1']);
    captured.connectionServer.isNodeConnected.mockReturnValue(true);
    await startStep();

    await expect(captured.initializeOptions?.execOnNode?.({
      node: 'windows-pc', executable, args,
    })).rejects.toThrow(/shared Chrome\/session/i);
    expect(captured.sendServiceRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['direct macOS open URL', 'open', ['https://example.test/path']],
    ['direct Linux xdg-open URL', 'xdg-open', ['https://example.test/path']],
    ['direct Linux gio open URL', 'gio', ['open', 'https://example.test/path']],
    ['cmd start URL', 'cmd.exe', ['/c', 'start https://example.test/path']],
    ['cmd caret-escaped start and scheme', 'cmd.exe', ['/c', 'st^art h^ttps^://example.test/path']],
    ['Windows explorer URL', 'explorer.exe', ['https://example.test/path']],
    [
      'Windows rundll32 URL handler',
      'rundll32.exe',
      ['url.dll,FileProtocolHandler', 'https://example.test/path'],
    ],
    [
      'PowerShell Start-Process URL',
      'powershell.exe',
      ['-Command', 'Start-Process https://example.test/path'],
    ],
    [
      'PowerShell saps alias URL',
      'pwsh',
      ['-Command', 'saps https://example.test/path'],
    ],
    [
      'PowerShell concatenated browser process',
      'powershell.exe',
      ['-Command', "Start-Process ('chr'+'ome.exe')"],
    ],
    [
      'PowerShell call operator concatenated browser process',
      'pwsh.exe',
      ['-Command', "& ('chr'+'ome.exe') https://example.test/path"],
    ],
    ['sh macOS open URL', 'sh', ['-c', 'open https://example.test/path']],
    ['bash quoted xdg-open URL', 'bash', ['-c', 'xdg-open "https://example.test/path"']],
    ['fish gio open URL', 'fish', ['-c', 'gio open https://example.test/path']],
    ['sh escaped xdg-open and scheme', 'sh', ['-c', 'xdg\\-open h\\ttps\\://example.test/path']],
    ['absolute macOS open URL', '/usr/bin/open', ['https://example.test/path']],
    ['env xdg-open URL', 'env', ['xdg-open', 'https://example.test/path']],
    ['env -S gio open URL', 'env', ['-S', 'gio open "https://example.test/path"']],
    ['cmd start empty title and background URL', 'cmd', ['/c', 'start "" /b https://example.test/path']],
    ['cmd nested explorer URL', 'cmd.exe', ['/c', 'explorer.exe https://example.test/path']],
    [
      'PowerShell explicit FilePath URL',
      'pwsh',
      ['-Command', 'Start-Process -FilePath https://example.test/path'],
    ],
    [
      'PowerShell start alias concatenated browser',
      'powershell.exe',
      ['-Command', "start ('chr' + 'ome.exe')"],
    ],
    ['sh command prefix quoted-concatenated open', 'sh', ['-c', "command o'p'en https://example.test/path"]],
    ['bash later xdg-open clause', 'bash', ['-c', 'printf fixture; xdg-open https://example.test/path']],
    [
      'sh nested PowerShell Start-Process URL',
      'sh',
      ['-c', 'pwsh -Command "Start-Process https://example.test/path"'],
    ],
    ['bash bracket-obscured open', 'bash', ['-c', 'o[p]en https://example.test/path']],
    [
      'bash extglob-obscured launcher',
      'bash',
      ['-O', 'extglob', '-c', '@(xdg-open|open) https://example.test/path'],
    ],
  ])('rejects a browser-launch sink before spawn: %s', async (
    _caseName,
    executable,
    args,
  ) => {
    const node = makeNode();
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.connectionServer.getConnectedNodeIds.mockReturnValue(['node-1']);
    captured.connectionServer.isNodeConnected.mockReturnValue(true);
    await startStep();

    await expect(captured.initializeOptions?.execOnNode?.({
      node: 'windows-pc', executable, args,
    })).rejects.toThrow(/shared Chrome\/session/i);
    expect(captured.sendServiceRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['direct curl URL', 'curl', ['https://example.test/path']],
    [
      'PowerShell writes launcher text',
      'powershell.exe',
      ['-Command', 'Write-Output "Start-Process https://example.test/path"'],
    ],
  ])('allows non-browser URL and non-URL launcher argv: %s', async (
    _caseName,
    executable,
    args,
  ) => {
    const node = makeNode();
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.connectionServer.getConnectedNodeIds.mockReturnValue(['node-1']);
    captured.connectionServer.isNodeConnected.mockReturnValue(true);
    captured.sendServiceRpc.mockResolvedValue({
      exitCode: 0, stdout: '', stderr: '', stdoutTruncated: false,
      stderrTruncated: false, durationMs: 1,
    });
    await startStep();

    await expect(captured.initializeOptions?.execOnNode?.({
      node: 'windows-pc', executable, args,
    })).resolves.toMatchObject({ exitCode: 0 });
  });

  it.each(
    ['?', '*', '+', '@', '!'].flatMap((operator) => {
      const command = `${operator}(chr|chrom)e --version`;
      return [
        [`${operator} direct`, 'bash', ['-O', 'extglob', '-c', command]] as const,
        [`${operator} absolute path`, '/usr/bin/bash', ['-O', 'extglob', '-c', command]] as const,
        [`${operator} env`, 'env', ['bash', '-O', 'extglob', '-c', command]] as const,
        [
          `${operator} env -S`,
          'env',
          ['-S', `/bin/bash -O extglob -c "${command}"`],
        ] as const,
      ];
    }),
  )('rejects active Bash extglob in %s', async (_caseName, executable, readonlyArgs) => {
    const node = makeNode();
    const args = [...readonlyArgs];
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.connectionServer.getConnectedNodeIds.mockReturnValue(['node-1']);
    captured.connectionServer.isNodeConnected.mockReturnValue(true);
    await startStep();

    await expect(captured.initializeOptions?.execOnNode?.({
      node: 'windows-pc', executable, args,
    })).rejects.toThrow(/shared Chrome\/session/i);
    expect(captured.sendServiceRpc).not.toHaveBeenCalled();
  });

  it.each(
    ['?', '*', '+', '@', '!'].flatMap((operator) => {
      const literal = `${operator}(chr|chrom)e`;
      const escaped = `\\${operator}\\(chr\\|chrom\\)e`;
      return [
        ['single quoted', `echo '${literal}'`],
        ['double quoted', `echo "${literal}"`],
        ['backslash escaped', `echo ${escaped}`],
      ].flatMap(([form, command]) => {
        const envSplitCommand = command.includes("'")
          ? `/bin/bash -O extglob -c "${command}"`
          : `/bin/bash -O extglob -c '${command}'`;
        return [
          [`${operator} ${form} direct`, 'bash', ['-O', 'extglob', '-c', command]] as const,
          [
            `${operator} ${form} absolute path`,
            '/usr/bin/bash',
            ['-O', 'extglob', '-c', command],
          ] as const,
          [
            `${operator} ${form} env`,
            'env',
            ['bash', '-O', 'extglob', '-c', command],
          ] as const,
          [`${operator} ${form} env -S`, 'env', ['-S', envSplitCommand]] as const,
        ];
      });
    }),
  )('rejects Bash wrappers even when extglob text is literal in %s', async (_caseName, executable, readonlyArgs) => {
    const node = makeNode();
    const args = [...readonlyArgs];
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.connectionServer.getConnectedNodeIds.mockReturnValue(['node-1']);
    captured.connectionServer.isNodeConnected.mockReturnValue(true);
    await startStep();

    await expect(captured.initializeOptions?.execOnNode?.({
      node: 'windows-pc', executable, args,
    })).rejects.toThrow(/shared Chrome\/session/i);
    expect(captured.sendServiceRpc).not.toHaveBeenCalled();
  });

  it.each(
    [
      ['escaped space, hidden Bash', '/bin/ba[s\\ ]h -c "printf bracket_glob_executed"'],
      ['escaped space, hidden Chrome', 'google-chr[o\\ ]me --version'],
      ['double-quoted space', '/bin/ba[s" "]h -c "printf bracket_glob_executed"'],
      ['single-quoted space', "google-chr[o' ']me --version"],
      ['single-quoted backslash', "google-chr[o'\\']me --version"],
    ].flatMap(([form, command]) => {
      const envSplitCommand = command.includes("'")
        ? `/bin/bash -c "${command}"`
        : `/bin/bash -c '${command}'`;
      return [
        [`${form} direct`, 'bash', ['-c', command]] as const,
        [`${form} absolute path`, '/usr/bin/bash', ['-c', command]] as const,
        [`${form} env`, 'env', ['bash', '-c', command]] as const,
        [`${form} env -S`, 'env', ['-S', envSplitCommand]] as const,
      ];
    }),
  )('rejects an active bracket glob with in-word whitespace in %s', async (
    _caseName,
    executable,
    readonlyArgs,
  ) => {
    const node = makeNode();
    const args = [...readonlyArgs];
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.connectionServer.getConnectedNodeIds.mockReturnValue(['node-1']);
    captured.connectionServer.isNodeConnected.mockReturnValue(true);
    await startStep();

    await expect(captured.initializeOptions?.execOnNode?.({
      node: 'windows-pc', executable, args,
    })).rejects.toThrow(/shared Chrome\/session/i);
    expect(captured.sendServiceRpc).not.toHaveBeenCalled();
  });

  it.each(
    [
      ['single quoted', "echo '[chr ]'"],
      ['double quoted', 'echo "[chr ]"'],
      ['backslash escaped', 'echo \\[chr\\ \\]'],
    ].flatMap(([form, command]) => {
      const envSplitCommand = command.includes("'")
        ? `/bin/bash -c "${command}"`
        : `/bin/bash -c '${command}'`;
      return [
        [`${form} direct`, 'bash', ['-c', command]] as const,
        [`${form} absolute path`, '/usr/bin/bash', ['-c', command]] as const,
        [`${form} env`, 'env', ['bash', '-c', command]] as const,
        [`${form} env -S`, 'env', ['-S', envSplitCommand]] as const,
      ];
    }),
  )('rejects Bash wrappers even when bracket text is literal in %s', async (_caseName, executable, readonlyArgs) => {
    const node = makeNode();
    const args = [...readonlyArgs];
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.connectionServer.getConnectedNodeIds.mockReturnValue(['node-1']);
    captured.connectionServer.isNodeConnected.mockReturnValue(true);
    await startStep();

    await expect(captured.initializeOptions?.execOnNode?.({
      node: 'windows-pc', executable, args,
    })).rejects.toThrow(/shared Chrome\/session/i);
    expect(captured.sendServiceRpc).not.toHaveBeenCalled();
  });

  it.each(
    [
      ['parameter expansion', '${AIO_TEST_SHELL} -c ${AIO_TEST_COMMAND}'],
      ['command substitution', '$(printf bash) -c "printf fixture"'],
      ['backtick substitution', '`printf bash` -c "printf fixture"'],
      ['process substitution', '<(printf bash) -c "printf fixture"'],
      ['ANSI-C quoting', "$'bash' -c 'printf fixture'"],
      ['brace expansion', 'ba{sh,zsh} -c "printf fixture"'],
      ['star glob', 'ba* -c "printf fixture"'],
      ['question glob', 'ba? -c "printf fixture"'],
      ['bracket glob', 'ba[s\\ ]h -c "printf fixture"'],
      ['extended glob', '@(bash|zsh) -c "printf fixture"'],
    ].flatMap(([syntax, splitString]) => [
      [`${syntax} through -S`, 'env', ['-S', splitString]] as const,
      [
        `${syntax} through --split-string=`,
        '/usr/bin/env',
        [`--split-string=${splitString}`],
      ] as const,
    ]),
  )('rejects active syntax anywhere in an env split string: %s', async (
    _caseName,
    executable,
    readonlyArgs,
  ) => {
    const node = makeNode();
    const args = [...readonlyArgs];
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.connectionServer.getConnectedNodeIds.mockReturnValue(['node-1']);
    captured.connectionServer.isNodeConnected.mockReturnValue(true);
    await startStep();

    await expect(captured.initializeOptions?.execOnNode?.({
      node: 'windows-pc', executable, args,
    })).rejects.toThrow(/shared Chrome\/session/i);
    expect(captured.sendServiceRpc).not.toHaveBeenCalled();
  });

  it.each(
    [
      ['quoted parameter', "/bin/echo '${AIO_TEST_SHELL}'"],
      ['escaped parameter', '/bin/echo \\${AIO_TEST_SHELL}'],
      ['quoted command substitution', "/bin/echo '$(printf bash)'"],
      ['escaped command substitution', '/bin/echo \\$\\(printf\\ bash\\)'],
      ['quoted process substitution', "/bin/echo '<(fixture)'"],
      ['escaped process substitution', '/bin/echo \\<\\(fixture\\)'],
      ['escaped ANSI-C text', "/bin/echo \\$\\'bash\\'"],
      ['quoted brace', "/bin/echo 'ba{sh,zsh}'"],
      ['escaped brace', '/bin/echo ba\\{sh,zsh\\}'],
      ['quoted glob', "/bin/echo 'ba*'"],
      ['escaped glob', '/bin/echo ba\\*'],
      ['quoted bracket', "/bin/echo 'ba[s ]h'"],
      ['escaped bracket', '/bin/echo ba\\[s\\ \\]h'],
      ['quoted extended glob', "/bin/echo '@(bash|zsh)'"],
      ['escaped extended glob', '/bin/echo \\@\\(bash\\|zsh\\)'],
    ].flatMap(([syntax, splitString]) => [
      [`${syntax} through -S`, 'env', ['-S', splitString]] as const,
      [
        `${syntax} through --split-string=`,
        '/usr/bin/env',
        [`--split-string=${splitString}`],
      ] as const,
    ]),
  )('rejects env split strings even when active syntax is quoted: %s', async (
    _caseName,
    executable,
    readonlyArgs,
  ) => {
    const node = makeNode();
    const args = [...readonlyArgs];
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.connectionServer.getConnectedNodeIds.mockReturnValue(['node-1']);
    captured.connectionServer.isNodeConnected.mockReturnValue(true);
    await startStep();

    await expect(captured.initializeOptions?.execOnNode?.({
      node: 'windows-pc', executable, args,
    })).rejects.toThrow(/shared Chrome\/session/i);
    expect(captured.sendServiceRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['powershell.exe', ['-File', 'C:\\repair-chrome.ps1']],
    ['powershell.exe', ['-File', 'C:\\repair-google-chrome.ps1']],
  ])('allows an opaque uploaded worker script through actual %s File mode', async (
    executable,
    args,
  ) => {
    const node = makeNode();
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.connectionServer.getConnectedNodeIds.mockReturnValue(['node-1']);
    captured.connectionServer.isNodeConnected.mockReturnValue(true);
    captured.sendServiceRpc.mockResolvedValue({
      exitCode: 0, stdout: '', stderr: '', stdoutTruncated: false,
      stderrTruncated: false, durationMs: 1,
    });
    await startStep();

    await expect(captured.initializeOptions?.execOnNode?.({
      node: 'windows-pc', executable, args,
    })).resolves.toMatchObject({ exitCode: 0 });
    expect(captured.sendServiceRpc).toHaveBeenCalledWith(
      'node-1', COORDINATOR_TO_NODE.NODE_EXEC,
      expect.objectContaining({ args, timeoutMs: 30_000 }), 35_000,
    );
  });

  it.each([
    ['sh', ['-c', 'printf fixture\\ value']],
    ['env', ['bash', '-c', 'printf fixture\\ value']],
    ['sh', ['-c', 'fixture_fn() { printf "%s\\n" fixture; }; fixture_fn']],
    ['env', ['bash', '-c', 'fixture_fn() { printf "%s\\n" "fixture value"; }; fixture_fn']],
    ['/bin/sh', ['-c', 'fixture_fn() { printf "%s\\n" fixture; }; fixture_fn']],
    ['/usr/bin/bash', ['-c', 'fixture_fn() { printf "%s\\n" fixture; }; fixture_fn']],
    ['env', ['-S', '/bin/bash -c "fixture_fn() { printf fixture; }; fixture_fn"']],
    ['/usr/bin/sh', ['-x', '-c', 'printf fixture']],
    ['/bin/bash', ['-O', 'extglob', '-c', 'printf fixture']],
    ['env', ['-S', '/bin/bash --noprofile -c "printf fixture"']],
    ['env', ['-S', '/bin/bash -O extglob -c "printf fixture"']],
    ['/bin/bash', ['-Cx', 'chr\\ome-fixture.sh']],
    ['/bin/bash', ['-nC', 'chr\\ome-fixture.sh']],
    ['env', ['bash', '-Cx', 'chr\\ome-fixture.sh']],
    ['/bin/sh', ['-Cx', 'chr\\ome-fixture.sh']],
    ['env', ['sh', '-nC', 'chr\\ome-fixture.sh']],
    ['bash', ['--', 'fixture.sh']],
    ['bash', ['-x', '--', '-c', 'fixture.sh']],
    ['env', ['-S', '/bin/bash -x -- -c fixture.sh']],
    ['bash', ['-c', 'printf "%s" \'$AIO_LITERAL\'']],
    ['bash', ['-c', 'printf "%s" \\$AIO_LITERAL']],
    ['bash', ['-c', 'printf "%s" \'`fixture`\'']],
    ['bash', ['-c', 'printf "%s" \\`fixture\\`']],
    ['bash', ['-c', 'printf "%s" \'<(fixture)\'']],
    ['bash', ['-c', 'printf "%s" \\<\\(fixture\\)']],
    ['bash', ['-c', 'printf "%s" \'ch{r,rr}ome\'']],
    ['bash', ['-c', 'printf "%s" ch\\{r,rr\\}ome']],
    ['bash', ['-c', 'printf fixture # $HOME']],
    ['/usr/bin/bash', ['-c', 'printf fixture # $HOME']],
    ['env', ['bash', '-c', 'printf fixture # $HOME']],
    ['env', ['-S', '/bin/bash -c "printf fixture # $HOME"']],
    ['fish', ['-C', 'printf fixture']],
    ['/usr/bin/fish', ['--init-command=printf fixture']],
    ['env', ['fish', '--init-command', 'printf fixture']],
    ['env', ['-S', '/usr/bin/fish -C "printf fixture"']],
  ])('rejects POSIX shell positional and command argv through %s', async (executable, args) => {
    const node = makeNode();
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.connectionServer.getConnectedNodeIds.mockReturnValue(['node-1']);
    captured.connectionServer.isNodeConnected.mockReturnValue(true);
    await startStep();

    await expect(captured.initializeOptions?.execOnNode?.({
      node: 'windows-pc', executable, args,
    })).rejects.toThrow(/shared Chrome\/session/i);
    expect(captured.sendServiceRpc).not.toHaveBeenCalled();
  });

  it('surfaces Android capabilities from list_remote_nodes', async () => {
    const node = makeNode({ hasAndroidMcp: true });
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep();

    const result = await captured.initializeOptions?.listRemoteNodes?.();

    expect(result).toMatchObject({
      connectedCount: 1,
      totalCount: 1,
      nodes: [
        expect.objectContaining({
          id: 'node-1',
          name: 'windows-pc',
          hasAndroidMcp: true,
          androidAutomation: expect.objectContaining({
            enabled: true,
            avds: ['Pixel_8'],
          }),
        }),
      ],
    });
  });

  it('surfaces worker and extension rollout evidence from list_remote_nodes', async () => {
    const node = makeNode({
      hasBrowserMcp: true,
      workerAgent: {
        version: '0.1.0',
        startedAt: 1_700_000_000_000,
      },
      extensionRelay: {
        enabled: true,
        running: true,
        extensionVersion: '0.2.1',
        extensionReloadedAt: 1_700_000_010_000,
        lastExtensionContactAt: 1_700_000_020_000,
      },
    });
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep();

    const result = await captured.initializeOptions?.listRemoteNodes?.();

    expect(result).toMatchObject({
      nodes: [
        expect.objectContaining({
          id: 'node-1',
          hasBrowserMcp: true,
          workerAgent: {
            version: '0.1.0',
            startedAt: 1_700_000_000_000,
          },
          hasExtensionRelay: true,
          extensionRelay: expect.objectContaining({
            enabled: true,
            running: true,
            extensionVersion: '0.2.1',
            extensionReloadedAt: 1_700_000_010_000,
            lastExtensionContactAt: 1_700_000_020_000,
          }),
        }),
      ],
    });
  });

  it('does not infer platform from fallback capabilities in list_remote_nodes', async () => {
    captured.roster.list.mockReturnValue([
      {
        id: 'node-unknown',
        name: 'paired-worker',
        status: 'disconnected',
        connected: false,
        address: '',
        supportedClis: [],
        hasBrowserRuntime: false,
        hasBrowserMcp: false,
        hasAndroidMcp: false,
        hasDocker: false,
        activeInstances: 0,
        maxConcurrentInstances: 0,
        workingDirectories: [],
        capabilities: {
          platform: 'linux',
          arch: '',
          supportedClis: [],
          hasBrowserRuntime: false,
          hasBrowserMcp: false,
          hasAndroidMcp: false,
          hasDocker: false,
          maxConcurrentInstances: 0,
          workingDirectories: [],
        },
      },
    ]);
    await startStep();

    const result = await captured.initializeOptions?.listRemoteNodes?.();

    expect(result).toMatchObject({
      nodes: [
        expect.objectContaining({
          id: 'node-unknown',
          platform: 'unknown',
        }),
      ],
    });
  });

  it('passes Android placement through run_on_node spawns', async () => {
    const node = makeNode({ hasAndroidMcp: true });
    const createInstance = vi.fn(async (config: Record<string, unknown>) => ({
      id: 'inst-1',
      status: 'initializing',
      ...config,
    }));
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc',
      prompt: 'run the Android smoke test',
      requiresAndroid: true,
      androidDeviceKind: 'emulator',
    });

    expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({
      forceNodeId: 'node-1',
      nodePlacement: {
        requiresAndroid: true,
        androidDeviceKind: 'emulator',
      },
    }));
  });

  it('injects only canonical enabled instance evidence ownership into MCP', async () => {
    await startStep({
      getInstance: vi.fn((id: string) => id === 'enabled'
        ? {
            contextEvidence: { mode: 'shadow', conversationId: 'ledger-1' },
            contextUsage: { used: 50_000, total: 200_000, percentage: 25 },
          }
        : id === 'off'
          ? { contextEvidence: { mode: 'off', conversationId: 'ledger-2' } }
          : undefined),
    });

    expect(captured.initializeOptions?.resolveContextEvidence?.('enabled')).toEqual({
      coordinator: { id: 'coordinator' },
      conversationId: 'ledger-1',
      mode: 'shadow',
      providerWindowTokens: 200_000,
    });
    expect(captured.initializeOptions?.resolveContextEvidence?.('off')).toBeNull();
    expect(captured.initializeOptions?.resolveContextEvidence?.('missing')).toBeNull();
  });

  it('infers Android placement from an Android run_on_node prompt', async () => {
    const node = makeNode({ hasAndroidMcp: true });
    const createInstance = vi.fn(async (config: Record<string, unknown>) => ({
      id: 'inst-1',
      status: 'initializing',
      ...config,
    }));
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc',
      prompt: 'install the APK and test it on the emulator',
    });

    expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({
      nodePlacement: {
        requiresAndroid: true,
        androidDeviceKind: 'any',
      },
    }));
  });

  it('rejects run_on_node when the explicit provider is not installed on the node', async () => {
    const node = makeNode({ supportedClis: ['antigravity', 'copilot', 'cursor'] });
    const createInstance = vi.fn();
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await expect(
      captured.initializeOptions!.spawnRemoteInstance!({
        node: 'windows-pc',
        prompt: 'say hi',
        provider: 'claude',
      } as never),
    ).rejects.toThrow(
      /provider "claude" is not installed on worker node "windows-pc".*antigravity, copilot, cursor/,
    );
    expect(createInstance).not.toHaveBeenCalled();
  });

  it('chooses an authenticated worker provider without coordinator-local CLI detection', async () => {
    const node = makeNode({ supportedClis: ['codex', 'cursor'] });
    const createInstance = vi.fn(async (config: Record<string, unknown>) => ({
      id: 'inst-1', status: 'initializing', ...config,
    }));
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.settings['defaultCli'] = 'cursor';
    await startStep({ createInstance });

    await captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc',
      prompt: 'say hi',
    });

    expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({ provider: 'cursor' }));
    expect(captured.sendServiceRpc).toHaveBeenCalledWith(
      'node-1',
      COORDINATOR_TO_NODE.PROVIDER_DIAGNOSE,
      { provider: 'cursor' },
      45_000,
    );
  });

  it('spawns when the explicit provider is installed on the node (case-insensitive)', async () => {
    const node = makeNode({ supportedClis: ['Cursor'] });
    const createInstance = vi.fn(async (config: Record<string, unknown>) => ({
      id: 'inst-1',
      status: 'initializing',
      ...config,
    }));
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc',
      prompt: 'say hi',
      provider: 'cursor',
    } as never);

    expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'cursor',
      forceNodeId: 'node-1',
    }));
  });

  it('refuses an installed but signed-out Cursor before instance creation', async () => {
    const node = makeNode({ supportedClis: ['cursor'] });
    const createInstance = vi.fn();
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.sendServiceRpc.mockResolvedValue({
      ok: true,
      provider: { provider: 'cursor', available: true, authenticated: false },
    });
    await startStep({ createInstance });

    await expect(captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc', prompt: 'say hi', provider: 'cursor',
    } as never)).rejects.toThrow(/cli_not_signed_in.*cursor/i);

    expect(createInstance).not.toHaveBeenCalled();
  });

  it('fails closed when worker authentication is unknown', async () => {
    const node = makeNode({ supportedClis: ['claude'] });
    const createInstance = vi.fn();
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.sendServiceRpc.mockResolvedValue({
      ok: true,
      provider: { provider: 'claude', available: true, authenticated: null },
    });
    await startStep({ createInstance });

    await expect(captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc', prompt: 'say hi', provider: 'claude',
    } as never)).rejects.toThrow(/cli_not_signed_in/i);
    expect(createInstance).not.toHaveBeenCalled();
  });

  it.each([null, 7])('treats malformed explicit provider diagnostics as unproven: %j', async (provider) => {
    const node = makeNode({ supportedClis: ['cursor'] });
    const createInstance = vi.fn();
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.sendServiceRpc.mockResolvedValue({
      ok: true,
      provider: { provider, available: true, authenticated: true },
    });
    await startStep({ createInstance });

    await expect(captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc', prompt: 'say hi', provider: 'cursor',
    } as never)).rejects.toThrow(/cli_not_signed_in/i);
    expect(createInstance).not.toHaveBeenCalled();
  });

  it('continues omitted-provider selection after a malformed diagnostic', async () => {
    const node = makeNode({ supportedClis: ['claude', 'cursor'] });
    const createInstance = vi.fn(async (config: Record<string, unknown>) => ({
      id: 'inst-1', status: 'initializing', ...config,
    }));
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.settings['defaultCli'] = 'claude';
    captured.sendServiceRpc.mockImplementation(async (
      _nodeId: string, method: string, params: { provider?: string },
    ) => method === COORDINATOR_TO_NODE.PROVIDER_DIAGNOSE && params.provider === 'claude'
      ? { ok: true, provider: { provider: 7, available: true, authenticated: true } }
      : {
          ok: true,
          provider: { provider: 'cursor', available: true, authenticated: true },
        });
    await startStep({ createInstance });

    await captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc', prompt: 'say hi',
    });

    expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({ provider: 'cursor' }));
  });

  it('continues omitted-provider selection after a diagnostic RPC timeout', async () => {
    const node = makeNode({ supportedClis: ['claude', 'cursor'] });
    const createInstance = vi.fn(async (config: Record<string, unknown>) => ({
      id: 'inst-1', status: 'initializing', ...config,
    }));
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.settings['defaultCli'] = 'claude';
    captured.sendServiceRpc.mockImplementation(async (
      _nodeId: string, method: string, params: { provider?: string },
    ) => {
      if (method !== COORDINATOR_TO_NODE.PROVIDER_DIAGNOSE) return { ok: true };
      if (params.provider === 'claude') throw new Error('provider diagnostic RPC timeout');
      return {
        ok: true,
        provider: { provider: 'cursor', available: true, authenticated: true },
      };
    });
    await startStep({ createInstance });

    await captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc', prompt: 'say hi',
    });

    expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({ provider: 'cursor' }));
  });

  it('fails closed with cli_not_signed_in when an explicit diagnostic RPC times out', async () => {
    const node = makeNode({ supportedClis: ['cursor'] });
    const createInstance = vi.fn();
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.sendServiceRpc.mockRejectedValue(new Error('provider diagnostic RPC timeout'));
    await startStep({ createInstance });

    await expect(captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc', prompt: 'say hi', provider: 'cursor',
    } as never)).rejects.toThrow(/cli_not_signed_in/i);
    expect(createInstance).not.toHaveBeenCalled();
  });

  it('falls through worker candidates until authentication is proven', async () => {
    const node = makeNode({ supportedClis: ['claude', 'cursor'] });
    const createInstance = vi.fn(async (config: Record<string, unknown>) => ({
      id: 'inst-1', status: 'initializing', ...config,
    }));
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.settings['defaultCli'] = 'claude';
    captured.sendServiceRpc.mockImplementation(async (
      _nodeId: string, method: string, params: { provider?: string },
    ) => method === COORDINATOR_TO_NODE.PROVIDER_DIAGNOSE
      ? { ok: true, provider: {
          provider: params.provider,
          available: true,
          authenticated: params.provider === 'cursor',
        } }
      : { ok: true });
    await startStep({ createInstance });

    await captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc', prompt: 'say hi',
    });

    expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({ provider: 'cursor' }));
    expect(captured.sendServiceRpc.mock.calls.map((call) => call[2])).toEqual([
      { provider: 'claude' },
      { provider: 'cursor' },
    ]);
  });

  it('rejects shared Browser Gateway tab work before spawning on a remote node', async () => {
    const node = makeNode({ hasBrowserMcp: true });
    const createInstance = vi.fn();
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await expect(
      captured.initializeOptions!.spawnRemoteInstance!({
        node: 'windows-pc',
        prompt: 'Use Browser Gateway on windows-pc to fill the credential in the existing logged-in Chrome tab.',
        requiresBrowser: true,
      }),
    ).rejects.toThrow(/Browser Gateway.*stay on the coordinator.*windows-pc/i);
    expect(createInstance).not.toHaveBeenCalled();
  });

  it.each([
    'Do not use Browser Gateway. Repair the native host relay service only and leave every Chrome tab untouched.',
    'Restart the native host, do not touch tabs.',
    'Repair the native host without touching tabs.',
    'Restart the Browser Gateway native host; do not touch tabs.',
    'Restart the Browser Gateway native host without touching tabs.',
    'Restart the Browser Gateway native host; do not touch tabs; then verify the relay process.',
    'Restart the Browser Gateway native host without touching tabs. Then verify the relay process.',
    'Restart the native host. Do not use Browser Gateway.',
    'Restart the native host without Browser Gateway.',
    'Restart the native host. Do not use Browser Gateway; then verify the relay process.',
    'Restart the native host without Browser Gateway. Then verify the relay process.',
    'Recover the native host without Browser Gateway.',
    'Restart the existing native host relay without Browser Gateway.',
    'Restart the native host. Do not use Browser Gateway for this repair.',
    'Restart the native host. Do not use Browser Gateway, only repair the relay process.',
    'Restart the native host and inspect the relay logs.',
    'Restart the native host and read its status file.',
    'Restart the native host without Browser Gateway; list relay processes and inspect their logs.',
    'Restart the native host without Browser Gateway; inspect the relay logs and summarize them.',
    'Restart the native host and inspect the relay logs; leave Chrome untouched.',
    'Restart the native host and read its status file; leave Chrome untouched.',
    'Restart the Browser Gateway native-host without touching tabs.',
    'Restart the native host; check status.',
    'Restart the native host; rotate logs.',
    'Restart the native host; inspect process.',
    'Restart the native host. Inspect its process.',
  ])('allows process-only browser relay recovery wording: %s', async (prompt) => {
    const node = makeNode();
    const createInstance = vi.fn(async (config: Record<string, unknown>) => ({
      id: 'inst-1',
      status: 'initializing',
      ...config,
    }));
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc',
      prompt,
      provider: 'claude',
    } as never);

    expect(createInstance).toHaveBeenCalledOnce();
  });

  it.each([
    'Restart the native host without Browser Gateway during this repair.',
    'Restart the native host. Do not use Browser Gateway while repairing the relay.',
    'Restart the native host without touching tabs during recovery.',
    'Restart the native host. Do not touch tabs while repairing the relay process.',
    'Restart the native host and list relay processes.',
    'Restart the native host and extract the relay logs.',
    'Restart the native host and focus on relay health.',
  ])('allows recovery after removing only complete benign negated prefixes: %s', async (prompt) => {
    const node = makeNode();
    const createInstance = vi.fn(async (config: Record<string, unknown>) => ({
      id: 'inst-1', status: 'initializing', ...config,
    }));
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc', prompt, provider: 'claude',
    } as never);
    expect(createInstance).toHaveBeenCalledOnce();
  });

  it.each([
    'Restart the native host without Browser Gateway; then use it.',
    'Restart the native host without Browser Gateway; then inspect it.',
    'Restart the native host without Browser Gateway; then read it.',
    'Restart the native host without Browser Gateway; then screenshot it.',
    'Restart the native host without Browser Gateway; then fill it.',
    'Restart the native host without Browser Gateway; then list it.',
    'Restart the native host without Browser Gateway; then extract from it.',
    'Restart the native host without Browser Gateway; then focus it.',
    'Restart the native host without Browser Gateway; then switch to it.',
    'Restart the native host without Browser Gateway; browser.cookies is required.',
    'Restart the native host without Browser Gateway; shared tabs are in scope.',
    'Restart the native host in extension-shared mode.',
    'Restart the native host without Browser Gateway; then interact with it.',
    'Restart the native host, then interact with Browser Gateway.',
    'Restart the native host; Browser Gateway is required for the rest of the task.',
    'Restart the native host without Browser Gateway; collect its cookies.',
    'Restart the native host without touching tabs; collect cookies from these.',
    'Restart the native host; collect cookies from Chrome.',
    'Restart the native host; capture the page.',
    'Restart the native host; session cookies are required.',
    'Restart the native host without touching tabs; verify the relay and collect cookies from these.',
    'Restart the native host; leave Chrome untouched and export its cookies while keeping the relay untouched.',
    'Restart the native host; leave tabs untouched and inspect the shared Chrome session while leaving existing files untouched.',
    'Restart the native host; leave Chrome untouched and use Browser Gateway while leaving the logs untouched.',
    'Restart the Browser Gateway native host, then click Save.',
    'Restart the Browser Gateway native host; submit the form.',
    'Restart the Browser Gateway native host and press Enter.',
    'Restart the Browser Gateway native messaging host, then fill the form.',
    'Restart the native host without touching tabs unless necessary.',
    'Restart the native host without Browser Gateway except when needed.',
    'Restart the native host without Browser Gateway until later.',
    'Restart the native host. Do not touch tabs except when required.',
    'Restart the native host without Browser Gateway as necessary.',
    'Restart the native host without Browser Gateway where necessary.',
    'Restart the Browser Gateway native host, then interact with it.',
    'Restart the Browser Gateway native host and operate it afterward.',
    'Restart the native host without Browser Gateway; then interact with that.',
    'Restart the native host without touching tabs; then operate the latter.',
    'Restart the native host; leave Chrome untouched; then interact with that.',
    'Restart the native host. Do not use Browser Gateway; if necessary interact with that.',
    'Restart the native host without Browser Gateway; then check its status.',
    'Restart the native host without Browser Gateway; then rotate its logs.',
    'Restart the native host without Browser Gateway; then inspect its process.',
    'Restart the native host without touching tabs. Then inspect their status.',
    'Restart the native host; leave Chrome untouched. Then check its process.',
    'Restart the native host without Browser Gateway. Then read its files.',
  ])('rejects recovery when unsafe browser evidence remains after benign prefixes: %s', async (prompt) => {
    const node = makeNode({ hasBrowserMcp: true });
    const createInstance = vi.fn();
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await expect(captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc', prompt, requiresBrowser: true,
    })).rejects.toThrow(/stay on the coordinator/i);
    expect(createInstance).not.toHaveBeenCalled();
  });

  it.each([
    'Restart the native host; leave every Chrome tab untouched and collect cookies while keeping logs untouched.',
    'Restart the native host; leave Microsoft Edge untouched but inspect the browser while leaving relay status untouched.',
    'Restart the native host; leave the shared Chrome tabs untouched and use Browser Gateway while keeping the process untouched.',
    'Restart the native host and leave Chrome untouched, except to click Save.',
    'Restart the native host and leave Chrome untouched unless you need to click Save.',
    'Restart the native host; leave Chrome untouched until you click Save.',
    'Restart the native host; leave Chrome untouched after clicking Save.',
    'Restart the native host and click Save, then leave Chrome untouched.',
    'Restart the native host without Browser Gateway except to click Save.',
    'Restart the native host without touching tabs until you click Save.',
    'Restart the native host and do not use Browser Gateway unless you need to click Save.',
  ])('does not let an untouched-browser mask consume later affirmative clauses: %s', async (prompt) => {
    const node = makeNode({ hasBrowserMcp: true });
    const createInstance = vi.fn();
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await expect(captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc', prompt, requiresBrowser: true,
    })).rejects.toThrow(/stay on the coordinator/i);
    expect(createInstance).not.toHaveBeenCalled();
  });

  it.each([
    'Restart the native host; do not leave the shared Chrome tabs untouched.',
    'Restart the native host and never leave Chrome untouched.',
    'Restart the native host; please don\'t leave the browser untouched.',
    'Restart the native host but do not ever leave all tabs untouched.',
    'Restart the native host and must not leave Microsoft Edge untouched.',
    'Restart the native host; cannot leave the Chrome session untouched.',
    'Restart the native host; do not, under any circumstances, leave Chrome untouched.',
    'Restart the native host and neither leave Chrome untouched nor stop the relay.',
  ])('does not mask negated or inverted leave-browser-untouched wording: %s', async (prompt) => {
    const node = makeNode({ hasBrowserMcp: true });
    const createInstance = vi.fn();
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await expect(captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc', prompt, requiresBrowser: true,
    })).rejects.toThrow(/stay on the coordinator/i);
    expect(createInstance).not.toHaveBeenCalled();
  });

  it.each([
    'Restart the native host and leave Chrome untouched.',
    'Restart the native host; leave tabs untouched.',
    'Leave Chrome untouched and restart the native host relay.',
    'Restart the native host; leave Chrome untouched. Leave tabs untouched.',
    'Restart the native host; leave the browser untouched; leave Microsoft Edge untouched.',
    'Restart the native host and inspect relay logs; leave Chrome untouched. Leave every tab untouched.',
  ])('masks untouched-browser wording only at an affirmative clause boundary: %s', async (prompt) => {
    const node = makeNode();
    const createInstance = vi.fn(async (config: Record<string, unknown>) => ({
      id: 'inst-1', status: 'initializing', ...config,
    }));
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc', prompt, provider: 'claude',
    } as never);
    expect(createInstance).toHaveBeenCalledOnce();
  });

  it.each([
    'Repair the native host in extension shared mode.',
    'Recover the extension relay for extension-shared operation.',
    'Restart the native host without Browser Gateway; then audit it.',
    'Restart the native host. Do not use Browser Gateway, then validate them.',
    'Restart the native host without Browser Gateway; then collect their cookies.',
    'Restart the native host. Do not use Browser Gateway; reconnect those afterward.',
  ])('rejects extension-shared and Browser Gateway pronoun recovery continuations: %s', async (prompt) => {
    const node = makeNode({ hasBrowserMcp: true });
    const createInstance = vi.fn();
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await expect(captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc', prompt, requiresBrowser: true,
    })).rejects.toThrow(/stay on the coordinator/i);
    expect(createInstance).not.toHaveBeenCalled();
  });

  it.each([
    'Restart the native host without Browser Gateway; inspect relay logs and archive them.',
    'Restart the native host without Browser Gateway; inspect the status file and summarize it.',
    'Restart the native host without touching tabs; check the relay process and report its status.',
    'Restart the native host without touching tabs; inspect native-host logs and archive those.',
  ])('allows post-mask coreference to an explicit relay/process/log/file antecedent: %s', async (prompt) => {
    const node = makeNode();
    const createInstance = vi.fn(async (config: Record<string, unknown>) => ({
      id: 'inst-1', status: 'initializing', ...config,
    }));
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc', prompt, provider: 'claude',
    } as never);
    expect(createInstance).toHaveBeenCalledOnce();
  });

  it.each([
    'Restart the native host and inspect relay logs; leave the browser untouched.',
    'Restart the native host and read the status file; leave all tabs untouched.',
    'Restart the native host and check the relay process; leave Microsoft Edge untouched.',
    'Restart the native host and inspect native-host logs; leave the shared Chrome tabs untouched.',
  ])('allows relay-only recovery with a complete untouched browser-surface clause: %s', async (prompt) => {
    const node = makeNode();
    const createInstance = vi.fn(async (config: Record<string, unknown>) => ({
      id: 'inst-1', status: 'initializing', ...config,
    }));
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc', prompt, provider: 'claude',
    } as never);
    expect(createInstance).toHaveBeenCalledOnce();
  });

  it.each([
    'Restart the native host without Browser Gateway; gather its telemetry.',
    'Restart the native host without Browser Gateway; revisit these after recovery.',
    'Restart the native host without touching tabs; archive their cookies.',
    'Restart the native host without touching tabs; reconnect those afterward.',
    'Restart the native host; Browser Gateway.',
    'Restart the native host; browser access follows.',
    'Restart the native host; tab access follows.',
  ])('rejects ambiguous post-mask coreference and residual browser surfaces: %s', async (prompt) => {
    const node = makeNode({ hasBrowserMcp: true });
    const createInstance = vi.fn();
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await expect(captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc', prompt, requiresBrowser: true,
    })).rejects.toThrow(/stay on the coordinator/i);
    expect(createInstance).not.toHaveBeenCalled();
  });

  it.each([
    'Restart the native host; Chrome is required.',
    'Restart the native host; the browser is required.',
    'Restart the native host; a tab is required.',
    'Restart the native host; the session is required.',
    'Restart the native host; the window is required.',
    'Restart the native host; the profile is required.',
    'Restart the native host; the page is required.',
    'Restart the native host; the webpage is required.',
    'Restart the native host; Microsoft Edge is required.',
    'Restart the native host; cookies are required.',
    'Restart the native host; session storage is required.',
  ])('rejects every residual protected recovery surface independent of action wording: %s', async (prompt) => {
    const node = makeNode({ hasBrowserMcp: true });
    const createInstance = vi.fn();
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await expect(captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc', prompt, requiresBrowser: true,
    })).rejects.toThrow(/stay on the coordinator/i);
    expect(createInstance).not.toHaveBeenCalled();
  });

  it.each([
    'Restart the native host without touching tabs; verify the relay and reconnect these.',
    'Restart the native host without Browser Gateway; list relay processes, then reconnect them.',
    'Restart the native host; leave Chrome untouched, then inspect it.',
    'Restart the native host; leave tabs untouched and collect their cookies.',
  ])('rejects distant or browser-bound recovery coreference: %s', async (prompt) => {
    const node = makeNode({ hasBrowserMcp: true });
    const createInstance = vi.fn();
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await expect(captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc', prompt, requiresBrowser: true,
    })).rejects.toThrow(/stay on the coordinator/i);
    expect(createInstance).not.toHaveBeenCalled();
  });

  it.each([
    'Fill credentials into the two tabs that are already open on windows-pc.',
    'Use the currently open logged-in Chrome tab on windows-pc.',
    'Use browser.fill_credential on windows-pc.',
    'Use browser.* tools on windows-pc.',
    'Repair the native host relay, then inspect the Chrome tabs.',
    'Restart the native host relay; fill the existing logged-in Chrome tab.',
    'Restart the native host relay; submit the existing logged-in Chrome tab.',
    'Restart the native host relay; the existing logged-in Chrome tab, then reload it.',
    'Do not restart the host, instead click the existing logged-in Chrome tab.',
    'Restart the native host relay without restarting Chrome, then inspect the shared tabs.',
    'Restart the native host relay; use worker-managed Chrome for the test; then fill the shared Chrome tab.',
    'Do not restart Chrome then click the existing logged-in Chrome tab.',
    'Restart the native host relay without restarting Chrome then inspect the shared tabs.',
    'Use worker-managed Chrome for a public audit, then click the shared tab.',
    'Use worker-managed Chrome for setup and fill the existing Chrome tab.',
    'Inspect tabs in worker-managed Chrome and click the existing Chrome tab.',
    'Inspect tabs in worker-managed Chrome and reload the existing Chrome tab.',
    'Inspect worker-managed Chrome; reload the existing logged-in tab.',
    'Use the operator\'s existing tab in the worker-managed Chrome profile.',
    'Use the shared existing tab in the worker-managed Chrome profile.',
    'Use the real-user existing tab in the worker-managed Chrome profile.',
    'The shared Chrome tab should be submitted after checking worker-managed Chrome.',
    'Restart the native host relay without restarting Chrome and inspect the shared tabs.',
    'Do not use Browser Gateway, and click the existing Chrome tab.',
    'Restart the native host, but do not use Browser Gateway, and click the existing Chrome tab.',
    'Inspect existing Chrome tabs and tabs in worker-managed Chrome.',
    'Do not use Browser Gateway and existing Chrome tabs should be inspected.',
    'Restart the native host and scroll the logged-in Chrome tab.',
    'Observe the shared browser tab.',
    'The existing Chrome tab should be read.',
    'Take a screenshot of the logged-in Chrome tab.',
    'Refresh the operator\'s browser session.',
    'Close the real-user-session Chrome tab.',
    'Select text in the existing browser tab.',
    'Evaluate JavaScript in the shared Chrome tab.',
    'Upload a file through the logged-in browser tab.',
    'Download the report from the existing Chrome tab.',
    'Do not use Browser Gateway and the existing Chrome tabs should be inspected.',
    'Repair the native host without Browser Gateway while inspecting existing Chrome tabs.',
    'Restart the native host relay but do not inspect the shared Chrome tab.',
    'Restart the Browser Gateway native host relay; do not inspect, click, type in, navigate, or otherwise drive any shared tabs.',
    'Do not inspect those shared Chrome tabs while repairing the native host relay.',
    'Without touching tabs, repair the native host and then observe the operator browser session.',
    'Restart the native host, do not touch shared tabs.',
    'Repair the native host without touching existing Chrome tabs.',
    'Extract text from the shared tab.',
    'Focus the existing Chrome tab.',
    'Switch to the logged-in browser tab.',
    'Restart the Browser Gateway native host relay, then list the shared tabs.',
    'Do not use Browser Gateway; extract text from the shared tab.',
    'The shared tab is in scope.',
    'Those shared Chrome tabs belong to the operator.',
    'An existing Chrome tab is required.',
    'Existing browser tabs contain the session state.',
    'The logged-in Chrome tab has the session.',
    'Logged in browser tabs are the target.',
    'The operator Chrome session is the target.',
    'The operator\'s browser is ready.',
    'The real-user-session is required.',
    'The real user browser session is available.',
    'Chrome tabs from the existing session are required.',
    'Browser tabs that are logged in contain the state.',
    'Click shared browser.',
    'Click logged-in tabs.',
    'Click operator tabs.',
    'Click existing tabs.',
    'Do not use Browser Gateway; click shared browser.',
    'Restart the native host; extract from already-open tabs.',
    'Use shared Chrome.',
    'Use shared tabs.',
    'Use logged in browser.',
    'Use logged-in Chrome.',
    'Use logged in tab.',
    'Use operator browser.',
    'Use operator Chrome.',
    'Use operator tabs.',
    'Use operator session.',
    'Use existing browser.',
    'Use existing Chrome.',
    'Use existing tab.',
    'Use real-user browser.',
    'Use real user Chrome.',
    'Use real-user tabs.',
    'Use real user session.',
    'Use already-open browser.',
    'Use already open Chrome.',
    'Use already-open tabs.',
    'Use already open session.',
    'shared session',
    'existing session',
    'logged-in session',
    'operator sessions',
    'already-open sessions',
    'real-user sessions',
    'Click shared browsers.',
    'Click existing browsers.',
    'Click logged-in browsers.',
    'Click operator browsers.',
    'Click already-open browsers.',
    'Click real-user browsers.',
    'Extract cookies from signed-in Chrome.',
    'Read the authenticated browser session.',
    'Inspect the logged-on browser.',
    'Restart the native host; extract text from the logged-in page.',
    'Do not use Browser Gateway; inspect the logged-in webpage.',
    'Restart native host. Extract user-owned Chrome.',
    'Without Browser Gateway, extract user-owned tabs.',
    'Extract user\'s: Chrome.',
    'Restart the native host without touching tabs that are shared, then take a screenshot of them.',
    'Restart the native host, do not touch tabs owned by the operator; instead inspect them.',
    'Restart the native host without touching tabs that are logged in; read their titles and report their URLs.',
    'Restart the native host, do not touch tabs which are shared; then inspect them.',
    'Restart the native host without touching tabs, which are logged in; then inspect them.',
    'Restart the native host, do not touch tabs shared with the operator; then inspect them.',
    'Restart the native host. Do not use Browser Gateway until the relay is healthy; then use it.',
    'Restart the native host without Browser Gateway that is shared; then inspect it.',
    'Restart the native host without Browser Gateway; then inspect it, the shared one.',
  ])('rejects implicit shared-browser wording before spawning: %s', async (prompt) => {
    const node = makeNode({ hasBrowserMcp: true });
    const createInstance = vi.fn();
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await expect(captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc',
      prompt,
      requiresBrowser: true,
    })).rejects.toThrow(/stay on the coordinator/i);
    expect(createInstance).not.toHaveBeenCalled();
  });

  it.each(
    ['shared', 'existing', 'logged-in', 'operator', 'already-open', 'real-user']
      .flatMap((marker) => [
        'browser', 'browsers', 'Chrome', 'tab', 'tabs', 'session', 'sessions',
        'window', 'windows', 'profile', 'profiles', 'page', 'pages', 'webpage', 'webpages',
        'Edge', 'Microsoft Edge',
      ].map((noun) => [`Use the ${marker} ${noun}.`] as const)),
  )('rejects explicit shared-surface marker/noun combination: %s', async (prompt) => {
    const node = makeNode({ hasBrowserMcp: true });
    const createInstance = vi.fn();
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await expect(captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc', prompt, requiresBrowser: true,
    })).rejects.toThrow(/stay on the coordinator/i);
    expect(createInstance).not.toHaveBeenCalled();
  });

  it.each(
    ['signed-in', 'signed in', 'authenticated', 'logged-on', 'logged on']
      .flatMap((marker) => [
        'page', 'pages', 'webpage', 'webpages', 'browser', 'browsers',
        'session', 'sessions', 'Chrome', 'Edge', 'Microsoft Edge',
      ].map((noun) => [`Use the ${marker} ${noun}.`] as const)),
  )('rejects authenticated shared-surface marker/noun combination: %s', async (prompt) => {
    const node = makeNode({ hasBrowserMcp: true });
    const createInstance = vi.fn();
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await expect(captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc', prompt, requiresBrowser: true,
    })).rejects.toThrow(/stay on the coordinator/i);
    expect(createInstance).not.toHaveBeenCalled();
  });

  it.each(
    ["user's", "users'", 'personal', 'everyday', 'real']
      .flatMap((marker) => [
        'browser', 'browsers', 'Chrome', 'tab', 'tabs', 'session', 'sessions',
        'window', 'windows', 'profile', 'profiles', 'page', 'pages', 'webpage', 'webpages',
        'Edge', 'Microsoft Edge',
      ].map((noun) => [`Use the ${marker} ${noun}.`] as const)),
  )('rejects possession/session marker with a protected surface noun: %s', async (prompt) => {
    const node = makeNode({ hasBrowserMcp: true });
    const createInstance = vi.fn();
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await expect(captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc', prompt, requiresBrowser: true,
    })).rejects.toThrow(/stay on the coordinator/i);
    expect(createInstance).not.toHaveBeenCalled();
  });

  it.each((() => {
    const markers = [
      'shared', 'existing', 'logged-in', 'logged in', 'signed-in', 'signed in',
      'authenticated', 'logged-on', 'logged on', 'operator', "operator's",
      'already-open', 'already open', 'currently-open', 'currently open',
      'real-user', 'real user', "user's", "users'", 'personal', 'everyday', 'real',
      'user-owned', 'user owned', 'user‐owned', 'user‑owned', 'user‒owned',
      'user–owned', 'user—owned', 'user―owned', 'user−owned',
    ];
    const surfaces = [
      'browser', 'browsers', 'Chrome', 'tab', 'tabs', 'session', 'sessions',
      'window', 'windows', 'profile', 'profiles', 'page', 'pages', 'webpage', 'webpages',
      'Edge', 'Microsoft Edge',
    ];
    const separators = [' ', ': ', ', ', '; '];
    return markers.flatMap((marker, markerIndex) => surfaces.map((surface, surfaceIndex) => [
      `Use ${marker}${separators[(markerIndex + surfaceIndex) % separators.length]}for the test, then inspect ${surface}.`,
    ] as const));
  })())('rejects any protected marker and surface anywhere in the prompt: %s', async (prompt) => {
    const node = makeNode({ hasBrowserMcp: true });
    const createInstance = vi.fn();
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await expect(captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc', prompt, requiresBrowser: true,
    })).rejects.toThrow(/stay on the coordinator/i);
    expect(createInstance).not.toHaveBeenCalled();
  });

  it.each([
    'Inspect the existing file.',
    'Read the shared cache.',
    'Check the logged-in credential record.',
    'Review the operator notes.',
    'Use the already-open file.',
    'Inspect the real-user fixture.',
    'Inspect the user\'s file.',
    'Read the users\' notes.',
    'Use personal data.',
    'Review everyday tasks.',
    'Check the real fixture.',
    'Inspect the user-owned file.',
    'Inspect the user owned file.',
    'Inspect the user—owned file.',
  ])('allows a shared-session marker without a protected surface noun: %s', async (prompt) => {
    const node = makeNode({ hasBrowserMcp: true });
    const createInstance = vi.fn(async (config: Record<string, unknown>) => ({
      id: 'inst-1', status: 'initializing', ...config,
    }));
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc', prompt, requiresBrowser: true,
    });
    expect(createInstance).toHaveBeenCalledOnce();
  });

  it.each([
    'Use browser automation.',
    'Open browsers for testing.',
    'Inspect Chrome.',
    'Inspect a tab.',
    'Inspect tabs.',
    'Create a session.',
    'Create sessions.',
    'Open a window.',
    'Open windows.',
    'Create a profile.',
    'Create profiles.',
    'Inspect a page.',
    'Inspect pages.',
    'Inspect a webpage.',
    'Inspect webpages.',
    'Inspect Edge.',
    'Inspect Microsoft Edge.',
  ])('allows a protected surface noun without a shared-session marker: %s', async (prompt) => {
    const node = makeNode({ hasBrowserMcp: true });
    const createInstance = vi.fn(async (config: Record<string, unknown>) => ({
      id: 'inst-1', status: 'initializing', ...config,
    }));
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc', prompt, requiresBrowser: true,
    });
    expect(createInstance).toHaveBeenCalledOnce();
  });

  it('still allows worker-managed Chrome work through run_on_node', async () => {
    const node = makeNode({ hasBrowserMcp: true });
    const createInstance = vi.fn(async (config: Record<string, unknown>) => ({
      id: 'inst-1',
      status: 'initializing',
      ...config,
    }));
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc',
      prompt: 'Audit the public site in the worker-managed Chrome profile.',
      requiresBrowser: true,
    });

    expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({
      forceNodeId: 'node-1',
      nodePlacement: { requiresBrowser: true },
    }));
  });

  it('allows tab work that is exclusively scoped to the worker-managed Chrome profile', async () => {
    const node = makeNode({ hasBrowserMcp: true });
    const createInstance = vi.fn(async (config: Record<string, unknown>) => ({
      id: 'inst-1', status: 'initializing', ...config,
    }));
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc',
      prompt: 'Use the existing tab in the worker-managed Chrome profile.',
      requiresBrowser: true,
    });

    expect(createInstance).toHaveBeenCalledOnce();
  });

  it('waits for remote provider readiness before reporting a successful spawn', async () => {
    const node = makeNode({ supportedClis: ['copilot'] });
    let releaseReady: (() => void) | undefined;
    const readyPromise = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const createInstance = vi.fn(async () => ({
      id: 'inst-1',
      status: 'initializing',
      readyPromise,
    }));
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    let settled = false;
    const spawn = captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc',
      prompt: 'say hi',
      provider: 'copilot',
    } as never).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseReady?.();
    await expect(spawn).resolves.toMatchObject({ instanceId: 'inst-1' });
  });

  it('propagates a worker provider-startup failure instead of returning a vanishing instance', async () => {
    const node = makeNode({ supportedClis: ['copilot'] });
    const createInstance = vi.fn(async () => ({
      id: 'inst-1',
      status: 'initializing',
      readyPromise: Promise.reject(new Error(
        'GitHub Copilot account "legacy" cannot run on this node: it is not signed in on this node.',
      )),
    }));
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await expect(
      captured.initializeOptions!.spawnRemoteInstance!({
        node: 'windows-pc',
        prompt: 'say hi',
        provider: 'copilot',
      } as never),
    ).rejects.toThrow(/Copilot account "legacy".*not signed in on this node/i);
  });

  it('rejects legacy nodes that do not advertise supported CLIs', async () => {
    const node = makeNode({ supportedClis: [] });
    const createInstance = vi.fn(async (config: Record<string, unknown>) => ({
      id: 'inst-1',
      status: 'initializing',
      ...config,
    }));
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await expect(captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc', prompt: 'say hi', provider: 'claude',
    } as never)).rejects.toThrow(/does not advertise any supported CLIs/i);

    expect(createInstance).not.toHaveBeenCalled();
    expect(captured.sendServiceRpc).not.toHaveBeenCalled();
  });

  it('rejects Android run_on_node spawns on nodes without Android readiness', async () => {
    const node = makeNode({ hasAndroidMcp: false });
    const createInstance = vi.fn();
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await expect(
      captured.initializeOptions!.spawnRemoteInstance!({
        node: 'windows-pc',
        prompt: 'run the Android smoke test',
        requiresAndroid: true,
      }),
    ).rejects.toThrow(/not Android-automation ready/i);
    expect(createInstance).not.toHaveBeenCalled();
  });
});

function makeNode(overrides: {
  hasAndroidMcp?: boolean;
  hasBrowserMcp?: boolean;
  supportedClis?: string[];
  workerAgent?: { version: string; startedAt: number };
  extensionRelay?: {
    enabled: boolean;
    running: boolean;
    extensionVersion?: string;
    extensionReloadedAt?: number;
    lastExtensionContactAt?: number;
  };
} = {}) {
  const hasAndroidMcp = overrides.hasAndroidMcp ?? false;
  const hasBrowserMcp = overrides.hasBrowserMcp ?? false;
  return {
    id: 'node-1',
    name: 'windows-pc',
    status: 'connected',
    activeInstances: 0,
    capabilities: {
      platform: 'win32',
      arch: 'x64',
      supportedClis: overrides.supportedClis ?? ['claude'],
      hasBrowserRuntime: true,
      hasBrowserMcp,
      ...(overrides.workerAgent ? { workerAgent: overrides.workerAgent } : {}),
      ...(overrides.extensionRelay
        ? {
            hasExtensionRelay: overrides.extensionRelay.enabled && overrides.extensionRelay.running,
            extensionRelay: overrides.extensionRelay,
          }
        : {}),
      hasAndroidMcp,
      ...(hasAndroidMcp
        ? {
            androidAutomation: {
              enabled: true,
              sdkPath: 'C:\\Android\\Sdk',
              adbVersion: 'Android Debug Bridge version 1.0.41',
              avds: ['Pixel_8'],
              connectedDevices: [],
              emulatorRunning: false,
              hasMaestro: false,
            },
          }
        : {}),
      hasDocker: false,
      maxConcurrentInstances: 4,
      workingDirectories: ['C:\\work'],
    },
  };
}

async function startStep(instanceManagerOverrides: Record<string, unknown> = {}): Promise<void> {
  const instanceManager = {
    getAllInstances: vi.fn(() => []),
    getInstance: vi.fn(() => undefined),
    createInstance: vi.fn(async () => ({
      id: 'inst-default',
      status: 'initializing',
    })),
    ...instanceManagerOverrides,
  };
  const windowManager = { sendToRenderer: vi.fn() };
  await createOrchestratorToolsStep(instanceManager as never, windowManager as never).fn();
}
