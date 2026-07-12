# Loop Library — borrowed slices completed

Source: https://signals.forwardfuture.ai/loop-library/ (50 curated agent loops)

**Verdict:** don't borrow their architecture — our `LoopCoordinator` (evidence
ladder, progress signals A–H, fresh-eyes review, hard caps) is already stronger
than their prompt-only loops. Borrow two things instead:

1. An **authoring template** (a writing convention — zero code).
2. A **handful of recipes** packaged as built-in `AutomationTemplate` entries
   (additive, fits the existing pattern in
   `src/main/automations/automation-templates.ts`).

Implementation status: the additive recipe slice is wired into
`src/main/automations/automation-templates.ts` and covered by
`src/main/automations/automation-templates.spec.ts`. The authoring convention is
captured in the new recipe prompt shape. Registry discovery is covered as well:
`SkillRegistry.discoverSkillsWithBuiltins([])` now accepts both inline
`triggers: [...]` frontmatter and the legacy singular `trigger: ...` shape, so
all built-ins are discoverable through the same path. The artifact-to-skill idea
in section 3 remains a separate proposal by design.

---

## 1. Authoring template (the one good convention they have)

Every loop they ship states the same four things up front, in this order. We
should adopt the same shape for any canned loop/automation/skill we write,
because it forces "how do we know it's done" to be answered before the agent
starts.

```
OBJECTIVE  — one measurable, bounded outcome (a number or a binary, not "improve X")
CHECKS     — exactly how we verify progress/success (a command, a metric, a diff)
STOP       — the three exits: done (success criteria met) | stalled (no progress) | needs-permission/approval
GUARDRAILS — don't regress passing behaviour · don't make destructive changes without verification · don't proceed past a permission boundary
```

Our `LoopConfig` already captures this structurally (caps, thresholds,
completion strategy, verifyCommand). The gap is purely human-facing: our recipe
*prose* doesn't follow a consistent shape. This template closes that gap with no
runtime change.

---

## 2. Drop-in recipe drafts (`AutomationTemplate` shape)

These follow the existing house style exactly: multi-line `prompt` joined with
`\n`, a "Do not …" guardrail line, and a closing "Return a concise summary …"
line (asserted by `automation-templates.spec.ts`). Picked to be distinct from
the 5 we already ship (daily-repo-health, dependency-audit, open-pr-review-sweep,
weekly-project-summary, log-triage) and to hit *this* repo's documented pain.

> NOTE: automations fire once per schedule tick — they are not true
> iterate-to-convergence loops. The prompts below are written to do one
> bounded, verified pass per run, which is the honest fit for the automation
> model. If/when a `LoopTemplate` registry exists, the same objective/checks/stop
> text ports straight over to a real loop.

