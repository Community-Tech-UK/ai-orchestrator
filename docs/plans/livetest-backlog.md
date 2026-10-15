# Live-test backlog — historical campaign record

> **Status reconciliation — 2026-09-27:** this file is no longer the current status index.
> It preserves the 2026-09-06 baseline and the campaign narrative through 2026-09-24. Its
> headline counts, routing tables, open filenames and "James only" classifications must not be
> used as present-tense status.

Current ownership is split across:

- [`2026-09-27-livetest-human-external-residuals_livetest.md`](./2026-09-27-livetest-human-external-residuals_livetest.md)
  — human judgment, production authority and unavailable external-system campaigns. It currently
  holds 28 open residual groups plus the retired RES-015 tombstone; these are campaign groups, not
  28 atomic legacy checks.
- [`2026-09-27-livetest-agent-runtime-residuals_livetest.md`](./2026-09-27-livetest-agent-runtime-residuals_livetest.md)
  — seven expensive or exclusive but agent-runnable campaigns.
- Every other unsuffixed `*_livetest.md` owner created after or not absorbed by that consolidation.
  Discover those files from the checkout rather than copying a static count from this document.

The fifteen dated `*-livetest-backlog-status-report.md` files were deleted on 2026-09-06 after
their content — including items that had quietly stopped being restated — was merged here. Closed
`_livetest_completed.md` documents still cite old filenames as historical context; those citations
are stale by design. Originals are in `_scratch/livetest-backup-2026-09-06/`.

**Do not add current status here.** Update the owning live-test file or the applicable 2026-09-27
consolidated residual document. Do not create another dated aggregate status report.

Companion documents:

- `docs/plans/livetest-campaign-runbook.md` — read before running a campaign.
- `docs/plans/livetest-remediation-register.md` — the `LT-NNN` defect register.
- `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md` — matching implementation status.

Every pre-compression original is preserved byte-for-byte in
`_scratch/livetest-backup-2026-09-06/` (gitignored), named after its original path with
`/` replaced by `_`. If a compression looks too aggressive, the original is right there.

**Precedence:** an owning live-test document's latest evidence wins for its check. For a check
transferred on 2026-09-27, the applicable consolidated residual owns current status. This file
never overrides either one.

---

## Historical 2026-09-06 baseline

Counted from the `## Status — 2026-09-06` block of all 43 open documents, not estimated:

| | |
| --- | --- |
| Open documents | **43** |
| Open checks | **169** |
| Closed checks | **93** |
| Reproduced defects still open | **5** |
| Corpus size | 1,156,643 bytes → **335,976 bytes**, 71% smaller |

Of the 169 open checks, the large majority are blocked on something only James can do —
a device, an account, a permission prompt, or a decision. The genuinely agent-runnable
remainder is listed first below.

The compression was checked afterwards by an independent reviewer that had not done it,
comparing the six most heavily compressed documents against their untouched backups,
looking specifically for a check that was dropped or quietly promoted from pending to
passed. Its verdict is recorded at the end of this file.

### Addendum — 2026-09-20 (outstanding-plans sweep)

The counts above are still as-of 2026-09-06 and have deliberately **not** been recomputed here;
recounting 43 documents from a different session's state is how this file previously went stale.
One change needs recording, because it adds a document the count does not include:

- **New:** [2026-08-28-browser-gateway-unattended-portal-fixes_livetest_completed.md](./2026-08-28-browser-gateway-unattended-portal-fixes_livetest_completed.md)
  — 3 open checks. Created when its plan was closed, so that the plan's genuinely-deferred portal
  checks (real filename on upload, cross-iframe accessibility snapshot, honest `type` refusal) were
  recorded rather than lost at the rename. Blocked on an app rebuild/restart, the Chrome extension
  reloaded on `windows-pc`, and a real portal page. **Working total: 44 open documents, 172 open
  checks.**

No existing document's open count changed: that sweep closed *plans*, and closing a plan never
closes a live check. Several of the newly-`_completed` plans point at livetest documents already
counted above.

---

### Addendum — 2026-09-20 (browser-gateway reliability queue run)

[`2026-07-17-browser-gateway-reliability_livetest_completed.md`](./2026-07-17-browser-gateway-reliability_livetest_completed.md)
went from 5 open checks to 3.

- **Closed:** check 2 (reveal survived a real forwarder restart — the first `tools/list` after the
  reconnect already carried `browser.evaluate`, no re-search) and check 5's old-binary half (a bridge
  built from commit `83cfda14`, 2026-07-23, reported 42/46 tools and produced the `contract-skewed …
  rebuild aio-mcp` warning plus a `contract_mismatch` event).
- **Still open:** checks 1, 4 and 6, now all behind one live fault rather than three separate
  blockers.
- **Two new register entries.** **LT-543**: the `aio-mcp` forwarder has no log sink at all, so the
  restore line check 2 asked for can never appear in `app.log` — a zero grep count there says nothing
  about forwarder behaviour, and any other document that greps for forwarder log lines is making the
  same mistake. **LT-544 (P1)**: both extension channels — `windows-pc` and the local Mac Chrome —
  accept commands and execute none, for ~16 h 50 m and across an app restart, while `browser.health`
  calls them healthy and `browser.recover_extension` refuses to act. That blocks every live browser
  check in the backlog, not just this document's.
- **One long-standing blocker is gone:** the auxiliary-LLM endpoint that check 1 and
  `sibling-audit-round2` B3 were both waiting on now exists — `windows-pc` serves Ollama with 8 models,
  enrolled with the `webExtract` role. Only LT-544 stands between check 1 and an answer.

### Addendum — 2026-09-20 (skill-observability queue run)

[`2026-07-23-skill-observability-and-design-skills_livetest_completed.md`](./2026-07-23-skill-observability-and-design-skills_livetest_completed.md)
still has **1 open check**, but check 4's blocker changed and three defects were reproduced driving it
through the real UI in a dev app.

- **The D1a mechanism now has live evidence in both directions.** A global skill (`playwright`) at
  the `suggest-only` default did not inject on a real send that scores 0.8888; flipped to `enabled`
  it injected on the very next send (`matchedBy: 'embedding'`, `matchScore: 0.8888480099864527`,
  880 tokens); reverted, it stopped. Discovery itself returns the expected corpus — 33 registered
  skills, 17 builtin — exactly what the check predicted.
- **LT-545 (P1):** every object-payload call in `OrchestrationIpcService` is double-wrapped before it
  reaches its positional preload wrapper, so the Skills page's **Discover Skills** button and every
  skill control button fail Zod validation. Confirmed live on three skills channels; 16 channels
  across workflow, review and supervision share the shape.
- **LT-546 (P1):** the Skill Health panel lists only skills that already have an activation row, so a
  suggest-only skill can never be promoted to On — the D1a path is circular — and it renders **On** as
  active for a control-less global skill whose effective mode is `suggest-only`.
- **LT-547 (P1):** a detected, enabled skill whose core exceeds the 5 000-token per-skill budget is
  dropped with no injection, no activation row and no log. `ui-ux-pro-max` measures 10 932 tokens, so
  it can never auto-inject at any threshold. Isolated with a same-description, small-core probe skill
  that injected on the same send while `ui-ux-pro-max` recorded nothing.
- **The embedding-provider item is no longer what blocks this document.** A keyword-dense on-topic
  request reaches 0.6786 against `ui-ux-pro-max` on the TF-IDF tier running today and *is* detected;
  the 2026-09-06 analysis of detection quality for ordinary phrasings still stands, but it is not the
  gate here. Related check on the new capability: `100.113.93.104:11434` did not answer from the
  coordinator (curl timed out), and the RLM `EmbeddingService`'s `ollamaHost` defaults to
  `http://localhost:11434` with no settings wiring, so skill matching still resolves to the local
  fallback whatever the `webExtract` role is using.

### Addendum — 2026-09-21 (session-restart-recovery queue run)

[`2026-08-30-session-restart-recovery_livetest_completed.md`](../superpowers/plans/2026-08-30-session-restart-recovery_livetest_completed.md)
went from 5 open checks to 3 — all five were run in full against an isolated dev app (commit
`b8fcbe88`, profile `/tmp/aio-lt-queue-cd0ca9ca`, CDP `:9590`, focus emulation verified first).

- **Closed:** checks 3 and 4. Recovery success is correct end to end — only the active action reads
  `Recovering...` with `aria-busy="true"` while every other row disables with *Recovery in progress*,
  the picker closes, the selected runtime is the returned id, the toast reads exactly
  *Recovered 3 autosaved messages.*, and a triple-click still produces one request. Failure is
  correct too: the picker stays open, an assertive alert carries the message, the candidate stays
  listed, busy clears, retry works, and no instance is created.
- **Still open:** checks 1, 2 and 5. Check 2 fails only on its focus-visibility clause; it passes on
  group ordering, row content, accessible naming and the Arrow/Tab route.
- **Two new register entries.** **LT-605 (P1):** `SessionRecoveryBannerComponent` is imported by no
  template, so the startup notice and its dismiss control do not exist in the running app and are
  tree-shaken out of both renderer bundles. Recovery is still reachable through the Resume Picker, so
  this is a discovery failure, not a functional one — but it is the entire premise of the plan.
  **LT-606 (P2):** every Resume Picker row action loses its keyboard focus ring because
  `.resume-action:focus-visible` uses an undefined `--focus-ring`, which is invalid at computed-value
  time and strips the global ring. Not recovery-specific.
- **A note for anyone writing a livetest doc:** this document's own synthetic-setup block reaches the
  store through `document.querySelector('app-session-recovery-banner')`, an element that has never
  existed. A setup recipe written from source rather than from a running app can encode the very
  defect the checks are meant to find. The store was reached through
  `ng.getComponent(document.querySelector('app-dashboard')).resumePickerController.recoveryStore`
  instead.

### Addendum — 2026-09-21 (background-work waiting-state queue run)

[`2026-09-17-background-work-waiting-state_plan_livetest_completed.md`](../superpowers/plans/2026-09-17-background-work-waiting-state_plan_livetest_completed.md)
went from 3 open checks to **0**. All three passed against an isolated dev app (branch
`queue/2026-09-17-background-work-wai-2de31e` off `cb66e955`, profile
`/tmp/aio-lt-queue-bb2de31e`, CDP `:9726`, focus emulation verified first). **No defect
reproduced, so no new register entry.** The document is ready to close.

- **Closed:** all three. A foreground command the CLI moves to the background on its timeout now
  registers as background work and renders the full waiting state (dashed `#7aa2c8` breathing ring,
  no spinner, no amber dot, `Claude · Waiting on 1 background task (since HH:MM)` as both tooltip
  and `aria-label`, steel-blue header dot titled *Waiting on background work*). A hung job got
  exactly one automatic check-in at 10.57 minutes and none in the 11 minutes after. A session
  holding live background work stayed `idle` for 24.8 minutes with zero `idle -> hibernating`
  transitions, while three control sessions without background work hibernated at 3.8–3.9 minutes.
