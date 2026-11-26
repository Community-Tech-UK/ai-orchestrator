# Existing Tab Browser Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe read-only Existing Tab Mode so a user can explicitly share the current Chrome tab with AI Orchestrator agents through Browser Gateway.

**Architecture:** Ship a Chrome extension that captures the active tab after a user gesture and sends a one-shot native message to an AI Orchestrator native host. The native host forwards the tab snapshot to the main-process Browser Gateway RPC server, which stores it as an `existing-tab` target using the existing target registry, policy checks, safe DTOs, and audit log.

**Tech Stack:** Electron main process TypeScript, Browser Gateway JSON-RPC socket, Chrome Manifest V3 extension JavaScript, Chrome native messaging stdio protocol, Vitest.

---

### Task 1: Existing Tab Attachment Model

**Files:**
- Modify: `packages/contracts/src/types/browser.types.ts`
- Modify: `packages/contracts/src/schemas/browser.schemas.ts`
- Test: `packages/contracts/src/schemas/__tests__/browser.schemas.spec.ts`

- [ ] **Step 1: Write failing schema tests**

Add tests that assert `BrowserAttachExistingTabRequestSchema` accepts a current `https` tab with `tabId`, `windowId`, `url`, `title`, `text`, and `screenshotBase64`, and rejects `chrome://settings`.

- [ ] **Step 2: Add request types and schemas**

Add `BrowserAttachExistingTabRequest` and `BrowserDetachExistingTabRequest`. The attach request must only accept `http` and `https` URLs, must cap text/screenshot payloads, and may optionally carry `allowedOrigins`.

- [ ] **Step 3: Run focused schema tests**

Run `npx vitest run packages/contracts/src/schemas/__tests__/browser.schemas.spec.ts`.

### Task 2: Existing Tab Store and Gateway Service

**Files:**
- Create: `src/main/browser-gateway/browser-extension-tab-store.ts`
- Modify: `src/main/browser-gateway/browser-gateway-service.ts`
- Modify: `src/main/browser-gateway/index.ts`
- Test: `src/main/browser-gateway/browser-extension-tab-store.spec.ts`
- Test: `src/main/browser-gateway/browser-gateway-service.spec.ts`

- [ ] **Step 1: Write failing store tests**

Assert that attaching a tab creates a stable pseudo profile id, target id, exact-origin allowlist, `mode: "existing-tab"`, and `driver: "extension"`.

- [ ] **Step 2: Write failing service tests**

Assert that `attachExistingTab()` returns an agent-safe target, `listTargets()` includes it, `snapshot()` returns redacted cached text, `screenshot()` returns cached base64, and blocked-origin attachments are denied.

- [ ] **Step 3: Implement store and service routing**

Create an in-memory store for selected existing tabs. Route existing-tab snapshot/screenshot through the store before managed-profile CDP code. Keep navigation and mutations on existing tabs outside this read-only slice.

- [ ] **Step 4: Run focused service tests**

Run `npx vitest run src/main/browser-gateway/browser-extension-tab-store.spec.ts src/main/browser-gateway/browser-gateway-service.spec.ts`.

### Task 3: Native Host RPC Entry

**Files:**
- Modify: `src/main/browser-gateway/browser-gateway-rpc-server.ts`
- Create: `src/main/browser-gateway/browser-extension-native-runtime.ts`
- Create: `src/main/browser-gateway/browser-extension-native-host.ts`
- Test: `src/main/browser-gateway/browser-gateway-rpc-server.spec.ts`
- Test: `src/main/browser-gateway/browser-extension-native-runtime.spec.ts`

- [ ] **Step 1: Write failing RPC tests**

Assert that `browser.extension_attach_tab` requires the native-host token, validates payload shape, forwards only to `attachExistingTab`, and does not require a provider child instance id.

- [ ] **Step 2: Implement runtime config**

Write a `0600` runtime config file under Electron `userData` containing the current socket path and a per-run native token. Generate an executable native-host wrapper that runs Electron as Node against `dist/main/browser-gateway/browser-extension-native-host.js`.

- [ ] **Step 3: Implement native host**

Read Chrome native-messaging frames from stdin, read the runtime config path from `AI_ORCHESTRATOR_BROWSER_NATIVE_CONFIG`, forward `attach_tab` to `browser.extension_attach_tab`, and write a native-messaging response frame to stdout.

- [ ] **Step 4: Run focused RPC/native tests**

Run `npx vitest run src/main/browser-gateway/browser-gateway-rpc-server.spec.ts src/main/browser-gateway/browser-extension-native-runtime.spec.ts`.

### Task 4: Chrome Extension Assets

**Files:**
- Create: `resources/browser-extension/manifest.json`
- Create: `resources/browser-extension/background.js`
- Create: `resources/browser-extension/popup.html`
- Create: `resources/browser-extension/popup.js`
- Modify: `electron-builder.json`

- [ ] **Step 1: Add extension assets**

The popup must share only the active tab after a user click. The background script must use `activeTab`, `scripting.executeScript`, `tabs.captureVisibleTab`, and `runtime.sendNativeMessage`.

- [ ] **Step 2: Add packaging resource**

Copy `resources/browser-extension` into packaged app resources so the user can load it unpacked or package it later.

- [ ] **Step 3: Run build verification**

Run `npm run build` and verify the extension assets are present in the source tree and included by builder config.

### Task 5: Verification

**Files:**
- Modified files from Tasks 1-4

- [ ] **Step 1: Run TypeScript checks**

Run `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.electron.json`, and `npx tsc --noEmit -p tsconfig.spec.json`.

- [ ] **Step 2: Run lint and tests**

Run `npm run lint`, focused browser gateway tests, and `npm run test`.

- [ ] **Step 3: Restore Electron native ABI after tests**

Run `npm run rebuild:native` because `npm run test` may rebuild `better-sqlite3` for the Node test runtime.

- [ ] **Step 4: Run production build**

Run `npm run build`.
