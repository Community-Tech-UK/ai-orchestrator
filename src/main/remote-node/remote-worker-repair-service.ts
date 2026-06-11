import { getRemoteAuthService } from '../auth/remote-auth';
import {
  getLocalIpv4Addresses,
  getTailscaleIpv4Address,
  getTailscaleMagicDnsName,
} from '../util/network-addresses';
import { getRemoteNodeConfig, type RemoteNodeConfig } from './remote-node-config';
import { getRemoteWorkerRepairTracker, type RemoteWorkerRepairTracker } from './remote-worker-repair-tracker';
import { getWorkerNodeRegistry, type WorkerNodeRegistry } from './worker-node-registry';
import {
  servicePaths,
  WORKER_SERVICE_ID,
} from '../../shared/service/worker-service-paths';
import type {
  NodeIdentity,
  NodePlatform,
  RemotePairingCredentialInfo,
  RemoteWorkerRepairCommand,
  RemoteWorkerRepairDiagnostic,
  RemoteWorkerRepairStatus,
  WorkerNodeInfo,
} from '../../shared/types/worker-node.types';

const REPAIR_TTL_MS = 30 * 60_000;

interface RepairAuthFacade {
  listSessions(): NodeIdentity[];
  issuePairingCredential(options: {
    label?: string;
    ttlMs?: number;
    purpose?: 'pairing' | 'repair';
    allowedNodeId?: string;
  }): RemotePairingCredentialInfo;
}

interface RemoteWorkerRepairServiceDeps {
  auth?: RepairAuthFacade;
  registry?: WorkerNodeRegistry;
  tracker?: RemoteWorkerRepairTracker;
  now?: () => number;
  getConfig?: () => RemoteNodeConfig;
  getLocalIpv4Addresses?: () => string[];
  getTailscaleIpv4Address?: () => string | null;
  getTailscaleMagicDnsName?: () => string | null;
}

export class RemoteWorkerRepairService {
  private readonly auth: RepairAuthFacade;
  private readonly registry: WorkerNodeRegistry;
  private readonly tracker: RemoteWorkerRepairTracker;
  private readonly now: () => number;
  private readonly readConfig: () => RemoteNodeConfig;
  private readonly readLocalIps: () => string[];
  private readonly readTailscaleIp: () => string | null;
  private readonly readTailscaleDnsName: () => string | null;

  constructor(deps: RemoteWorkerRepairServiceDeps = {}) {
    this.auth = deps.auth ?? getRemoteAuthService();
    this.registry = deps.registry ?? getWorkerNodeRegistry();
    this.tracker = deps.tracker ?? getRemoteWorkerRepairTracker();
    this.now = deps.now ?? Date.now;
    this.readConfig = deps.getConfig ?? getRemoteNodeConfig;
    this.readLocalIps = deps.getLocalIpv4Addresses ?? getLocalIpv4Addresses;
    this.readTailscaleIp = deps.getTailscaleIpv4Address ?? getTailscaleIpv4Address;
    this.readTailscaleDnsName = deps.getTailscaleMagicDnsName ?? getTailscaleMagicDnsName;
  }

