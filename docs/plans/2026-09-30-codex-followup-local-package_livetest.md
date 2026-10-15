# Codex follow-up local package: live checks

Status: pending. 0 of 2 checks passed.

**Prerequisites:** No rebuild, install or Harness restart. Both checks run against what is already on disk: LC-1 uses the Harness James is running now (installed 2026-10-04); LC-2 uses this plan's package in `_scratch/codex-followup-local-package/release/`. Do not stop or restart sessions for either check.

**Do not install this plan's DMG.** It was built on 2026-09-30. The Harness installed on 2026-10-04 is newer, already contains the verified follow-up renderer change, and also contains the later fatal-trap startup guard that this DMG lacks. Installing it would be a downgrade.

**Owning plan:** [Codex follow-up local package](2026-09-30-codex-followup-local-package_plan_completed.md).

**Remediation:** Read [Live-test campaign runbook](livetest-campaign-runbook.md) first. A reproduced defect requires a new numbered entry in [the remediation register](livetest-remediation-register.md) and a matching implementation-status section in `2026-07-19-livetest-failure-remediation_plan.md`. Keep per-check evidence here. Never edit a closed `_completed` document to add a new requirement; open a follow-up or reopen its lifecycle first.

## LC-1. Follow-up buttons work in the running Harness

Why deferred: the packaged app has no debug port, and Computer Use is hard-denied for Harness itself, so no agent can look at or click inside James's running app. The completed renderer plan verified the production Markdown service and styles in a browser fixture, and explicitly did not claim the real OS clipboard or the running packaged app.

Agent-side evidence already gathered (2026-10-06): the installed `app.asar` (modified 2026-10-04 19:06 local) contains the renderer markup `data-followup-prompt` / `Copy follow-up prompt` and the `.codex-followup` styles. The six reviewed source files still match the hashes from the renderer plan's independent PASS. Since that install the packaged app has kept spawning sessions from `/Applications/Harness.app/Contents/Resources/config/mcp-servers.json` (production `app.log`, through 2026-10-05 23:07 UTC), so the running app is that build.

- [ ] In the running Harness, open a Codex session whose output contains a follow-up directive (raw form `::codex-followup[Label]{prompt="..."}`, usually at the end of a Codex reply). Expected: each follow-up shows as a readable button with its label, not the raw directive text.
- [ ] Press Tab until a follow-up button is focused. Expected: a visible focus ring.
- [ ] Click (or press Enter on) the button, then paste into any text field outside Harness. Expected: the pasted text is exactly the follow-up prompt, the button changes to its copied style with the tooltip `Prompt copied. Click to copy again`, and nothing is sent to the session or written into the draft box.

Evidence to record here: date, session used, what was pasted (or a note that it matched), and any difference from the expected result.

## LC-2. This package starts with Chromium's sandbox on

Why deferred: every agent shell runs inside Harness's Seatbelt signal fence, and macOS refuses the nested sandbox Chromium's GPU and network helpers need. In-session launches therefore fail with `sandbox initialization failed: Operation not permitted`, then `GPU process isn't usable. Goodbye.` (2026-09-30 evidence). With Chromium's sandbox and GPU switched off, the same package started cleanly in-session on 2026-10-06 (below), so the remaining unknown is only the sandboxed launch, which needs a shell outside Harness.

Agent-side evidence (2026-10-06, `_scratch/codex-followup-local-package/nosandbox-probe-result.json`): isolated smoke profile, `--no-sandbox --disable-gpu --js-flags=--max-old-space-size=8192`; ready marker after 14.0 s, `Harness initialized` then `Packaged startup smoke completed`, self-quit with exit code 0, no FATAL line, no forced kill. The only error was the thin-client port 4880 already being held by the running Harness, which is expected and non-fatal. The Chrome native-messaging manifest still pointed at the production profile afterwards, and the package and DMG hashes were unchanged.

Steps (Terminal.app, not a Harness session; about 30 seconds; safe while Harness is running):

```bash
cd /Users/suas/work/orchestrat0r/ai-orchestrator
node _scratch/codex-followup-local-package/terminal-startup-check.mjs
```

- [ ] Expected: the command prints `Packaged startup smoke passed (darwin)` and `PASS: packaged startup check passed`, and `_scratch/codex-followup-local-package/terminal-startup-check-result.json` records `"passed": true`. A Harness window may flash briefly; it quits on its own. A `Failed to initialize: Thin-client WebSocket` / port 4880 line is expected while the real Harness runs.
- [ ] If it fails: the script keeps its throwaway profile and prints its path plus the last lines of output. This build lacks the fatal-trap guard, so a Chromium fatal error can leave a `Harness` process at full CPU that ignores Quit; find it in Activity Monitor by the `_scratch/codex-followup-local-package` path and Force Quit it (never the `/Applications` one). Record the printed output here and treat it as a reproduced defect per the remediation header.

Evidence to record here: date, the printed result, and the result JSON contents.
