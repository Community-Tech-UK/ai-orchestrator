# October Phase 4 tooltip foundation: live checks

**Status:** pending live validation. No live result is implied by worker unit tests.
**Plan:** [Tooltip foundation](2026-10-10-oct-phase4-tooltips_plan.md).
**Prerequisites:** coordinator-integrated build containing this queue worktree's changes; rebuild main and renderer (`npm run build:main`, `npm run build:renderer`) and restart the designated Harness application on `windows-pc`. Record the build commit, app instance and date before testing. Use a disposable project folder and test session for loop/queue checks. Required settings are named in each check; use both light and dark themes for visual checks. The shortcut/reason first-adopter checks from 5c/5d belong to Phase 4 part 2, whose adopters are outside this foundation.

**Routing:** browser and desktop work run on `windows-pc` through the approved gateway after worker/channel health checks. No local Mac browser or desktop use without James's task-specific permission. If Windows is unavailable, report health evidence and leave these checks pending.

**Remediation flow:** read [the live-test campaign runbook](livetest-campaign-runbook.md) before the campaign. A reproduced defect becomes a new LT-NNN entry in [the remediation register](livetest-remediation-register.md) plus the matching implementation-status section in `2026-07-19-livetest-failure-remediation-followup_plan.md`. Keep per-check evidence here. Rename this document `_livetest_completed.md` only after every applicable check passes.

**Why deferred:** these checks require native Chromium/Electron event behaviour, a rebuilt/restarted designated app, visual judgement, a screen reader, or fresh real provider sessions. Agent-runnable DOM, source-analysis, sanitiser, binding and focus-trap checks are covered by targeted tests and are not deferred here. The queue verifier owns the full suite and completion verdict.

For each numbered check below record PASS/FAIL, the exact action/settings, the observed result and an evidence reference. Optional checks may be explicitly skipped with a reason.

## Step 1. D1b: Existing hover hints show in Harness's own tooltip (M)

**Live checks:** (Windows PC, rebuilt app; not the Mac)
1. Hover a titled control (for example the History button in the rail). Expect the styled tooltip after about 0.2 s and
   never a grey native bubble, even after waiting 2 s. Repeat on a title-bar chip while a reply is streaming (the transcript
   scrolls by itself): the tooltip must stay open.
2. Click it, keep the pointer there, wait 2 s. Expect no tooltip and no grey bubble. Move off and back on: the tooltip
   returns (the title was restored).
3. Press Tab to a titled control. Expect the tooltip; Escape hides it.
4. Hover the title-bar chips (quota, notifications, pause). Expect styled tooltips (the drag-region check).
5. Hover a `disabled` titled button. Expect the tooltip (Chromium delivers pointer events to disabled controls; jsdom
   cannot prove it). This is the same check as step 5d's: record the result once, here.
6. Hover the queued-message "not saved" tag. Expect the full "a renderer crash right now could lose this message".
7. Hover an empty-state card heading area (for example Snapshots with nothing saved). Record whether a native bubble
   appears today; the bridge must not add a styled one.
8. Alt-tab away while hovering a titled button and come back. Expect it to still show a tooltip on the next hover.
9. Hover a button that sits inside a titled area (the 2 real cases are `input-panel.component.html:66,92`). Expect only the
   styled tooltip, with no grey bubble from the outer element.

## 2b. The "Completed" dot gets its hover hint (XS)

**Live checks:** (Windows PC) in the history list, hover the dot on an unread, completed entry: "Completed — click to
view" appears.

## 3a. The guide, the pointer and the guard (S)

**Live checks:** (needs a person and the real CLIs; no browser)
1. Start a fresh Claude Code, Codex, Copilot and OpenCode session in this repo (any machine). Ask each: "Add a delete
   button to the plan queue row." Confirm each reads `docs/screen-and-wording-guide.md` before editing, and that the
   result has a tooltip, an accessible name and a visible consequence.
