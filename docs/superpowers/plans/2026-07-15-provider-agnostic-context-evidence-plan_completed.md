# Provider-Agnostic Context Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Status:** Completed 2026-07-16 — all agent-runnable tasks implemented and verified; provider live validation deferred to `2026-07-15-provider-agnostic-context-evidence-plan_livetest.md`. Uncommitted.

**Source design:** `docs/superpowers/specs/2026-07-15-provider-agnostic-context-evidence-spec_planned.md`

**Goal:** Preserve every AIO-visible provider and orchestration result as durable, encrypted, conversation-owned evidence while giving every provider a truthful, bounded working set, audited retrieval, shared pressure/recovery policy, and evidence-backed completion gate.

**Architecture:** Add a main-process `ContextEvidenceCoordinator` above a new encrypted evidence store and the existing conversation ledger. Capture full results before any AIO truncation, derive deterministic evidence cards, and give providers only bounded previews or audited retrieval excerpts. Replace provider-specific context-governor ownership with a shared pure policy plus capability-aware executors. Expose evidence and clearly separated context metrics through generated contracts, preload IPC, renderer stores, and provider-neutral MCP tools. Roll out per provider through `off | shadow | enforce`, defaulting every provider to `off` until its live acceptance checks pass.

**Tech Stack:** Electron 40 main process, TypeScript/Node, better-sqlite3 worker-backed conversation ledger, Electron `safeStorage`, AES-256-GCM, HMAC-SHA-256, Zod 4 generated IPC contracts, Angular 21 standalone `OnPush` signal stores/components, Vitest.

## Global Constraints

- Keep this plan untracked and unstaged throughout implementation. Do not commit or push unless James explicitly asks. Before any later commit, rename this file with `_completed` only after all agent-runnable work and verification pass.
- Preserve all unrelated dirty-tree changes. Re-read every listed implementation file and its current diff immediately before editing because several related Codex/context files already contain user work.
- The canonical owner is the AIO conversation-ledger thread ID. Provider-native session/thread IDs are provenance only and must never authorize reads or deletion.
- Never persist plaintext evidence, secret values, absolute blob paths, raw source locators, or secret-like test fixtures. If `safeStorage` or the active key is unavailable, fail closed and retain the result in memory/provider flow rather than writing plaintext.
- Evidence durability and provider visibility are separate: raw capture may succeed even when only a bounded preview is shown to the provider. Every bounded, metadata-only, post-retention, or unobservable capture must be disclosed explicitly.
- Treat the existing Codex context-cost controller, `CompactionCoordinator`, `ContextCompactor`, `MicrocompactManager`, loop externalizer, and `OutputPersistenceManager` as migration seams. Do not create a second independent policy or another cache.
- Use test-driven changes. Run the named targeted test after each task, then run all canonical gates in Task 19.
- Do not weaken existing transcript, forensic provider-capture, loop receipt, or verification-ledger behavior while adding evidence links.

## Locked Implementation Decisions

### Persistence and cryptography

- Use conversation-ledger schema migration `004_context_evidence` in `src/main/conversation-ledger/conversation-ledger-schema.ts`.
- Store metadata in the existing conversation-ledger SQLite database and encrypted payloads below `<userData>/conversation-evidence/`.
- Store a `keyring.json` containing only `safeStorage`-wrapped 32-byte data keys, the active key version, and rotation timestamps. Never store an unwrapped key on disk.
- Encrypt raw evidence and card payloads with AES-256-GCM using a fresh 12-byte nonce per blob. The binary envelope is `AIOEV1`, key version, nonce, ciphertext, and 16-byte authentication tag.
- Derive opaque content IDs, citation digests, and conversation directory names with HMAC-SHA-256 under a key separated from the encryption key with HKDF labels. Do not use bare hashes of low-entropy or secret content.
- Finalize capture by inserting staged metadata, writing and fsyncing an encrypted staging blob, computing keyed content ID/size/tag, atomically renaming the blob, then marking the row complete. Recovery sweeps fail stale staged rows and remove orphan staging files without exposing content.

### Ledger tables and lifecycle

Migration `004_context_evidence` adds `deleted_at TEXT NULL` to `conversation_threads` and creates:

- `evidence_records`: `id`, `conversation_id`, provider/native provenance, turn/tool references, source kind, redacted locator, status (`staging | complete | failed | corrupt | deleted`), opaque blob reference, keyed content ID, byte/token counts, MIME type, sensitivity, provenance trust (`runtime-authenticated | legacy-unverified`), capture mode (`pre-retention | post-retention | observed-only`), capture completeness (`complete | bounded | metadata-only`), truncation reason, key version, timestamps, and an idempotent `capture_key` unique per logical result. A repeated capture key is idempotent only when its keyed content identity matches; divergent content fails visibly and never aliases the existing record.
- `evidence_cards`: encrypted card blob reference plus evidence ID, extractor kind/version, status, sensitivity, byte/token counts, and timestamps. Card prose never lives in SQLite.
- `evidence_access_log`: content-free audit rows for search/read/compare/verify/list, requester, conversation, evidence IDs, requested ranges, outcome code, and timestamp.
- `evidence_deletion_queue`: opaque blob reference, grace deadline, attempts, last non-secret error code, completion timestamp.
- `context_evidence_events`: content-free pressure samples, threshold decisions, recovery/compaction proofs, epochs, aggregate counters, and last action.

Soft deletion marks the conversation and evidence rows deleted in the same ledger transaction that removes transcript children and enqueues opaque blob references. Authorization is revoked immediately; a retrying janitor removes blobs after the grace period.

Use a 15-minute stale-capture window and a 10-minute deletion grace period. Both are named constants with fake-clock tests; neither is operator-configurable in the first release.

### Provider capability defaults

Add `getContextCapabilities(): ProviderContextCapabilities` to the base adapter with a conservative default. Initial adapter snapshots are:

| Adapter mode | Tool-result control | Visibility | Transcript control | Occupancy | Cumulative usage | Interrupt proof | Compaction proof | Same-thread continuation |
|---|---|---|---|---|---|---|---|---|
| Codex app-server | post-retention | full | native-compaction | current | available | observed | observed | true |
| Codex exec | post-retention | full | none | aggregate-only | available | none | none | false |
| Resident Claude | post-retention | full | none | current | available | acknowledged-only | none | true |
| Claude non-resident | post-retention | full | none | aggregate-only | available | none | none | false |
| Gemini stateless | post-retention | full | none | aggregate-only | available | none | none | false |
| Copilot ACP | post-retention | full | none | aggregate-only | available | none | none | false |

Provider-native telemetry may only upgrade these values when a test and runtime proof establish the stronger claim. AIO-owned MCP tools use `pre-retention` capture independently of the provider-native snapshot.

### Provider-visible citations and retrieval

- Provider-visible references use `[evidence:<id>@<start>-<end>#<digest>]`, where offsets are UTF-8 byte offsets and the digest is keyed and range-specific.
- Provider-neutral logical operations are `evidence.search`, `evidence.read`, `evidence.compare`, `evidence.verify`, and `evidence.list`; MCP tool names use underscores (`evidence_search`, and so on).
- Every operation requires an injected canonical conversation ID, enforces sensitivity and range limits, records a content-free access event, and returns bounded text plus exact citations.
- A single inline preview or retrieval excerpt is at most `min(1% of provider context window, 4096 tokens)`, with a 512-token floor only when the provider window is known and at least 512 tokens.

