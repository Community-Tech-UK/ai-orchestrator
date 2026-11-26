# Remote Node Tool Discovery Design

## Context

AIO already exposes Orchestrator MCP tools for remote worker execution:

- `run_on_node` spawns an AI CLI instance on a connected worker node.
- `read_node_output` reads output from an instance spawned by `run_on_node`.
- Remote node setup and connection state already live in `src/main/remote-node/`.

The failure mode is discovery, not core capability. Agents can miss the tool when the user says "Windows PC", "other machine", or similar language, then incorrectly infer that MCP servers only run locally.

## Goal

Make remote worker access explicit and inspect-first. Agents should know that AIO can operate connected remote worker nodes, but should check current node status before claiming a specific machine is reachable.

## Non-Goals

- Do not hard-code James's `windows-pc` as always available.
- Do not expose secrets, enrollment tokens, or node transport credentials.
- Do not change worker pairing, connection, or service setup.
- Do not broaden recursive spawning beyond the existing spawn-depth guard.

## Design

Add a read-only Orchestrator MCP tool named `list_remote_nodes`.

The tool returns the currently registered worker nodes with operational fields:

- node `id`, `name`, `status`, `platform`, and `arch`
- supported CLI providers
- browser, browser MCP, GPU, and Docker capability flags
- active instance count and maximum concurrent instance count
- advertised working directories
- last heartbeat and latency when available

The tool should be available anywhere `run_on_node` and `read_node_output` are available. Leaf/depth-limited instances may lose `run_on_node`, but should keep `list_remote_nodes` and `read_node_output`.

## Runtime Discovery

Update tool descriptions and runtime MCP summaries so the Orchestrator Tools surface is discoverable for prompts mentioning:

- Windows PC / Windows machine / PC
- remote machine / other machine / another computer
- worker node / connected node
- run a task over there / use the other machine

The discovery copy should say AIO can use connected remote worker nodes through Orchestrator Tools, and that the agent should call `list_remote_nodes` first when reachability is relevant.

## Spawn Targeting

Update the `run_on_node` spawn path to use the existing `resolveWorkerNodeTarget` helper. That gives consistent support for:

- exact node id
- exact node name, case-insensitive
- capability tags such as `windows`, `pc`, `gpu`, `browser`, `docker`, and CLI provider names

If no workers are connected, the error should clearly say so. If multiple workers are connected and no target was supplied, keep the existing explicit-target requirement.

## Testing

Use test-first implementation.

Focused tests:

- `orchestrator-tools.spec.ts`: `list_remote_nodes` returns sanitized node status and capabilities.
- `orchestrator-tools-mcp-forwarder.spec.ts`: forwarder exposes `list_remote_nodes` and dispatches `orchestrator_tools.list_remote_nodes`.
- `orchestrator-tools-rpc-server.spec.ts`: RPC dispatch validates and routes `list_remote_nodes`; spawn-depth scoping keeps it available when `run_on_node` is stripped.
- `mcp-runtime-tool-context.spec.ts` or `mcp-manager.spec.ts`: searching for "Windows PC" selects the remote-node tool description.
- `worker-node-registry.spec.ts`: `run_on_node` target matching remains consistent for platform/capability tags where needed.

## Verification

After implementation:

1. Run focused Vitest files for MCP tools, RPC server, forwarder, runtime tool context, and worker-node registry.
2. Run `npx tsc --noEmit`.
3. Run `npx tsc --noEmit -p tsconfig.spec.json`.
4. Run lint for the modified files or `npm run lint` if the change touches shared formatting-sensitive surfaces.

## Risks

The main risk is context bloat or leaking too much host detail. Keep returned fields operational and bounded to data the worker already advertises for routing. Do not include credentials, tokens, environment variables, or arbitrary filesystem listings.