2. Ask a fresh reviewer session to review a small diff that adds `<button>×</button>` under `src/renderer/`. Check that it
   reports check 1 and does not answer "All clear".

## 5a. Windows and Linux hints say Ctrl, not Win (XS)

**Live checks:** (Windows PC) Settings → Keyboard and the command palette show "Ctrl", never "Win".

## 5b. Screen readers hear a button's name once (XS)

**Live checks:** optional (needs a screen reader on the Windows PC): Tab to a migrated icon button; it is announced once.

## 5c. Hover hints can show the button's real shortcut (S)

**Live checks:** run on part 2's step 1b (the rail, the first adopter). Visual: the chip is readable in light and dark themes.

## 5d. Buttons that stay greyed out say why, and Tab reaches them (S)

**Live checks:** run on part 2's 1d and 1g. Hovering a plain `disabled` control is the same check as step 1's live check 5, so
it is recorded once, there (it settles the unverified claim above; the design does not depend on it).

## 5e. One phrase names and explains an icon button (S)

**Live checks:** run on 7c (the first "?" button). Optional: NVDA reads the reason on focus (best effort; the first reasons are in part 2).

## 6a. The glossary data and the underlined word (S-M)

**Live checks:** with 6c.

## 6b. One shared Help panel, mounted once (S-M)

**Live checks:** with 6c.

## 6c. The first three screens, and two dead tooltip texts removed (XS-S)

**Live checks:** (Windows PC; no browser on the Mac)
1. Queue a message and make it a steer message. Hover "steer": the definition appears. Tab to it: the same appears. Enter opens the
   Words panel on that word.
2. Open a term from inside Settings with Settings' own Help drawer already open: the new panel sits on top, Escape closes only
   it, and focus returns to the term.
3. Check the dotted underline and the focus ring in light and dark themes, and that clicking a term inside a clickable row does
   not trigger the row.

## 7b. File names in the conversation can be reached with the Tab key (S)

**Live checks:** (Windows PC) in a transcript that mentions a file path in backticks: Tab onto it, see the hint, press Enter, and the
file opens. Repeat with a path written as a markdown link. Press Tab from the top of a long transcript and Shift+Tab from the message
box, and record how long crossing takes.

## 7c. A "?" on the loop panel and the session header (S-M)

**Live checks:** (Windows PC)
1. Open a session, Tab to the header "?" and press Enter: the panel opens on "Working in a session"; Tab stays inside it; Escape closes
   it and focus is back on the "?".
2. Open the loop setup form, then (with a loop running) the loop panel: both "?" buttons open "Loop Mode" help.
3. Check the "?" at narrow window widths (header wrapping) and in light and dark themes.
4. This is the first real use of `[appIconButton]` (step 5e): confirm each "?" button's accessible name and tooltip are the same
   words, and record which route the 5e spike used.

## 7d. The loop help in plain English (S)

**Live checks:** (Windows PC) read the loop help once as James would, and confirm there is no word you would have to ask about.

## 8b. The screen-and-wording section in the reviewer prompts (S)

**Live checks:** (needs a real reviewer CLI and a little quota; no browser; no branch)
1. In a quiet moment (no other session's renderer changes in the tree), add `<button (click)="remove()">×</button>` to a renderer template in the
   working tree and run `aio review` (it defaults to `HEAD`) with one real reviewer: expect one "screen and wording note" naming that line. Revert
   the edit. Repeat with only a `src/main/` change: expect no such note. If the working tree is too busy for the 32,000-character window, use a
   throwaway clone made outside this repository's folder (not a branch or worktree of it).
2. Optional: have a fresh reviewing agent (Claude or Codex) review the same change in this repo with no extra instruction, and confirm it reads the
   guide and reports check 1.

## Step 9. D10 (first half): The lint plug-in and its link test, with every rule off (M)

**Live checks:** none required. Optional, with a person: after the first switch-on, open a template in the editor and confirm the squiggle appears.