  diagnose(nodeId: string): RemoteWorkerRepairDiagnostic {
    const identity = this.findIdentity(nodeId);
    const live = this.registry.getNode(nodeId);
    const rejection = this.tracker.get(nodeId, this.now());
    const trustedPlatform = live?.capabilities.platform ?? identity?.platform;
    const status = this.classifyStatus(identity, live, rejection?.lastSeenAt);
    const config = this.readConfig();
    const tlsBlocked = this.isTlsRepairBlocked(config);
    const coordinatorUrls = tlsBlocked ? [] : this.buildCoordinatorUrls(config);
    const recommendedAction = this.recommendedAction(status, trustedPlatform, Boolean(rejection), tlsBlocked);
    const nodeName = identity?.nodeName ?? live?.name ?? rejection?.nodeName ?? nodeId;

    return {
      nodeId,
      nodeName,
      status,
      ...(live ? { liveStatus: live.status } : {}),
      ...(trustedPlatform ? { trustedPlatform } : {}),
      ...(rejection?.platformHint ? { platformHint: rejection.platformHint } : {}),
      ...(identity?.lastSeenAt ? { lastSeenAt: identity.lastSeenAt } : {}),
      ...(live?.lastHeartbeat ? { lastHeartbeat: live.lastHeartbeat } : {}),
      ...(rejection ? { lastRejectedRegistration: rejection } : {}),
      coordinatorUrls,
      hasCoordinatorRecoveryToken: Boolean(identity?.recoveryToken),
      recommendedAction,
      availableActions: live ? ['check_service_status'] : [],
      summary: this.buildSummary({ identity, live, rejection, status, trustedPlatform, recommendedAction }),
    };
  }

  generateRepairCommand(input: {
    nodeId: string;
    platform?: 'win32';
    operatorConfirmedPlatform?: boolean;
  }): RemoteWorkerRepairCommand {
    const identity = this.findIdentity(input.nodeId);
    if (!identity) {
      throw new Error('Repair command requires a registered node identity');
    }

    const diagnostic = this.diagnose(input.nodeId);
    if (diagnostic.recommendedAction === 'configure_tls') {
      throw new Error('Repair command generation is blocked by the current TLS configuration');
    }
    if (diagnostic.status === 'healthy') {
      throw new Error('Repair command is not available for a healthy connected node');
    }
    if (diagnostic.status === 'unreachable' && !diagnostic.lastRejectedRegistration) {
      throw new Error('Repair command requires recent rejected-registration evidence');
    }
    if (diagnostic.status !== 'depaired') {
      throw new Error('Repair command is only available for depaired registered nodes');
    }
    if (diagnostic.trustedPlatform && diagnostic.trustedPlatform !== 'win32') {
      throw new Error('Windows repair command cannot override a trusted non-Windows platform');
    }
    if (!diagnostic.trustedPlatform && !(input.platform === 'win32' && input.operatorConfirmedPlatform === true)) {
      throw new Error('Windows platform confirmation is required before generating this repair command');
    }

    const paths = servicePaths('win32');
    const coordinatorUrls = diagnostic.coordinatorUrls;
    if (coordinatorUrls.length === 0) {
      throw new Error('No worker-reachable coordinator URL is available');
    }
    const config = this.readConfig();
    const credential = this.auth.issuePairingCredential({
      label: `Repair ${diagnostic.nodeName}`,
      ttlMs: REPAIR_TTL_MS,
      purpose: 'repair',
      allowedNodeId: input.nodeId,
    });
    const payload = {
      nodeId: input.nodeId,
      nodeName: diagnostic.nodeName,
      primaryCoordinatorUrl: coordinatorUrls[0],
      coordinatorUrls,
      authToken: credential.token,
      namespace: config.namespace,
      configPath: paths.configFile,
      serviceId: WORKER_SERVICE_ID,
    };
    const command = buildWindowsPowerShellCommand(payload);

    return {
      nodeId: input.nodeId,
      nodeName: diagnostic.nodeName,
      platform: 'win32',
      expiresAt: credential.expiresAt,
      serviceId: WORKER_SERVICE_ID,
      configPath: paths.configFile,
      primaryCoordinatorUrl: coordinatorUrls[0],
      coordinatorUrls,
      command,
      redactedPreview: `Windows repair command for ${diagnostic.nodeName}; token redacted; expires ${new Date(credential.expiresAt).toISOString()}`,
    };
  }

  private findIdentity(nodeId: string): NodeIdentity | undefined {
    return this.auth.listSessions().find((identity) => identity.nodeId === nodeId);
  }

