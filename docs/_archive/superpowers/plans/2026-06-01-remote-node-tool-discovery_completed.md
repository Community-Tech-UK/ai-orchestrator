# Remote Node Tool Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AIO agents discover and inspect connected remote worker nodes before deciding whether they can operate another machine.

**Architecture:** Add a read-only `list_remote_nodes` Orchestrator MCP tool beside `run_on_node` and `read_node_output`. Thread the tool through the parent-side RPC server and stdio forwarder, use `WorkerNodeRegistry` through a narrow injected function, and update runtime discovery text so Windows/remote-machine prompts select the right tools.

**Tech Stack:** TypeScript, Zod, Electron main process services, MCP tool definitions, Vitest.

---

## File Structure

- Modify `src/main/mcp/orchestrator-tools.ts`: add list schemas/types, injected list function, tool definition, shared remote discovery copy, and richer `run_on_node` text.
- Modify `src/main/mcp/orchestrator-tools-mcp-forwarder.ts`: expose the same list tool over the stdio MCP forwarder.
- Modify `src/main/mcp/orchestrator-tools-rpc-server.ts`: add RPC dispatch and keep `list_remote_nodes` in full and leaf toolsets.
- Modify `src/main/app/initialization-steps.ts`: inject a sanitized remote-node lister and route `run_on_node` target resolution through `resolveWorkerNodeTarget`.
- Modify `src/main/mcp/mcp-manager.ts`: make Orchestrator Tools server summaries advertise remote worker capability.
- Modify focused tests:
  - `src/main/mcp/__tests__/orchestrator-tools.spec.ts`
  - `src/main/mcp/orchestrator-tools-mcp-forwarder.spec.ts`
  - `src/main/mcp/orchestrator-tools-rpc-server.spec.ts`
  - `src/main/mcp/mcp-manager.spec.ts`

## Task 1: Orchestrator Tool Contract

**Files:**
- Modify: `src/main/mcp/__tests__/orchestrator-tools.spec.ts`
- Modify: `src/main/mcp/orchestrator-tools.ts`

- [ ] **Step 1: Write failing tests for `list_remote_nodes` and discovery text**

Add tests that create tools with a stub `listRemoteNodes` function, assert the new tool exists, assert sanitized node fields are returned, and assert `run_on_node` mentions Windows/remote-machine use cases.

- [ ] **Step 2: Run the failing tests**

Run:

```bash
npx vitest run src/main/mcp/__tests__/orchestrator-tools.spec.ts
```

Expected: fail because `list_remote_nodes` does not exist yet.

- [ ] **Step 3: Implement the contract**

Add these exports and context members in `orchestrator-tools.ts`:

```ts
export const ListRemoteNodesArgsSchema = z.object({});

export type ListRemoteNodesArgs = z.infer<typeof ListRemoteNodesArgsSchema>;

export interface RemoteNodeToolInfo {
  id: string;
  name: string;
  status: 'connecting' | 'connected' | 'degraded' | 'disconnected';
  platform: string;
  arch: string;
  supportedClis: string[];
  hasBrowserRuntime: boolean;
  hasBrowserMcp: boolean;
  hasDocker: boolean;
  gpuName?: string;
  gpuMemoryMB?: number;
  activeInstances: number;
  maxConcurrentInstances: number;
  workingDirectories: string[];
  lastHeartbeat?: number;
  latencyMs?: number;
}

export interface ListRemoteNodesResult {
  connectedCount: number;
  totalCount: number;
  nodes: RemoteNodeToolInfo[];
}

export type ListRemoteNodesFn = () => Promise<ListRemoteNodesResult>;
```

Add `listRemoteNodes?: ListRemoteNodesFn | null` to `OrchestratorToolRuntimeContext`, add the `list_remote_nodes` tool before `run_on_node`, and update `run_on_node` description to include "Windows PC", "other machine", "remote machine", and "call list_remote_nodes first".

- [ ] **Step 4: Run the focused test**

Run:

```bash
npx vitest run src/main/mcp/__tests__/orchestrator-tools.spec.ts
```

Expected: pass.

## Task 2: Forwarder Wiring

**Files:**
- Modify: `src/main/mcp/orchestrator-tools-mcp-forwarder.spec.ts`
- Modify: `src/main/mcp/orchestrator-tools-mcp-forwarder.ts`

- [ ] **Step 1: Write failing forwarder tests**

Update the exposed tool list expectation to include `list_remote_nodes`, and add a test that calls the tool with `{}` and expects `orchestrator_tools.list_remote_nodes`.

- [ ] **Step 2: Run the failing forwarder tests**

Run:

```bash
npx vitest run src/main/mcp/orchestrator-tools-mcp-forwarder.spec.ts
```

Expected: fail because the forwarder does not expose `list_remote_nodes`.

- [ ] **Step 3: Implement the forwarder tool**

Add a read-only tool definition that validates object args and forwards:

```ts
return client.call('orchestrator_tools.list_remote_nodes', args as Record<string, unknown>);
```

- [ ] **Step 4: Run the forwarder test**

Run:

```bash
npx vitest run src/main/mcp/orchestrator-tools-mcp-forwarder.spec.ts
```

Expected: pass.

## Task 3: Parent RPC Dispatch

**Files:**
- Modify: `src/main/mcp/orchestrator-tools-rpc-server.spec.ts`
- Modify: `src/main/mcp/orchestrator-tools-rpc-server.ts`

- [ ] **Step 1: Write failing RPC tests**

Add tests for:

- `orchestrator_tools.list_remote_nodes` dispatches to the matching tool.
- malformed non-empty payload is rejected by the empty schema.
- spawn-ineligible instances still retain `list_remote_nodes`.

- [ ] **Step 2: Run the failing RPC tests**

