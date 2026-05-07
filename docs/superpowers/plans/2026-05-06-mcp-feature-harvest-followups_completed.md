# MCP Feature Harvest Followups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add HTTP MCP transport support and wire the existing MCP tool-search service into prompt/tool discovery after the April MCP management baseline has shipped.

**Architecture:** This plan does not duplicate `docs/superpowers/plans/2026-04-21-mcp-multi-provider-management_completed.md`. It starts only after that baseline provides persisted Orchestrator MCPs, provider config services, and capability summaries. The follow-up adds `connectHttp()` behind `McpManager`, then replaces eager MCP tool-description injection with `MCPToolSearchService`.

**Tech Stack:** Electron main process, MCP JSON-RPC transports, TypeScript, Vitest, existing MCP manager.

---

## Prerequisite Gate

- [x] `docs/superpowers/plans/2026-04-21-mcp-multi-provider-management_completed.md` is complete, or the April MCP spec has been explicitly superseded by a consolidated MCP plan.
- [x] `McpManager` has persisted Orchestrator registry behavior and typed HTTP rejection from the baseline.
- [x] Capability summaries and zero-tool warnings exist from the baseline.

Do not execute this plan before the gate is true.

## File Map

- Modify `src/main/mcp/mcp-manager.ts`: add HTTP branch and connection lifecycle.
- Create `src/main/mcp/transports/http-transport.ts`: streamable HTTP JSON-RPC transport wrapper.
- Test `src/main/mcp/transports/http-transport.spec.ts`.
- Modify `src/main/mcp/mcp-tool-search.ts`: keep service, add any missing query DTOs needed by runtime callers.
- Modify prompt/tool assembly files discovered by `rg "mcp-tool|MCPToolSearchService|tool descriptions|mcpConfig"` during implementation.
- Add tests around prompt assembly that currently eagerly injects MCP tool descriptions.

## Tasks

### Task 1: HTTP Transport

**Files:**
- Create: `src/main/mcp/transports/http-transport.ts`
- Modify: `src/main/mcp/mcp-manager.ts`
- Test: `src/main/mcp/transports/http-transport.spec.ts`

- [x] **Step 1: Write failing HTTP transport tests**

Create an in-process HTTP test server that accepts JSON-RPC request bodies and returns JSON-RPC responses. Assert:

```ts
await transport.connect();
await transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
expect(receivedRequests[0].method).toBe('ping');
await transport.disconnect();
```

Run:

```bash
npx vitest run src/main/mcp/transports/http-transport.spec.ts
```

Expected: fail because transport does not exist.

- [x] **Step 2: Implement transport**

Implement:

```ts
export class HttpTransport {
  constructor(options: { url: string; headers?: Record<string, string>; timeoutMs?: number }) {}
  async connect(): Promise<void> {}
  async send(message: unknown): Promise<void> {}
  async disconnect(): Promise<void> {}
  on(event: 'message' | 'error' | 'disconnected', cb: (...args: any[]) => void): void {}
}
```

Use `fetch`/Node HTTP APIs available in the Electron main process. Redact headers in logs. Treat non-2xx responses as transport errors.

- [x] **Step 3: Wire `McpManager`**

Add:

```ts
} else if (connection.config.transport === 'http') {
  await this.connectHttp(connection);
}
```

Store the HTTP transport on the connection and disconnect it in `disconnect()`.

- [x] **Step 4: Verify Task 1**

```bash
npx vitest run src/main/mcp/transports/http-transport.spec.ts src/main/mcp/mcp-manager.spec.ts
npx tsc --noEmit -p tsconfig.electron.json
```

### Task 2: Tool-Search Wiring

**Files:**
- Modify: `src/main/mcp/mcp-tool-search.ts`
- Modify: prompt/tool assembly files identified during implementation.
- Test: new or existing prompt assembly spec.

- [x] **Step 1: Find eager MCP injection sites**

Run:

```bash
rg -n "MCPToolSearchService|tool description|tool descriptions|mcp tools|mcpConfig|--mcp-config|tools:" src/main packages
```

Record the exact files in the implementation notes before editing.

- [x] **Step 2: Write failing prompt assembly test**

Create a test with 100 fake MCP tools and long descriptions. Assert the initial prompt/context contains compact server summaries but not every full tool description. Then query `MCPToolSearchService` and assert the relevant tool description is available.

- [x] **Step 3: Wire service**

Use `getMCPToolSearchService()` or add a singleton getter if missing. Prompt assembly should include:

```ts
{
  serverName,
  toolCount,
  resourceCount,
  promptCount,
  searchHint: 'Use MCP tool search for detailed tool descriptions when needed.'
}
```

Full tool descriptions are loaded only from search results.

- [x] **Step 4: Add telemetry**

Emit counters or OTel attributes for:

- total MCP tools;
- deferred MCP tools;
- loaded MCP tools after search.

- [x] **Step 5: Verify Task 2**

```bash
npx vitest run src/main/mcp/mcp-tool-search.spec.ts <prompt-assembly-spec>
npx tsc --noEmit -p tsconfig.electron.json
```

### Task 3: Full Slice Verification

- [x] **Step 1: Required gates**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
```

- [x] **Step 2: Manual verification**

Add an HTTP MCP server in `/mcp`, connect it, and confirm it reaches ready/discovered state. Then connect a large MCP config and confirm the spawned provider context no longer eagerly includes all full tool descriptions.

## Completion Validation

Completed and revalidated on 2026-05-07.

Implementation evidence:

- HTTP transport: `src/main/mcp/transports/http-transport.ts`, `src/main/mcp/mcp-manager.ts`.
- Tool-search runtime wiring: `McpManager.getRuntimeToolContext()` and `McpManager.formatRuntimeToolContext()`.
- Capability summaries and zero-tool warnings: `src/main/mcp/mcp-tool-search.ts`, MCP page/store tests.

Focused verification run:

```bash
npx vitest run src/main/mcp/transports/http-transport.spec.ts src/main/mcp/mcp-manager.spec.ts src/main/mcp/__tests__/multi-provider-service.spec.ts src/main/mcp/__tests__/mcp-core-services.spec.ts src/renderer/app/features/mcp/state/mcp-multi-provider.store.spec.ts src/renderer/app/features/mcp/mcp-page.component.spec.ts
```

Result: 6 files passed, 19 tests passed.