  private classifyStatus(
    identity: NodeIdentity | undefined,
    live: WorkerNodeInfo | undefined,
    lastRejectedAt: number | undefined,
  ): RemoteWorkerRepairStatus {
    if (live) {
      return 'healthy';
    }
    if (!identity) {
      return 'unknown';
    }
    if (lastRejectedAt !== undefined && lastRejectedAt > identity.lastSeenAt) {
      return 'depaired';
    }
    return 'unreachable';
  }

  private recommendedAction(
    status: RemoteWorkerRepairStatus,
    trustedPlatform: NodePlatform | undefined,
    hasRejection: boolean,
    tlsBlocked: boolean,
  ): RemoteWorkerRepairDiagnostic['recommendedAction'] {
    if (status === 'healthy') {
      return 'none';
    }
    if (status === 'unknown') {
      return 're_pair';
    }
    if (status === 'unreachable' || !hasRejection) {
      return 'check_connectivity';
    }
    if (tlsBlocked) {
      return 'configure_tls';
    }
    if (trustedPlatform === 'win32') {
      return 'copy_windows_command';
    }
    if (trustedPlatform === undefined) {
      return 'choose_platform';
    }
    return 're_pair';
  }

  private buildSummary(input: {
    identity?: NodeIdentity;
    live?: WorkerNodeInfo;
    rejection?: { count: number; reason: string; lastSeenAt: number; platformHint?: NodePlatform };
    status: RemoteWorkerRepairStatus;
    trustedPlatform?: NodePlatform;
    recommendedAction: RemoteWorkerRepairDiagnostic['recommendedAction'];
  }): string {
    if (input.status === 'healthy') {
      if (input.rejection && input.live?.connectedAt && input.rejection.lastSeenAt > input.live.connectedAt) {
        return `Node is connected, but another registration attempt was rejected ${input.rejection.count} time(s): ${input.rejection.reason}. Check for a duplicate worker or stale config.`;
      }
      return 'Node is connected. Use in-band service status checks for diagnostics.';
    }
    if (input.status === 'unknown') {
      return 'This node id is not registered. Use normal pairing instead of repair.';
    }
    if (input.status === 'unreachable') {
      return 'Node is registered but disconnected. The coordinator has not seen a recent authentication failure, so check service or network reachability first.';
    }
    if (input.recommendedAction === 'configure_tls') {
      return 'Node appears depaired, but the coordinator TLS mode requires separate worker trust or client-certificate setup before a v1 repair command can work.';
    }
    const platformContext = input.trustedPlatform
      ? `Trusted platform is ${input.trustedPlatform}.`
      : input.rejection?.platformHint
        ? `Rejected registration reported untrusted platform hint ${input.rejection.platformHint}.`
        : 'Trusted platform is unknown.';
    return `Registered node is disconnected and has a newer rejected registration: ${input.rejection?.reason ?? 'registration rejected'}. ${platformContext}`;
  }