- **Two things worth carrying forward.**
  1. **A live VPN silently postpones every automatic send.** The first check-2 run produced no
     check-in at all because the host had `utun12` up, the detector paused the app
     (`pauseGetState() → {isPaused: true, reasons: ["vpn"]}`), and
     `InstanceAsyncWorkContinuation.automaticInputBlocked()` holds continuations and stall check-ins
     while paused. That is correct behaviour, but it looks exactly like a dead feature. Check
     `pauseGetState()` before filing any "the automatic send never happened" finding. Setting
     `pauseOnVpnEnabled: false` in the isolated profile released the held check-in on the very next
     60-second sweep, so nothing was lost — the guard runs before `checkedInWork` is recorded.
  2. **Check 3 is unsound at the default 30-minute threshold.** The 10-minute stall check-in resets
     `lastActivity`, so a 30-minute hibernation window restarts at roughly the moment a 40-minute job
     ends. Lower `autoTerminateIdleMinutes` in the isolated profile (3 minutes was used) and run a
     no-background-work control session alongside to prove the sweep is actually firing.


### Addendum — 2026-09-24 (campaign across all 65 open documents)

On 2026-09-24 all 65 open `*_livetest.md` documents were triaged. Everything agent-runnable was then
re-run: four dev-app batches plus three verification passes, and the packaged app plus `windows-pc`
from the orchestrating session. Per-check evidence is in each owning document's
`## Evidence run — 2026-09-24 (...)` section. Defect status is in the register's new "Current status
corrections — 2026-09-24" table. The headline counts at the top of this file were **not** recomputed.

**What changed in the picture:**

- **Most "fixed in code, never confirmed" items are now confirmed live.** Roughly 35 of the LT-539
  to LT-614 fixes were exercised against a running app. All held except the reopens below.
- **A P0 fix had never reached `main`.** LT-541 (every remote assistant reply silently dropped) and
  LT-542 were fixed and live-verified on 2026-09-20, but only on the land-blocked queue branch
  `queue/2026-07-13-fable-ws15-332c74`. The code was ported to the `main` working tree and
  unit-verified. Seventeen other `queue/*` branches are also parked as land-blocked. Only that
  one carried code, but the "fixed" status in the register had been read as true.
- **New defects found and fixed in code the same day:**
  - LT-615 to LT-621;
  - LT-630 and LT-631 (the latter reopened once after its first fix);
  - LT-640 and LT-641 (each reopened once after a live re-check exposed a second fault);
  - LT-642 and LT-643 (the ping-pong hang);
  - LT-650 and LT-651.

  Reopened and fixed again: LT-572 (width), and LT-612 for Grok, which reports `exit_code`.
- **Still needing James:**
  - Local Network permission for Harness (LT-619): its mDNS advertisement is invisible.
  - The worker launcher deployment he chose to keep local (worker-offline-resilience check 1).
  - The existing physical-device, OAuth, TCC and Discord items, which are unchanged.
