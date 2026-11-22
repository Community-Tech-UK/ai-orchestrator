import type { McpServerToolDefinition } from './mcp-server-tools';
import type { OrchestratorToolsRpcClientLike } from './orchestrator-tools-rpc-client';
import { z } from 'zod/v4';
import type { ExtensionTestInstallToolResult } from '../remote-node/extension-test-install-service';

const RESET_NODE_CONNECTION_DESCRIPTION =
  'Close a connected worker node\'s coordinator WebSocket WITHOUT revoking it; the worker reconnects on its own backoff. '
  + 'Use when a node is connected but its traffic is not flowing, e.g. browser_health shows relay_not_forwarding or the '
  + 'node has an active flap storm (repeated "Replacing existing socket"). Running instances on the node keep running. '
  + 'Target must be an exact node name or id from list_remote_nodes.';

export const ResetNodeConnectionArgsSchema = z.object({
  node: z.string().trim().min(1).max(200),
}).strict();

export type ResetNodeConnectionArgs = z.infer<typeof ResetNodeConnectionArgsSchema>;

export interface ResetNodeConnectionResult {
  nodeId: string;
  nodeName: string;
  /** False when the node had no open socket at the moment of the call. */
  reset: boolean;
}

export type ResetNodeConnectionFn = (args: ResetNodeConnectionArgs) => Promise<ResetNodeConnectionResult>;

const ISSUE_REMOTE_NODE_PAIRING_DESCRIPTION =
  'Pair a new worker computer with Harness: issues a single-use pairing credential (default and maximum lifetime '
  + '60 minutes) and returns the ready-to-run `aio-worker pair "<link>"` command, the canonical connection config '
  + 'and the expiry. Run the command on the new computer (for example over SSH); it then appears in list_remote_nodes. '
  + 'The command contains the credential: never repeat it in chat, logs or files other than the worker config. '
  + 'The pairing shows on the Other computers page with this session as the requester, and can be revoked there.';

/** Longest lifetime an agent may ask for; the default (no ttlMinutes) is the app's 60-minute pairing default. */
export const MAX_AGENT_PAIRING_TTL_MINUTES = 60;

export const IssueRemoteNodePairingArgsSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  ttlMinutes: z.number().int().min(1).max(MAX_AGENT_PAIRING_TTL_MINUTES).optional(),
}).strict();

export type IssueRemoteNodePairingArgs = z.infer<typeof IssueRemoteNodePairingArgsSchema>;

export interface IssueRemoteNodePairingResult {
  /** `aio-worker pair "<link>"`, ready to run on the new computer. */
  command: string;
  link: string;
  connectionConfig: Record<string, unknown>;
  label?: string;
  createdAt: number;
  expiresAt: number;
}

export type IssueRemoteNodePairingFn = (
  args: IssueRemoteNodePairingArgs & { instanceId: string },
) => Promise<IssueRemoteNodePairingResult>;

const INSTALL_TEST_BROWSER_EXTENSION_DESCRIPTION =
  'Install your branch build of the Harness browser extension on a browser computer for a test; check the result in '
  + 'list_remote_nodes (extensionRelay.extensionVersion). sourceDir (usually resources/browser-extension) must be inside '
  + 'your working folder. Refused unless its version is above the running one, its permissions are no wider, and no one '
  + 'else holds the lease. The original is restored by restore_test_browser_extension, when the lease ends (default 30, '
  + 'max 120 minutes) or when the worker restarts. Always restore when done. Exact node name or id.';

const RESTORE_TEST_BROWSER_EXTENSION_DESCRIPTION =
  'Put back the extension that install_test_browser_extension replaced and wait for the browser to reload onto it. '
  + 'Only the installing session may restore before the lease ends. Exact node name or id.';

export const InstallTestBrowserExtensionArgsSchema = z.object({
  node: z.string().trim().min(1).max(200),
  sourceDir: z.string().trim().min(1).max(4096),
  ttlMinutes: z.number().int().min(1).max(120).optional(),
}).strict();
export type InstallTestBrowserExtensionArgs = z.infer<typeof InstallTestBrowserExtensionArgsSchema>;

export const RestoreTestBrowserExtensionArgsSchema = ResetNodeConnectionArgsSchema;
export type RestoreTestBrowserExtensionArgs = ResetNodeConnectionArgs;

export type InstallTestBrowserExtensionFn = (
  args: InstallTestBrowserExtensionArgs & { instanceId: string },
) => Promise<ExtensionTestInstallToolResult>;
export type RestoreTestBrowserExtensionFn = (
  args: RestoreTestBrowserExtensionArgs & { instanceId: string },
) => Promise<ExtensionTestInstallToolResult>;