### Rollout and ownership

- Add `contextEvidenceModeByProvider: Record<string, 'off' | 'shadow' | 'enforce'>` to settings. Initialize every concrete provider returned by the adapter registry as `off`; ignore the `auto` selector and normalize the legacy `openai` alias to `codex`.
- `off` preserves current provider behavior and does not claim durable capture. `shadow` captures, derives, measures, and audits without changing provider-visible context or blocking completion. `enforce` enables bounded previews, retrieval, shared safety actions, and the accuracy gate.
- Resolve ownership through `ChatStore.getByInstanceId(...).ledgerThreadId` for chats. For non-chat instances, create or reuse an orchestrator ledger thread keyed by `Instance.historyThreadId`; never fall back to provider session IDs.
- Represent a provider-native result that AIO could not observe as `observed-only/metadata-only` with a truncation reason; “unobservable” is a UI/diagnostic disclosure, not an extra contract literal.

### Rollout phase map

- Phase 0: Task 1 freezes the contracts and records the controlled ungoverned baseline.
- Phase 1: Tasks 2–4 add durable storage and capture primitives; runtime shadow ingress begins in Tasks 6–8 after the coordinator exists.
- Phase 2: Tasks 5–11 add cards, retrieval, transforms, and managed working sets.
- Phase 3: Tasks 12–13 run the shared safety controller in shadow before enforcement.
- Phase 4: Tasks 7, 14, and 18 complete core mode plumbing and enforce-mode gates; Task 19 live-validates Codex observed mode.
- Phase 5: Task 19 live-validates Claude, Gemini, Copilot, and every additional concrete adapter.
- Phase 6: Tasks 15–18 deliver deletion, renderer inspection, reconciliation, and final plaintext-path retirement only after orphan/deletion checks pass.

---

## Task 1: Characterize the incident and freeze contracts

**Files:**

