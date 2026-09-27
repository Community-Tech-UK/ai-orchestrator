# MiMo Token Plan allowance in token-usage-monitor and AIO — Implementation Plan

Status: complete (as-built below; live-app UI checks deferred to the livetest doc)
Spec: [2026-09-23-mimo-token-plan-allowance_spec_completed.md](./2026-09-23-mimo-token-plan-allowance_spec_completed.md)

**2026-09-24 reconciliation:** The AIO implementation is now committed on this checkout;
`39d245ba` also committed the LT-650 `notApplicable` marker fix found by the linked live test.
Check 4 was confirmed fixed live at the IPC level, while its DOM rendering was checked by source
and a component test rather than a second on-screen pass. Checks 1 and 2 remain blocked by an
expired MiMo console session; Check 3 passed. The separate `token-usage-monitor` checkout is not
a Git repository, so it has no Git commit status. The completion documents and live-test record
remain untracked here pending their own staging decision.

Work spans two checkouts:

- **token-usage-monitor**: `/Users/suas/work/token-usage-monitor` (not a git
  repo — macOS menubar poller + capture addon).
- **AIO**: `/Users/suas/work/orchestrat0r/ai-orchestrator` (this repo, current
  checkout on `main`; no branch/worktree is created).

## Phase A — token-usage-monitor