```ts
// Append to TEMPLATES[] in src/main/automations/automation-templates.ts
{
  id: 'test-stabilizer',
  name: 'Test Stabilizer',
  description: 'Find flaky tests, fix their root cause, and prove stability with repeated runs.',
  prompt: [
    'OBJECTIVE: identify one flaky test and eliminate its root cause this run.',
    'CHECKS: re-run the affected test file multiple times; it must pass on every run before you consider it fixed.',
    'STOP: done when the flaky test has a root-cause fix and repeat-run evidence; stalled when no reproducible flaky test or root cause is found; needs-permission when the fix requires destructive changes, external credentials, or approval.',
    'GUARDRAILS: Do not delete tests, weaken assertions, add blanket retry wrappers, or hide instability behind longer timeouts.',
    'Investigate the underlying cause (timing, shared state, ordering, mocks) rather than masking it with retries or longer timeouts.',
    'Return a concise summary of the flaky test found, the root cause, the fix, the repeat-run evidence, and any blockers.',
  ].join('\n'),
  suggestedSchedule: { type: 'cron', expression: '0 7 * * 1-5', timezone: 'UTC' },
  tags: ['tests', 'flaky', 'stability'],
},
{
  id: 'contract-alias-sync-audit',
  name: 'Contract Alias Sync Audit',
  description: 'Verify @contracts subpaths stay in sync across the three alias sites that the packaged DMG depends on.',
  prompt: [
    'OBJECTIVE: confirm every @contracts/schemas/* and @contracts/types/* subpath resolves at runtime, not just at typecheck.',
    'CHECKS: for each subpath alias, verify it is declared in all of tsconfig.json, tsconfig.electron.json, and the exactAliases map in src/main/register-aliases.ts (and vitest.config.ts if imported from tests). Report any subpath missing from one or more sites.',
    'STOP: done when all contract subpaths are checked and any drift is reported; stalled when aliases cannot be enumerated from the repo; needs-permission when verifying a path requires unavailable packaging credentials or external access.',
    'GUARDRAILS: Do not edit alias files automatically; only report drift and the exact missing entries.',
    'This guards a packaging trap that has silently broken the DMG: tsc path aliases are type-check-only and do not rewrite emitted JS.',
    'Return a concise summary of subpaths checked, any out-of-sync sites, the exact entries needed, and any blockers.',
  ].join('\n'),
  suggestedSchedule: { type: 'cron', expression: '0 11 * * 1', timezone: 'UTC' },
  tags: ['contracts', 'packaging', 'propagation'],
},
{
  id: 'fresh-clone-onboarding',
  name: 'Fresh-Clone Onboarding Check',
  description: 'Act as a first-time user following the README, surface the first hidden setup assumption.',
  prompt: [
    'OBJECTIVE: find the first place a brand-new contributor would get stuck following the README/setup docs from scratch.',
    'CHECKS: read the documented setup steps in order and verify each is actually runnable and correct against the current repo (scripts exist, commands match package.json, native/ABI steps are documented).',
    'STOP: done when the first blocking setup assumption is identified or all setup steps are verified; stalled when setup docs are absent or contradictory; needs-permission when verification requires credentials, external accounts, or destructive machine changes.',
    'GUARDRAILS: Do not change source code or configuration; documentation-gap reporting only.',
    'Assume no prior knowledge and no pre-existing local state; flag any step that relies on undocumented context.',
    'Return a concise summary of the steps walked, the first blocking assumption found, a suggested doc fix, and any other gaps.',
  ].join('\n'),
  suggestedSchedule: { type: 'cron', expression: '0 12 * * 3', timezone: 'UTC' },
  tags: ['onboarding', 'docs', 'developer-experience'],
},
{
  id: 'docs-sweep',
  name: 'Docs Sweep',
  description: 'Keep documentation aligned with the current codebase; flag drift between docs and reality.',
  prompt: [
    'OBJECTIVE: find one concrete place where documentation no longer matches the code and propose the correction.',
    'CHECKS: cross-check claims in docs/ and the root markdown files against the actual code (commands, file paths, type names, architecture statements). A claim counts as drift only when the code contradicts it.',
    'STOP: done when one verified documentation drift and its minimal correction are reported; stalled when no code-backed drift is found; needs-permission when checking the claim requires unavailable credentials or external systems.',
    'GUARDRAILS: Do not rewrite docs wholesale or change code; identify the specific drift and the minimal correction.',
    'Prioritise load-bearing docs (architecture, setup, packaging gotchas) over cosmetic wording.',
    'Return a concise summary of docs checked, the drift found, the suggested fix, and any blockers.',
  ].join('\n'),
  suggestedSchedule: { type: 'cron', expression: '0 13 * * 4', timezone: 'UTC' },
  tags: ['docs', 'maintenance', 'sweep'],
},
{
  id: 'production-error-sweep',
  name: 'Production Error Sweep',
  description: 'Find the highest-signal recurring error in local logs, trace it, and propose a verified fix.',
  prompt: [
    'OBJECTIVE: pick the single most actionable recurring error from recent logs and trace it to a root cause.',
    'CHECKS: confirm the error is real and recurring (multiple occurrences, a clear trace), and identify the originating code path before proposing a fix.',
    'STOP: done when one recurring error is traced to a root cause with a narrow proposed or applied fix; stalled when recent logs contain no actionable recurring error; needs-permission when the fix requires credentials, production access, or approval.',
    'GUARDRAILS: Do not apply broad changes or delete logs; propose a narrow fix and only apply it if it is clearly safe and verifiable.',
    'Distinguish actionable errors from expected noise; ignore one-off or already-handled cases.',
    'Return a concise summary of errors triaged, the chosen error and its root cause, the proposed/applied fix, verification, and any blockers.',
  ].join('\n'),
  suggestedSchedule: { type: 'cron', expression: '0 15 * * 1-5', timezone: 'UTC' },
  tags: ['errors', 'operations', 'triage'],
},
```

