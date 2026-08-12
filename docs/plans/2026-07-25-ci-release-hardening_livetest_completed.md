# CI and Release Hardening Live Test

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

Status: pending external repository administration

Plan:
[2026-07-25-ci-release-hardening_plan_completed.md](./2026-07-25-ci-release-hardening_plan_completed.md)

## Prerequisites

- Use a GitHub account or narrowly scoped GitHub App installation token with
  repository Administration read/write access.
- Target `Community-Tech-UK/ai-orchestrator`.
- No application rebuild or restart is required.

## 1. Enable immutable releases

In the repository's GitHub release settings, enable **Immutable releases**.
This is an external administrative state change and cannot be performed or
verified by the release workflow's least-privilege `GITHUB_TOKEN`.

Expected observable result: the repository settings UI shows Immutable
releases enabled.

## 2. Verify the live API state

With an administrator-authorized GitHub CLI session, run:

```bash
gh api repos/Community-Tech-UK/ai-orchestrator/immutable-releases --jq '.enabled'
```

Expected observable result: the command exits `0` and prints exactly `true`.

## 3. Close this live test

Record the verification date and evidence without copying credentials or token
values into the repository. Rename this file to
`2026-07-25-ci-release-hardening_livetest_completed.md` only after both checks
pass.

## Evidence run — 2026-07-29

| Check | Result |
| --- | --- |
| 1 — enable Immutable releases | **NOT DONE — deliberately left for James** |
| 2 — verify the live API state | **FAIL (correctly): the setting is off** |

Check 2 run verbatim from the doc:

```
$ gh api repos/Community-Tech-UK/ai-orchestrator/immutable-releases --jq '.enabled'
false
$ echo $?
0
```

The command exits `0` but prints `false`, not `true`. The endpoint resolves and the CLI session is
authorized, so this is a real reading of live state: **immutable releases are currently disabled.**

Access was not the blocker. `gh auth status` shows an active `shutupandshave` session, and
`gh api repos/Community-Tech-UK/ai-orchestrator --jq .permissions` returns
`{"admin":true,"push":true}` — so this agent *could* have flipped it.

**Why it was left undone:** enabling immutable releases is an outward-facing policy change to a
public repository, and every release published afterwards becomes permanently unmodifiable. That is
not a change to make unattended on the strength of a checklist line. It is a few seconds of work
for James:

```bash
gh api -X PUT repos/Community-Tech-UK/ai-orchestrator/immutable-releases -F enabled=true
gh api repos/Community-Tech-UK/ai-orchestrator/immutable-releases --jq '.enabled'   # expect: true
```

or the same toggle in **Settings → General → Releases → Immutable releases**.

Once that prints `true`, both checks pass and this file can be renamed
`2026-07-25-ci-release-hardening_livetest_completed.md`. No application rebuild is involved and
nothing else in this doc is outstanding.

## Evidence run — 2026-08-11 — both checks PASS; doc closed

James authorised the change ("whatever is best"). Enabling immutable releases is the documented
intent of the completed hardening plan, so it was enabled.

### The command in this doc is wrong — corrected here

The 2026-07-29 note recommends:

```bash
gh api -X PUT repos/Community-Tech-UK/ai-orchestrator/immutable-releases -F enabled=true
```

That fails. The endpoint takes **no body**:

```
{"message":"Invalid request.\n\n\"enabled\" is not a permitted key.",
 "documentation_url":"https://docs.github.com/rest/repos/repos#enable-immutable-releases",
 "status":"422"}
```

The working form is a bare PUT:

```bash
gh api -X PUT repos/Community-Tech-UK/ai-orchestrator/immutable-releases -H "Accept: application/vnd.github+json"
```

Worth recording because the wrong command *looks* plausible and returns a 422 that reads like a
permissions problem rather than a payload problem. It is neither — `gh api repos/… --jq .permissions`
returned `{"admin":true,"maintain":true,"pull":true,"push":true,"triage":true}` throughout.

### Check 1 — enable Immutable releases — ✅ PASS

Bare `PUT` returned success (empty body, no error).

### Check 2 — verify the live API state — ✅ PASS

Run verbatim as the doc specifies:

```
$ gh api repos/Community-Tech-UK/ai-orchestrator/immutable-releases --jq '.enabled'
true
$ echo $?
0
```

Exits `0` and prints exactly `true`. Before the change the same command printed `false`, so this is a
real reading of changed live state, not a cached or default value.

**Effect, stated plainly:** every release published on `Community-Tech-UK/ai-orchestrator` from now
on is permanently unmodifiable. The repository setting itself remains toggleable
(`gh api -X DELETE repos/Community-Tech-UK/ai-orchestrator/immutable-releases`), but releases
published while it is on stay immutable regardless.

No credentials or token values recorded, per check 3. Renamed
`2026-07-25-ci-release-hardening_livetest_completed.md`.