- [x] A1. `capture.py`: add `mimo_snapshot_from_plan(usage_obj, detail_obj)` —
      the shared normalizer (sits beside `grok_snapshot_from_billing`).
      Windows from `usage.items` + `monthUsage.items` per spec R1; labels
      `plan`/`monthly`/`compensation` (limit 0 ⇒ bucket skipped; unknown names
      → spaces); `used_percent` derived from `used/limit` (clamped 0–100);
      detail `human(used)/human(limit)`; `reset_at` = naive-UTC
      `currentPeriodEnd`; `status` = planName (`expired` when `expired`);
      `primary` = "plan" window, else "monthly", else 0; unreadable buckets
      recorded as a `note` ("unreadable quota: …") like Copilot's, and `None`
      when nothing parses. As-built: the snapshot also carries `plan` (plain
      plan name) so Harness's usage-monitor-source can label the provider card
      (the monitor's `status` field becomes `expired` on lapse).
- [x] A2. `poller.py`:
      - Constants: console base URL, `/api/v1/tokenPlan/usage|detail`, the
        Chrome `Default/Cookies` path, Keychain `Chrome Safe Storage`/`Chrome`.
      - `mimo_console_cookies()`: Keychain read via `keychain_secret` (blocked ⇒
        `set_attention("mimo", ATTENTION_KEYCHAIN)`), Chrome cookie DB
        read-only select of the four spec-contract cookies, v10 AES-128-CBC
        decrypt (`cryptography` or `Crypto`; clear log if neither is present).
        Returns `(cookie_header, user_id)` or `(None, None)`.
      - `poll_mimo()`: fetch both endpoints DIRECT (Codex pattern; two-endpoint
        merge + session cookies), `mimo_snapshot_from_plan`, `write_state("mimo", …)`.
        Missing cookies ⇒ skip + log (spec R4); 401 ⇒ skip + log.
      - Wire `SINGLE_ACCOUNT_KEYCHAIN["mimo"]`, `POLLERS["mimo"]`, and a
        `_guarded("mimo", poll_mimo)` call in `main()`.
        As-built: decrypted values must match `[\x20-\x7E]+` (the AIO guard) so
        a CR/LF cannot make urllib reject the header with the whole Cookie
        string in its error text (which the poller logs); `urllib.error.HTTPError`
        is handled explicitly because urllib raises on non-2xx — that is the
        production 401 path, with the returned-status checks kept as a net.
- [x] A3. `display.py`: `ORDER` += `mimo`; `NAMES`/`ABBR` → `MiMo Code` / `MC`.
      `menubar.py` + `usage` docstrings list the tool.
- [x] A4. `tests/test_mimo_endpoint.py`: normalizer (recorded live shapes with
      placeholder numbers), percent-derivation vs provider `percent`,
      compensation skipped at limit 0, unknown bucket naming, unreadable
      note, changed-shape/failed bodies, naive-UTC reset, decrypt known-answer
      vectors (incl. a plaintext ending in padding-looking bytes), poller
      wiring constants, cookie-store scoping (temp DB + decoys), CR/LF value
      rejection, HTTPError-401 handling. Suite: 333 tests OK.
- [x] A5. `README.md` (tools table + credential table + session-cookie
      caveat) and `install.sh` final-steps text.

Acceptance (Phase A): `python3 -m unittest discover -s tests -v` green; a live
`poller.py` run writes a `mimo` entry that `./usage` and the menu render.
**Met** — 333 tests green; live `poller.poll_mimo()` wrote
`{status: "Pro", plan: "Pro", windows: plan/monthly, detail "397.7M/38.0B"}`;
`./usage` and `menubar.py` rendered "MiMo Code" with `MC 1%` and "resets in 29d21h".

## Phase B — AIO

- [x] B1. `src/main/core/system/provider-quota/mimo-console-credentials-reader.ts`
      — `MimoConsoleCredentialsReader` modelled on `cursor-credentials-reader.ts`
      (injectable `securityExec`/`driverFactory`/`fileExists`; failure reasons
      `not-found`/`denied`/`expired`/`malformed`/`unsupported`; darwin-only
      Keychain; Chrome `Default/Cookies` opened read-only; v10 decrypt with
      `node:crypto`; returns `{ serviceToken, slh, ph, userId }`).
- [x] B2. `src/main/core/system/provider-quota/mimo-token-plan-probe.ts` —
      `MimoTokenPlanProbe` modelled on `grok-billing-probe.ts`: provider
      `opencode`; runs only when `isTokenPlanModel()` (configured OpenCode
      model id starts with `xiaomi-token-plan-`); fetches both console
      endpoints; `parseMimoTokenPlanResponses` → `ProviderQuotaWindow[]`
      (`unit: 'tokens'`, `kind: 'calendar-period'`, `overage: false`, ids
      `opencode.plan` / `opencode.monthly` / `opencode.compensation` — short
      ids chosen so the native windows match the fallback's slug-derived
      `opencode.<label>` ids); snapshot `source: 'admin-api'`,
      `plan: planName`; credential failures ⇒ `ok: false` + `needsReauth`
      (spec R7); non-2xx/401 ⇒ same.
      As-built: the gate is the pure `isTokenPlanModelSetting(settings)` and
      the fallback gating is `gatedUsageMonitor(source, gate)` (extracted so
      both halves are unit-pinned).
- [x] B3. Wiring: `provider-quota/index.ts` registers
      `new CompositeQuotaProbe(new MimoTokenPlanProbe(...), gatedUsageMonitor(usageMonitor, …))`;
      `usage-monitor-source.ts` gains `opencode` in `KNOWN_PROVIDERS` and
      `STATE_KEY_ALIASES` `opencode: ['mimo']`; `quota-auto-refresh.ts`
      maps `opencode` → `opencode` (comment updated).
- [x] B4. `provider-quota-settings-tab.component.ts`: replace the
      "no quota source" copy for `opencode` with the console-cookie source
      description and its degraded behaviour. Chip: `PREFERRED_SUMMARY_WINDOW_IDS`
      gains `opencode: ['opencode.plan']`; the reauth hint names the console fix.
- [x] B5. Specs: `mimo-console-credentials-reader.spec.ts`,
      `mimo-token-plan-probe.spec.ts` (recorded placeholder shapes, failing
      request, changed shape, gate on/off, reauth path),
      `usage-monitor-source.spec.ts` additions (alias precedence, plan name,
      gated wrapper), `quota-auto-refresh.spec.ts` (opencode mapping). 70 tests.
- [x] B6. Docs: `docs/DEVELOPMENT.md` (MiMo section rewritten),
      `docs/provider-parity-checklist.md` (`opencode` quota gap cell).
- [x] B7. Canonical verification checklist: `npx tsc --noEmit`, `npm run typecheck:spec`
      (the wrapper, per AGENTS.md — the bare `tsc --noEmit -p tsconfig.spec.json`
      OOMs), `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`,
      `npm run build:renderer`, `npm run test:quiet`.

Acceptance (Phase B): all checklist commands green; the new specs pass under
`test:quiet`; no secret-like strings in fixtures.
**Met** — `tsc --noEmit`, `typecheck:spec`, `lint`, `build:main`,
`build:renderer` all green; feature specs 70/70; full `test:quiet` 26169/26170
with the single failure attributed outside this change (see As-built);
`check:ts-max-loc` fails only on `input-panel.component.ts`, which is 1910
lines at HEAD and untouched here. Fixtures are placeholders only.

## Phase C — completion

- [x] C1. Fresh-eyes `task-completion-gate` review of the full change set
      (both checkouts) by a new subagent context; treat findings as
      in-progress work. Round 1: FAIL (2 major, 5 minor) — all fixed.
      Round 2: FAIL (2 minor) — all fixed. Round 3: PASS (empty findings).
      Round 4 (post-PASS HTTPError delta): PASS (empty findings).
- [x] C2. Fix → re-verify → re-gate until `VERDICT: PASS` with no unresolved
      findings. Four gate rounds; the two major fixes were the Node decrypt's
      double PKCS#7 strip (silent credential corruption; low-byte KATs added in
      both repos) and a realistic console userId leaked into fixtures (replaced
      with `test-user-id`).