Run:

```bash
npx vitest run src/main/mcp/orchestrator-tools-rpc-server.spec.ts
```

Expected: fail because the RPC server does not know `orchestrator_tools.list_remote_nodes`.

- [ ] **Step 3: Implement RPC dispatch**

Import `ListRemoteNodesArgsSchema`, add `listRemoteNodes` to server options/tool factory deps, add `list_remote_nodes` to both full and leaf toolsets, and add a switch case:

```ts
case 'orchestrator_tools.list_remote_nodes': {
  const validated = ListRemoteNodesArgsSchema.parse(params.payload);
  const tools = this.getToolsForInstance(params.instanceId);
  const tool = tools.find((t) => t.name === 'list_remote_nodes');
  if (!tool) {
    throw new Error('list_remote_nodes tool unavailable');
  }
  return tool.handler(validated);
}
```

- [ ] **Step 4: Run the RPC tests**

Run:

```bash
npx vitest run src/main/mcp/orchestrator-tools-rpc-server.spec.ts
```

Expected: pass.

## Task 4: Runtime Integration

**Files:**
- Modify: `src/main/app/initialization-steps.ts`

- [ ] **Step 1: Write or extend tests only if an existing initialization seam covers this path**

This file is integration-heavy and already relies on many runtime singletons. If no focused seam exists, verify through TypeScript and the lower-level unit tests from Tasks 1-3.

- [ ] **Step 2: Inject node listing**

Import `resolveWorkerNodeTarget` from `../remote-node/worker-node-registry`. In the Orchestrator-tools RPC initialization, pass:

```ts
listRemoteNodes: async () => {
  const nodes = getWorkerNodeRegistry().getAllNodes();
  return {
    connectedCount: nodes.filter((node) => node.status === 'connected').length,
    totalCount: nodes.length,
    nodes: nodes.map((node) => ({
      id: node.id,
      name: node.name,
      status: node.status,
      platform: node.capabilities.platform,
      arch: node.capabilities.arch,
      supportedClis: node.capabilities.supportedClis,
      hasBrowserRuntime: node.capabilities.hasBrowserRuntime,
      hasBrowserMcp: node.capabilities.hasBrowserMcp,
      hasDocker: node.capabilities.hasDocker,
      ...(node.capabilities.gpuName ? { gpuName: node.capabilities.gpuName } : {}),
      ...(node.capabilities.gpuMemoryMB ? { gpuMemoryMB: node.capabilities.gpuMemoryMB } : {}),
      activeInstances: node.activeInstances,
      maxConcurrentInstances: node.capabilities.maxConcurrentInstances,
      workingDirectories: node.capabilities.workingDirectories,
      ...(node.lastHeartbeat ? { lastHeartbeat: node.lastHeartbeat } : {}),
      ...(node.latencyMs !== undefined ? { latencyMs: node.latencyMs } : {}),
    })),
  };
}
```

- [ ] **Step 3: Use consistent target resolution**

Replace the exact-match `args.node` lookup with `resolveWorkerNodeTarget(args.node, connected)`. Preserve the current single-node default and multiple-node explicit-target error.

- [ ] **Step 4: Run TypeScript after downstream tests are green**

Run:

```bash
npx tsc --noEmit
```

Expected: pass.

## Task 5: Runtime Discovery Text

**Files:**
- Modify: `src/main/mcp/mcp-manager.spec.ts`
- Modify: `src/main/mcp/mcp-manager.ts`

- [ ] **Step 1: Write failing search/discovery test**

Add a test that registers an Orchestrator Tools server with `run_on_node` and `list_remote_nodes`, searches `Windows PC`, and expects a selected remote-node tool. Also assert `formatRuntimeToolContext` includes an inspect-first hint for Orchestrator Tools summaries.

- [ ] **Step 2: Run the failing test**

Run:

```bash
npx vitest run src/main/mcp/mcp-manager.spec.ts
```

Expected: fail until descriptions/search hints include Windows/remote-machine language.

- [ ] **Step 3: Implement discovery copy**

Update server summary generation so the Orchestrator Tools server gets a specific `searchHint`:

```ts
'AIO can use connected remote worker nodes, including Windows PCs and other machines, through list_remote_nodes, run_on_node, and read_node_output. Inspect nodes before claiming reachability.'
```

Keep generic summaries for other MCP servers.

- [ ] **Step 4: Run the discovery test**

Run:

```bash
npx vitest run src/main/mcp/mcp-manager.spec.ts
```

Expected: pass.

## Task 6: Verification

**Files:**
- All modified source and test files.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npx vitest run src/main/mcp/__tests__/orchestrator-tools.spec.ts src/main/mcp/orchestrator-tools-mcp-forwarder.spec.ts src/main/mcp/orchestrator-tools-rpc-server.spec.ts src/main/mcp/mcp-manager.spec.ts
```

Expected: pass.

- [ ] **Step 2: Run main TypeScript check**

Run:

```bash
npx tsc --noEmit
```

Expected: pass.

- [ ] **Step 3: Run spec TypeScript check**

Run:

```bash
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: pass.

- [ ] **Step 4: Run lint**

Run:

```bash
npx eslint src/main/mcp/orchestrator-tools.ts src/main/mcp/orchestrator-tools-mcp-forwarder.ts src/main/mcp/orchestrator-tools-rpc-server.ts src/main/mcp/mcp-manager.ts src/main/app/initialization-steps.ts src/main/mcp/__tests__/orchestrator-tools.spec.ts src/main/mcp/orchestrator-tools-mcp-forwarder.spec.ts src/main/mcp/orchestrator-tools-rpc-server.spec.ts src/main/mcp/mcp-manager.spec.ts
```

Expected: pass.
