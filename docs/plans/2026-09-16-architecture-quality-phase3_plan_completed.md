# Architecture quality Phase 3 — first increments

Status: completed
Date: 2026-09-16
Parent: `docs/plans/2026-09-15-architecture-quality-remediation_plan.md`

## Scope

Shared output-message factory and argv redaction after Phase 3.8 parity pin.

## Implementation notes

- 3.6 `createOutputMessage` in `base-cli-adapter-utils.ts`; Copilot, Cursor, and Gemini output sites now use it.
- 3.7 `redactArgvForLog` covers `--prompt` (Copilot) and last-positional (Cursor).
- 3.1 `NdjsonLineBuffer` / `splitCompleteNdjsonLines` in `json-parse.ts`; Copilot and Gemini streaming, final parse, and error extraction share it.
- 3.4 `isCliStderrFailureText` is the shared classifier. Gemini and Copilot emit visible `error` output for real failures and debug-log banners. Claude send/stream stderr uses the same classifier instead of promoting every chunk.
- 3.5 Gemini stream/parse paths no longer use throw/catch for malformed lines. Remaining adapter `catch` blocks are spawn/kill/temp-dir ignores, not JSON parse.
- 3.2 Copilot stdout framing uses the shared line buffer; server-mode lives in `copilot/copilot-server-mode.ts`.
- 3.3 `asUnknownRecord` / `isRawCliPayload` / `toRawCliPayload` decode Claude stream objects. `parseClaudeStreamError` and `parseClaudeToolProgress` accept `unknown`. The `ClaudeAssistantMessageHost` adapter-host cast remains because those methods stay private on the adapter.

## Verification

`src/main/cli/json-parse.spec.ts`, `claude-cli-adapter.types.spec.ts`, `claude-cli-async-work.spec.ts`, `base-cli-adapter-utils.spec.ts`, plus Copilot/Cursor/adapter-parity specs (including Copilot stderr output).