### Wiring completed

**Automation catalog** (scheduled one-pass recipes):
1. Appended the 5 entries above to `TEMPLATES[]` in
   `src/main/automations/automation-templates.ts`.
2. Updated `src/main/automations/automation-templates.spec.ts`: extended the
   exact id-list assertion and added an authoring-template test that asserts each
   borrowed recipe leads with `OBJECTIVE`/`CHECKS`/`STOP`/`GUARDRAILS` lines and
   the three `done`/`stalled`/`needs-permission` exits.

**Built-in skills** (loop-mode invocable, same five recipes):
3. Added 5 skill bundles under `src/main/skills/builtin/`, each a `SKILL.md`
   carrying the authoring-template loop contract:
   - `test-stabilizer/` (trigger `/test-stabilizer`)
   - `contract-alias-audit/` (trigger `/contract-alias-audit`)
   - `fresh-clone/` (trigger `/fresh-clone`)
   - `docs-sweep/` (trigger `/docs-sweep`)
   - `error-sweep/` (trigger `/error-sweep`)
4. Added `src/main/skills/builtin/loop-recipe-skills.spec.ts` asserting valid
   frontmatter (name/description/triggers/`category: loop`) and the loop-contract
   sections in each bundle. They are auto-discovered by
   `SkillRegistry.discoverSkillsWithBuiltins()` like the existing built-ins.
5. Fixed the shared skill frontmatter parser so `SkillRegistry` recognizes both
   the loop-recipe `triggers: [...]` arrays and older built-in `trigger: /...`
   entries; added registry discovery assertions for both shapes.

**Verified:** direct registry smoke check (`discoverSkillsWithBuiltins([])`)
returned all 12 built-ins and matched `/docs-sweep` + `/verify`;
`npx vitest run src/main/automations/automation-templates.spec.ts src/main/skills/builtin/builtin-skill-routing.spec.ts src/main/skills/builtin/loop-recipe-skills.spec.ts`
(20 passed); `npx tsc --noEmit` (exit 0);
`npx tsc --noEmit -p tsconfig.spec.json` (exit 0); `npm run lint` (ng lint
clean); `npm run lint:fast` (exit 0, 532 existing warnings, 0 errors);
`npm run check:ts-max-loc` (passed); `npm run test` (1027 test files and 10357
tests passed).

---

## 3. The one structural idea worth a real spike (not just a recipe)

**Strip Miner / artifact-to-skill** (loops #46 + #45): mine authorised agent
history for workflows that repeatedly succeeded *and survive a fresh replay*,
then promote them into reusable skills.

Why it stands out for us: we already own all three subsystems it needs —
`observation/`, `learning/`, and `skills/` — but nothing connects them into a
feedback loop. This is the highest-leverage borrow on the page because it's
"wire together things we already built," not "build a new engine." Treat as a
separate proposal, not part of the recipe slice above.

---

## What we already have and do NOT need to borrow

- Completion-contract (#28), Multi-LLM convergence (#34), Clodex adversarial
  review (#19) → already covered by the evidence ladder + codex-cli MCP
  cross-model review. Only borrow is *packaging it as a one-click named loop*.
- Quality-streak / full-product-eval / builder-reviewer loops → subsumed by
  fresh-eyes review mode + progress signals.
- Champion/holdout (#23) → only relevant if we pursue self-improving system
  prompts/routing; park it.
