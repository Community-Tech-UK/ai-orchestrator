# Hardened Mode — Enable Every Provider — Completed Plan

**Status:** Completed 2026-09-28 for everything an agent can run: code, tests, the full suite, and a
fresh-eyes PASS. The in-app checks that need a rebuilt Harness, and the Copilot tool turn after the
2026-10-01 quota reset, are deferred to
[`2026-09-28-hardened-mode-provider-support_livetest.md`](2026-09-28-hardened-mode-provider-support_livetest.md).
**Created:** 2026-09-28
**Follows:** [`2026-09-28-hardened-mode-provider-support_plan_completed.md`](2026-09-28-hardened-mode-provider-support_plan_completed.md)
(Phase 0: refuse every provider except Claude). This plan supersedes that plan's
"one provider at a time" approach and its decision to keep Grok refused.

## Decisions (James, 2026-09-28)

1. **Do all providers now**, not one at a time.
2. **Granting `~/.grok` is acceptable**, even though `~/.grok` is shared with every Grok process.
   This also means a jailed Grok session can change files under `~/.grok/bin`, which the Grok npm
   launcher runs outside the jail. The same is already true of `~/.claude` and `~/.codex`, which have
   been writable roots since WS13.

## Evidence — hardened probe, 2026-09-28

`scripts/hardened-probe/probe.mjs` launches each CLI the way Harness does (same command, flags,
Harness `PATH` order, `CLAUDE_CODE_TMPDIR`, Copilot `COPILOT_HOME` and `--use-openssl-ca`) under
the shipped base policy with the generated writable-root clauses. It asks the CLI to write
`probe-inside.txt` in the workspace and a file on `~/Desktop`. It must run from a normal Terminal,
because a Harness session sits inside the Seatbelt signal fence and macOS refuses nested sandboxes.

**Run 1 (17:06 UTC)** exposed two blockers:
- **TLS failures.** Every CLI that checks certificates through the macOS Security framework failed
  HTTPS with `OSStatus -26276` because the policy blocked `trustd`/`ocspd` and the network-config
  services. Antigravity failed its eligibility check, Codex failed "workspace routing discovery",
  Copilot could not reach `api.github.com`, and Grok and Cursor lost their remote MCP servers.
- **Missing state folders.** Grok failed with `FS_PERMISSION_DENIED` without `~/.grok`. OpenCode
  could not open `~/.local/share/opencode/log/opencode.log`. Cursor could not create
  `~/.cursor/projects/…`.

**Run 2 (17:26 UTC)**, with the fixes below:

| Provider | Result | Grant needed |
|---|---|---|
| Claude | PASS with shared defaults | none |
| Codex (exec mode, as forced when hardened) | PASS with shared defaults | none |
| Antigravity | PASS with shared defaults | none (`~/.gemini` is already a default root) |
| Grok | fails without, PASS with | `~/.grok` |
| OpenCode | fails without, PASS with | `~/.local/share/opencode`, `~/.config/opencode`, `~/.cache/opencode`, `~/.local/state/opencode` (XDG-aware) |
| Cursor | fails without, PASS with | `~/.cursor` only (`~/.local/share/cursor-agent` not needed) |
| Copilot | fails without its home. With it, the CLI starts, authenticates and reaches the model API, then GitHub returns `402 quota_exceeded` | resolved per-account Copilot home |

Each PASS means the turn answered, the workspace file exists, and the Desktop file does not.
Copilot's tool turn is unproven because the personal account has no premium requests until
2026-10-01, and the EBRD seats must not be used.

## As built

- `resources/sandbox/aio-seatbelt-base.sbpl`: TLS trust and network-configuration `mach-lookup`s,
  taken from the sandbox policy text bundled in the installed codex 0.16x binary (seven names from
  its network-policy block, plus `com.apple.trustd` from its system-agents list). These are lookups
  only, and no write grant changes.
- The composer's "Hardened N/A" state now has no provider a user can pick. Only the legacy `gemini`
  alias is refused, and it is not offered in the provider menu. The check stays in place for any
  future provider added without jail evidence, and the specs use `gemini` to keep it covered.
- `src/main/sandbox/seatbelt.ts`: `providerHardenedWritableRoots(provider)` grants each provider
  only its own proven state folders, so a hardened Claude session still cannot write `~/.grok`.
- `src/main/cli/adapters/hardened-adapter-config.ts` (new, split from `adapter-factory.ts` to stay
  under its size ceiling): builds the jail roots as shared defaults, then the provider's own roots,
  the derived Claude home, the routed `COPILOT_HOME`, and session allow-and-retry grants.
- `src/shared/hardened-mode-support.ts`: the allow-list is Claude, Codex, Antigravity, Grok,
  OpenCode, Cursor and Copilot. Only the legacy `gemini` alias stays refused.
- `scripts/hardened-probe/`: the probe, kept for re-verification.
- Tests:
  - `seatbelt.spec.ts`: TLS lookups present, per-provider roots, XDG handling.
  - `adapter-factory-hardened-remote.spec.ts`: each provider builds hardened with only its own
    roots, Copilot gets its routed home, `gemini` is refused.
  - Composer specs: re-targeted to `gemini` as the refused example, and a Codex hardened launch now
    goes through.

## Verification

- `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`,
  `npm run build:main` and `npm run build:renderer` all exit 0.
- Full `npm run test:quiet`: 2,250 files, 26,913 tests passed.
- Fresh completion-gate reviewer: `VERDICT: PASS`. It revert-checked the new tests (16 fail without
  the change). Its two low findings are fixed: the policy provenance wording, and the note above on
  the now-unreachable "Hardened N/A" state.

## Deferred live checks

In-app verification per provider, Codex respawn count, and the Copilot tool turn are in the
live-test doc linked above.
