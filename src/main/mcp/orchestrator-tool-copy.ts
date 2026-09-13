/**
 * Shared orchestrator MCP tool prose. Electron-free so the aio-mcp SEA
 * forwarder and the parent tool table can use the same strings.
 *
 * The long discovery paragraph lives on `list_remote_nodes` only. Other node
 * tools keep a short pointer so we do not pay that paragraph on every schema.
 */

export const REMOTE_NODE_DISCOVERY_HINT =
  'Harness can use connected remote worker nodes, including Windows PCs, laptops, desktops, named machines, remote machines, other machines, and another computer, through list_remote_nodes, run_on_node, exec_on_node, read_node_output, and terminate_node_instance. If the user names a machine or asks for work on another computer, for example "Noah\'s laptop", check list_remote_nodes before local filesystem or shell work. Use exec_on_node for one executable with exact argv and run_on_node when a coding agent is required. For browser or Android/mobile testing, inspect node capabilities and pass requiresBrowser or requiresAndroid to run_on_node so the worker receives the right testing tools. requiresBrowser means a dedicated worker-managed Chrome profile through chrome-devtools; it cannot access Browser Gateway, extension-shared tabs, or an existing logged-in Chrome tab. Keep Browser Gateway work on the coordinator and target the named computer from browser tools. Terminate finished run_on_node instances when you are done with them — idle agents hold a capacity slot on the node until terminated.';

export const LIST_REMOTE_NODES_DESCRIPTION =
  `${REMOTE_NODE_DISCOVERY_HINT} Lists currently registered remote worker nodes with status, platform, supported CLIs, browser/GPU/Docker capabilities, active capacity, working directories, heartbeat, and latency. Read-only; does not spawn work.`;

export const RUN_ON_NODE_DESCRIPTION =
  'Run a task on a connected remote worker node by spawning a coding agent there. If the user names a machine, call list_remote_nodes first. Use exec_on_node for one executable with exact argv. requiresBrowser is a worker-managed Chrome profile, not Browser Gateway or an existing logged-in tab. Returns after the worker provider starts; read later output with read_node_output.';

export const EXEC_ON_NODE_DESCRIPTION =
  'Run one executable with an exact argv array on a connected worker without spawning a coding agent. If the user names a machine, call list_remote_nodes first. There is no shell command string. For powershell -File, call upload_to_node first and pass its sha256 as scriptSha256; the worker rejects unbound or browser-launching scripts. Never launch or drive the operator\'s shared Chrome session; Browser Gateway work stays on the coordinator.';