  private buildCoordinatorUrls(config: RemoteNodeConfig): string[] {
    const protocol = config.tlsCertPath && config.tlsKeyPath ? 'wss' : 'ws';
    const port = config.serverPort;
    const candidates = [
      this.readTailscaleDnsName(),
      this.readTailscaleIp(),
      ...this.readLocalIps(),
      config.serverHost !== '0.0.0.0' ? config.serverHost : null,
    ].filter((host): host is string => typeof host === 'string' && host.trim().length > 0);

    const seen = new Set<string>();
    const urls: string[] = [];
    for (const host of candidates) {
      const url = `${protocol}://${host}:${port}`;
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
    return urls;
  }

  private isTlsRepairBlocked(config: RemoteNodeConfig): boolean {
    const tlsEnabled = Boolean(config.tlsCertPath && config.tlsKeyPath);
    return tlsEnabled && Boolean(config.tlsCaPath || config.tlsMode === 'auto');
  }
}

interface WindowsRepairPayload {
  nodeId: string;
  nodeName: string;
  primaryCoordinatorUrl: string;
  coordinatorUrls: string[];
  authToken: string;
  namespace: string;
  configPath: string;
  serviceId: string;
}

function buildWindowsPowerShellCommand(payload: WindowsRepairPayload): string {
  const payloadBase64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const script = `
$payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payloadBase64}'))
$repair = $payloadJson | ConvertFrom-Json
$configPath = [string]$repair.configPath
$configDir = Split-Path -Parent $configPath
try {
  if (-not (Test-Path -LiteralPath $configDir)) {
    New-Item -ItemType Directory -Path $configDir -Force -ErrorAction Stop | Out-Null
  }
  $existing = $null
  if (Test-Path -LiteralPath $configPath) {
    try {
      $existing = Get-Content -LiteralPath $configPath -Raw -ErrorAction Stop | ConvertFrom-Json
    } catch {
      $existing = $null
    }
  }
  function Get-ExistingOrDefault([string]$key, $defaultValue) {
    if ($null -ne $existing -and $existing.PSObject.Properties.Name -contains $key) {
      return $existing.$key
    }
    return $defaultValue
  }
  $config = [ordered]@{
    nodeId = [string]$repair.nodeId
    name = [string]$repair.nodeName
    coordinatorUrl = [string]$repair.primaryCoordinatorUrl
    coordinatorUrls = @($repair.coordinatorUrls)
    authToken = [string]$repair.authToken
    namespace = [string]$repair.namespace
    maxConcurrentInstances = Get-ExistingOrDefault 'maxConcurrentInstances' 10
    workingDirectories = @(Get-ExistingOrDefault 'workingDirectories' @())
    reconnectIntervalMs = Get-ExistingOrDefault 'reconnectIntervalMs' 5000
    heartbeatIntervalMs = Get-ExistingOrDefault 'heartbeatIntervalMs' 10000
  }
  foreach ($key in @('browserAutomation', 'androidAutomation')) {
    if ($null -ne $existing -and $existing.PSObject.Properties.Name -contains $key) {
      $config[$key] = $existing.$key
    }
  }
  # Deliberately omit nodeToken, recoveryToken, and legacy token so the worker performs a clean repair pairing.
  $json = $config | ConvertTo-Json -Depth 20
  $utf8NoBom = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
  [System.IO.File]::WriteAllText($configPath, $json, $utf8NoBom)
} catch {
  Write-Host ("Failed to write worker config at " + $configPath + ": " + $_.Exception.Message)
  Write-Host "This command requires an elevated PowerShell session when writing C:\\ProgramData\\Orchestrator."
  throw
}
$service = Get-Service -Name ([string]$repair.serviceId) -ErrorAction SilentlyContinue
if ($service) {
  try {
    if ($service.Status -eq 'Running') {
      Restart-Service -Name ([string]$repair.serviceId) -Force -ErrorAction Stop
      Write-Host "AI Orchestrator worker service restarted."
    } else {
      Start-Service -Name ([string]$repair.serviceId) -ErrorAction Stop
      Write-Host "AI Orchestrator worker service started."
    }
  } catch {
    Write-Host ("Config was written, but the AI Orchestrator worker service could not be restarted or started: " + $_.Exception.Message)
    Write-Host "This command may require an elevated PowerShell session to restart the Windows service."
  }
} else {
  Write-Host "AI Orchestrator worker service is not installed. Config was written; start or install the worker service manually."
}
`.trim();
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedScript}`;
}

let remoteWorkerRepairService: RemoteWorkerRepairService | null = null;

export function getRemoteWorkerRepairService(): RemoteWorkerRepairService {
  if (!remoteWorkerRepairService) {
    remoteWorkerRepairService = new RemoteWorkerRepairService();
  }
  return remoteWorkerRepairService;
}

export function _resetRemoteWorkerRepairServiceForTesting(): void {
  remoteWorkerRepairService = null;
}

export type { RemoteWorkerRepairServiceDeps };
