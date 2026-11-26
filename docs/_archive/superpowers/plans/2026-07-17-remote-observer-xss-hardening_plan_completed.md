# Remote Observer XSS Hardening Implementation Plan

Status: Completed on 2026-07-17

> **For agentic workers:** Execute this plan inline in the shared checkout. Do not
> dispatch subagents because the repository contains concurrent user work and the
> current task has not authorized delegation. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Remove stored DOM-XSS sinks from the remote observer and enforce the
browser boundary with a strict same-origin CSP and defensive response headers.

**Architecture:** Keep observer transport and protected APIs in
`RemoteObserverServer`. Extract the page shell, stylesheet, and browser client
into focused modules. Serve script and CSS as same-origin static assets, render
all dynamic data through DOM APIs, and reject non-HTTP(S) observer links.

**Tech Stack:** TypeScript, Node HTTP server, browser DOM APIs, JSDOM, Vitest.

## Global Constraints

- Preserve snapshot/event data and existing observer authentication semantics.
- Do not add an escaping helper as the primary defense; remove dynamic HTML
  parsing sinks.
- Do not weaken CSP with inline/eval allowances.
- Keep each new production TypeScript file under the 700-line repository limit.
- Preserve unrelated working-tree changes and do not commit active documents.

---

### Task 1: Reproduce the browser injection path with adversarial tests

**Files:**
- Create: `src/main/remote/observer-page.spec.ts`
- Create later: `src/main/remote/observer-page.ts`
- Create later: `src/main/remote/observer-client-script.ts`

**Interfaces:**
- `buildObserverPageResponse()` returns the HTML shell plus security headers.
- `OBSERVER_CLIENT_SCRIPT` is the exact browser program served in production.

- [x] Write a JSDOM test that executes the planned production client against a
  snapshot containing hostile instance, job, prompt, result, and message values.
- [x] Assert hostile strings render literally, no attacker-selected element is
  created, and no event handler runs.
- [x] Assert `javascript:` observer URLs are omitted and HTTP(S) links use
  `noreferrer`.
- [x] Assert the client source contains no `innerHTML`, `outerHTML`, or
  `insertAdjacentHTML` sink.
- [x] Write page-policy assertions for strict CSP and defensive headers.
- [x] Run the focused spec and confirm it fails because the planned production
  modules/behavior do not yet exist.

### Task 2: Extract and implement the secure observer page

**Files:**
- Create: `src/main/remote/observer-page.ts`
- Create: `src/main/remote/observer-client-script.ts`
- Create: `src/main/remote/observer-styles.ts`
- Modify: `src/main/remote/observer-server.ts`

**Interfaces:**
- Root page: `/`
- Static client: `/observer-client.js`
- Static stylesheet: `/observer.css`
- Existing protected APIs: unchanged.

- [x] Move the HTML shell and CSS into focused page/asset modules.
- [x] Replace string-template rendering with element creation, `textContent`,
  `replaceChildren`, property assignment, and fixed class allowlists.
- [x] Parse observer links with `URL` and allow only `http:`/`https:`.
- [x] Replace the authentication-failure body without an HTML parsing sink.
- [x] Serve the page and assets with correct content types, no-store caching,
  nosniff, no-referrer, frame denial, and strict CSP on the document.
- [x] Keep protected APIs and SSE behind the existing authorization boundary.
- [x] Run the focused page spec until it passes.

### Task 3: Prove real HTTP integration

**Files:**
- Create or extend: `src/main/remote/observer-server.spec.ts`

- [x] Start `RemoteObserverServer` on an available loopback port with a minimal
  fake instance manager.
- [x] Fetch `/`, `/observer-client.js`, and `/observer.css` through the real HTTP
  server and assert response content types, policy headers, and asset bodies.
- [x] Verify a protected API still rejects a missing token and accepts the
  observer token.
- [x] Stop the server in cleanup and run both focused observer specs together.

### Task 4: Review, canonical verification, and lifecycle closure

**Files:**
- Active: `docs/superpowers/specs/2026-07-17-remote-observer-xss-hardening_spec_planned.md`
- Active: `docs/superpowers/plans/2026-07-17-remote-observer-xss-hardening_plan.md`

- [x] Inspect the task-only diff for remaining HTML sinks, test weakening,
  dependency changes, secrets, and unrelated edits.
- [x] Run `npx tsc --noEmit`.
- [x] Run `npx tsc --noEmit -p tsconfig.spec.json`.
- [x] Run `npm run lint`.
- [x] Run `npm run check:ts-max-loc`.
- [x] Regenerate `docs/generated/architecture-inventory.json` in the task-only
  checkout and run `npm run verify:architecture`.
- [x] Run `npm run test:quiet`.
- [x] Obtain a fresh independent task-completion-gate verdict.
- [x] Record as-built behavior and evidence in both documents.
- [x] Rename the plan to `_plan_completed.md` and the spec to
  `_spec_completed.md` only after every agent-runnable gate passes.

## Final Verification State (as-built, 2026-07-17)

All verification ran in the detached task-only worktree
(`/private/tmp/aio-observer-xss-gate.HXd5Cu`, HEAD `677d7e02` plus exactly the
task files) because the shared checkout carries concurrent, unrelated IPC work.
Task files in the worktree and the shared checkout are byte-identical.

- Focused observer specs: 2 files, 6 tests pass
  (`observer-page.spec.ts`, `observer-server.spec.ts`).
- Full suite on the final code: `npm run test:quiet` → 1503 files,
  14,848 tests passed, exit 0. The earlier `ENOTEMPTY` temp-cleanup flake in
  untouched files did not recur in either of the two final full runs
  (14,847 then 14,848 green).
- `npx tsc --noEmit` and `npx tsc --noEmit -p tsconfig.spec.json`: pass.
- `npm run lint`: all files pass. `npm run check:ts-max-loc`: pass.
- `npm run verify:architecture` (import boundaries + regenerated
  `docs/generated/architecture-inventory.json`): pass.
- Independent task-completion gate (Codex, read-only, fresh session): first
  verdict FAILED and flagged a real residual — the token-protected SSE route
  still sent `Access-Control-Allow-Origin: *`. As-built change beyond the task
  list: that header was removed from `handleSse` in `observer-server.ts`, and a
  new integration test asserts the stream returns 401 without a token,
  `text/event-stream` with one, and no ACAO header. A second fresh gate verdict
  on the final code: PASS on all eight invariants, no blocking findings.
- Auth semantics, snapshot/event shapes, and SSE behavior are otherwise
  unchanged; no dependency changes; no unrelated files edited.
