import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import {
  BrowserExtensionTestResultSchema,
  EXTENSION_TEST_DEFAULT_TTL_MS,
  EXTENSION_TEST_MAX_FILES,
  EXTENSION_TEST_RELOAD_WAIT_MS,
  compareExtensionVersions,
  decodeExtensionTestBundle,
  manifestVersion,
  parseExtensionManifest,
  type BrowserExtensionTestParams,
  type BrowserExtensionTestResult,
} from './extension-test-install-rpc';
import { assertExistingPathInsideWorkspace, resolveInsideWorkspace } from './remote-node-file-transfer-path-utils';
import type { WorkerNodeConnectionControlDeps } from './worker-node-connection-control';
import { COORDINATOR_TO_NODE } from './worker-node-rpc';

export interface ExtensionTestInstallDeps {
  nodeControl: WorkerNodeConnectionControlDeps;
  /** One service RPC to a node; the worker re-validates everything it is sent. */
  sendRpc: (nodeId: string, method: string, params: unknown, timeoutMs: number) => Promise<unknown>;
  /** The calling session's working folder; the build to install must be inside it. */
  resolveWorkspace: (instanceId: string) => string | undefined;
  /** The roster's browser-computer classification (sticky once a node has reported browser automation). */
  isBrowserComputer: (nodeId: string) => boolean;
}

export interface ExtensionTestInstallToolResult extends BrowserExtensionTestResult {
  nodeId: string;
  nodeName: string;
}

// Install may wait for one reload and, after an expired lease, for a restore reload first.
const RPC_TIMEOUT_MS = 2 * EXTENSION_TEST_RELOAD_WAIT_MS + 30_000;

/** Exact name or id only: this changes the browser a person's real sign-ins live in. */
function resolveBrowserComputer(deps: ExtensionTestInstallDeps, requested: string): WorkerNodeInfo {
  const want = requested.trim().toLowerCase();
  const node = deps.nodeControl.registry.getAllNodes().find(
    (candidate) => candidate.id.toLowerCase() === want || candidate.name?.toLowerCase() === want,
  );
  if (!node) {
    throw new Error(`No worker node with name or id "${requested}"; call list_remote_nodes for exact names.`);
  }
  if (!deps.nodeControl.server.isNodeConnected(node.id)) {
    throw new Error(`Node is not connected: ${node.name}`);
  }
  if (!deps.isBrowserComputer(node.id)) {
    throw new Error(`${node.name} is not a browser computer; a test extension can only be installed on one`);
  }
  if (!node.capabilities.extensionRelay?.enabled) {
    throw new Error(`${node.name} has no browser extension relay turned on`);
  }
  return node;
}

async function readBuild(workspace: string, sourceDir: string): Promise<Array<{ name: string; contentBase64: string }>> {
  const source = resolveInsideWorkspace(workspace, sourceDir);
  await assertExistingPathInsideWorkspace(workspace, source, 'Extension source folder');
  const entries = await fs.readdir(source, { withFileTypes: true });
  if (entries.length > EXTENSION_TEST_MAX_FILES) {
    throw new Error(`Extension source folder holds more than ${EXTENSION_TEST_MAX_FILES} entries`);
  }
  const files: Array<{ name: string; contentBase64: string }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      throw new Error(`Extension source folder must hold only plain files; refused ${entry.name}`);
    }
    files.push({ name: entry.name, contentBase64: (await readPlainFileInsideWorkspace(workspace, path.join(source, entry.name))).toString('base64') });
  }
  return files;
}

/**
 * The listing above is only a snapshot: an entry can be swapped for a link, or the folder itself replaced, before
 * it is read. So open the file without following a final link, then prove the open handle is the very file that
 * the path resolves to inside the workspace. Nothing is read from a handle that fails either check.
 */
async function readPlainFileInsideWorkspace(workspace: string, filePath: string): Promise<Buffer> {
  // O_NOFOLLOW does not exist on Windows; the identity check below still covers a swapped link there.
  const handle = await fs.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new Error(`Extension source folder must hold only plain files; refused ${path.basename(filePath)}`);
    }
    const real = await fs.realpath(filePath);
    await assertExistingPathInsideWorkspace(workspace, real, 'Extension source file');
    const resolved = await fs.stat(real);
    if (resolved.dev !== opened.dev || resolved.ino !== opened.ino) {
      throw new Error(`Extension source file changed while it was being read: ${path.basename(filePath)}`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function call(
  deps: ExtensionTestInstallDeps,
  node: WorkerNodeInfo,
  params: BrowserExtensionTestParams,
): Promise<ExtensionTestInstallToolResult> {
  const result = BrowserExtensionTestResultSchema.parse(
    await deps.sendRpc(node.id, COORDINATOR_TO_NODE.BROWSER_EXTENSION_TEST_INSTALL, params, RPC_TIMEOUT_MS),
  );
  return { nodeId: node.id, nodeName: node.name, ...result };
}

export async function installTestBrowserExtension(
  deps: ExtensionTestInstallDeps,
  args: { instanceId: string; node: string; sourceDir: string; ttlMinutes?: number },
): Promise<ExtensionTestInstallToolResult> {
  const node = resolveBrowserComputer(deps, args.node);
  const workspace = deps.resolveWorkspace(args.instanceId);
  if (!workspace) throw new Error('install_test_browser_extension needs the calling session\'s working folder');
  const files = await readBuild(path.resolve(workspace), args.sourceDir);
  const manifest = decodeExtensionTestBundle(files).find((file) => file.name === 'manifest.json')!;
  const testVersion = manifestVersion(parseExtensionManifest(manifest.content));
  const running = node.capabilities.extensionRelay?.extensionVersion;
  // Cheap early refusal on the version the node last reported; the worker checks the folder itself.
  if (running && compareExtensionVersions(testVersion, running) <= 0) {
    throw new Error(`Test extension version ${testVersion} must be above the version running on ${node.name} (${running})`);
  }
  return call(deps, node, {
    action: 'install',
    ownerId: args.instanceId,
    ttlMs: args.ttlMinutes ? args.ttlMinutes * 60_000 : EXTENSION_TEST_DEFAULT_TTL_MS,
    files,
  });
}

export async function restoreTestBrowserExtension(
  deps: ExtensionTestInstallDeps,
  args: { instanceId: string; node: string },
): Promise<ExtensionTestInstallToolResult> {
  return call(deps, resolveBrowserComputer(deps, args.node), { action: 'restore', ownerId: args.instanceId });
}