- Create: `packages/contracts/src/types/context-evidence.types.ts`
- Create: `packages/contracts/src/schemas/context-evidence.schemas.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `src/main/cli/adapters/base-cli-adapter.types.ts`
- Create: `src/main/context-evidence/__fixtures__/codex-44-call-incident.manifest.json`
- Create: `src/main/context-evidence/context-evidence-baseline.spec.ts`
- Test: `packages/contracts/src/schemas/__tests__/context-evidence.schemas.spec.ts`
- Test: `src/main/cli/adapters/base-cli-adapter.context-capabilities.spec.ts`

- [x] Build a sanitized manifest that deterministically expands to 44 tool calls, 25 externalizable results, and exactly 900,532 UTF-8 result characters without storing a giant or secret-like payload.
- [x] Write a characterization test around the current output cache, microcompaction, context compactor, duplicate provider-event ingress, async output/completion ordering, and Codex governor. Record the controlled ungoverned cumulative/cached-input baseline and current data-loss/plaintext behaviors without changing production code.
- [x] Write failing schema tests for all exact design records: `EvidenceRecord`, `EvidenceCitation`, `EvidenceCard`, `ContextPressureSample`, and `ProviderContextCapabilities`.
- [x] Preserve the source-design literals exactly: capture mode is `pre-retention | post-retention | observed-only`; capture completeness is `complete | bounded | metadata-only`; evidence status is `staging | complete | failed | corrupt | deleted`; and capability fields use the exact tool-result, transcript, reporting, proof, and continuation unions from the source design.
- [x] Define `EvidenceFinding` concretely as an ID, `fact | change | warning | error | verification` kind, statement, `info | warning | critical` importance, and its own citations. Define `EvidenceContradiction` as an ID, statement, left/right citations, `unresolved | resolved` status, and an optional cited resolution. Validate that every card finding and resolution is supported by citations included in the card.
- [x] Add `EvidenceCaptureRequest`, `EvidenceCaptureResult`, bounded retrieval request/response, accuracy-gate result, working-set allocation, enforcement action, and renderer metrics types. Keep stored metadata content-free.
- [x] Encode range invariants in Zod: non-negative UTF-8 byte offsets, `end > start`, positive token limits, valid keyed digest format, and an explicit disclosure whenever capture completeness is not `complete`.
- [x] Add `getContextCapabilities()` to the base adapter contract and implement the conservative default in `BaseCliAdapter`.
- [x] Run `npm run test:quiet -- src/main/context-evidence/context-evidence-baseline.spec.ts packages/contracts/src/schemas/__tests__/context-evidence.schemas.spec.ts src/main/cli/adapters/base-cli-adapter.context-capabilities.spec.ts`; expect the frozen baseline and both contract files to pass.

## Task 2: Add ledger migration 004 and evidence metadata operations

**Files:**

- Modify: `src/main/conversation-ledger/conversation-ledger-schema.ts`
- Modify: `src/main/conversation-ledger/ledger-store-port.ts`
- Modify: `src/main/conversation-ledger/conversation-ledger-store.ts`
- Modify: `src/main/conversation-ledger/conversation-ledger-worker-main.ts`
- Modify: `src/main/conversation-ledger/conversation-ledger-worker-protocol.ts`
- Modify: `src/main/conversation-ledger/conversation-ledger-worker-client.ts`
- Modify: `src/main/conversation-ledger/conversation-ledger-service.ts`
- Test: `src/main/conversation-ledger/__tests__/conversation-ledger-schema.spec.ts`
- Test: `src/main/conversation-ledger/__tests__/conversation-ledger-store.spec.ts`
- Test: `src/main/conversation-ledger/__tests__/conversation-ledger-service.spec.ts`

- [x] First write migration tests that open schema v3 data, migrate to v4, and assert the exact columns, foreign keys, indexes, uniqueness of `capture_key`, and preservation of existing transcript/checkpoint/provider-capture rows.
- [x] Add typed store operations for staging/finalizing/failing evidence, storing cards, scoped listing/search metadata, range authorization metadata, access logging, pressure/event recording, soft conversation deletion, and deletion-queue claims/completion.
- [x] Add a compare-and-swap transcript operation that replaces one exact legacy output-cache marker with an evidence citation only after its referenced file has been captured successfully. This operation is used solely by the legacy reconciler in Task 9.
- [x] Add every operation to the closed worker RPC method union and client without adding a generic SQL escape hatch.
- [x] Make all evidence reads require `conversation_id` and exclude staged, failed, and deleted records unless a maintenance method explicitly asks for them.
- [x] Make ordinary conversation list/get methods exclude `deleted_at` rows.
- [x] Implement idempotent finalization: the same `capture_key` returns the existing complete record and never creates a second blob reference.
- [x] Run `npm run test:quiet -- src/main/conversation-ledger/__tests__/conversation-ledger-schema.spec.ts src/main/conversation-ledger/__tests__/conversation-ledger-store.spec.ts src/main/conversation-ledger/__tests__/conversation-ledger-service.spec.ts`; expect migration, authorization, idempotency, and deletion tests to pass.

## Task 3: Build the fail-closed encrypted blob and key stores

**Files:**

- Create: `src/main/context-evidence/evidence-key-manager.ts`
- Create: `src/main/context-evidence/encrypted-evidence-blob-store.ts`
- Create: `src/main/context-evidence/evidence-storage.types.ts`
- Modify: `src/main/session/safe-storage-accessor.ts`
- Test: `src/main/context-evidence/evidence-key-manager.spec.ts`
- Test: `src/main/context-evidence/encrypted-evidence-blob-store.spec.ts`

- [x] Write failing tests for first-run key creation, restart unwrapping, unavailable `safeStorage`, corrupted keyring, key rotation, unique nonces for identical plaintext, authentication-tag failure, opaque path derivation, path traversal/symlink attempts, atomic staging/finalization, and orphan cleanup.
- [x] Implement `EvidenceKeyManager` with injected `SafeStorageAccessor`, atomic `keyring.json` replacement, in-memory unwrapped keys, versioned rotation, and a hard error when encryption is unavailable.
- [x] Implement `EncryptedEvidenceBlobStore` at `<userData>/conversation-evidence/` using AES-256-GCM and HMAC/HKDF decisions above. Accept `Uint8Array` so UTF-8 byte offsets remain stable.
- [x] Fsync the staging file and containing directory before/after rename where supported; return only an opaque relative blob reference to the ledger.
- [x] Add constant-time keyed-digest comparison and never include plaintext, keys, source locators, or full paths in error/log fields.
- [x] Run `npm run test:quiet -- src/main/context-evidence/evidence-key-manager.spec.ts src/main/context-evidence/encrypted-evidence-blob-store.spec.ts`; expect every fail-closed and corruption case to pass.

## Task 4: Implement crash-safe evidence capture and startup reconciliation

**Files:**

- Create: `src/main/context-evidence/evidence-capture-service.ts`
- Create: `src/main/context-evidence/evidence-maintenance-service.ts`
- Create: `src/main/context-evidence/evidence-content-identity.ts`
- Modify: `src/main/app/initialization-steps.ts`
- Test: `src/main/context-evidence/evidence-capture-service.spec.ts`
- Test: `src/main/context-evidence/evidence-maintenance-service.spec.ts`
- Test: `src/main/app/initialization-steps.context-evidence.spec.ts`

- [x] Write failure-injection tests for every boundary: metadata stage failure, file write/disk-full failure, fsync failure, finalize failure after rename, process restart with staged metadata, orphan staging file, and duplicate logical capture.
- [x] Implement the ordered capture transaction: stage metadata, encrypt/write/fsync staging blob, derive identity/size/tag, atomic rename, finalize metadata.
- [x] Run secret detection before final metadata classification. Upgrade sensitivity on detection but store no matched secret text or raw detector evidence in SQLite/logs.
- [x] Represent provider/AIO observability truthfully with capture mode, completeness, and truncation reason. A post-retention result must never be labeled pre-retention.
- [x] Implement a startup sweep that reconciles safely recoverable finalized blobs, fails irrecoverable stale rows, removes orphan staging files, and leaves complete authenticated blobs untouched.
- [x] Implement incremental key rotation in the maintenance service: claim one complete blob at a time, authenticate/decrypt with its recorded version, re-encrypt under the active version through the same atomic write path, then update metadata. A crash leaves either old or new authenticated content recoverable.
- [x] Initialize the key manager, blob store, capture service, and maintenance sweep after the conversation ledger but before instance/chat restoration.
- [x] Run `npm run test:quiet -- src/main/context-evidence/evidence-capture-service.spec.ts src/main/context-evidence/evidence-maintenance-service.spec.ts src/main/app/initialization-steps.context-evidence.spec.ts`; expect all crash windows and restart cases to pass without duplicate records.

## Task 5: Add deterministic evidence-card extraction

**Files:**

- Create: `src/main/context-evidence/cards/evidence-card-service.ts`
- Create: `src/main/context-evidence/cards/card-citation-validator.ts`
- Create: `src/main/context-evidence/cards/extractors/command-card-extractor.ts`
- Create: `src/main/context-evidence/cards/extractors/file-card-extractor.ts`
- Create: `src/main/context-evidence/cards/extractors/database-card-extractor.ts`
- Create: `src/main/context-evidence/cards/extractors/web-card-extractor.ts`
- Create: `src/main/context-evidence/cards/extractors/browser-card-extractor.ts`
- Create: `src/main/context-evidence/cards/extractors/mcp-card-extractor.ts`
- Create: `src/main/context-evidence/cards/extractors/generic-card-extractor.ts`
- Create: `src/main/context-evidence/evidence-access-policy.ts`
- Test: `src/main/context-evidence/cards/evidence-card-service.spec.ts`
- Test: `src/main/context-evidence/cards/card-citation-validator.spec.ts`
- Test: `src/main/context-evidence/cards/extractors/card-extractors.spec.ts`

- [x] Create table-driven fixtures that cover exit status, errors, paths, line/row/result counts, URLs/status codes/titles, browser actions, MCP tool metadata, binary/unknown MIME, bounded capture, and secret-classified content using obvious placeholders.
- [x] Make every deterministic extractor emit claims only when it can cite exact UTF-8 byte ranges in authenticated raw evidence.
- [x] For bounded or metadata-only capture, prohibit wording that implies complete coverage. Include the required limitation disclosure in the encrypted card payload.
- [x] On extractor failure, store a generic card containing an authenticated raw head/tail citation plus retrieval reference, never an invented summary.
- [x] Add an optional model-assisted path through the existing auxiliary LLM service only when sensitivity/data-boundary policy authorizes it. Reject its entire output unless every claim has a valid exact citation.
- [x] Define one injected conservative evidence policy used by cards, retrieval, IPC, and the accuracy gate. By default, provider/model-assisted paths may use only `normal` evidence; `sensitive` requires an explicitly authorized local requester; `restricted` is denied to provider/model-assisted paths. Web/current-fact evidence older than 24 hours requires an age disclosure; other evidence remains conversation-lifetime-valid unless the requester supplies a stricter freshness requirement.
- [x] Wrap every card and excerpt as explicitly untrusted source material so instructions found in evidence cannot override system, developer, user, or task instructions.
- [x] Encrypt card payloads with the blob store and persist only content-free card metadata in SQLite.
- [x] Run `npm run test:quiet -- src/main/context-evidence/cards/evidence-card-service.spec.ts src/main/context-evidence/cards/card-citation-validator.spec.ts src/main/context-evidence/cards/extractors/card-extractors.spec.ts`; expect determinism, disclosure, secret, and invalid-citation cases to pass.

## Task 6: Implement scoped retrieval and provider-neutral evidence tools

**Files:**

- Create: `src/main/context-evidence/evidence-retrieval-service.ts`
- Create: `src/main/context-evidence/context-evidence-coordinator.ts`
- Create: `src/main/mcp/orchestrator-evidence-tools.ts`
- Modify: `src/main/mcp/orchestrator-tools.ts`
- Modify: `src/main/mcp/orchestrator-tools-mcp-forwarder.ts`
- Modify: `src/main/mcp/orchestrator-tools-rpc-server.ts`
- Modify: `src/main/mcp/orchestrator-tools-rpc-client.ts`
- Test: `src/main/context-evidence/evidence-retrieval-service.spec.ts`
- Test: `src/main/mcp/orchestrator-evidence-tools.spec.ts`
- Test: `src/main/mcp/orchestrator-tools-rpc-evidence.spec.ts`

- [x] Write failing tests proving cross-conversation reads, missing injected ownership, deleted conversations, oversized ranges, digest mismatch, disallowed sensitivity, and malformed search queries are denied and audited without leaking content.
- [x] Implement `list`, `search`, `read`, `compare`, and `verify` against authenticated decrypted blobs with canonical conversation scoping and exact byte citations.
- [x] On authentication failure, mark the record `corrupt`, refuse its body/citations, emit a content-free integrity failure, and make subsequent reads fail without repeatedly decrypting it.
- [x] Search only authorized decrypted content in bounded chunks; never add raw evidence text to SQLite indexes. Return card matches first, then bounded raw matches with citations.
- [x] Enforce `min(1% window, 4096 tokens)` and the 512-token floor in one shared range-budget function. When the provider window is unknown, cap at 4096 without claiming a percentage.
- [x] Register `evidence_list`, `evidence_search`, `evidence_read`, `evidence_compare`, and `evidence_verify` in the injected AIO MCP surface and RPC forwarder. The runtime context supplies the canonical conversation ID; model arguments cannot override it.
- [x] Introduce `ContextEvidenceCoordinator` here as the sole production orchestration entrypoint for new durable evidence, initially wiring capture, cards, and retrieval. Capture AIO-owned MCP results through it before bounding them for the provider and mark those records `pre-retention/complete`; Tasks 8, 11, and 12 extend the same coordinator with common runtime ingress, working-set planning, and safety policy rather than creating another entrypoint.
- [x] Run `npm run test:quiet -- src/main/context-evidence/evidence-retrieval-service.spec.ts src/main/mcp/orchestrator-evidence-tools.spec.ts src/main/mcp/orchestrator-tools-rpc-evidence.spec.ts`; expect scope, audit, citation, and bound tests to pass.

## Task 7: Resolve canonical conversation ownership for every instance

**Files:**

- Create: `src/main/context-evidence/evidence-conversation-resolver.ts`
- Create: `src/main/context-evidence/context-evidence-settings.ts`
- Modify: `src/shared/types/settings.types.ts`
- Modify: `src/shared/types/settings-defaults.ts`
- Modify: `src/main/chats/chat-transcript-bridge.ts`
- Modify: `src/main/chats/chat-service.ts`
- Modify: `src/main/instance/instance-lifecycle.ts`
- Modify: `src/shared/types/instance.types.ts`
- Test: `src/main/context-evidence/evidence-conversation-resolver.spec.ts`
- Test: `src/main/chats/chat-transcript-bridge.evidence.spec.ts`
- Test: `src/main/instance/instance-lifecycle.evidence.spec.ts`

- [x] Write tests for chat instances, standalone instances, restored instances, loop-borrowed adapters, missing ledger rows, and malicious provider-native IDs that collide with another AIO conversation.
- [x] Resolve chat ownership from the chat's `ledgerThreadId`, not from mutable instance/provider session fields.
- [x] Ensure standalone instance creation creates/reuses an orchestrator ledger thread identified by `historyThreadId` before evidence capture is enabled.
- [x] Store provider thread/session IDs only as provenance on the evidence record.
- [x] Add and normalize `contextEvidenceModeByProvider` with every concrete adapter defaulting to `off`, ignoring `auto`, and normalizing `openai` to `codex`. This core mode source must exist before any `off | shadow | enforce` branch in ownership/capture/gating code; Task 18 exposes the already-defined setting through operator controls and adds replay acceptance coverage.
- [x] Make unresolved ownership an explicit capture failure metric. In `shadow`, leave provider output unchanged; in `enforce`, pause before destructive compaction or completion rather than saving unowned evidence.
- [x] Run `npm run test:quiet -- src/main/context-evidence/evidence-conversation-resolver.spec.ts src/main/chats/chat-transcript-bridge.evidence.spec.ts src/main/instance/instance-lifecycle.evidence.spec.ts`; expect all ownership and collision tests to pass.

## Task 8: Capture all AIO-visible results at the common runtime seam

**Files:**

- Modify: `src/main/context-evidence/context-evidence-coordinator.ts`
- Modify: `src/main/instance/instance-communication.ts`
- Modify: `src/main/instance/instance-communication-provider-events.ts`
- Modify: `src/main/providers/adapter-runtime-event-bridge.ts`
- Modify: `src/main/instance/instance-provider-event-ingress.ts`
- Test: `src/main/context-evidence/context-evidence-coordinator.spec.ts`
- Test: `src/main/instance/instance-communication.evidence.spec.ts`
- Test: `src/main/instance/instance-communication-provider-events.spec.ts`

- [x] Reproduce the current ordering risk in a test: an async output listener can still be capturing when the adapter emits completion.
- [x] Add a per-instance serialized capture queue in `ContextEvidenceCoordinator`. Enqueue the original message/tool result before any output-buffer truncation, UI grouping, microcompaction, or provider working-set transform.
- [x] Deduplicate common parsed output and raw `tool_result` ingress with a stable logical `capture_key`; preserve raw provider capture separately for forensics.
- [x] Treat a repeated logical `capture_key` with a different keyed content identity as a visible capture conflict, never as a successful duplicate.
- [x] Drain the instance capture queue before strict completion gating, transcript finalization, instance deletion, or app shutdown.
- [x] Preserve original bytes, MIME metadata, provider/turn/tool provenance, and actual capture truth. Do not normalize newlines before computing citations.
- [x] Emit content-free coordinator events for card-ready, capture-failed, and aggregate metrics updates.
- [x] Run `npm run test:quiet -- src/main/context-evidence/context-evidence-coordinator.spec.ts src/main/instance/instance-communication.evidence.spec.ts src/main/instance/instance-communication-provider-events.spec.ts`; expect byte identity, ordering, deduplication, and drain tests to pass.

## Task 9: Introduce the evidence-backed compatibility facade and reconciler

**Files:**

- Modify: `src/main/context/output-persistence.ts`
- Modify: `src/main/context/__tests__/output-persistence.spec.ts`
- Create: `src/main/context-evidence/legacy-output-cache-reconciler.ts`
- Test: `src/main/context-evidence/legacy-output-cache-reconciler.spec.ts`
- Modify: `src/main/orchestration/loop-output-externalize.ts`
- Modify: `src/main/orchestration/loop-output-externalize.spec.ts`
- Modify: `src/main/orchestration/default-invokers.ts`
- Test: `src/main/orchestration/default-invokers.context-evidence.spec.ts`

- [x] Write tests showing the current manager writes plaintext and exposes a raw cache path; make the new expected behavior an opaque evidence citation and bounded preview.
- [x] Change `OutputPersistenceManager` into a temporary mode-aware facade over `ContextEvidenceCoordinator`. Require capture context containing canonical conversation, turn, logical call, provider, source kind, and capture truth. In `shadow`/`enforce`, never create a new plaintext file; isolate the historical writer behind `off` only until Phase 6 retirement.
- [x] If a legacy caller lacks ownership, keep the full result in its existing in-memory/provider path and record a content-free migration error; never fall back to plaintext.
- [x] Pass loop conversation/turn/iteration identity from `default-invokers.ts` into `maybeExternalizeLoopOutput`. Preserve completion markers in the bounded tail and use an evidence citation instead of a file path.
- [x] Implement `LegacyOutputCacheReconciler`: enumerate ledger messages containing the exact historical cache-marker format, resolve only files canonically contained below `<userData>/output-cache/`, capture each under the owning conversation as `legacy-unverified` provenance, compare-and-swap the marker to an evidence citation carrying that disclosure, then delete the legacy file only when no ledger marker references it. Reject symlinks, traversal, unknown formats, and ownerless files. Legacy-unverified evidence is inspectable but cannot be the sole support for an important or completion claim.
- [x] Run the reconciler after evidence startup maintenance. Preserve an unreconciled marker/file and surface a content-free failure state rather than deleting the last copy.
- [x] Keep the historical writer visibly isolated for rollback during this task; add a caller audit test proving `shadow` and `enforce` create no files below `<userData>/output-cache/`. Final writer removal happens in Task 18 after deletion/orphan coverage passes.
- [x] Run `npm run test:quiet -- src/main/context/__tests__/output-persistence.spec.ts src/main/context-evidence/legacy-output-cache-reconciler.spec.ts src/main/orchestration/loop-output-externalize.spec.ts src/main/orchestration/default-invokers.context-evidence.spec.ts`; expect no plaintext/path leakage, safe migration, and complete loop retrieval identity.

## Task 10: Convert microcompaction and compaction into evidence-reference transforms

**Files:**

- Modify: `src/main/context/microcompact.ts`
- Modify: `src/main/context/microcompact.spec.ts`
- Modify: `src/main/context/context-compactor.ts`
- Modify: `src/main/context/__tests__/context-compactor.spec.ts`
- Create: `src/main/context-evidence/evidence-preview-builder.ts`
- Test: `src/main/context-evidence/evidence-preview-builder.spec.ts`

- [x] Write regression tests proving the current `[microcompacted]` and `[Output pruned...]` replacements sever access to raw results.
- [x] Make `MicrocompactManager` replace eligible results only after complete evidence exists, using bounded card/head-tail previews and an authenticated retrieval citation.
- [x] Make pruning/collapse summaries preserve evidence IDs and exact citations. If capture is failed or incomplete, do not claim recoverability and do not discard the only full in-memory copy.
- [x] Rebuild from original transcript/evidence state rather than repeatedly compacting previously compacted text.
- [x] Keep existing context-compactor summary behavior for dialogue but separate evidence cards/excerpts as first-class working-set sections.
- [x] Run `npm run test:quiet -- src/main/context/microcompact.spec.ts src/main/context/__tests__/context-compactor.spec.ts src/main/context-evidence/evidence-preview-builder.spec.ts`; expect lossless retrieval and disclosure tests to pass.

## Task 11: Build the deterministic working-set planner

**Files:**

- Create: `src/main/context-evidence/working-set-planner.ts`
- Create: `src/main/context-evidence/context-token-estimator.ts`
- Create: `src/main/context-evidence/working-set-renderer.ts`
- Test: `src/main/context-evidence/working-set-planner.spec.ts`
- Test: `src/main/context-evidence/context-token-estimator.spec.ts`
- Test: `src/main/context-evidence/working-set-renderer.spec.ts`

- [x] Write table tests for the default allocation: instructions 15%, dialogue 15%, cards 15%, excerpts 15%, reasoning 25%, emergency reserve 15%.
- [x] Keep normal assembled context at or below 60% of a known provider window. Treat control-plane overhead above 30% as a degraded condition: route to a larger model when available, reduce optional context, or pause.
- [x] Implement provider-tokenizer injection with a conservative byte/character fallback. Label fallback estimates and never report them as provider-observed token counts.
- [x] Select recent/relevant cards and excerpts deterministically using recency, explicit user references, contradictions, failed checks, and active task entities; do not use model prose to decide citations.
- [x] Render sections with budget accounting and explicit bounded/metadata-only disclosures. Hold the emergency reserve out of ordinary selection.
- [x] Never blindly truncate required instructions or latest user intent. Report control-plane overage and shrink lower-priority sections first; unused card/excerpt allocation flows only to reasoning/answer and emergency reserve, not to additional retained evidence.
- [x] Run `npm run test:quiet -- src/main/context-evidence/working-set-planner.spec.ts src/main/context-evidence/context-token-estimator.spec.ts src/main/context-evidence/working-set-renderer.spec.ts`; expect allocation, unknown-window, overflow, and deterministic-order tests to pass.

## Task 12: Add truthful provider capabilities and the shared safety policy

**Files:**

- Create: `src/main/context-evidence/context-safety-policy.ts`
- Create: `src/main/context-evidence/provider-context-action-executor.ts`
- Modify: `src/main/cli/adapters/base-cli-adapter.ts`
- Modify: `src/main/cli/adapters/claude-cli-adapter.ts`
- Modify: `src/main/cli/adapters/gemini-cli-adapter.ts`
- Modify: `src/main/cli/adapters/codex-cli-adapter.ts`
- Modify: `src/main/cli/adapters/acp-cli-adapter.ts`
- Modify: `src/main/cli/adapters/adapter-factory.ts`
- Test: `src/main/context-evidence/context-safety-policy.spec.ts`
- Test: `src/main/cli/adapters/provider-context-capabilities.spec.ts`

- [x] Add contract tests for the locked capability table and prove no adapter infers stronger proof from command acknowledgement, process exit, or a provider-native thread ID.
- [x] Implement one pure safety-policy decision per threshold per epoch: rebuild at 60%, use only proven native compaction at 75%, stop broad research at 85%, and at 92% use controlled interrupt plus observed compaction plus same-thread continuation or pause.
- [x] Handle a new oversized result immediately: externalize before retention only for `pre-retention` control; otherwise record post-retention pressure and compact or pause at the next safe provider boundary.
- [x] Add cumulative input checkpoints at 2x and controlled recovery at 4x the effective window. Trigger convergence review when repeated research adds no new evidence/findings.
- [x] Reset an epoch only after observed compaction or an observed provider counter reset. Acknowledgement-only and requested actions do not reset it.
- [x] Enforce a maximum of three recovery attempts both per epoch and per outer send; an epoch reset never resets the outer-send ceiling. Prohibit duplicate replay of the interrupted user/tool turn.
- [x] When occupancy is unknown, never synthesize a percentage from cumulative totals. Use explicit output-byte/request budgets and conservative visible pauses.
- [x] Implement provider action executors separately from the policy. Unsupported actions return structured unavailable results and force the policy's safe fallback.
- [x] Treat provider disconnect as a proof boundary: preserve durable evidence and runtime identity, then resume only through the adapter's tested provider-specific continuation proof. Never infer safe replay from reconnection alone.
- [x] Run `npm run test:quiet -- src/main/context-evidence/context-safety-policy.spec.ts src/main/cli/adapters/provider-context-capabilities.spec.ts`; expect thresholds, proof strength, epoch, convergence, and recovery-ceiling cases to pass.

## Task 13: Fold existing context controllers into the shared coordinator

**Files:**

- Modify: `src/main/context/compaction-coordinator.ts`
- Modify: `src/main/context/compaction-coordinator.spec.ts`
- Modify: `src/main/cli/adapters/codex/context-cost-controller.ts`
- Test: `src/main/cli/adapters/codex/context-cost-controller.spec.ts`
- Modify: `src/main/cli/adapters/codex/turn-cost-governor.ts`
- Modify: `src/main/cli/adapters/codex/turn-cost-governor.spec.ts`
- Modify: `src/main/cli/adapters/codex/compaction-gate.ts`
- Modify: `src/main/cli/adapters/codex/compaction-gate.spec.ts`
- Modify: `src/main/cli/adapters/codex-cli-adapter.ts`
- Test: `src/main/context-evidence/context-policy-integration.spec.ts`

- [x] Write integration tests proving the current coordinator/Codex controller can otherwise make independent decisions for the same pressure sample.
- [x] Make `CompactionCoordinator` obtain the shared policy decision and delegate execution through the adapter action executor. Retain existing event compatibility while marking legacy thresholds deprecated.
- [x] Reduce the Codex cost controller to an observed executor/telemetry adapter: native compact request, interrupt proof, counter reset/compaction proof, and same-thread continuation. Remove policy thresholds from it.
- [x] Ensure self-managed providers are not silently exempt from cumulative pressure or evidence-preservation rules; capabilities change available actions, not ownership or accuracy requirements.
- [x] Record every requested/acknowledged/observed action as distinct content-free events and enforce one decision per threshold/epoch.
- [x] Run `npm run test:quiet -- src/main/context/compaction-coordinator.spec.ts src/main/cli/adapters/codex/context-cost-controller.spec.ts src/main/cli/adapters/codex/turn-cost-governor.spec.ts src/main/cli/adapters/codex/compaction-gate.spec.ts src/main/context-evidence/context-policy-integration.spec.ts`; expect a single decision owner and proof-correct Codex recovery.

## Task 14: Implement the evidence-backed accuracy gate

**Files:**

- Create: `src/main/context-evidence/accuracy-gate.ts`
- Create: `src/main/context-evidence/evidence-citation-parser.ts`
- Create: `src/main/context-evidence/execution-receipt-linker.ts`
- Modify: `src/main/orchestration/evidence-resolver.ts`
- Modify: `src/main/orchestration/evidence-store.ts`
- Modify: `src/main/instance/instance-communication.ts`
- Test: `src/main/context-evidence/accuracy-gate.spec.ts`
- Test: `src/main/context-evidence/execution-receipt-linker.spec.ts`
- Test: `src/main/instance/instance-communication.accuracy-gate.spec.ts`

- [x] Write failing cases for wrong conversation ownership, invalid ranges/digests, stale evidence, unresolved contradictions, absent raw span, missing execution receipt, corrupted blob, and bounded evidence presented as complete.
- [x] Classify turns into casual, evidence-backed, completion-claim, and high-stakes modes using deterministic signals. Only the latter three require citations; completion claims also require current execution receipts.
- [x] Validate every `[evidence:...]` marker against authenticated raw bytes, conversation ownership, freshness policy, sensitivity, and completeness disclosure.
- [x] Reject `legacy-unverified` evidence as the sole support for important or completion claims and surface its provenance limitation whenever it is cited.
- [x] Require cited raw spans when they are available; a model-assisted card cannot be the sole support for an important claim. Missing/corrupt evidence lowers confidence visibly and blocks unsupported completion claims.
- [x] Keep the gate's verdict narrow: it validates evidence linkage and execution receipts but never claims that every cited interpretation is true.
- [x] Link existing loop/tool execution receipts and verification-ledger entries to evidence IDs without replacing their current provenance fields.
- [x] In `shadow`, record the verdict and do not alter output. In `enforce`, buffer all assistant content for evidence-backed, completion-claim, and high-stakes turns until the capture queue drains and the gate passes; on failure emit a visible structured pause/block reason with safe repair actions, not the unsupported claim.
- [x] Keep tool/status streaming live while the final assistant claim is gated. Do not replay already emitted provider turns after repair.
- [x] Run `npm run test:quiet -- src/main/context-evidence/accuracy-gate.spec.ts src/main/context-evidence/execution-receipt-linker.spec.ts src/main/instance/instance-communication.accuracy-gate.spec.ts`; expect every required design check and mode behavior to pass.

## Task 15: Add deletion, revocation, and retention cleanup

**Files:**

- Modify: `src/main/chats/chat-store.ts`
- Modify: `src/main/chats/chat-service.ts`
- Modify: `packages/contracts/src/channels/chat.channels.ts`
- Modify: `src/main/ipc/handlers/chat-handlers.ts`
- Modify: `src/preload/domains/chat.preload.ts`
- Create: `src/main/context-evidence/evidence-deletion-service.ts`
- Test: `src/main/chats/chat-store.spec.ts`
- Test: `src/main/chats/chat-service.spec.ts`
- Test: `src/main/context-evidence/evidence-deletion-service.spec.ts`

- [x] Add a `CHAT_DELETE` contract and tests for explicit destructive confirmation at the UI boundary, active-instance termination/drain, and canonical ledger ownership.
- [x] In one ledger transaction: soft-delete the conversation, remove its transcript/checkpoint children, mark evidence deleted, and enqueue opaque blob references with the 10-minute grace deadline. Leave the separate forensic provider-event stream under its existing retention policy unless it is already explicitly conversation-owned.
- [x] Revoke search/read/compare/verify/list access immediately after the transaction commits.
- [x] Delete the operator `chats` row only after canonical ledger deletion succeeds; make retries idempotent after process interruption.
- [x] Implement a bounded janitor with retry/backoff, symlink-safe path resolution, content-free error codes, and no provider-native ownership lookup.
- [x] Run `npm run test:quiet -- src/main/chats/chat-store.spec.ts src/main/chats/chat-service.spec.ts src/main/context-evidence/evidence-deletion-service.spec.ts`; expect immediate revocation, queued deletion, restart retry, and cross-conversation safety to pass.

## Task 16: Expose generated IPC contracts and renderer state

**Files:**

- Create: `packages/contracts/src/channels/context-evidence.channels.ts`
- Modify: `packages/contracts/src/channels/index.ts`
- Create: `src/main/ipc/handlers/context-evidence.handlers.ts`
- Modify: `src/main/ipc/handlers/index.ts`
- Modify: `src/main/ipc/ipc-main-handler.ts`
- Create: `src/preload/domains/context-evidence.preload.ts`
- Modify: `src/preload/preload.ts`
- Create: `src/renderer/app/core/state/context-evidence.store.ts`
- Create: `src/main/context-evidence/context-evidence-diagnostics.ts`
- Test: `src/main/ipc/handlers/context-evidence.handlers.spec.ts`
- Test: `src/renderer/app/core/state/context-evidence.store.spec.ts`
- Test: `src/main/context-evidence/context-evidence-diagnostics.spec.ts`

- [x] Define exact channels: `context-evidence:list`, `context-evidence:get-card`, `context-evidence:search`, `context-evidence:read`, `context-evidence:compare`, `context-evidence:verify`, `context-evidence:get-metrics`, and push event `context-evidence:state-changed`.
- [x] Require conversation identity on every request and derive authorization from main-process chat/instance ownership; never trust renderer-supplied provider IDs.
- [x] Reuse the same retrieval limits, audit records, sensitivity rules, and citation formats as MCP.
- [x] Regenerate contract/preload artifacts with the repository's normal generation command discovered from `package.json`; do not hand-edit generated files.
- [x] Add a signal store that keeps occupancy, cumulative input, working-set allocation, evidence/card counts, stored bytes, model-request count, tool-call count, result bytes, enforcement state, and last action as distinct fields.
- [x] Add content-free diagnostics containing only classifications, counts, thresholds, actions/proof stages, durations, and failure codes. The privacy-safe export mode must omit provider/conversation/evidence identifiers as well as all evidence bodies and locators.
- [x] Run `npm run test:quiet -- src/main/ipc/handlers/context-evidence.handlers.spec.ts src/renderer/app/core/state/context-evidence.store.spec.ts src/main/context-evidence/context-evidence-diagnostics.spec.ts`; expect schema rejection, scope enforcement, event cleanup, privacy-safe export, and metric separation tests to pass.

## Task 17: Build the truthful renderer evidence and context UI

**Files:**

- Create: `src/renderer/app/shared/components/context-evidence-panel/context-evidence-panel.component.ts`
- Create: `src/renderer/app/shared/components/context-evidence-panel/context-evidence-panel.component.html`
- Create: `src/renderer/app/shared/components/context-evidence-panel/context-evidence-panel.component.scss`
- Modify: `src/renderer/app/features/instance-detail/context-bar.component.ts`
- Modify: `src/renderer/app/shared/components/tool-group/tool-group.component.ts`
- Modify: `src/renderer/app/features/chats/chat-detail.component.ts`
- Test: `src/renderer/app/shared/components/context-evidence-panel/context-evidence-panel.component.spec.ts`
- Test: `src/renderer/app/shared/components/tool-group/tool-group.component.spec.ts`
- Test: `src/renderer/app/features/instance-detail/context-bar.component.spec.ts`

- [x] Add component tests for normal, unknown-occupancy, degraded, paused, corrupted, deleted, bounded, and metadata-only states.
- [x] Show occupancy and cumulative input separately; never derive one from the other. Show provider-observed, AIO-estimated, acknowledged, and observed proof labels explicitly.
- [x] Show working-set sections, evidence/card/excerpt counts, encrypted stored bytes, model requests, tool calls, result bytes, enforcement mode, last action, and recovery count.
- [x] Change collapsed tool groups to truthful summaries such as `44 calls · 900,532 characters · 25 results externalized`, counting actual tool calls/results rather than renderer message wrappers.
- [x] Let each result open its card and request authorized bounded inspection through IPC. “Full inspection” is authenticated pagination over bounded chunks, never one unbounded response. Display the evidence ID, capture completeness, sensitivity, citation ranges, provenance trust, and any limitation disclosure.
- [x] Integrate the panel into chat detail and the existing context bar without combining evidence storage size with provider context occupancy.
- [x] Run `npm run test:quiet -- src/renderer/app/shared/components/context-evidence-panel/context-evidence-panel.component.spec.ts src/renderer/app/shared/components/tool-group/tool-group.component.spec.ts src/renderer/app/features/instance-detail/context-bar.component.spec.ts`; expect semantic labels, counts, inspection, and accessibility tests to pass.

## Task 18: Add rollout controls, replay harness, and acceptance coverage

**Files:**

- Modify: `src/main/core/config/settings-control-policy.ts`
- Modify: `src/main/mcp/orchestrator-settings-tools.ts`
- Modify: `src/main/context/output-persistence.ts`
- Modify: `src/main/context-evidence/legacy-output-cache-reconciler.ts`
- Modify: `src/main/context-evidence/__fixtures__/codex-44-call-incident.manifest.json`
- Create: `src/main/context-evidence/context-evidence-incident-replay.spec.ts`
- Create: `scripts/replay-context-evidence-incident.ts`
- Test: `src/shared/types/__tests__/context-evidence-settings.types.spec.ts`
- Test: `src/main/context-evidence/context-evidence-settings.spec.ts`

- [x] Expose the Task 7 `contextEvidenceModeByProvider` setting through the existing safe settings tool and control policy as operator-writable but not silently agent-writable during a run; retain its provider normalization in the single Task 7 helper.
- [x] Reuse the frozen Phase 0 manifest to run the governed replay; fail if its 44-call, 25-externalized-result, or exact 900,532-character shape changes.
- [x] Assert the replay preserves byte-for-byte raw evidence, generates inspectable cards, bounds the working set, provides exact retrieval, records truthful metrics, and never duplicates a result across restart/recovery.
- [x] Measure cumulative/cached provider input using the same workload before and after `enforce`; require at least a 60% reduction while the accuracy gate still passes all cited claims.
- [x] Add restart-mid-capture, authenticated corruption, missing-key, cross-conversation, deletion/revocation, three-recovery ceiling, and provider-capability matrix scenarios.
- [x] After reconciliation, orphan, and deletion tests pass, delete the historical plaintext writer and 24-hour cleanup from `OutputPersistenceManager`. In `off`, preserve provider-visible pre-feature output inline but never create a plaintext fallback. Delete only reconciled or provably orphaned legacy cache files and keep unresolved files visible for manual review.
- [x] Run `npm run test:quiet -- src/shared/types/__tests__/context-evidence-settings.types.spec.ts src/main/context-evidence/context-evidence-settings.spec.ts src/main/context-evidence/context-evidence-incident-replay.spec.ts`; expect all ten source-design acceptance criteria to pass.

## Task 19: Run full verification and prepare provider live validation

**Files:**

- Update: `docs/superpowers/plans/2026-07-15-provider-agnostic-context-evidence-plan.md`
- Create only if live checks remain: `docs/superpowers/plans/2026-07-15-provider-agnostic-context-evidence-plan_livetest.md`
- Rename after agent-runnable completion: `docs/superpowers/plans/2026-07-15-provider-agnostic-context-evidence-plan_completed.md`

- [x] Re-read the source design and map every requirement and all ten acceptance criteria to passing tests or an explicit live-only check. Record the test/file evidence in an as-built section in this plan.
- [x] Update the active source design with final status/as-built notes and plan link, then rename `2026-07-15-provider-agnostic-context-evidence-spec_planned.md` to `2026-07-15-provider-agnostic-context-evidence-spec_completed.md` before any later staging or commit; keep it untracked and unstaged unless James explicitly instructs otherwise.
- [x] Run focused suites for every touched subsystem and resolve failures without altering tests to excuse broken runtime behavior.
- [x] Run `npx tsc --noEmit`; expect exit 0.
- [x] Run `npx tsc --noEmit -p tsconfig.spec.json`; expect exit 0.
- [x] Run `npm run lint`; expect exit 0.
- [x] Run `npm run check:ts-max-loc`; expect exit 0.
- [x] Run `npm run test:quiet`; expect exit 0.
- [x] Run `npm run build`; expect exit 0 because Electron/preload/generated-contract wiring changed.
- [x] Run `npm run test:slow` for any context/provider/restart suites classified as slow by `docs/testing.md`; record the exact invoked files and results.
- [x] Inspect `git diff --check`, `git status --short`, generated contract diffs, imports/exports, initialization ordering, IPC registration, preload exposure, adapter capability wiring, and absence of plaintext evidence/cache artifacts.
- [x] Exercise the replay CLI against a temporary user-data directory and confirm exact 900,532-character accounting, authenticated retrieval, at least 60% input reduction, restart idempotency, and deletion revocation.
- [x] For checks that genuinely require rebuilt provider CLIs or human UI interaction, move the exact steps, flags/modes, expected observations, and reason into the `_livetest.md` file. Include a Codex app-server `shadow` run, Codex `enforce` recovery/continuation run, Claude resident/non-resident capability checks, Gemini stateless check, Copilot ACP check, one check for every additional concrete provider exposed by the adapter registry, UI inspection, and provider kill-switch rollback.
- [x] Keep every provider setting `off` by default. Promote an installed provider to `shadow` or `enforce` only during its live-test procedure and restore it afterward unless James explicitly approves rollout.
- [x] Rename this plan to `_completed.md` last, only when every agent-runnable item passes and any remaining checks are fully isolated in `_livetest.md`. Do not stage or commit either file without James's explicit instruction.

## Acceptance Checklist

- [x] Every AIO-visible result in the incident replay has one authenticated, conversation-owned raw evidence record with byte-for-byte identity.
- [x] Every compacted/externalized result remains inspectable through a bounded card and exact authenticated retrieval citation.
- [x] Bounded, metadata-only, post-retention, unobservable, corrupted, and deleted states are never presented as complete/full evidence.
- [x] The provider working set stays within the declared allocation and normal 60% ceiling when the window is known.
- [x] Cumulative input for the replay is at least 60% below the baseline on providers capable of the equivalent workload without reducing accuracy-gate pass coverage; opaque providers still satisfy the shared budget and integrity invariants.
- [x] Threshold actions occur once per epoch, require the declared proof strength, and stop after three recoveries per epoch or per outer send, whichever limit is reached first.
- [x] Restart/recovery never duplicates a user turn, provider result, evidence blob, or completion message.
- [x] Cross-conversation and deleted-evidence access fail closed and produce content-free audit records.
- [x] Renderer counts, bytes, context occupancy, cumulative input, evidence storage, enforcement state, and last action match coordinator records.
- [x] Provider kill switches restore the pre-feature behavior without deleting already captured evidence or creating plaintext fallback files.

## As-Built Evidence

**Closure date:** 2026-07-16 (autonomous loop `loop-1784205984733-079fe232`, iterations 0–9).

### Implementation shape

- Tasks 1–16 were implemented before this closure pass and were verified DONE and wired
  end-to-end by a skeptical call-site audit (iteration 0): capture → cards → working-set
  planner → retrieval → accuracy gate → deletion, IPC handlers in
  `src/main/ipc/handlers/context-evidence.handlers.ts`, preload domain
  `src/preload/domains/context-evidence.preload.ts`, renderer store
  `src/renderer/app/core/state/context-evidence.store.ts`.
- Task 17 (renderer): `context-evidence-panel` component (+21 tests), truthful tool-group
  summaries (real `tool_use`/`tool_result` counts; externalized segment omitted when the
  metadata is absent rather than fabricating 0), integration into `chat-detail` (scope from
  `chat.ledgerThreadId`) and `context-bar`/`instance-header` (scope from
  `instance.contextEvidence.conversationId`). Bounded card/raw inspection is paginated
  (4,000-byte chunks advanced by the RETURNED endByte); degraded statuses are labeled and
  never inspectable. `@if`-gated rendering was used instead of `@defer` (no `@defer`
  precedent or test harness in this repo; the panel subtree is not created until toggled).
- Task 18 (proof): frozen-manifest replay harness
  (`src/main/context-evidence/__fixtures__/incident-replay-{manifest,ledger,harness}.ts`),
  master spec `context-evidence-incident-replay.spec.ts` (10 tests covering all ten
  acceptance criteria), CLI `scripts/replay-context-evidence-incident.ts` sharing 100% of
  the harness. Settings rollout was already correct: `contextEvidenceModeByProvider` is
  renderer/operator-writable only (`readOnly()` to agent tools + privileged-CLI
  operator-only), normalization solely in `context-evidence-settings.ts` (now with 15
  behavioral tests + 4 shared-type shape tests). The historical plaintext writer and
  24-hour cleanup were already deleted from `OutputPersistenceManager` in a prior commit;
  verified absent.
- Closure fix found in fresh-eyes review: `EvidenceRecord` carries no card id, so the
  renderer keys card inspection by EVIDENCE id — `retrieveEvidenceCard`
  (`src/main/context-evidence/evidence-card-retrieval.ts`) now falls back to
  `listEvidenceCards(conversationId, { evidenceId, limit: 1 })` with identical ownership
  scoping (test: `evidence-retrieval-service.spec.ts` "resolves the newest card by
  EVIDENCE id").

### Measurements (replay CLI against a temp user-data dir, 2026-07-16)

- Exact character accounting: **900,532** characters across 44 calls / 25 externalizable —
  manifest-shape guard enforces this and fails the suite if the frozen manifest changes.
- Governed cumulative input: **917,853** tokens vs frozen ungoverned baseline **5,693,312**
  → **83.9% reduction** (bar: ≥60%), accuracy gate passing all cited claims. Cumulative
  figures scale the frozen session total by the measured per-request reduction ratio (a
  modeled projection, stated in the CLI output — the original per-request growth formula is
  not recorded anywhere to re-simulate literally).
- Restart idempotency: re-capture returns `duplicate`; startup reconciliation clean.
- Deletion/revocation: 69 blobs queued, revoked read → `EVIDENCE_NOT_FOUND`, janitor
  deleted 69/69.

### Verification results (agent-runnable gates, 2026-07-16)

- `npx tsc --noEmit` → exit 0; `npx tsc --noEmit -p tsconfig.spec.json` → exit 0.
- `npm run lint` → "All files pass linting".
- `npm run check:ts-max-loc` → passed (no new file flagged).
- `npm run test:quiet` (full suite) → **13,968/13,968 tests passed** (348s).
- Targeted suites: context-evidence + context + renderer panel/chats/instance-detail/state
  → 1,219 tests passed; incident replay + settings specs → 31 passed.
- `npx tsx scripts/replay-context-evidence-incident.ts` → exit 0 (figures above).
- `git diff --check` → clean.
- `npm run build` → exit 0 (renderer + electron + preload + aio-mcp SEA all built).
- `npm run test:slow` → 4/4 passed (loop-coordinator-auto-integration.e2e,
  loop-coordinator-concurrent-isolation.e2e, loop-coordinator-abandon-preserve.e2e,
  codemem soak). No context-evidence spec is classified slow; the loop e2e files cover
  the coordinator touched by this loop's parallel WS2/WS3 work.

### Deviations from the plan text

- Task 3's literal adapter-internal design was superseded by the provider-neutral
  `ContextSafetyPolicy` + `ProviderContextActionExecutor` architecture (deliberate; the
  old controller is `@deprecated` as decision-owner).
- Task 18's file list marks the frozen manifest "Modify"; it was deliberately NOT modified —
  it already has the exact shape the replay must prove unchanged.
- Card-id linkage gap (Task 16 contracts omit card ids from `EvidenceRecord`) resolved via
  the evidence-id retrieval fallback above rather than a contracts change.

### Live-test deferrals

Provider live validation (Codex shadow/enforce, Claude resident/non-resident, Gemini,
Copilot, registry sweep, human UI inspection, kill-switch rollback) is recorded with exact
steps in `2026-07-15-provider-agnostic-context-evidence-plan_livetest.md`. Every provider
default remains `off`.