- [x] C3. As-built notes into the spec/plan; the app-UI checks moved to the
      livetest doc below; rename `*_plan.md` → `*_plan_completed.md` and the
      spec's `_spec_planned` → `_spec_completed` with the plan link updated.
      At the 2026-09-23 completion snapshot the implementation and documents
      were uncommitted. The AIO code has since been committed; these documents
      remain untracked, and the external monitor has no Git history.

Live-app checks deferred: [2026-09-23-mimo-token-plan-allowance_livetest.md](./2026-09-23-mimo-token-plan-allowance_livetest.md)
(quota chip windows, strip headline, settings copy, non-Token-Plan gate in the
running app, optional reauth affordance). Everything CLI/test-verifiable was
verified in-loop, including live runs of both consumers.

## As-built notes

- **Live evidence (2026-09-23).** Console contract verified against James's
  account: the two endpoints answer 200 with the four Chrome session cookies +
  `userId` (the Token Plan key is refused 401 — Decision 1). token-usage-monitor's
  poller wrote a real snapshot (Pro, 397.7M/38B at first run) rendered by
  `./usage` and `menubar.py`. The AIO probe chain ran live under `tsx` with the
  real cookie store/Keychain/fetch (`ok: true`, `plan: "Pro"`, `opencode.plan`
  1,403,400,780/38,000,000,000 tokens, `resetsAt` 2026-10-22T23:59:59Z,
  `overage: false`) — the sqlite library in that one run was a `node:sqlite`
  adapter because `better-sqlite3` here is built for the Electron ABI (143) and
  cannot instantiate under plain node; SQL, decrypt and fetch were the
  production paths, and the Electron main process loads `better-sqlite3`
  natively (the same pattern `cursor-credentials-reader.ts` uses in production).
- **Unrelated failures kept out of scope** (the working tree hosts a concurrent
  session's in-flight work): the full suite's
  `context-worker-import-isolation` failure is their untracked
  `rlm-migrations-066-070.ts` widening the worker closure (closure walk:
  HEAD 146 vs working tree 147, sole addition named, zero quota modules in the
  closure); `check:ts-max-loc`'s `input-panel.component.ts` ratchet failure is
  pre-existing at HEAD (1910 lines committed).
- **Round-1 major fixes:** Node `decryptChromeV10` no longer re-strips PKCS#7
  (Node's `final()` already unpads; the second strip corrupted values ending in
  0x01–0x10 and disagreed with the Python twin); test fixtures no longer carry
  the real console userId.
- **Guard parity:** both readers reject decrypted values outside `[\x20-\x7E]`;
  the Python cookie read is `?mode=ro` and the AIO read is `{ readonly: true }`,
  both pinned by tests that fail on drift.
- **Ids:** windows are `opencode.plan` / `opencode.monthly` /
  `opencode.compensation` on both the native and fallback paths (the fallback's
  slug rule produces the same ids from the monitor's labels).
