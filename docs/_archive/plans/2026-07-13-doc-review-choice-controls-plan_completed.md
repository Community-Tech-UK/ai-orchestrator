# Doc-review artifacts: selectable choice controls for decisions

**Status:** Completed — 2026-07-13. Automated implementation and verification are complete.
Electron/browser live validation is deferred to
[`2026-07-13-doc-review-choice-controls-plan_livetest.md`](2026-07-13-doc-review-choice-controls-plan_livetest.md).
**Date:** 2026-07-13
**Effort:** S/M — one runtime feature, mirrored in two template copies + the embedded host.

## Problem

Review artifacts render numbered decisions as prose option lists (`(a) … (b) … (c) …`), but the review runtime only injects Approve/Reject + a free-text comment per section. Answering a multiple-choice decision therefore means *typing* the option letter into the comment box. James wants the options to be selectable controls: radio buttons for single-choice decisions, checkboxes for multi-select, with the selection flowing into the decisions payload and the canonical Markdown block automatically.

## Current state (verified 2026-07-13)

The artifact contract lives in **two synchronized template copies** — both must change identically:

- Skill (portable path): `.claude/skills/doc-review-artifact/references/artifact-template.html` + `references/serve-review.mjs`, authored per `.claude/skills/doc-review-artifact/SKILL.md`.
- In-app (`request_doc_review` MCP pipeline): `src/main/doc-review/assets/artifact-template.html` + `assets/serve-review.mjs`, rendered by `src/main/doc-review/artifact-renderer.ts`, validated by `artifact-validator.ts`, orchestrated by `doc-review-service.ts`; contract enforced by `artifact-template.spec.ts` (the template lint) and `artifact-renderer.spec.ts`.

Runtime facts (identical in both copies):
- `renderItemControls()` injects the Approve/Reject toggle + `textarea.rv-comment` into every `[data-review-item]` section.
- `decisionsPayload()` emits `{ id, title, decisionId, decision, comment }` per item; `toMarkdown()` renders the canonical `## Document review feedback` block; standalone Submit POSTs the payload to `serve-review.mjs`, which relays it verbatim (payload-agnostic — verify when implementing).
- Embedded mode mirrors state to the host via `postMessage` kinds `aio-review/ready|decision|comment|state`, consumed by `src/renderer/app/features/doc-review/doc-review-viewer.component.ts` (Zod: `ReadyMessageSchema` :24, `DecisionMessageSchema` :28, `CommentMessageSchema` :34; dispatch :131-136), with types in `doc-review.types.ts`, state in `doc-review.store.ts`, IPC in `src/main/ipc/handlers/doc-review-handlers.ts`, MCP tools in `src/main/mcp/doc-review-tools.ts`.

## Design

**Authoring contract (additive, v1-compatible).** Inside a decision section, the author declares options as a plain list the runtime upgrades:

```html
<ul data-review-options data-multi="false">
  <li data-option="a" data-option-default="true">wire auto-failover for loop mode only</li>
  <li data-option="b">also for regular chat sessions</li>
  <li data-option="c">leave manual; drop WS7</li>
</ul>
```

- The runtime replaces each `<li>`'s marker with an injected `<input type="radio">` (`data-multi="false"`, one `name` per section) or `<input type="checkbox">` (`data-multi="true"`), keeping the option text as the `<label>`. Authors never hand-write inputs — the runtime owns all controls, exactly as it owns Approve/Reject today.
- `data-option-default="true"` renders a small "(default)" tag. No selection submitted = the agent applies the stated default, as today.
- Clicking an option **implies approval**: it sets the section's decision to `approve` unless the reviewer has explicitly pressed Reject (reject stays authoritative — it means "this decision is framed wrong"). Re-clicking a selected radio clears it.

**Payload + canonical block (additive).**
- Item payload gains `choice: string | null` (single) or `choices: string[]` (multi).
- `toMarkdown()` line format: `3. [Decision 3: ticket intake] approve — choice: a` (choice rendered before any free-text comment, comma-joined for multi). The free-text comment stays for nuance.
- Embedded mode: new message kind `aio-review/choice` `{ itemId, decisionId, choice | choices }`, mirrored on every change; `applyInit()` accepts stored choices back; `ready` payload advertises `options` per item so the host can render its own mirror if it wants.

**Compatibility.** Sections without a `data-review-options` list behave byte-identically to today. The meta contract stays `aio-doc-review` v1 (additive change). The embedded host must *tolerate* unknown message kinds from newer artifacts (verify it already ignores unmatched schemas — dispatch falls through today) and gains explicit `ChoiceMessageSchema` support.

## Tasks

1. Read both template copies, `SKILL.md`, `artifact-template.spec.ts`, `artifact-renderer.ts`/`artifact-validator.ts`, `doc-review-viewer.component.ts`, `doc-review.types.ts`, `doc-review.store.ts`, `doc-review-tools.ts`, and `serve-review.mjs` (confirm payload-agnostic relay) in full.
2. Implement the runtime feature in `src/main/doc-review/assets/artifact-template.html`: option discovery, control injection (radio/checkbox, keyboard-accessible, styled per existing `.rv-*` conventions incl. dark mode + `prefers-reduced-motion`), choice→approve implication, payload/`toMarkdown` extension, `aio-review/choice` post + init mirror.
3. Copy the identical runtime to `.claude/skills/doc-review-artifact/references/artifact-template.html` (the two files must stay byte-synchronized in the runtime block; if a sync check exists in the specs, extend it — if not, add one comparing the `<script>` blocks of both copies).
4. Extend the template lint (`artifact-template.spec.ts`) for the new contract markers and add rendering specs: single-select, multi-select, default tag, no-options section unchanged (golden), choice-implies-approve, reject-overrides-choice.
5. Update the embedded host: `ChoiceMessageSchema` + dispatch + store fields + canonical-block builder wherever the app reconstructs the feedback Markdown (trace from `doc-review.store.ts` / `doc-review-tools.ts`); specs for mirror + init round-trip.
6. Update `SKILL.md`: authoring contract section + the example, and change the decision-doc guidance from "James answers by number" to "declare options with `data-review-options`; typed comments remain for nuance".
7. Automated verification completed: focused runtime coverage, canonical TypeScript checks, lint,
   LOC ratchet, and the full test suite. Deferred Electron/browser validation is recorded only in
   the [`_livetest` checklist](2026-07-13-doc-review-choice-controls-plan_livetest.md).

## Acceptance

- A decision section authored with the options list renders radio buttons; selecting one sets Approve automatically; Submit produces `choice` in the JSON **and** `— choice: X` in the canonical Markdown, from both the standalone server path and the embedded in-app viewer.
- Multi-select works with checkboxes (`choices` array).
- A section without options renders byte-identically to the current runtime (golden spec).
- Both template copies' runtime blocks are identical (sync spec).
- Template lint + full canonical checklist green.

## Guardrails

- Do not change the meta contract version or break v1 artifacts.
- Runtime owns all injected controls; authors only write the `data-review-options` list.
- Reject must always override an implied approve.

## Interim convention (until this lands)

When authoring decision sections in new artifacts, avoid typed-letter answers: either phrase each option as its own `data-review-item` (so Approve/Reject buttons suffice), or accept that James will type the letter — never require multi-field typing.
