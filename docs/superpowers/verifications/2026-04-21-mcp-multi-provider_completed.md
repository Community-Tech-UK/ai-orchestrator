# MCP Multi-Provider Verification

**Status:** Completed
**Validated:** 2026-05-07

This file started as the manual `npm run dev` checklist for the April MCP multi-provider slice. The checklist below is now backed by focused automated coverage plus full-app verification gates.

## Multi-Provider Tabs

1. [x] Open Settings -> MCP Servers. The tab strip shows Orchestrator, Shared, Claude, Codex, Gemini, Copilot.
2. [x] Click each provider tab. Existing provider config entries appear without exposing secret env values.
3. [x] Click Refresh. The state version changes and the table refreshes without clearing the existing MCP connection controls below it.

Evidence:

- `src/renderer/app/features/mcp/mcp-page.component.spec.ts`
- `src/renderer/app/features/mcp/state/mcp-multi-provider.store.spec.ts`
- `src/main/mcp/__tests__/multi-provider-service.spec.ts`

## Shared Fan-Out

4. [x] Create a shared MCP server through IPC or UI wiring: name `shared-fs`, transport `stdio`, command `npx`, args `-y,@modelcontextprotocol/server-filesystem`, targets Claude and Codex.
5. [x] Run fan-out. Confirm `~/.claude.json` and `~/.codex/config.toml` contain the server.
6. [x] Edit the Claude command to `DIFFERENT`, refresh, and confirm drift reports `drifted`.
7. [x] Resolve with `overwrite-target`; confirm drift returns to `in-sync`.

Evidence:

- `src/main/mcp/__tests__/multi-provider-service.spec.ts`
- `src/main/ipc/handlers/__tests__/mcp-handlers.spec.ts`

## Provider User Scope

8. [x] Add a Claude user-scope server and confirm it is written under `mcpServers` in `~/.claude.json`.
9. [x] Add a Codex user-scope server and confirm comments outside `[mcp_servers.*]` survive in `~/.codex/config.toml`.
10. [x] Delete those user-scope entries and confirm unrelated config keys remain.

Evidence:

- `src/main/mcp/adapters/__tests__/provider-adapters.spec.ts`
- `src/main/mcp/__tests__/mcp-repositories.spec.ts`

## Safety Settings

11. [x] Advanced Settings shows the MCP Safety section.
12. [x] `Clean up MCP config backups on quit` defaults on.
13. [x] Turn off backups and edit a provider server; no `.orch-bak` sibling is created.
14. [x] Turn on world-writable parent writes only after confirming the warning intent.

Evidence:

- `src/renderer/app/features/settings/advanced-settings-tab.component.ts`
- `src/renderer/app/core/state/settings.store.spec.ts`
- `src/main/mcp/__tests__/mcp-core-services.spec.ts`

## Runtime

15. [x] Connect an HTTP MCP server. It reaches initialized/discovered state.
16. [x] Connect a server with many tools. Tool search can find a specific tool without adding all descriptions to startup context.

Evidence:

- `src/main/mcp/transports/http-transport.spec.ts`
- `src/main/mcp/mcp-manager.spec.ts`
- `src/renderer/app/features/mcp/mcp-page.component.spec.ts`

## Verification Commands

Focused MCP verification:

```bash
npx vitest run src/main/mcp/transports/http-transport.spec.ts src/main/mcp/mcp-manager.spec.ts src/main/mcp/__tests__/multi-provider-service.spec.ts src/main/mcp/__tests__/mcp-core-services.spec.ts src/renderer/app/features/mcp/state/mcp-multi-provider.store.spec.ts src/renderer/app/features/mcp/mcp-page.component.spec.ts
```

Provider adapter and IPC verification:

```bash
npx vitest run src/main/mcp/adapters/__tests__/provider-adapters.spec.ts src/main/mcp/__tests__/mcp-repositories.spec.ts src/main/persistence/rlm/__tests__/mcp-migrations.spec.ts packages/contracts/src/schemas/__tests__/mcp-multi-provider.schemas.spec.ts src/main/ipc/handlers/__tests__/mcp-handlers.spec.ts
```
