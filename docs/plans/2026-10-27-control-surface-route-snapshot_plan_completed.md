# Control-page route snapshot follow-up

Status: existing implementation rechecked and ready for queue verification (2026-11-03); live checks and
independent verification remain open. Created 2026-10-27 by the Local AI CLI parity live-test worker.
This renderer defect does not change the Local AI parity acceptance criteria. Keep this document untracked.

Register: LT-790. Origin: [Local AI parity evidence](2026-10-04-local-ai-cli-parity_livetest.md).
Shared implementation: [Settings/Local AI remediation](2026-10-27-control-surface-route-snapshot-remediation_plan_completed.md).
The coordinator's combine decision retains both reports' verification requirements.

## Implementation status

- [x] Capture the real CDP exception on a directly loaded control-page route (original campaign).
- [x] Trace the constructor subscription through `startWith(null)` to the unguarded
  `current.snapshot.data` read in `ControlSurfaceShellComponent`.
- [x] File observed behaviour, root cause, required behaviour and acceptance in LT-790 (original campaign).
- [x] Add a focused absent-child-snapshot regression before changing the component; reproduce
  using the real router for Settings, Local AI, Automations and nested metadata.
- [x] Implement snapshot-tree traversal, preserving route-specific navigation, heading and help.
- [x] Run component/router regressions, static checks, lint and production builds; retain receipts
  in the shared remediation evidence directory.
- [ ] Queue verifier: run the full suite and independent task-completion gate before closure.

Direct-load and repeated-navigation checks in a rebuilt Electron app, with focus emulation and
fresh-error capture, remain deferred to the
[combined live checklist](2026-10-27-control-surface-route-snapshot-remediation_livetest.md).

## As-built notes and limits — 2026-10-31

One shared shell change addresses this report and the Settings report. It reads the shell's
complete recognized snapshot tree rather than live child routes that have not yet activated.
The tests observe the missing live child snapshot and present recognized snapshot immediately
before the real router constructs the shell. They also verify later navigation updates,
active links, deepest recognized metadata, heading/help selection and Settings help suppression.
They substitute feature contents, so they do not claim full Local AI or Settings integration.

See the shared plan for code locations, command receipts, evidence integrity seal and remaining
checks. No separate spec is linked. No register entries were renumbered or closed, and the July
completed remediation plan was not edited. The historical Local AI evidence directory mentioned
by the original report is absent from this root checkout and the assigned worktree; this worker
relies on the current failing/passing router evidence instead of treating that missing directory
as current proof. Both active plans stay at their root-checkout paths, untracked and unrenamed.
The coordinator retains independent verification and closure authority.

## Worker readiness refresh — 2026-11-03

The assigned checkout already contains the shared implementation and regressions in its starting
commit. No production or test changes were needed. The executing path remains the shell
constructor's synchronous subscription and subsequent `NavigationEnd` events
(`src/renderer/app/shared/control-surface/control-surface-shell.component.ts:66`), calling snapshot
traversal at line 121. The real-router regressions at
`src/renderer/app/shared/control-surface/control-surface-shell.component.spec.ts:88` verify absent
live-child snapshots on initial activation; the navigation regression at line 127 verifies shell
reuse/recreation, headings, active links and contextual help. Placeholder feature content still
limits these checks to routing and the shell.

Fresh targeted tests, both type checks, lint, TypeScript size/UI-hint checks, both production
builds and both committed generators passed. Generators left the tracked checkout unchanged.
The renderer build reports an initial-bundle size warning; test output retains the test
environment's Zone.js, unavailable Electron API and HTML-sanitization warnings. No warnings
were suppressed. Exact command results, full logs, source identity, cleanup receipt and an
integrity seal are in the
[current worker report](evidence/2026-11-03-control-surface-route-snapshot-readiness/report.md).

Ruling: retain the existing implementation because the current source and routing tests satisfy
all worker implementation items. Do not duplicate the fix or manufacture a code diff. The only
unchecked plan item belongs to the queue verifier; the worker instruction explicitly reserves
the full suite and independent completion gate for that verifier. No independent PASS, new
before/after failure reproduction, or live Electron validation is claimed by this refresh.

The shared-plan link above now follows its existing `_completed` filename; its name alone is
not evidence that its pending verification passed. This worker did not edit that document,
rename this plan, or close any register entry. The combined live checklist remains pending and
unchanged. This plan stays untracked at its original root-checkout path; the coordinator owns
verification and closure. No linked spec exists for this follow-up.

## Merge-conflict follow-up — 2026-11-03

Resolved and staged the coordinator's two merge conflicts in
`src/main/rlm/frontier-cost-attribution.ts` and `src/shared/types/provider.types.ts`.
Both sides centralized the same Claude 5.5 accounting IDs. The resolution uses
incoming main's dedicated `CLAUDE_PRICING_MODELS` group throughout accounting and
removes unused duplicate pinned constants, preserving prices, IDs and picker
contents. Both resolved files exactly match the incoming merge revision.

Fresh targeted tests, both type checks, lint, size/UI-hint checks, generators and
both production builds passed. A direct runtime smoke confirmed the affected
Antigravity labels retain their priced Anthropic identities and picker exclusion.
The baseline tests reproduced the conflict-marker parse failure. Full receipts,
self-review, source identity, cleanup and seal are in the
[merge follow-up report](evidence/2026-11-03-control-surface-route-snapshot-merge/report.md).
The whole-index whitespace check found trailing spaces only in an unrelated
incoming browser-login evidence report; the resolved source files pass the check.

No commit or merge abort was made; the merge remains open for the coordinator.
No test source, renderer code or generated tracked files changed. The full suite,
independent completion gate and existing live checks remain open with their
existing owners. This active plan remains untracked, unrenamed and unclosed.
