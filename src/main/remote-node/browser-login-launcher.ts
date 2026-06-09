/**
 * Tier 3 — guided automation-profile login.
 *
 * Launches a HEADFUL Chrome on a remote node against its dedicated automation
 * profile so the operator can log the profile into the target site once. The
 * Chrome window opens on the NODE's physical display, so this only helps an
 * operator who is at (or RDP'd into) that machine — the coordinator merely fires
 * the command via the existing terminal RPC.
 */
import { getWorkerNodeRegistry } from './worker-node-registry';
import { getRemoteTerminalManager } from './remote-terminal-manager';
import { sendServiceRpc } from './service-rpc-client';
import { COORDINATOR_TO_NODE } from './worker-node-rpc';
import { buildBrowserLoginCommand } from '../../shared/utils/browser-login-command';
import { getLogger } from '../logging/logger';

const logger = getLogger('BrowserLoginLauncher');

export interface RunBrowserLoginResult {
  sessionId: string;
}

/**
 * Spawn a remote terminal on the node and run the login command. Fire-and-forget:
 * the operator interacts with Chrome on the node's screen, then closes it; the
 * persisted profile keeps the session for the worker-managed Chrome to reuse.
 */
export async function runBrowserLoginOnNode(
  nodeId: string,
  url?: string,
): Promise<RunBrowserLoginResult> {
  const node = getWorkerNodeRegistry().getNode(nodeId);
  if (!node) {
    throw new Error(`Worker node not connected: ${nodeId}`);
  }
  const caps = node.capabilities;
  const profileDir = caps.browserAutomation?.profileDir;
  if (!profileDir) {
    throw new Error('Node has no browser-automation profile configured yet — enable it first');
  }
  const cwd = caps.workingDirectories[0];
  if (!cwd) {
    throw new Error('Node has no working directory available for a terminal session');
  }

  // Stop the worker's managed Chrome first so it isn't holding a lock on the
  // automation profile dir — otherwise the headful login Chrome can't open the
  // same profile. Best-effort: older workers won't know this method, and a node
  // with Chrome idle has nothing to stop. Config stays enabled; the managed
  // Chrome relaunches lazily (now logged in) on the next browser-enabled spawn.
  try {
    await sendServiceRpc(nodeId, COORDINATOR_TO_NODE.BROWSER_STOP_MANAGED, {});
  } catch (error) {
    logger.debug('stopManaged before login failed (continuing)', {
      nodeId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const { shell, command } = buildBrowserLoginCommand(caps.platform, profileDir, url ?? 'about:blank');
  const manager = getRemoteTerminalManager();
  const { sessionId } = await manager.spawn({ nodeId, cwd, shell });
  // Newline submits the command in both PowerShell and POSIX shells.
  await manager.write(sessionId, `${command}\r`);
  return { sessionId };
}
