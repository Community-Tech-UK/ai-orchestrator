/**
 * Log base-directory resolution.
 *
 * Split from `logger.ts` to keep it under the repo's LOC ratchet.
 */

/**
 * Safely get the Electron app userData path.
 * Returns undefined if Electron is not available (e.g., in tests).
 */
export function getElectronUserDataPath(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron');
    return app?.getPath?.('userData');
  } catch {
    return undefined;
  }
}

/**
 * Persistent log directory set on the aio-mcp browser-gateway forwarder by the
 * MCP config writer (`AI_ORCHESTRATOR_BROWSER_FORWARDER_LOG_DIR`). Outside
 * Electron there is no userData path, so without this the constructor disables
 * the file sink and every forwarder log line dies in an in-memory buffer inside
 * a process that is then killed (LT-543).
 */
export function getForwarderLogDirectory(): string | undefined {
  const fromEnv = process.env['AI_ORCHESTRATOR_BROWSER_FORWARDER_LOG_DIR'];
  return fromEnv && fromEnv.trim() !== '' ? fromEnv : undefined;
}