export interface NodeConnectionToolContext {
  resetNodeConnection?: ResetNodeConnectionFn | null;
  issueRemoteNodePairing?: IssueRemoteNodePairingFn | null;
  installTestBrowserExtension?: InstallTestBrowserExtensionFn | null;
  restoreTestBrowserExtension?: RestoreTestBrowserExtensionFn | null;
}

const installTestExtensionInputSchema = {
  type: 'object',
  properties: {
    node: { type: 'string', description: 'Exact node name or id.' },
    sourceDir: { type: 'string', description: 'Extension build folder inside your working folder.' },
    ttlMinutes: { type: 'integer', minimum: 1, maximum: 120, description: 'Lease minutes, default 30.' },
  },
  required: ['node', 'sourceDir'],
  additionalProperties: false,
};

const issuePairingInputSchema = {
  type: 'object',
  properties: {
    label: { type: 'string', description: 'Name for the new computer, shown in Settings and on the worker (1-120 characters).' },
    ttlMinutes: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_AGENT_PAIRING_TTL_MINUTES,
      description: 'Minutes the credential stays usable. Defaults to 60.',
    },
  },
  required: [],
  additionalProperties: false,
};

const inputSchema = {
  type: 'object',
  properties: {
    node: { type: 'string', description: 'Exact connected worker node name or id.' },
  },
  required: ['node'],
  additionalProperties: false,
};

export function createNodeConnectionToolDefinitions(
  context: NodeConnectionToolContext & { instanceId?: string | null },
): McpServerToolDefinition[] {
  return [{
    name: 'reset_node_connection',
    description: RESET_NODE_CONNECTION_DESCRIPTION,
    inputSchema,
    handler: async (args) => {
      const parsed = ResetNodeConnectionArgsSchema.parse(args);
      if (!context.resetNodeConnection) {
        throw new Error('reset_node_connection is unavailable: node connection control is not wired in this process');
      }
      return context.resetNodeConnection(parsed);
    },
  }, {
    name: 'issue_remote_node_pairing',
    description: ISSUE_REMOTE_NODE_PAIRING_DESCRIPTION,
    inputSchema: issuePairingInputSchema,
    handler: async (args) => {
      const parsed = IssueRemoteNodePairingArgsSchema.parse(args);
      if (!context.issueRemoteNodePairing) {
        throw new Error('issue_remote_node_pairing is unavailable: remote node pairing is not wired in this process');
      }
      if (!context.instanceId) {
        throw new Error('issue_remote_node_pairing needs the calling session');
      }
      return context.issueRemoteNodePairing({ ...parsed, instanceId: context.instanceId });
    },
  }, {
    name: 'install_test_browser_extension',
    description: INSTALL_TEST_BROWSER_EXTENSION_DESCRIPTION,
    inputSchema: installTestExtensionInputSchema,
    handler: async (args) => {
      const parsed = InstallTestBrowserExtensionArgsSchema.parse(args);
      if (!context.installTestBrowserExtension) {
        throw new Error('install_test_browser_extension is unavailable: test extension install is not wired in this process');
      }
      if (!context.instanceId) throw new Error('install_test_browser_extension needs the calling session');
      return context.installTestBrowserExtension({ ...parsed, instanceId: context.instanceId });
    },
  }, {
    name: 'restore_test_browser_extension',
    description: RESTORE_TEST_BROWSER_EXTENSION_DESCRIPTION,
    inputSchema,
    handler: async (args) => {
      const parsed = RestoreTestBrowserExtensionArgsSchema.parse(args);
      if (!context.restoreTestBrowserExtension) {
        throw new Error('restore_test_browser_extension is unavailable: test extension install is not wired in this process');
      }
      if (!context.instanceId) throw new Error('restore_test_browser_extension needs the calling session');
      return context.restoreTestBrowserExtension({ ...parsed, instanceId: context.instanceId });
    },
  }];
}

export function createNodeConnectionForwarderTools(
  client: OrchestratorToolsRpcClientLike,
): McpServerToolDefinition[] {
  const forward = (name: string, description: string, schema: Record<string, unknown>): McpServerToolDefinition => ({
    name,
    description,
    inputSchema: schema,
    handler: async (args) => {
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error(`${name} args must be an object`);
      }
      return client.call(`orchestrator_tools.${name}`, args as Record<string, unknown>);
    },
  });
  return [
    forward('reset_node_connection', RESET_NODE_CONNECTION_DESCRIPTION, inputSchema),
    forward('issue_remote_node_pairing', ISSUE_REMOTE_NODE_PAIRING_DESCRIPTION, issuePairingInputSchema),
    forward('install_test_browser_extension', INSTALL_TEST_BROWSER_EXTENSION_DESCRIPTION, installTestExtensionInputSchema),
    forward('restore_test_browser_extension', RESTORE_TEST_BROWSER_EXTENSION_DESCRIPTION, inputSchema),
  ];
}
