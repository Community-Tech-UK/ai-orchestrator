# Runtime Plugin Package Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add package-manager lifecycle for Orchestrator runtime plugins: install from file/directory/zip/URL, validate before activation, track source metadata, update, prune, and uninstall.

**Architecture:** Keep `ProviderPluginsManager` on the existing `PLUGINS_*` provider-plugin channels. Add a separate runtime plugin package-manager service, channels, preload domain, and renderer methods for `PluginManager` runtime plugins only.

**Tech Stack:** Electron main process, TypeScript, Node fs/archive APIs, Zod contracts, Angular signals, Vitest.

---

## File Map

- Create `src/main/plugins/plugin-package-manager.ts`.
- Create `src/main/plugins/plugin-source-resolver.ts`.
- Create `src/main/plugins/plugin-validator.ts`.
- Create `src/main/plugins/plugin-dependency-resolver.ts`.
- Create `src/main/plugins/plugin-install-store.ts`.
- Modify `src/main/plugins/plugin-manager.ts` only where runtime plugin reload/list hooks are needed.
- Create `src/main/ipc/handlers/runtime-plugin-handlers.ts`.
- Modify `src/main/ipc/handlers/index.ts` and `src/main/ipc/ipc-main-handler.ts`.
- Create `packages/contracts/src/channels/runtime-plugin.channels.ts`.
- Modify `packages/contracts/src/channels/index.ts`.
- Extend `packages/contracts/src/schemas/plugin.schemas.ts`.
- Run `npm run generate:ipc`.
- Create `src/preload/domains/runtime-plugin.preload.ts`.
- Modify `src/preload/preload.ts`.
- Modify `src/renderer/app/core/services/ipc/plugin-ipc.service.ts` or create `runtime-plugin-ipc.service.ts`.
- Modify `src/renderer/app/features/plugins/plugins-page.component.ts`.
- Tests:
  - `src/main/plugins/plugin-package-manager.spec.ts`
  - `src/main/plugins/plugin-source-resolver.spec.ts`
  - `src/main/plugins/plugin-validator.spec.ts`
  - `src/main/ipc/handlers/runtime-plugin-handlers.spec.ts`

## Tasks

### Task 1: Contracts and IPC Channels

**Files:**
- Create: `packages/contracts/src/channels/runtime-plugin.channels.ts`
- Modify: `packages/contracts/src/channels/index.ts`
- Modify: `packages/contracts/src/schemas/plugin.schemas.ts`

- [x] **Step 1: Add channels**

```ts
export const RUNTIME_PLUGIN_CHANNELS = {
  RUNTIME_PLUGINS_LIST: 'runtime-plugins:list',
  RUNTIME_PLUGINS_VALIDATE: 'runtime-plugins:validate',
  RUNTIME_PLUGINS_INSTALL: 'runtime-plugins:install',
  RUNTIME_PLUGINS_UPDATE: 'runtime-plugins:update',
  RUNTIME_PLUGINS_PRUNE: 'runtime-plugins:prune',
  RUNTIME_PLUGINS_UNINSTALL: 'runtime-plugins:uninstall',
} as const;
```

Export from channel index.

- [x] **Step 2: Add package metadata schemas**

Add `PluginPackageSourceSchema`, `PluginDependencySchema`, `RuntimePluginInstallPayloadSchema`, `RuntimePluginValidatePayloadSchema`, and `RuntimePluginPrunePayloadSchema`. Keep existing plugin manifests valid by making package metadata optional.

- [x] **Step 3: Regenerate IPC**

```bash
npm run generate:ipc
```

- [x] **Step 4: Verify contracts**

```bash
npx vitest run packages/contracts/src/channels/__tests__/provider.channels.spec.ts packages/contracts/src/schemas/__tests__/plugin.schemas.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
```

### Task 2: Source Resolver and Validator

**Files:**
- Create: `src/main/plugins/plugin-source-resolver.ts`
- Create: `src/main/plugins/plugin-validator.ts`
- Create: `src/main/plugins/plugin-dependency-resolver.ts`
- Test: matching specs.

- [x] **Step 1: Write failing resolver tests**

Cover file, directory, zip, and URL source normalization:

```ts
expect(await resolver.resolve({ type: 'directory', value: fixtureDir }))
  .toMatchObject({ kind: 'directory', stagedPath: expect.any(String) });
```

- [x] **Step 2: Implement source resolver**

Resolver rules:

- file: copy to temp staging path;
- directory: copy recursively to temp staging path;
- zip: extract to temp staging path;
- URL: download to temp file, then file/zip handling based on content type or extension.

All extraction happens outside the active plugin directory.

- [x] **Step 3: Write failing validator tests**

Tests:

- missing `.codex-plugin/plugin.json` fails;
- missing required dependency fails with dependency name;
- optional missing dependency warns but does not fail;
- checksum mismatch fails when checksum provided.

- [x] **Step 4: Implement validator**

Read manifest using the existing plugin schema. Return:

```ts
type PluginValidationResult =
  | { ok: true; manifest: PluginManifest; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };
```

