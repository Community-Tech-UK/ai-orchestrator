/**
 * `aio-mcp` SEA Dispatcher — entrypoint baked into the Node SEA binary.
 *
 * The single binary `aio-mcp` shipped via `extraResources` replaces all four
 * spawn sites that used to launch the Harness Electron binary with
 * `ELECTRON_RUN_AS_NODE=1`:
 *
 *   `aio-mcp orchestrator-tools`   thin stdio forwarder → OrchestratorToolsRpcServer
 *   `aio-mcp codemem`              thin stdio forwarder → CodememRpcServer
 *   `aio-mcp browser-gateway`      thin stdio forwarder → BrowserGatewayRpcServer
 *   `aio-mcp native-host`          Chrome native-messaging host → BrowserGatewayRpcServer
 *
 * None of these forwarders import `better-sqlite3` (or any other native
 * module). The whole point of the dispatcher is to keep the SEA blob pure
 * JS so it loads cleanly under vanilla Node — which in turn lets us re-set
 * the `RunAsNode` Electron fuse to `false` in scripts/set-electron-fuses.js
 * without breaking any of the integrations.
 */

import { runOrchestratorToolsForwarder } from './orchestrator-tools-mcp-forwarder';
import { runCodememForwarder } from '../codemem/codemem-mcp-forwarder';
import { runBrowserMcpForwarder } from '../browser-gateway/browser-mcp-stdio-server';
import { runBrowserExtensionNativeHost } from '../browser-gateway/browser-extension-native-host';
import { runRemoteNodesCli } from './remote-nodes-cli';

type AioMcpRunner = (argv: readonly string[]) => Promise<void>;

const SUBCOMMANDS = {
  'orchestrator-tools': (() => runOrchestratorToolsForwarder()) as AioMcpRunner,
  codemem: (() => runCodememForwarder()) as AioMcpRunner,
  'browser-gateway': (() => runBrowserMcpForwarder()) as AioMcpRunner,
  'native-host': (() => runBrowserExtensionNativeHost()) as AioMcpRunner,
  'remote-nodes': runRemoteNodesCli,
} as const;

export type AioMcpSubcommand = keyof typeof SUBCOMMANDS;

export function isAioMcpSubcommand(value: unknown): value is AioMcpSubcommand {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SUBCOMMANDS, value);
}

export async function runAioMcpDispatcher(argv: readonly string[]): Promise<number> {
  const subcommand = argv[2];
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    process.stderr.write(formatHelp());
    return subcommand ? 0 : 1;
  }
  if (!isAioMcpSubcommand(subcommand)) {
    process.stderr.write(
      `aio-mcp: unknown subcommand "${subcommand}"\n${formatHelp()}`,
    );
    return 2;
  }
  try {
    await SUBCOMMANDS[subcommand](argv.slice(3));
    return 0;
  } catch (error) {
    process.stderr.write(
      `aio-mcp ${subcommand} failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

function formatHelp(): string {
  return [
    'Usage: aio-mcp <subcommand>',
    '',
    'Subcommands:',
    '  orchestrator-tools  Stdio MCP forwarder for orchestrator-tools (git_batch_pull)',
    '  codemem             Stdio MCP forwarder for codemem (LSP/symbol search)',
    '  browser-gateway     Stdio MCP forwarder for browser-gateway',
    '  native-host         Chrome native-messaging host for the browser extension',
    '  remote-nodes        Print the safe remote worker roster (--json for JSON)',
    '',
  ].join('\n');
}

// `process.argv` from Node: [nodeBinary, scriptPath, ...args]. Inside the SEA
// the script path is replaced with the SEA binary path — same shape either way,
// so argv[2] is consistently the subcommand.
if (require.main === module) {
  void runAioMcpDispatcher(process.argv).then((code) => {
    process.exit(code);
  });
}
