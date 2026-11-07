import { getRemoteAuthService, type RemoteAuthService } from '../auth/remote-auth';
import type {
  IssueRemoteNodePairingArgs,
  IssueRemoteNodePairingResult,
} from '../mcp/orchestrator-node-connection-tools';
import type { PairingCredentialIssuer } from '../../shared/types/worker-node.types';
import {
  buildCanonicalConnectionConfig,
  buildPairingCommand,
  buildPairingLink,
  selectPairingConnectionHosts,
  type PairingEndpointStatus,
} from '../../shared/remote-node/pairing-command';
import { readCoordinatorReachableHosts } from './coordinator-advertised-urls';
import { getRemoteNodeConfig, type RemoteNodeConfig } from './remote-node-config';
import { getWorkerNodeConnectionServer } from './worker-node-connection';

export interface AgentPairingDeps {
  auth: Pick<RemoteAuthService, 'issuePairingCredential'>;
  isServerRunning: () => boolean;
  readConfig: () => Pick<RemoteNodeConfig, 'serverHost' | 'serverPort' | 'namespace' | 'tlsCertPath' | 'tlsKeyPath'>;
  readAddresses: () => Promise<Pick<PairingEndpointStatus, 'localIps' | 'tailscaleIp' | 'tailscaleIpv6' | 'tailscaleDnsName'>>;
}

/**
 * Issues a one-time pairing credential for an agent and builds the same
 * command, link and config the Settings screen's Copy Command would. Never
 * touches the long-lived manual token (`remoteNodesEnrollmentToken`).
 */
export async function issueAgentPairingCommand(
  args: IssueRemoteNodePairingArgs & { issuedBy: PairingCredentialIssuer },
  deps: AgentPairingDeps = defaultAgentPairingDeps(),
): Promise<IssueRemoteNodePairingResult> {
  if (!deps.isServerRunning()) {
    throw new Error(
      'Harness is not accepting worker connections. Turn on "Let your other computers connect" on the '
      + 'Other computers page, then try again.',
    );
  }
  const config = deps.readConfig();
  const addresses = await deps.readAddresses();
  const credential = deps.auth.issuePairingCredential({
    ...(args.label ? { label: args.label } : {}),
    ...(args.ttlMinutes ? { ttlMs: args.ttlMinutes * 60_000 } : {}),
    issuedBy: args.issuedBy,
  });
  const input = {
    token: credential.token,
    // The label travels in the link as `name`, which the worker uses as its own name.
    label: credential.label,
    ...selectPairingConnectionHosts(addresses, config.serverHost),
    port: config.serverPort,
    namespace: config.namespace,
    requireTls: Boolean(config.tlsCertPath && config.tlsKeyPath),
  };
  return {
    command: buildPairingCommand(input),
    link: buildPairingLink(input),
    connectionConfig: buildCanonicalConnectionConfig(input),
    ...(credential.label ? { label: credential.label } : {}),
    createdAt: credential.createdAt,
    expiresAt: credential.expiresAt,
  };
}

/**
 * Same addresses the Settings screen sees, but read without blocking the main
 * thread on the Tailscale CLI. The MagicDNS name only counts while Tailscale
 * is running, as for the addresses advertised to connected workers.
 */
const readPairingAddresses: AgentPairingDeps['readAddresses'] = () => readCoordinatorReachableHosts();

function defaultAgentPairingDeps(): AgentPairingDeps {
  return {
    auth: getRemoteAuthService(),
    isServerRunning: () => getWorkerNodeConnectionServer().isRunning(),
    readConfig: getRemoteNodeConfig,
    readAddresses: readPairingAddresses,
  };
}