- **Closed on 2026-09-24** (renamed `_livetest_completed` after the independent completion gate
  returned `VERDICT: PASS` on the campaign's code changes, twice):
  - `2026-09-10-browser-tab-close-and-inspection-metadata`;
  - `2026-08-30-session-restart-recovery`;
  - `2026-09-05-history-preview-model-selection`;
  - `2026-09-08-interrupt-stuck-watchdog-and-streaming-rewind`;
  - `2026-08-23-workspace-secret-card`;
  - `2026-07-13-fable-ws13`;
  - `2026-07-17-browser-permission-ux_plan`;
  - `2026-07-26-local-ai-guard_plan`.

  The last three already had every check passed from their 2026-09-20/21 Plan Queue runs, but their
  queue items were land-blocked, so the rename never happened. Those parked queue items
  (`queue/2026-07-13-fable-ws13-…`, `…browser-permission-…`, `…local-ai-guard-plan-…`, plus
  `…session-restart-rec-…`, `…history-preview-mod-…`, `…interrupt-stuck-wat-…`,
  `…workspace-secret-ca-…`) now carry only superseded docs and can be discarded in AIO.
  **`2026-07-13-fable-ws15` was deliberately left open.** Its passing evidence ran on the queue
  branch's code, and the matching LT-541/542 fix was committed in `39d245ba` on `main`, but
  has not been live-verified on the current checkout.
- **Three current-status corrections:** WS15 needs checks 2 and 3 re-run live on the ported
  LT-541/542 fixes; its queue-branch 0-open count is historical. Session title generation still
  has two partial checks and one failed check (LT-533/534), despite its 2026-09-08 `Open: 0`
  line. The LT-196 correction miner's Cursor/Grok primary path now passes live, while its
  exit-code-only, no-output failure clause remains unverified. Their owning `_livetest.md`
  files carry the current status and acceptance wording.

---

## Environment preflight — verified 2026-09-06

Measured this session, not carried over from an older report. Several older reports are
stale on these points and the corrections change what is runnable.

| Fact | Measured value | Effect on the backlog |
| --- | --- | --- |
| `windows-pc` worker | **Connected.** Worker started 2026-09-06 05:18, heartbeat current, latency 1 ms. Extension relay running, registration `ok`, extension v0.2.19, last contact current. Browser automation running. Android SDK + AVDs present. Docker + RTX 5090 available. | The 2026-08-31 report blocked a whole class of checks on "`windows-pc` is disconnected". That blocker is **gone**. |
| Other worker nodes | `Noah3900x` and `noahlaptop` both disconnected. | Only relevant if a check needs a second node. |
| Harness app | **Packaged `/Applications/Harness.app` is running** (pid 40322). | The packaged app has no debug port, so CDP-driven checks need a separate dev app. The usual Chrome native-manifest conflict does *not* apply here — this Mac has no local native messaging manifest, the relay lives on `windows-pc`. The real reason not to start one unattended is the ten live loop agents. |
| Build freshness | `dist/main/index.js` and `dist/renderer` rebuilt 2026-09-06 11:35. No `src/main` file is newer than the build. | The compiled tree is current. The *running* packaged app is not necessarily running this build. |
| Concurrent writers | **10 `claude --print` processes** are running under the Harness main process against this repository. | Loop agents are editing this tree right now. Anything destructive, and any full-suite timing, is unreliable. |
| M365 Graph calendar | `graph_calendar_status` returns **zero connected accounts**. | The Outlook/Graph calendar checks are genuinely blocked on James's consent. Confirmed, not assumed. |
| Release state | **No version tags** (only four `preserve/*` tags), **no GitHub releases**, `package.json` version `0.1.0`. | The harness auto-update live test cannot run. There is nothing published to update from. Confirmed, not assumed. |
| Bitwarden | `bw` CLI present, vault **locked**, last sync 2026-09-05. | Vault access is available to an agent; the credential-login check still needs a real third-party login with OTP, which is James's. |
| Browser Gateway from this session | A `browser.list_targets` call against `windows-pc` was intercepted by the routing-approval hook and did not execute. | Browser-driven checks are not runnable *from this non-interactive session*. They are runnable from an interactive one. |

---

## Blocker classes

Used in every table below.

- **A — agent-runnable now.** Tests, CLI, filesystem, `windows-pc`, an interactive session's browser tools. No new authority needed.
- **B — needs a rebuilt and relaunched app**, then agent-runnable.
- **C — James only.** Physical device, TCC/System Settings, account consent or OAuth, OTP, a real third-party login, production authority, or a product decision.
- **D — blocked on an external service.**
- **E — obsolete.** Recommend deleting the check rather than running it.

---

## The backlog

At the 2026-09-06 baseline, 43 `*_livetest.md` documents were open. Every one was read in full and re-audited then; passed-check narrative was compressed into a `## Closed checks` table inside
each owning document, and each now carries a `## Status — 2026-09-06` block. The corpus
shrank from 1,156,643 bytes to roughly a third of that.

### Ready to run now — class A

No new authority and no rebuild required. This is the list to work through first.

| Document | Outstanding | What to do |
| --- | --- | --- |
| `2026-07-13-fable-ws15_livetest.md` | **2 current-checkout live rechecks** | The queue branch passed all seven checks on 2026-09-20, including checks 2 and 3 after LT-541/542 fixes. Those fixes never landed on `main`; the current working-tree port is unit-verified but not live-verified. Re-run checks 2 (healthy-link reply and replay) and 3 (parked-work window) with the disposable-worker harness before closing this file. The [LT-541](livetest-remediation-register.md) and [LT-542](livetest-remediation-register.md) entries now exist in the root register and say **REOPENED**. Check 5's historical pass includes a recorded reduced-ring-capacity method deviation. |
| `2026-07-17-browser-gateway-reliability_livetest.md` | 6 (5 are class A) | Check 1 needs an auxiliary LLM endpoint actually serving a model on `windows-pc` (`endpointCount` was 0). Check 2 is a reveal-then-reconnect cycle. Check 3 needs one continuous drop-to-reconnect observation, or a human decision that the existing split evidence counts. Check 5 needs an older `aio-mcp` SEA built from a pre-2026-07-17 commit. Check 6 needs duration instrumentation that does not exist yet, and is entangled with the LT-217 audit-table decision. |
| `2026-07-13-fable-ws13_livetest_completed.md` | **0 — closed 2026-09-20** | Nothing outstanding. All four remaining checks (4, 7, 10, 11) passed on 2026-09-20; see that document's `## Evidence run — 2026-09-20`. Check 4's mode contradiction is explained (the second log line is a `WarmStartManager` pre-spawn, not the hardened instance). Check 7 was packaged with `npm run build` + `electron-builder --mac dir --arm64` (there is no `npm run dist` script). Checks 10/11 no longer need James: an interrupt-suppression lever stages the denial-classified crash. Two new defects came out of the run — [LT-539](livetest-remediation-register.md) and [LT-540](livetest-remediation-register.md). |
| `2026-07-15-provider-agnostic-context-evidence-plan_livetest.md` | 3 (2 are class A) | Check 2 needs a long, non-tool-heavy session that actually climbs to 60%/75% occupancy — five sessions have failed to reach it. Check 7's renderer-store propagation gap is CDP-drivable. |
| `2026-07-22-local-shared-browser-control_livetest.md` | 5 (2 are class A) | §2 second half (reload the extension, recheck `browser.health` returns to `ready`) and §4 positive half (share exactly one tab, confirm `driver:"extension"` and no leak of unshared tabs). Both are single extension-popup clicks, covered by the standing local-UI authorisation. |
| `2026-07-13-codex-context-pressure-observability-discovery-plan_livetest.md` | 1 | The full literal 12-section protocol, under a quiet host. Substance already passed under relaxed conditions; what remains is running it properly. Needs an idle machine, which today's load average of 32 is not. |
| `2026-09-02-loop-issue-diagnosis-ux_livetest.md` | 3 (2 are class A) | Card layout at normal and ~900px width, and real detector text against `PROGRESS_SIGNAL_CATALOG`. Both readable from the DOM once a loop is driven into WARN then CRITICAL. |
| `2026-08-23-browser-extension-channel-flapping_plan_livetest.md` | 1 | Check 2 needs a read-only Gateway command already queued at the exact instant of a transport loss. Reachable passively by watching for another natural occurrence. |

### Needs a rebuilt and relaunched app — class B

All of these are agent-runnable *after* a rebuild and relaunch. See the warning in
"Why almost nothing ran today" before starting one.

| Document | Outstanding | Note |
| --- | --- | --- |
| `2026-09-01-browser-approval-coherence_livetest.md` | ~~4~~ → 2 | **Run live 2026-09-21** (Plan Queue worker). CDP plus a real Browser Gateway RPC instance was an acceptable substitute — no operator boundary was hit, and no real secret was used (synthetic classifier fixtures only). Checks 1 (exact redemption + dedup, including the uninspectable element) and 3 (minimise/restore) pass. Check 2 fails only at step 5: the deep link moves the highlight but not keyboard focus → **LT-610**. Check 4 passes its negative matrix and every hard stop; its "credential cards expose only Allow once and Deny" clause is contradicted by the deliberate reusable-credential-consent change in `ef4e7d90` and needs the check text reconciled. A second defect found off-check: mutations with no `instanceId` can never redeem → **LT-611**. |
| `2026-08-30-session-restart-recovery_livetest_completed.md` | 0 | All five checks passed live by 2026-09-24; LT-605/606 were confirmed fixed. The earlier “Never run” entry is superseded. |
| `2026-09-04-regular-session-announce-then-halt-guard_livetest_completed.md` | 0 | All four checks passed live on 2026-09-21; the earlier “Never run” entry is superseded. |
| `2026-09-02-loop-auto-unstick_livetest_completed.md` | 0 | **Both checks passed live 2026-09-20** (Plan Queue worker): rebuilt dev app, real review-driven Claude loop steered into a same-tool CRITICAL (signal G). In-flight card leads with **See why**; after the cap the run parks (L14) and the card is hint-first again. LT-2's "stays running" clause is superseded by L14/UX27 and amended in the document. No defect filed. The driving fixture is reusable for the loop-issue-diagnosis doc. |
| `2026-07-17-resilient-threads-sessions_plan_livetest.md` | 1 | **Re-run live 2026-09-21** (Plan Queue worker): the LT-215 fix fires but the restart's own ready-edge redelivery erases the retained record ~25 ms before the reconcile reads it — 4/4 reproductions, same two sub-assertions still failing. Filed as **LT-603** (supersedes LT-215). Now class **A**: needs the LT-603 code fix, not another attempt. |
| `2026-07-21-in-session-auth-repair_livetest.md` | ~~2 (1 is class B)~~ → 1 | **Check 4 passed live 2026-09-20** (Plan Queue worker): the LT-168 fix re-driven end-to-end via the fake-`HOME` Codex substitution — banner cleared 9s after a genuine sign-in, same instance restarted in place, failed turn replayed and answered. Only class-C check 2 remains. |

### James only — class C and D

Grouped by what one sitting with James would unblock, rather than by document, because
several documents share a single blocker.

**One approved Computer Use grant on a safe disposable app** would close, or unblock,
checks in four documents at once. James clicks Approve on the real banner inside its
60-second window; everything after that is agent-driven.

| Document | Outstanding | Blocked on |
| --- | --- | --- |
| `2026-08-26-computer-use-autonomy-level_livetest.md` | 4 | Checks 2, 3, 4 and 6. No app has ever received an approved grant in any session of this doc. Worth doing all four in one sitting. |
| `2026-08-26-session-scoped-computer-use-autonomy_plan_livetest.md` | 1 | Check 3, in-flight timing and attribution. An agent approving its own grant would defeat the self-control guard the passing checks depend on. |
| `2026-08-09-computer-use-consent-and-targeting_livetest.md` | 1 | Check 4. Also needs an allowlisted harmless in-window control — the only attempt so far, Activity Monitor at a 2,000-node snapshot, found none. |
| `2026-07-22-local-shared-browser-control_livetest.md` (§5) | — | Computer Use window activation on a real, awake, multi-monitor Chrome. |

**One clean-TCC window**, with Harness stopped, covers the macOS signing and onboarding
documents. These are in batch L and are listed in the full index below.

**One physical iPhone session** closes an entire document:

| Document | Outstanding | Blocked on |
| --- | --- | --- |
| `2026-07-25-mobile-queue-interrupt-draft_livetest.md` | 10 | Nine of ten need James's paired iPhone — Capacitor haptics, native dialogs and visual rendering have no CDP or web equivalent. Check 9 is the only agent-side item and it is a policy call: add a timing hook to `dispatchSend()`/`deliverNext()`, or accept the existing 30/30 unit evidence. |

**Account, consent and third-party login:**

| Document | Outstanding | Blocked on |
| --- | --- | --- |
| `2026-07-23-outlook-graph-calendar-connector_livetest.md` | 4 | Check 2 is one interactive delegated Microsoft sign-in as `james@communitytech.co.uk`. Checks 3 and 4 are mechanically agent-runnable the moment that lands; check 4 also needs James to supply the exact subject, dates, recurrence and attendees. Check 5 (Hotmail) needs an intentional Entra `signInAudience` change and is deferred by design. Confirmed this session: **zero connected accounts.** |
| `2026-08-25-acp-long-tool-timeout_livetest.md` | 1 | An already-authenticated disposable Copilot profile. Automation origin is policy-excluded from Copilot via `providersExcludedFromAutomation`, so the sign-in has to be James's. Also needs a quiet 10–60 minute window. |
| `browser-gateway-credential-login_livetest.md` | 2 | A real interactive Bitwarden unlock, then a real Report MI portal login with cross-domain OTP. The `bw` CLI is available and the vault is merely locked, but the portal login itself is James's. |
| `browser-gateway-cdp-hop-deadlines_livetest.md` | 1 | Check 1 needs the authenticated eTendersNI tender page shared and host-readable. Once shared, the probe and the re-validation of checks 2/3/6 are agent work. Run a `browser.query_elements` host-permission probe on that origin first — LT-218 risks a silent success-with-empty-text. |

**Production authority and disruption:**

| Document | Outstanding | Blocked on |
| --- | --- | --- |
| `2026-07-26-local-ai-guard_plan_livetest_completed.md` | 0 — both ran 2026-09-21, awaiting verification | **NO LONGER BLOCKED.** Ran in full as a Plan Queue item on `queue/2026-07-26-local-ai-guard-plan-58373b`. The blocker dissolved once "disposable worker" stopped being read as "separate machine": a second worker agent from the same commit, run on the coordinator Mac under an isolated `HOME` against an isolated coordinator port (4979, not the packaged app's 4878), advertising a disposable Ollama-compatible endpoint. Checks 2 and 5 both pass; `windows-pc` was never touched. One defect filed — **LT-604**: a worker server started after launch (Settings → Start Server, or the pair-both flow, which flips `remoteNodesEnabled` mid-session) has no `RpcEventRouter`, so every worker stays "disconnected" and no worker-local endpoint can be enrolled until the app restarts. |
| `2026-07-30-local-ai-guard-cli_plan_livetest.md` | 2 | Check 2 needs a healthy endpoint advertising the required Qwen model ids, plus authority to run a live `enrol` that rewires 11 real auxiliary-LLM routing roles. Check 3 depends on check 2. |
| `2026-07-16-worker-controller-file-movement_livetest.md` | 4 | All four share one root blocker: the Harness app is a hard-denied Computer Use target with no debug port. An opt-in debug port, or one supervised run by James, would close all four together. |
| `2026-07-22-local-shared-browser-control_livetest.md` (§3, §8) | — | §3 quits Chrome entirely, which would drop every other AIO instance's shared session. §8 is a live ProContract task needing explicit approval before any write. |

**Open product decisions — no more testing will resolve these:**

| Decision | Where it blocks |
| --- | --- |
| ~~Skill-matching injection threshold~~ — **settled 2026-09-06** (keep `0.65`) and **no longer the blocker** (2026-09-20). Retained only so the row is not re-raised. | `2026-07-23-skill-observability-and-design-skills_livetest.md`'s last open check is now blocked by LT-545/546/547, all class A. |
| LT-481 Snooze: pick between two fix directions | `2026-07-30-sibling-audit-round2_livetest.md` |
| ~~LT-196 learning-scan architecture: pick between two fix directions~~ — decided and implemented after this 2026-09-06 list; the [correction-miner live test](../superpowers/plans/2026-09-06-lt196-correction-miner_livetest_completed.md) retains one unverified no-output failure clause. | `2026-07-30-sibling-audit-round2_livetest.md` |
| Whether to spend billed provider tokens on the continuation-card and recycle-threshold comparisons | `docs/plans/2026-09-03-enhancements-backlog_livetest.md`, checks 20 and 21 (G42 / G43) |
| Whether split evidence from two separate natural disconnects satisfies check 3 | `2026-07-17-browser-gateway-reliability_livetest.md` |
| Whether to add a `dispatchSend()` timing hook or accept existing unit evidence | `2026-07-25-mobile-queue-interrupt-draft_livetest.md`, check 9 |

**Blocked on an external service — class D:**

`2026-07-30-sibling-audit-round2_livetest.md` carries three: the A5 Discord suppression
half, B8/C8 Discord and WhatsApp progress-draft behaviour, and B3 Guardian adjudication
end-to-end, which needs a reachable auxiliary-LLM endpoint and has been attempted twice.

### Copilot, Discord and secure-credential documents

| Document | Outstanding | Class | Note |
| --- | --- | --- | --- |
| `2026-08-25-copilot-account-routing_plan_livetest.md` | 11 | 9×C, 2×B | Checks 1–9 all need real OAuth against two entitled accounts. Checks 10 and 11 are pure renderer geometry — the tall Copilot section scrolling in the project `⋯` menu, and that menu painting above lower rows. Do those two first; they need a driveable renderer, not an account. |
| `2026-07-23-discord-bot-parity_livetest.md` | 10 | C | The bot is connected. Every check needs James in Discord: one bare DM, one Approve click, one "no" reply, a `select_option`, a forced failing turn, a file/image request, a tool-heavy turn with `channelToolHeartbeat` toggled, and a silent long turn for the completion ping. **This is roughly a ten-minute sitting and closes an entire document.** The 2026-07-29 "no bot configured" verdict was wrong and is now marked superseded. |
| `2026-07-13-local-macos-computer-use-signing-plan_livetest.md` | 1 | C | Steps 3–5 need a genuinely clean TCC state and James at the keyboard. Steps 1–2 have re-verified clean on every campaign pass since 2026-07-29. Note: the 2026-07-18 already-granted-TCC observation does **not** count as evidence here. Running this clean also satisfies check 1 of the permission-onboarding doc. |
| `2026-08-28-browser-gateway-secure-remote-credential_livetest.md` | 2 | A, E | **Check 1 became runnable today.** It was blocked on `windows-pc` being reconnected; the worker restarted 2026-09-06 05:18 and the extension relay is registered. Check 4 is flagged as possibly obsolete — a human should confirm whether the existing 20-file/422-test suite really exercises the Instagram-vs-Meta origin dispatch before deleting it. |

---

## The rest of the index

### macOS permissions, signing and release

| Document | Open | Class | Blocked on |
| --- | --- | --- | --- |
| `2026-07-11-harness-auto-update-plan_livetest.md` | 9 | C | **The least agent-reachable document in the set.** All nine checks sit behind one precondition: seven CI signing/notarisation secrets, a version bump, a pushed `vX.Y.Z` tag, and a green `release.yml` run. Confirmed this session: no version tags exist, no GitHub releases exist, version is `0.1.0`. The current build is ad-hoc signed and Gatekeeper-rejected; the Windows build is `NotSigned`. Nothing narrows this without James. |
| `2026-07-11-computer-use-permission-onboarding-plan_livetest.md` | 3 | C | Clean TCC state (fresh user or `tccutil reset`) taken while no live session depends on current grants, plus James clicking through the banner, System Settings and repair flows. Running check 1 clean also closes checks 3–5 of the signing doc. Computer Use enable/disable is **no longer** an open product decision. |
| `2026-07-26-browser-harness-group-lifecycle_livetest.md` | 4 | C | One bounded Computer Use observation grant for Chrome on `windows-pc`. After that all four are agent-driveable via a cropped PowerShell window capture — there is no coordinator-side route to read `chrome.tabGroups` state. Check 4 additionally needs two duplicate `Harness` group chips staged first. |
| ~~`2026-07-17-browser-permission-ux_plan_livetest_completed.md`~~ | 0 | — | **Closed 2026-09-21.** Check 1 ran end to end and passed; LT-001's post-approval retry is re-verified live and closed. The rig was a dev app from the queue worktree plus an *isolated* Chrome for Testing 152 carrying the unpacked extension, so James's Chrome and the packaged app's local channel were untouched. Two reusable lessons are in that document's `## Evidence run — 2026-09-21`: stable Chrome 153 ignores `--load-extension`, and Chrome for Testing hangs on an invisible macOS Keychain prompt without `--use-mock-keychain --password-store=basic`. No defect filed. |

### The recent documents (2026-08-23 onward)

Mostly written after the last campaign, so mostly never run.

| Document | Open | Class | What it needs |
| --- | --- | --- | --- |
| `2026-09-12-fresh-session-token-cuts_livetest_completed.md` | 0 — six checked 2026-09-21 | **Historical B** | **RAN IN FULL 2026-09-21** as a Plan Queue item on `queue/2026-09-12-fresh-session-token-789255`, in an isolated dev app built from that worktree. All six checks pass with live evidence and **no defect reproduced**, so the branch carries no commits. Claude spawns `toolMode: deferred` with 8 of 53 orchestrator tools (7,174 of 52,910 schema bytes); a hidden calendar tool was found by search, invoked for real, and a revealed `upload_to_node` still failed Zod argument validation and then RPC node resolution. Codex spawns `toolMode: stable` with 9 tools and ran search → describe → execute with its tool list unchanged. Cursor still gets all 53 eagerly. On instructions, a same-directory control spawn (`gemini`) proves the stack resolves all three files at 34,187 chars: Claude drops to 339 (nothing prepended, CLI still holds each file once) and Codex to 24,143 (exactly `AGENTS.md`, 10,048 bytes, removed). Measured saving on the orchestrator surface alone: 17,652 → 2,393 tokens per fresh session. The document has since been renamed `_livetest_completed.md`. |
| `2026-09-05-token-efficiency-remediation_livetest.md` | 5 | **A / product** | **RUN 2026-09-21** in an isolated dev app. Four checks closed: the stable wrapper passes a Browser Gateway `denied` decision to the agent verbatim; per-instance eager still gives all 46 tools directly against 11 in stable, with truthful telemetry; the composed prompt's manifested blocks hash-match the delivered Codex native input exactly, including a budgeted excerpt; the second message uses native continuation with no startup repeat; and a four-call turn reconciled to the token with cache and reasoning kept disjoint. Three defects reproduced and filed: **LT-596** (a native sub-agent's 21,830 tokens charged to nobody), **LT-597** (an interrupted turn recorded as costing zero while the quota window moves), **LT-598** (the manifest omits the adapter-appended `[Browser Gateway]` block). Of the two savings checks, the eager-vs-stable A/B is measured — **no measurable token reduction**, confirming the plan's own hedge — and the Medium-vs-High evaluation needs James. |
| `2026-09-05-history-preview-model-selection_livetest_completed.md` | 1 | **A** | **RUN 2026-09-21.** The Gateway prerequisite did not apply — all six checks are Harness renderer behaviour and were driven over CDP against a dev app with real Claude and Codex turns. Five pass. Check 2 fails its last clause and is filed as LT-595 (after a closed-session continuation the composer's model picker keeps showing the old model while the header and the backend show the new one). Re-run check 2 only, once LT-595 is fixed. |
| `2026-09-05-browser-secret-observation-recovery_livetest.md` | 9 | A/C | Written on 2026-09-05 when `windows-pc` was reported disconnected. **It is connected now and already running extension 0.2.19**, so six of the nine (deploy, reload, preflight, snapshot, induced frame-inspection failure, restore) become agent work. The other three need James operating the real toolbar popup against his own protected tabs and site data. |
| `2026-09-03-acp-loop-liveness-accounting_livetest_completed.md` | 0 | Historical B | Its six checks now have pass evidence in the owning completed document. The earlier rebuild/ACP-session blocker was cleared in the 2026-09-20 live run. |
| `2026-09-02-cross-model-checking-policy_livetest.md` | 6 | B then A | `build:main` plus relaunch, then LT-A to LT-F are agent work on a live `lawrencj` Copilot seat in an EBRD scratch repo. LT-C and LT-E need a temporary config or policy change and a restore. **LT-G cannot be run at all**: `runReviewCommand` has no runtime entrypoint anywhere in `src/`, so `aio review --reviewers none` is uninvokable. That is an implementation gap, not a scheduling problem — decide whether to keep it here or split it into the remediation plan. |
| `2026-08-30-rlm-global-budget-single-owner_livetest.md` | 6 | C | All six need the installed app stopped and a rebuilt dev app run against James's real, non-isolated RLM profile. The document is explicit that this must not run concurrently with other work using that profile — which, with ten loop agents live, rules out today. |
| `2026-08-23-workspace-secret-card_livetest_completed.md` | 4 | **A** | **Ran in full 2026-09-20** against a dev app built from the `queue/2026-08-23-workspace-secret-ca-4b8813` worktree, isolated profile, real macOS keychain, real Claude sessions. No part of it needed James — the earlier "James enters a disposable test value" note was wrong, an agent drove the whole card. All four checks completed and all four reproduced a defect, so none closed: **LT-548** the materialised workspace secret is passed to the spawned CLI in `--mcp-config` argv and was read back from an unrelated shell; **LT-549** the card keeps a rejected credential in its password input after a failed save; **LT-550** management hides the secret's name, both timestamps and the entire audit trail; **LT-551** no agent can raise the card at all, and the fallback a live session named is the plaintext `ask_questions` path. Everything else held: encryption fails closed, per-workspace scoping refuses a cross-workspace resolve, the agent saw only `secret://demo-token`, and a binary-safe sweep of the whole profile found the value in zero files. |

### Documents with checks proposed for deletion

Six documents now carry a `## Recommended for deletion` section. Each needs a yes/no
rather than a test run:

`2026-07-25-mobile-queue-interrupt-draft_livetest.md`,
`2026-07-17-browser-gateway-reliability_livetest.md`,
`2026-08-28-browser-gateway-secure-remote-credential_livetest.md`,
`2026-07-15-provider-agnostic-context-evidence-plan_livetest.md`,
`2026-07-26-local-ai-guard_plan_livetest_completed.md`,
`2026-07-30-local-ai-guard-cli_plan_livetest.md`.

The clearest case is check 3's non-resident-Claude half in the provider-agnostic document:
the architecture no longer permits reaching that state via `createInstance`, so it is not a
live-testing gap at all.


---

## What the defect register says

`livetest-remediation-register.md` holds 109 `LT-NNN` items. Auditing its index against
`2026-07-19-livetest-failure-remediation_plan_completed.md` gives three buckets:

| Bucket | Count |
| --- | ---: |
| Fixed and closed | **76** |
| **Fixed in code, live re-check still outstanding** | **23** |
| Genuinely open — no fix implemented | **10** |

**The middle bucket is the point of this whole backlog.** Twenty-three defects have a fix
sitting in the tree that nobody has ever confirmed against a running app. Several were
fixed on 2026-08-31 and have sat unverified since:

LT-147 (context-evidence kill switch), LT-168 (auth-repair auto-resume), LT-215
(fresh-fallback degradation notice), LT-218 (`browser.snapshot` empty text), LT-370
(quality-tier model pick), LT-371 (worker-socket churn), LT-523 (orchestration injection
bypassing `SessionAdmissionService`), ~~LT-524 and LT-525 (WS15 durable resume and stuck
`degraded`)~~ — both live-confirmed 2026-09-20, LT-526 (**P0** — `hardened:true` on a remote node silently running fully
unsandboxed), LT-530 (Claude OAuth failure rendered as prose), LT-532 (record-mode
preflight budget). Plus LT-018, LT-019, LT-130, LT-188, LT-192 and LT-002/003/004/011
from earlier waves.

LT-526 is the one to care about. A P0 sandbox escape marked fixed in code on 2026-08-31,
never confirmed live, and its owning check is `fable-ws13` check 5.

At the 2026-09-06 snapshot, the ten genuinely open ones were: **LT-022, LT-028, LT-029,
LT-105, LT-137, LT-196, LT-208, LT-350, LT-441, LT-481.** LT-196 and LT-481 were
product decisions in that snapshot. LT-196's design choice was subsequently implemented;
its [live test](../superpowers/plans/2026-09-06-lt196-correction-miner_livetest_completed.md)
still has one unverified no-output failure clause.

**A register hygiene problem worth fixing separately.** Fourteen index rows carry no
status text at all, and for six of them — LT-005, LT-006, LT-007, LT-008, LT-009,
LT-013 — the register still reads as an unresolved defect while the plan document records
a dated, live-verified fix. Anyone reading the register alone would reopen work that is
finished. The register's own as-built note points at the index for authoritative status,
and the index is the part that is stale, so the pointer is circular.

## Items recovered from the superseded reports

The thirteen older dated reports were re-read specifically to find anything that stopped
being restated. A number of items were carried for a session or two and then simply
dropped out of the narrative.

**Important caveat, and the reason this section is shorter than it first looked.** The
initial reconciliation flagged roughly twenty-two "silently dropped" items. Checking each
one against `livetest-remediation-register.md` directly shows most were not lost at all —
they were fixed, and the register records the fix. Dropping out of a status report is not
the same as being forgotten. The items below are the ones whose register entry carries
**no fix marker**, verified by reading the register's own index rows:

| Item | Priority | What it is |
| --- | --- | --- |
| LT-022 | P3 | `Renderer heartbeat stalled — UI event loop likely blocked` logged at ERROR level purely because the window is hidden. A CPU profile across a full "stall" showed the loop idle. A false alarm that trains people to ignore a real signal. |
| LT-028 | P2 | Codex under hardened mode is effectively unusable. The adapter logs both `using exec mode (app-server not available)` and `using app-server mode` 400 ms apart, and the MCP workers die with `Transport channel closed`. Relates directly to check 4 of `fable-ws13`. | **Re-read 2026-09-20 (WS13 check 4): the two-line reading is a misattribution — the `app-server mode` line comes from a concurrent `WarmStartManager` pre-spawn in the same process, not from the hardened adapter, and the `Transport channel closed` errors are Codex's optional remote HTTP MCP connectors failing inside the jail, non-fatal. A hardened Codex turn completed normally. The item as written no longer describes a live defect.**
| LT-029 | P2 | Hardened mode breaks on credential *refresh*: keychain writes go to `~/Library/Keychains`, which is in none of the writable roots. Needs a decision — grant the root, or document the limitation as a deliberate security trade-off. |
| LT-105 | P2 | An errored resident Claude turn still never fires `'complete'`. LT-047 fixed the `case 'result'` path; `case 'error'` in `claude-cli-adapter.ts` never calls it. |
| LT-208 | P3 | Explicitly "FOUND, NOT FIXED". The LT-195 retry-preservation branch assumes every disable path flips `enabled` and never `active`, but the schema permits `active: false` independently and nothing enforces the assumption. A latent trap that could silently reopen LT-195. |
| LT-539 | P1 | A `hardened: true` create adopts a warm-start adapter spawned **without** the Seatbelt jail, so the session runs unconfined while reporting `hardened: true`. `warmStartBlocked` has no hardened term — the LT-528 shape, one guard short. Reproduced live 2026-09-20 with a negative control. |
| LT-540 | P2 | A packaged app in startup-smoke mode repoints the machine-global Chrome native-messaging manifest at its throwaway profile, which the smoke harness then deletes — silently breaking the installed app's local extension channel. Reproduced and restored by hand 2026-09-20 with the same env `npm run smoke:packaged` sets (the npm script itself was not run). |
| LT-217 | — | Ongoing growth is fixed and 90-day read retention is implemented. What remains open is the optional compaction of the historical audit rows — the 1.36 GB already in `rlm.db`. A yes/no, not a defect. |

Verified as **already fixed** and needing nothing further, despite vanishing from the
reports: LT-095, LT-100, LT-138, LT-188, LT-193, LT-206. LT-218 is fixed with a live
unreadable-page recheck still pending, which is already tracked as check 1 of the
CDP-hop-deadlines document.

**Non-LT items that were dropped and have no register entry**, so they are genuinely
untracked and need a decision:

- 76% of production sends miss the 500 ms context deadline. (2026-07-26)
- Automation-initiated turns bypass skill observability entirely — they never call `buildInputContexts` or `fetchSkills`. (2026-07-26)
- 28 orphaned `codex app-server` processes parented to Harness, several 4–12 hours old, against zero active instances. (2026-07-26)
- `rlm-storage:get-health` blocks the main event loop for 189–2,164 ms against a 100 ms threshold. (2026-07-26)
- The dev app writes its `app.log` into the production profile, contaminating log-based evidence. (2026-07-26)
- WS13 check 8's per-provider seatbelt writable-root tightening recommendation. (2026-08-01)
- Roughly 16 GB of stale `_scratch/` database snapshots — an 11 GB `pre-migration-.../rlm.db` and 5.2 GB of `dedupe-verify/*.db` — awaiting a deliberate delete. (2026-08-01)
- Whether `contextEvidenceModeByProvider` being agent-writable, despite a design doc claiming it is not, is intentional. (2026-08-11)
- The unexplained Local AI enrolment already live in production — `733d66c0-...`, created 2026-08-24 20:44 UTC, 12 routing roles on `windows-pc`. No evidence run created it and the app log had rotated past its creation. **Worth a yes/no from James:** was this deliberate? (2026-08-25)
- `windows-pc` worker supervision. The worker was killed by an external `TerminateProcess` and stayed dead 9.3 hours because nothing supervises it. `--supervise` exists in `worker-agent/worker-supervisor.ts` but is not in the launch path, and the Windows scheduled task has no restart-on-failure. (2026-08-25) — note that the worker restarted cleanly at 05:18 today, which does not mean supervision was ever wired.
- An opt-in remote-debugging port on the packaged app. Called "the single highest-leverage unblock in the backlog" across four consecutive reports, it blocks at least three documents outright, and it never reached a punch-list. **This is probably the highest-value single decision in this file.**

## Two contradictions to settle

1. The 2026-08-19 report states that context-evidence check 7's three named residuals were "driven live and closed". The 2026-08-31 baseline still lists "check 7 visual residual" as open. One of them is wrong.
2. The 2026-08-31 report says "LT-220 and LT-521 are no longer decisions". The 2026-09-02 report, which explicitly declares 08-31 canonical, re-lists LT-521 as an open product decision. These cannot both stand.

## Why almost nothing was actually *run* today

Being straight about this rather than reporting a bigger number of closures than the
evidence supports.

1. **The host is busy.** Load average 32.65, with ten `claude --print` loop agents writing
   to this repository under the live Harness process. Several documents explicitly
   require a quiet machine, and the campaign runbook's overload rules exist for a reason.
2. **The packaged app is the running app.** `/Applications/Harness.app` is live and has no
   debug port. Every class-B check needs a *separate* dev app. Starting one unattended
   while ten loop agents are mid-flight is not a safe unilateral call. (The usual Chrome
   native-manifest conflict does not apply here — this Mac has no local native messaging
   manifest; the extension relay lives on `windows-pc`.)
3. **Browser tools are gated in this session.** A `browser.list_targets` call against
   `windows-pc` was intercepted by the routing-approval hook and never executed. Browser
   work needs an interactive session.

None of that blocks the consolidation, which is done. It does mean the honest count of
checks closed by *running* them today is zero, and the value delivered is that the
backlog is now legible and correctly classified.

## Recommended order of work

**Ahead of everything else: LT-526.** A P0 sandbox escape — `hardened:true` combined with
a remote node silently running fully unsandboxed — was marked fixed in code on 2026-08-31
and has never been confirmed against a running app. Its owning check is `fable-ws13`
check 5, class B: rebuild, relaunch, then one disposable-worker create with `hardened:true`
and `forceNodeId` to confirm it now fails closed. That is a short job and it is the only
open item where being wrong is a security problem.

Then, roughly in order of value per unit of James's time:

1. **A ten-minute Discord sitting** closes `discord-bot-parity` outright — ten checks, one whole document, no engineering.
2. **One approved Computer Use grant** on a safe disposable app unblocks four documents at once.
3. **One clean-TCC window**, with Harness stopped, covers the macOS signing and onboarding documents together.
4. **Decide the packaged-app debug port.** An opt-in remote-debugging port was called the single highest-leverage unblock across four consecutive reports and still has no decision. It blocks `worker-controller-file-movement` entirely and constrains several others.
5. **Re-run WS15 checks 2 and 3 on this checkout** with the disposable-worker harness. The 2026-09-20 queue-branch run passed all seven checks, but LT-541/542 were absent from `main`; their current working-tree port is unit-verified and still needs live revalidation before the document closes.
6. ~~**`token-efficiency-remediation`** needs no rebuild and no new authority — nine checks in the app as it already is.~~ **Run 2026-09-21** — four checks closed, three defects filed (LT-596/597/598), one savings check measured and one left for James.
7. **One M365 sign-in** turns three of the four calendar checks into agent work.
8. **One iPhone session** closes nine of the ten mobile checks.
9. **Settle the remaining product decisions and contradictions.** This 2026-09-06 list included LT-196 as a design decision; that choice has since been implemented. Its live-test document remains open for the exit-code-only, no-output failure clause.
10. **Repair the register index** — fourteen rows with no status, six of them reading as open when they are verifiably fixed.

### One thing to check before the next campaign — settled 2026-09-21

`2026-09-05-history-preview-model-selection_livetest_completed.md` gated all six of its checks behind
James re-verifying a Browser Gateway audit. That suspicion was right: the six checks are Harness
renderer and model-picker behaviours with no browser-page involvement at all, and the prerequisite
had been carried over from a browser-focused template. All six were driven agent-side on
2026-09-21 over CDP against a dev app — no Gateway, no `windows-pc`, no James. Five passed; check 2
failed and is filed as LT-595.

The general lesson is worth keeping: a browser prerequisite that names the Gateway as the *tool*
previously used to drive a renderer is not a browser dependency. Read what the checks actually
touch before classifying a document as James-only.

## Appendix — baseline documents at a glance (historical snapshots)

Originally generated from each document's `## Status — 2026-09-06` block, with a few
later row updates. The subtotal below is not a current backlog count; the owning
live-test documents and the 2026-09-24 addendum above govern current status.

| Document | Open | Closed | Failed |
| --- | ---: | ---: | ---: |
| `docs/browser-gateway-cdp-hop-deadlines_livetest.md` | 1 | 5 | 0 |
| `docs/plans/2026-07-13-fable-ws13_livetest_completed.md` | 0 | 11 | 0 | *(updated 2026-09-20 from that document's new `## Status — 2026-09-20` block; every other row is still as of 2026-09-06)*
| `docs/plans/2026-07-13-fable-ws15_livetest.md` | 2 | 5 | 0 | *Current-checkout revalidation of checks 2 and 3 remains open; the 2026-09-20 queue-branch run had 0 open / 7 passed.*
| `docs/plans/2026-07-16-worker-controller-file-movement_livetest.md` | 4 | 3 | 0 |
| `docs/plans/2026-07-17-browser-gateway-reliability_livetest.md` | 6 | 1 | 0 |
| `docs/plans/2026-07-21-in-session-auth-repair_livetest.md` | 1 | 6 | 0 | *(updated 2026-09-20 from that document's new `## Status — 2026-09-20` block)*
| `docs/plans/2026-07-22-local-shared-browser-control_livetest.md` | 5 | 3 | 0 |
| `docs/plans/2026-07-23-discord-bot-parity_livetest.md` | 10 | 0 | 0 |
| `docs/plans/2026-07-23-outlook-graph-calendar-connector_livetest.md` | 4 | 1 | 0 |
| `docs/plans/2026-07-23-skill-observability-and-design-skills_livetest.md` | 1 | 8 | 0 |
| `docs/plans/2026-07-25-mobile-queue-interrupt-draft_livetest.md` | 10 | 0 | 0 |
| `docs/plans/2026-07-30-sibling-audit-round2_livetest.md` | 5 | 16 | 3 |
| `docs/plans/2026-08-23-workspace-secret-card_livetest_completed.md` | 4 | 0 | 4 | *(updated 2026-09-20 from that document's new `## Status — 2026-09-20` block; all four ran, all four filed a defect)*
| `docs/plans/2026-08-30-rlm-global-budget-single-owner_livetest.md` | 6 | 0 | 0 |
| `docs/plans/2026-09-02-cross-model-checking-policy_livetest.md` | 6 | 1 | 0 |
| `docs/plans/2026-09-02-loop-auto-unstick_livetest_completed.md` | 0 | 2 | 0 | *(updated 2026-09-20; both checks ran and passed)*
| `docs/plans/2026-09-02-loop-issue-diagnosis-ux_livetest.md` | 3 | 0 | 0 |
| `docs/plans/2026-09-03-acp-loop-liveness-accounting_livetest_completed.md` | 0 | 6 | 0 | *(updated 2026-09-21; historical 2026-09-06 row was 5 open / 1 closed)*
| `docs/plans/2026-09-05-browser-secret-observation-recovery_livetest.md` | 9 | 0 | 0 |
| `docs/plans/2026-09-05-history-preview-model-selection_livetest_completed.md` | 1 | 5 | 1 | *(updated 2026-09-21 from that document's new `## Status — 2026-09-21` block; all six ran, one filed LT-595)*
| `docs/plans/2026-09-05-token-efficiency-remediation_livetest.md` | 5 | 5 | 3 | *(updated 2026-09-21 from that document's new `## Status — 2026-09-21` block; LT-596, LT-597, LT-598 filed)*
| `docs/plans/browser-gateway-credential-login_livetest.md` | 2 | 2 | 0 |
| `docs/superpowers/plans/2026-07-11-computer-use-permission-onboarding-plan_livetest.md` | 3 | 2 | 0 |
| `docs/superpowers/plans/2026-07-11-harness-auto-update-plan_livetest.md` | 9 | 0 | 0 |
| `docs/superpowers/plans/2026-07-13-codex-context-pressure-observability-discovery-plan_livetest.md` | 1 | 4 | 0 |
| `docs/superpowers/plans/2026-07-13-local-macos-computer-use-signing-plan_livetest.md` | 1 | 2 | 0 |
| `docs/superpowers/plans/2026-07-15-provider-agnostic-context-evidence-plan_livetest.md` | 3 | 5 | 0 |
| `docs/superpowers/plans/2026-07-17-browser-permission-ux_plan_livetest_completed.md` | 0 | 3 | 0 | *(updated 2026-09-21 from that document's new `## Status — 2026-09-21` block; Check 1 ran and passed, no defect filed)*
| `docs/superpowers/plans/2026-07-17-resilient-threads-sessions_plan_livetest.md` | 1 | 2 | 0 |
| `docs/superpowers/plans/2026-07-26-browser-harness-group-lifecycle_livetest.md` | 4 | 0 | 0 |
| `docs/superpowers/plans/2026-07-26-local-ai-guard_plan_livetest_completed.md` | 0 | 6 | 0 | *(updated 2026-09-21 from that document's new `## Status — 2026-09-21` block; checks 2 and 5 ran and passed, LT-604 filed)*
| `docs/superpowers/plans/2026-07-30-local-ai-guard-cli_plan_livetest.md` | 2 | 1 | 0 |
| `docs/superpowers/plans/2026-08-09-computer-use-consent-and-targeting_livetest.md` | 1 | 3 | 0 |
| `docs/superpowers/plans/2026-08-23-browser-extension-channel-flapping_plan_livetest.md` | 1 | 3 | 0 |
| `docs/superpowers/plans/2026-08-25-acp-long-tool-timeout_livetest.md` | 1 | 0 | 0 |
| `docs/superpowers/plans/2026-08-25-copilot-account-routing_plan_livetest.md` | 11 | 0 | 0 |
| `docs/superpowers/plans/2026-08-26-computer-use-autonomy-level_livetest.md` | 4 | 2 | 0 |
| `docs/superpowers/plans/2026-08-26-session-scoped-computer-use-autonomy_plan_livetest.md` | 1 | 4 | 0 |
| `docs/superpowers/plans/2026-08-28-browser-gateway-secure-remote-credential_livetest.md` | 2 | 2 | 0 |
| `docs/superpowers/plans/2026-08-30-session-restart-recovery_livetest_completed.md` | 0 | 5 | 0 | *(updated 2026-09-24; all five checks passed live)*
| `docs/superpowers/plans/2026-09-01-browser-approval-coherence_livetest.md` | 2 | 2 | 1 |
| `docs/superpowers/plans/2026-09-04-regular-session-announce-then-halt-guard_livetest_completed.md` | 0 | 4 | 0 | *(updated 2026-09-21; all four checks passed live)*
| `docs/plans/2026-09-03-enhancements-backlog_livetest.md` (billed-token checks 20–21; was `grok3_livetest.md`) | 2 | 0 | 0 |
| **Historical subtotal (43 rows; mixed snapshot dates)** | **134** | **130** | **12** |

---

---

## Compression verification — 2026-09-06

An independent reviewer that had not done the compression audited the six most heavily
compressed documents against their untouched backups, looking specifically for a check
that was dropped, or quietly promoted from pending to passed. It substituted one of the
six candidates for a higher-risk one it identified itself
(`provider-agnostic-context-evidence`, 15.8% of bytes kept, in place of
`local-shared-browser-control` at 23.3%).

Documents audited: `skill-observability-and-design-skills`, `sibling-audit-round2`,
`local-ai-guard`, `browser-gateway-credential-login`, `resilient-threads-sessions`,
`provider-agnostic-context-evidence`.

**VERDICT: PASS.** No lost, upgraded or downgraded checks. Every `Open · Closed · Failed`
count matched an independent recount. Every outstanding check retained its steps, blocker
class, register links and reproduction recipe; every closed check retained an evidence
pointer.

The highest-risk cases were checked deliberately — fixes that landed only days before the
compression, where the temptation to record "fixed" as "passed" is greatest. LT-523,
LT-215, LT-147 and LT-189 were all correctly held as *fixed in code, live re-check
pending* rather than closed. That distinction is the one this backlog most depends on.

---

## Adversarial re-test of the "needs James" claims — 2026-09-06

James's view was that `needjamesfor.md` is padded with items that no longer need him. Each
was re-tested with the explicit goal of *disproving* it. Some claims broke. The four
"quick sittings" did not.

### Claims that broke

| Item | Was | Actually |
| --- | --- | --- |
| Workspace Secret Card | Doc carried a "⚠ do not run — this code does not exist" warning | **Built since 2026-09-02.** Migration `062_workspace_mcp_connectors` (`rlm-migrations-061-065.ts:64`), `WorkspaceSecretStore.resolve()` (`workspace-secret-store.ts:175`), connector repository and spawn materialisation (`src/main/mcp/`), `secret://` handling (`workspace-secret-fill.ts`), commit `ca09eeefb`. All four checks runnable; check 4 was wrongly recorded as blocked on unbuilt work. Warning was stale by eleven days. |
| `history-preview-model-selection`, 6 checks | Gated on James re-verifying a tainted Gateway audit | **Confirmed wrong, 2026-09-21.** All six ran agent-side over CDP against a dev app, with no Gateway and no browser. Five pass; check 2 filed LT-595. |
| `sibling-audit-round2` B3 and `browser-gateway-reliability` check 1 | Blocked on an unreachable auxiliary-LLM endpoint | Filed when no local model server existed. `windows-pc` is now connected with an RTX 5090, 32 GB VRAM and Docker. Standing up a local endpoint is agent work. One action, two documents. |
| Install the staged `Harness.secure-credential-gate19.app` | "Staged and waiting" for James | Not in `/Applications` and not found on disk. If it does not exist, this is waiting on a build, not on James. |

### A claim that holds, but for the wrong reason

`in-session-auth-repair` check 2 is justified as "Terminal is a hard-denied Computer Use
target, so an agent structurally cannot trigger it." That reasoning is wrong — running
`/usr/bin/osascript` from a shell is not Computer Use, which means screen observation plus
synthetic input. `buildTerminalLaunchCandidates()` is pure and fully unit-tested
(`provider-login-launcher.spec.ts:14-18`); only the `execFile` at
`provider-login-launcher.ts:285-295` is unexercised.

The item still needs James, for two real reasons that should replace the stated one:

1. macOS Automation (Apple-event) permission to control Terminal is granted **per calling application**. An agent's shell process holding it proves nothing about whether the signed `Harness.app` can send those events — that is a separate one-time TCC consent dialog.
2. The check requires a real signed-out provider completing a real interactive CLI login. `provider-login-launcher.ts:1-7` says outright the app cannot complete this headlessly.

**Wording fixed 2026-09-20.** The owning livetest's check-2 blocker now states these two reasons
instead of the Computer Use one.

Worth fixing the wording so the next adversarial pass does not spend an hour disproving a
technically-wrong framing that happens to reach the right answer.

### Claims that hold, verified in code

- **Computer Use grant.** The agent MCP surface (`desktop-mcp-tools.ts:7-24`) exposes `request_app_grant` and `get_approval_status` but deliberately omits `resolve_app_grant`. The only resolution path is `PERMISSION_REGISTRY_RESOLVE` (`permission-registry-handlers.ts:64-79`), reachable from the renderer banner only. No autonomy level bypasses it — `desktop_computer_use_grant` is excluded from ACP auto-approval.
- **Discord.** `discord-adapter.ts:633-635` rejects any sender with the bot flag, not just the bot itself, so no agent-controlled identity works. Adding an allowed sender requires the real pairing-code flow (`channel-handlers.ts:191-218`); `ChannelSetAccessPolicyPayloadSchema` accepts only `mode`, never a sender list. None of the ten checks is verifiable from the outbound side.
- **Microsoft Graph.** `graph-auth.ts:41-50` wraps `PublicClientApplication` only. There is no `ConfidentialClientApplication` or client-credentials path anywhere in `src/main/graph/`, so no stored secret can drive it. Zero accounts confirmed by direct read-only query against the live operator database.

### Security observation, unrelated to the backlog

Computer Use grants persist to `~/Library/Application Support/harness/desktop-gateway-grants.json`
(`desktop-grant-store.ts:131-132`) — a plain, user-writable JSON file whose records carry
`decidedBy: 'user'`. The human-approval gate is enforced at the tool and IPC surface, not at
the storage layer, so any process with filesystem access can fabricate an approved grant and
a false audit attribution. A well-behaved agent cannot approve its own grant; a misbehaving
or compromised one can. Defence-in-depth gap rather than an active problem, but it undercuts
the audit trail those checks rely on. Not filed as an `LT-NNN` — it is a design question, not
a reproduced defect.

### Second cluster — sit-down and authority items

| Item | Verdict | Finding |
| --- | --- | --- |
| **Name an EBRD scratch repo** | **Not James** | Copilot seat routing is a pure path-prefix test — `copilot-account-resolver.ts:170-186` calls `isPathWithin()` (`canonical-workspace-path.ts:62-69`), a lexical comparison on canonicalised paths. When `input.remotes` is empty the remote-evidence loop never runs (`:308-330`), so a repo needs **no git remote at all**. An empty directory under `/Users/suas/work/ebrd/` matches identically to any client repo and satisfies LT-A to LT-F, none of which assert anything about repo content, history or remote. Creating one is still worth asking about — it is his client-repo space — but it is a courtesy, not a technical gate. |
| **Disposable worker / authority to disrupt `windows-pc`** | **Splits** | `local-ai-guard` checks 2 and 5: **not James.** That document's own prerequisites always asked for "a disposable coordinator-local Ollama endpoint" and "a disposable worker in an isolated test profile" — it was never designed around `windows-pc`. The fable-ws15 harness (isolated dev app plus from-source worker-agent over loopback) registers as a genuine `WorkerNodeInfo`, and nothing in `local-ai-public-operations.ts:88-89` or `local-ai-target-repository.ts:77` distinguishes it from a real node. `capability-reporter.ts:106-143` is what advertises Ollama, so an agent can run a controllable endpoint on that host, enrol it, and kill only that process. `local-ai-guard-cli` checks 2 and 3: **still James** — the blocker is a deliberate, repeatedly reaffirmed authority boundary against `enrol` rewiring eleven live auxiliary-LLM routing roles in the running app. A toy harness would produce weaker evidence and misrepresent the check as closed. |
| **Five minutes with VoiceOver** | **Shrinks** | `loop-issue-card.component.ts:14-30` scopes the live region (`role` alert/status, `aria-atomic`) to the diagnosis prose, with the `<details>` disclosure and action buttons as siblings **outside** it — exactly what LT-3 is trying to confirm. No existing spec asserts this: every current assertion checks `textContent` only, and none toggles the disclosure or focuses a button. A component test rendering a CRITICAL issue, toggling `<details>`, focusing each button and asserting the live-region subtree never mutates is a real, currently-missing test an agent can write. It proves Angular's mutation behaviour, not that VoiceOver honours the contract — so the human ear shrinks to final sign-off rather than the whole check. |
| **Install the staged signed build** | **Premise false** | `/Users/suas/Applications/Harness.secure-credential-gate19.app` does not exist, and none of the `app.asar` hashes on this machine matches the `0a7289f1…` in the plan. But a **current signed build already exists**: `release/Harness-0.1.0-mac-arm64.dmg`, 349 MB, built today at 11:24, signed under the same `TeamIdentifier GJL9WJ4S4W` as the installed app. So this is not waiting on a build either — it is waiting on a decision about which artifact to install and a safe window to replace the running app that every agent session depends on. Coordination, not capability. |

**A check that can never pass as written.** `browser-gateway-secure-remote-credential`
check 1 pins extension `0.2.18` and its file hashes. The repo ships `0.2.19`
(`resources/browser-extension/manifest.json:4`) and `windows-pc` is live on `0.2.19`. The
hashes are stale by construction. Corrected in the owning document.

### Third cluster — the twelve decisions

Seven of the twelve are no longer decisions, or shrink to one word.

| # | Was | Now |
| --- | --- | --- |
| **9** — was the unexplained Local AI enrolment deliberate? | Filed as unknowable: "no evidence run created it and the app log had rotated past its creation" | **Settled. It was deliberate, and James asked for it.** The log-rotation claim is true — the oldest surviving rotation starts 17 hours after the event — but a third source nobody checked has the whole thing. `conversation-ledger.db`'s `provider_event_captures` holds the transcript: on 2026-08-24 at 20:40:24Z, in codex session `01a0357b-283b-7e03-ad3c-7a32aa10ea10`, James asked "Can you fix the settings for now via CLI or something" after being walked through the enrolment UI. The assistant replied that it would "enrol the currently discovered Windows/Ollama target through the supported `aio-mcp` CLI", ran `local-ai discover --json`, then `validate` twice (both `ok: true`), the second finishing at `1787604236211`. The target's `created_at` is `1787604240000` — 3.8 seconds later, in the same tool sequence. Close the line item. |
| **12** — ~16 GB of stale `_scratch/` snapshots | Awaiting a deliberate delete | **Settled.** Measured: `pre-migration-20260712T165711Z/rlm.db` is 11,312,406,528 bytes; `dedupe-verify/` is 5.6 GB across two files. 16.2 GB total. Zero references anywhere in `*.ts`/`*.js`/`*.json` outside `_scratch/` — the only mentions are narrative tracking docs. `AGENTS.md:133` classifies `_scratch/` as disposable. Command, not run: `rm -rf "_scratch/pre-migration-20260712T165711Z" "_scratch/dedupe-verify"`. |
| **11** — six documents carry "Recommended for deletion" | Six yes/nos | **Four of the six say "None"** and need no decision at all. Of the two that carry a real proposal: the non-resident-Claude half of check 3 in `provider-agnostic-context-evidence` is **settled — delete it.** `residentClaudeForSpawn()` returns `true` unconditionally (`instance-lifecycle.ts:790-795`) and `migrateResidentClaudeDefault()` force-writes `residentClaudeSession: true` over any stale `false` (`settings-migrations.ts:184-189`), so that state is architecturally unreachable via `createInstance`. The other, check 4 of `browser-gateway-secure-remote-credential`, narrows to a single sub-item (see below). |
| **2** — compact the browser-audit rows | An open design question | **All four claims verified true**, read-only against the live database: `auto_vacuum` is `0` (NONE), `browser_audit_entries` holds 3,481,610 rows at 1,388,568,576 bytes = 28.8% of a 4.48 GiB `rlm.db`, and `grep VACUUM src/main/browser-gateway/*.ts` returns nothing. 90-day pruning is real and scheduled (`browser-audit-retention-maintenance.ts:17`, wired at `browser-gateway/index.ts:198`) but prunes only `actionClass: 'read'` rows. This is not a design decision — it is a bounded maintenance job: stop app, back up, `VACUUM`, restart. Needs free headroom roughly equal to the file. |
| **8** — does split evidence satisfy check 3? | Open | **Recommend accept.** `suspendNode()` sets `stale: true` and emits `attachment_suspended` in the same call (`browser-extension-tab-store.ts:177-198`); `restoreNode()` (`:200-222`) restores purely from the attachment's current `suspendedAt`, with no cross-incident state. The during-drop and after-restore behaviours are the same shared state machine with no coupling that only appears within one continuous incident. No defect class exists that one continuous drop would catch and two real independent drops would not. |
| **7** — mobile check 9, add a timing hook? | Open | **Recommend accept the existing evidence; add no hook.** `MobileInputQueue.drain()`/`deliverNext()` is the real production class and `mobile-gateway-server.ts:255-261` wires `deliver` straight to `dispatchSend()`. The specs drive park-on-error and resume-after-cancel through the real public API with only the injected `deliver` mocked — the network boundary, not the logic under test. 30/30 reconfirmed passing today. The only untested surface is winning a live HTTP timing race to *reach* code that is already deterministically exercised. Adding a test-only hook to a shipped hot path is the worse trade. |

Check 4 of `browser-gateway-secure-remote-credential` narrows to one sub-item: the
Instagram-bound credential must not dispatch to the Meta origin. Sub-items 1 and 3 are
solidly covered by `browser-credential-authorization-store.spec.ts`,
`browser-escalation-store.spec.ts` and `browser-gateway-action-guard.spec.ts`. Sub-item 2
is tested only against mocked frame origins, never real `business.facebook.com` — but the
already-closed check 3 validated real-target discrimination against that exact origin at
the preflight layer on 2026-08-30, so a light live preflight check may be enough rather
than a destructive live fill.

### Correction to the CI claim

`needjamesfor.md` says `main` is CI-red on `rlm-process-ownership.spec.ts` and
`loop-coordinator-memory.spec.ts`, "looks like a sharding/order-dependent flake, but that
is unproven." The failure is real — `gh run list` confirms last green was
2026-09-01T02:13:02Z and the 2026-09-06T10:32Z run failed on exactly those two specs in
shard 1/4. But **the order-dependence hypothesis is now disproven at the two-file level.**
On the exact failing commit (`03927b27b`, which is current `HEAD`), locally: 60/60 pass,
2/2 pass, and 62/62 pass together. Remaining candidates are an environment difference — CI
is Linux, this was macOS — or pollution from elsewhere in shard 1/4. Narrow the search to
OS-specific behaviour in `analyzeProductionOwnership()` and to shard-wide state, not to
these two files interacting.

---

## Work completed 2026-09-06 (second pass)

James asked for the outstanding items to be carried out rather than just listed.

### LT-526 — the P0 — is now live-verified and closed

`fable-ws13` check 5 was run end to end against a rebuilt app, not merely traced. The harness was
the documented WS15 method: an isolated dev-app coordinator on a disposable
`AIO_DEV_USER_DATA_PATH`, remote nodes enabled on loopback port 47990, and a from-source
worker-agent paired over the real pairing flow (node `26475361-…`, status `connected`).

- **Positive:** `createInstance({ provider:'claude', hardened:true, forceNodeId })` threw
  `Hardened mode is not supported for remote instances (Phase A is local macOS only).` with a stack
  through `adapter-factory.js:583` → `provider-runtime-service.js` → `instance-lifecycle.js`.
  `spawnTransaction.rollback()` fired, the instance was fully unregistered, `listInstances()`
  returned 0, and the worker's own log shows zero spawn or sandbox activity — nothing reached it.
- **Negative control:** the identical create *without* `hardened` produced instance `c5b1pn5ns` at
  `idle` with `executionLocation: {type:"remote"}`. The harness genuinely could place remotely, so
  the positive result is not an artefact of a broken harness. Terminated afterwards.

One behavioural nuance worth knowing, not a security problem: the guard fires during async
background init, so the IPC call resolves `success: true` with a transient local placeholder before
the throw and rollback. It fails closed correctly, but a user clicking Create would see a card
appear and vanish rather than get an immediate error.

Every process, port and temp profile from that run was cleaned up and verified gone.

### Decisions applied

| Decision | Outcome |
| --- | --- |
| `browser-gateway-reliability` check 3 | **Closed.** Split evidence accepted, with the code reasoning recorded in the doc: `suspendNode()` sets `stale` and emits `attachment_suspended` in one call, `restoreNode()` reads only the current `suspendedAt`, so there is no cross-incident coupling for a single continuous drop to exercise. |
| Mobile check 9 | **Decided: accept the unit evidence, add no timing hook.** The document now has no open decisions — it is purely one iPhone session. |
| `provider-agnostic-context-evidence` check 3, non-resident half | **Deleted.** Re-verified against current source: `residentClaudeForSpawn()` (`instance-lifecycle.ts:790-795`) returns `true` unconditionally and force-corrects the flag at all four spawn sites; `migrateResidentClaudeDefault()` (`settings-migrations.ts:184-189`) force-writes the setting; `residentClaudeSession` is `readOnly()` in `settings-control-policy.ts:305`. Earlier write-ups cited `:747-752`, which had drifted. |
| **LT-481, Workboard snooze** | **Fixed, not just decided** — see below. |
| **Skill-matching threshold** | **Reframed: not a product decision at all** — see below. |
| 16 GB of stale `_scratch/` snapshots | **Deleted.** 16.2 GB reclaimed, free space 995 GiB → 1.0 TiB. The livetest backup directory was verified untouched. |

### LT-481 — fixed rather than deferred

The fork was "broaden the mechanism or remove the control". Removing a control users already click
is worse than repairing it, and a Needs You lane with no way to defer a card you have already seen
is what makes a workboard unusable when several cards block on the same external thing.

Reproduced with a failing test first (1 of 21 failing), then fixed:

- `WorkboardStore` now stores `ReadonlyMap<string, AttentionLevel>` — the level held at snooze
  time — instead of a bare id set.
- New `snoozeClearedByAttention(current, baseline)` in `workboard-projection.ts` clears a snooze
  only on completion (`idle`, always worth surfacing despite being the least urgent rank) or a
  strict rise above the baseline. It survives `working`/`waiting` churn, including
  `working` → `waiting`, which is a rank rise carrying no new demand on the user.

77/77 workboard tests pass, including the five pre-existing hand-raise cases. `tsc --noEmit`,
`tsc -p tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc` and `npm run build:renderer`
all pass. A live click-through on a rebuilt app remains listed in `sibling-audit-round2`.

### The skill threshold was never a product decision

The four options were: lower the global cut, add per-skill thresholds, rewrite 36 skill
descriptions, or wire a real embedding provider. Three of those tune around a metric that cannot
do the job.

`EmbeddingService` (`src/main/rlm/embedding-service.ts:1-9`) prioritises Ollama, then OpenAI, then
a **local TF-IDF fallback**. All three measurement sessions ran on that last tier — re-confirmed
2026-09-06, `127.0.0.1:11434` is not reachable from this machine. TF-IDF over short prompts is
lexical overlap; it cannot score "review this UI/UX design comprehensively" as close to
`ui-ux-pro-max`, which is exactly why that skill scores 0.337–0.393 against its own paraphrases.
The reported inseparability (`min(on-topic) 0.0961` below `max(off-topic) 0.3368`) is a property of
the fallback metric, not of the skills or the threshold.

Keep `0.65`. Deploy an embedding provider, re-measure, then set the threshold from real data. The
literal trigger path already works (check 9, `matched_trigger: 'upload aab'`), so the current
failure mode is under-injection rather than noise — the right way to be wrong while embeddings are
missing. **This moves the check from blocker class C to class A**, and it is the same missing
capability blocking `sibling-audit-round2` B3 and `browser-gateway-reliability` check 1: one
deployment unblocks three documents.

### LT-196 — 2026-09-06 discovery (historical; implementation superseded this status)

At the time, the spec was an untracked `_spec.md` with no plan. It is now
[`2026-09-06-lt196-correction-miner_spec_completed.md`](../superpowers/specs/2026-09-06-lt196-correction-miner_spec_completed.md),
with a completed implementation plan. The [owning live test](../superpowers/plans/2026-09-06-lt196-correction-miner_livetest_completed.md)
records current Cursor/Grok passes and the remaining unverified no-output failure clause.
The present-tense investigation below describes the 2026-09-06 source state only.

Writing it turned up a scope error in the register, verified independently against the executing
code before being accepted:

- The live spawn path for **Copilot, Cursor and Grok** builds `AcpCliAdapter`
  (`adapter-factory.ts:332/399`, `:460/481`, `:523/564`). Its `tool_result` metadata is
  `{sessionUpdate, toolCallId, title, status, transport}` — **no `is_error`**
  (`acp-cli-adapter.ts:1496-1507`). The `CopilotCliAdapter`/`CursorCliAdapter` classes that do set
  it (`copilot-cli-adapter.ts:503`) are wired only into model listing, discovery and probing.
- **Codex is the only provider still feeding the miner**
  (`src/main/cli/adapters/codex/codex-notification-item-events.ts:211,230,273,304`).
- Claude computes `is_error` but raw-emits it on an internal `EventEmitter`, never as a visible
  `OutputMessage` (`claude-cli-adapter.ts:1291-1305`) — the original LT-062 effect.

So "structurally non-functional for Claude" understates it: the feature is dead for four of five
live providers. The register row has been corrected.

**A stale comment worth fixing with the code:** `correction-miner.ts:5-11` still states that
`tool_result` "carries `metadata.is_error: boolean` on Claude, ACP, Codex-exec, Cursor, and
Copilot adapters". That is false for four of those five, and it is the sentence most likely to
convince the next reader the miner is fine.

The spec recommends persisting a transcript-invisible outcome record at each adapter's true
is-error computation site, rather than feeding the miner from the raw live `tool_result` event
channel — the latter was one of the two candidate directions but carries no error signal for any
provider today (`CliToolCall` has no error field; `instance-communication-provider-events.ts:53`
hardcodes `success: true`). One deliberately open implementation choice is flagged in the spec
rather than invented: whether the record is a new `OutputMessage.type` or the existing
`tool_result` type with a hidden-from-transcript flag.

---

## Work completed 2026-09-15

### Browser Bitwarden stale-session recovery — live-verified and closed

`2026-09-15-browser-bw-stale-session-recovery_livetest_completed.md` closed both deferred checks
against the restarted Harness and the shared `windows-pc` browser channel:

- After an external `bw lock` plus non-interactive unlock invalidated the gateway's in-memory
  session, `$AIO_MCP browser-credentials enrol` recovered automatically and exited 0 with valid,
  origin-matching redacted metadata.
- After a second deliberate invalidation, `browser.fill_credential` on a separate public Jaggaer
  login tab recovered automatically and reported two filled fields. The authenticated tender tab
  was preserved; no credential value was read, no screenshot was taken, and the form was not
  submitted.

No defect was reproduced, so no remediation-register entry was added. This 2-check document was
created after the 2026-09-06 43-document baseline above and therefore does not change that
historical baseline's `43 / 169 / 93` figures.

### Addendum — 2026-09-20 (loop-issue-diagnosis-UX queue run)

[`2026-09-02-loop-issue-diagnosis-ux_livetest_completed.md`](./2026-09-02-loop-issue-diagnosis-ux_livetest_completed.md)
went from **3 open / 0 failed** to **1 open / 2 failed**. All three checks ran; three defects were
reproduced and one residual genuinely needs James.

- **The deferred prerequisite was met without a steered loop.** The document asked for a loop
  driven into a stuck iteration. The production loop-mode database already holds 2,873 recorded
  iterations, 2,447 of them carrying real detector signals. Six representative iterations were
  rebuilt into `LoopStatePayload`s from their own rows and pushed into the live `LoopStore` of an
  isolated dev app (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-b94c3b38`, port 9722), so the real
  template, the real `buildLoopIssueView` and the real theme variables did the rendering with
  verbatim detector copy. That turns out to be a **stronger** source than one steered run, because
  the same corpus can be swept for how often each defect fires.
- **LT-1 — layout passes, colour fails in one theme.** No clipping, no horizontal overflow, and
  zero overlap with the ping-pong row or the activity feed at 1400px or 900px. But in the light
  theme the severity chip, the fixability tag and the filled buttons drop to 1.09–1.91:1
  (**LT-590**) — the same hard-coded-hex family as LT-575, on a different surface.
- **LT-2 — no catalog gap, one false headline.** Every signal id the detectors can emit is in
  `PROGRESS_SIGNAL_CATALOG`, statically and across all 2,447 real iterations, with **zero** fallback
  headlines. The failure is that the WARN-escalation branch reuses signal id `A`, so **51** real
  iterations headline "Repeating the same work" for a condition that measured no repeated work
  (**LT-591**). A smaller self-contradiction — a "Needs a decision" tag beside a "give a hint" next
  step, with two primary buttons — is **LT-592**.
- **LT-1/LT-2 both shipped green because the unit tests used hand-written detector messages.** One
  existing test asserts the wrong headline as the expectation. Real recorded output is what exposed
  it, which is the argument for this class of deferral existing at all.
- **LT-3 — mechanically verified, audio left for James.** `role="alert"` for CRITICAL and
  `role="status"` for WARN, the live region scoped to the prose with the disclosure and every button
  outside it, **0 mutations** inside the live region when the disclosure is toggled or a button is
  focused, and real `Input.dispatchKeyEvent` Tab traversal reaching the summary and all three
  buttons in visual order with correct accessible names. Only "does VoiceOver actually speak it
  once" is left; that needs the physical Mac and a System Settings pane Computer Use hard-denies.
- **Numbering gap is deliberate.** This run took `LT-590`–`LT-592`, clear of the `LT-570`–`LT-575`
  block and of the `LT-535`–`LT-538` rows that exist here but not on the queue branch.

This 3-check document was created after the 2026-09-06 43-document baseline, so it does not change
that historical baseline's `43 / 169 / 93` figures.

### Addendum — 2026-09-20 (settings-UX-remediation queue run)

[`2026-08-28-settings-ux-remediation_livetest_completed.md`](./2026-08-28-settings-ux-remediation_livetest_completed.md)
still has **2 open checks**, but both were run end to end for the first time and six defects were
reproduced. Neither check was blocked, and none of the six needs James.

- **Both checks ran in full** in an isolated dev app (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-a1525f75`,
  port 9516), driven over one CDP connection with verified viewport overrides, focus emulation and
  real key events. LT-1 covered 4 widths × 2 themes × 5 reorganised tabs (80 section renders); LT-2
  covered secret masking, three destructive confirmations with both answers, all eight Ecosystem
  unsaved-edit routes, and two induced async failures.
- **Most of it passes.** The 56px compact rail, the Help drawer breakpoint, every internal section
  switcher (including Arrow/Home/End with wraparound), the Escape ladder, focus visibility on all 22
  rail stops in both themes, **0 of 57 measurements with page-level horizontal scroll at 800px** with
  long paths and a 148-char token injected, the shell skeleton and `role="alert"` error banner, the
  masked manual pairing token with no token in `app.log`, all three destructive confirmations
  cancelling safely, and all eight unsaved-edit routes.
- **Six new register entries.** **LT-574 (P1)**: `ECOSYSTEM_LIST` clears the command cache but not
  the directory-mtime cache, so the Ecosystem tab lists **no commands at all** on every visit after
  the first — a `touch` restores them for exactly one call. **LT-570**: the Help drawer is
  `aria-modal="true"` with no focus management (Tab goes into the page behind it) and the compact nav
  overlay drops focus to `<body>` on close. **LT-571**: Remote Nodes → Pairing renders an entirely
  empty panel when the server is off, which is the default; its two sibling sections both have the
  disabled-state line it is missing. **LT-572**: compact-rail nav items are 37 × 38px and the rail
  toggle is 30 × 30px, both icon-only and both under the plan's own 44 × 44 floor. **LT-573**: the
  shared save-state banner has no `role` or `aria-live` in any state, so a failed save on Ecosystem,
  Permissions, Remote Nodes, Display or Network is never announced. **LT-575**: light-theme contrast
  failures, two families confirmed from rendered pixels (Permissions preflight tiles at 1.09:1,
  Ecosystem instruction-inspector pill at 1.82:1) — this is the first contrast measurement of this
  work, which the document had recorded as unverified in either direction.
- **Numbering gap is deliberate.** This run took `LT-570`–`LT-575`. The register on the queue branch
  ended at `LT-534`, the register here at `LT-538`, and this plan already carried `LT-551` from the
  skill-observability run the same day; a gap was the only way to avoid colliding with the workers
  still allocating ids.

This document was created after the 2026-09-06 43-document baseline, so it does not change that
historical baseline's `43 / 169 / 93` figures. Open-check count unchanged at 2 — every item ran, and
they stay open only until the six defects are fixed and the failing items re-run.