### Task 3: Package Manager Store and Operations

**Files:**
- Create: `src/main/plugins/plugin-install-store.ts`
- Create: `src/main/plugins/plugin-package-manager.ts`
- Test: `src/main/plugins/plugin-package-manager.spec.ts`

- [x] **Step 1: Write install/rollback tests**

Assert failed update restores previous plugin directory:

```ts
await manager.install(validSource);
await expect(manager.update(pluginId, invalidSource)).rejects.toThrow();
expect(await manager.list()).toContainEqual(expect.objectContaining({ id: pluginId, status: 'installed' }));
```

- [x] **Step 2: Implement install store**

Use ElectronStore or SQLite, following the existing plugin persistence pattern. Store:

- plugin ID;
- installed version;
- source type/value;
- cache path;
- last validation result;
- last updated timestamp.

- [x] **Step 3: Implement package manager operations**

Implement:

```ts
list(): Promise<RuntimePluginPackage[]>
validate(source): Promise<PluginValidationResult>
install(source): Promise<RuntimePluginPackage>
update(pluginId, source?): Promise<RuntimePluginPackage>
prune(): Promise<{ removed: string[] }>
uninstall(pluginId): Promise<void>
```

Install/update must validate staged content before copying into the active runtime plugin directory.

### Task 4: IPC and Renderer

**Files:**
- Create: `src/main/ipc/handlers/runtime-plugin-handlers.ts`
- Modify: `src/main/ipc/handlers/index.ts`
- Modify: `src/main/ipc/ipc-main-handler.ts`
- Create: `src/preload/domains/runtime-plugin.preload.ts`
- Modify: `src/preload/preload.ts`
- Modify: renderer IPC service and plugins page.

- [x] **Step 1: Register runtime plugin IPC**

Each handler validates payloads and returns `IpcResponse`. Do not call `getProviderPluginsManager()` from these handlers.

- [x] **Step 2: Expose preload domain**

Expose:

```ts
runtimePluginsList()
runtimePluginsValidate(source)
runtimePluginsInstall(source)
runtimePluginsUpdate(pluginId, source?)
runtimePluginsPrune()
runtimePluginsUninstall(pluginId)
```

- [x] **Step 3: Update plugins page**

Add source input accepting path or URL, validation status, update action, prune action, and install progress/error state.

### Task 5: Full Slice Verification

```bash
npx vitest run src/main/plugins/plugin-source-resolver.spec.ts src/main/plugins/plugin-validator.spec.ts src/main/plugins/plugin-package-manager.spec.ts src/main/ipc/handlers/runtime-plugin-handlers.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
```

Manual check: install a local runtime plugin directory, install a zip, reject a missing dependency, and prune a stale disabled plugin.

## Completion Validation

Completed on 2026-05-06.

- Focused red/green tests:
  - `npx vitest run src/main/plugins/plugin-source-resolver.spec.ts src/main/plugins/plugin-validator.spec.ts`
  - `npx vitest run src/main/plugins/plugin-package-manager.spec.ts src/main/plugins/plugin-manager.spec.ts`
  - `npx vitest run src/main/ipc/handlers/runtime-plugin-handlers.spec.ts`
  - `npx vitest run src/renderer/app/core/services/ipc/plugin-ipc.service.spec.ts`
  - `npx vitest run src/renderer/app/features/plugins/plugins-page.component.spec.ts`
- Combined focused suite:
  - `npx vitest run src/main/plugins/plugin-source-resolver.spec.ts src/main/plugins/plugin-validator.spec.ts src/main/plugins/plugin-package-manager.spec.ts src/main/plugins/plugin-manager.spec.ts src/main/ipc/handlers/runtime-plugin-handlers.spec.ts src/renderer/app/core/services/ipc/plugin-ipc.service.spec.ts src/renderer/app/features/plugins/plugins-page.component.spec.ts packages/contracts/src/channels/__tests__/runtime-plugin.channels.spec.ts packages/contracts/src/schemas/__tests__/plugin-schemas.spec.ts`
- Type/lint:
  - `npx tsc --noEmit`
  - `npx tsc --noEmit -p tsconfig.spec.json`
  - `npm run lint`
- Manual package-manager check:
  - Installed a temp runtime plugin directory.
  - Installed a single-file runtime plugin when an adjacent `.codex-plugin/plugin.json` sidecar manifest is present.
  - Installed a real zip package using `zip` and `extract-zip`.
  - Rejected a plugin with a missing required dependency.
  - Pruned a stale install record after deleting its active plugin directory.
- Fresh browser sanity:
  - Started Angular renderer on `http://127.0.0.1:4569/plugins`.
  - Verified runtime package cards and install/validate controls at desktop and mobile widths with a mocked Electron API.
- Full validation:
  - `npm run test` passed: 584 files, 5360 tests.
  - `npm run rebuild:native` restored Electron ABI 143 for `better-sqlite3`.
  - `npm run build` passed, including prebuild IPC sync, export verification, and contract alias checks.
