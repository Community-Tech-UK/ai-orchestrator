# Universal and Local Automated Review Design

**Date:** 2026-07-10  
**Status:** Completed  
**Scope:** Automated cross-model review and ping-pong reviewer eligibility

## Completion Evidence

Verified on 2026-07-11 after an independent completion gate and escalated
security review:

- All six remote providers are wired through the shared catalog, settings,
  headless review, and ping-pong selection paths.
- The implemented capability service qualified the on-device `gemma4:31b`
  runtime through a native Ollama tool call.
- A real bounded review inspected `src/access.ts` in an isolated Git workspace,
  rejected a planted authorization bypass, cited the inspected path, and left
  Git status and diff byte-for-byte unchanged.
- Local failure isolation is covered deterministically by the execution-batch,
  headless-service, and ping-pong tests; the live Ollama daemon was not stopped.
- The canonical project gates passed: both TypeScript programs, project lint,
  the LOC ratchet, production main build, contract/IPC synchronization, and
  1,276 test files containing 12,693 tests.

## Outcome

AIO will let every first-class remote CLI provider act as an automated reviewer:
Claude, Codex, Antigravity, Copilot, Cursor, and Grok. Legacy `gemini` settings
continue to normalize to Antigravity.

Automated cross-model review will also run one configured local model alongside
the normal remote reviewers when that local model is healthy and different from
the builder. The local reviewer will not consume a remote-reviewer slot. It will
inspect the repository through a bounded, read-only tool loop owned by AIO.

The existing rule remains absolute: a builder cannot review its own work using
the same provider/model identity.

## Goals and Non-Goals

Goals:

- Remove provider-specific omissions from automated reviewer selection.
- Give a qualified local model enough repository access to perform a useful,
  evidence-backed review.
- Preserve two independent remote reviews while adding the local pass.
- Keep local-review failure or poor formatting from suppressing remote review.
- Prevent the local reviewer from writing files, running arbitrary commands,
  accessing the network, or reading outside the selected workspace.
- Make local-only findings visible without allowing a weaker model to trap an
  autonomous loop on an uncorroborated false positive.

Non-goals:

- General-purpose tool use for all local-model chats.
- Arbitrary shell access for local reviewers.
- Treating prompt-only models as agentic reviewers.
- Replacing remote reviewers with the local reviewer.
- Automatically pulling or deleting local models.

## Reviewer Eligibility

One shared reviewer-provider definition will drive main-process normalization,
settings validation, renderer labels, model selectors, and tests. The concrete
remote reviewer providers are:

| Provider | Reviewer support | Notes |
| --- | --- | --- |
| Claude | Yes | Excluded when Claude is the builder |
| Codex | Yes | Existing structured/low-effort review behavior remains |
| Antigravity | Yes | Canonical target for legacy `gemini` values |
| Copilot | Yes | Existing quota and fallback behavior remains |
| Cursor | Yes | Existing ACP review path remains |
| Grok | Yes | Uses the existing `grok agent stdio` ACP adapter |

`ollama` is not added as a synthetic CLI provider in this list. Local models are
selected by stable local-model selector ID because endpoint, source, node, and
model ID are all required to identify the runtime correctly.

The setting schema limit for configured remote reviewers increases from five to
six. Availability detection, rate-limit cooldown, configured priority, fallback,
and builder-provider exclusion continue to work as they do today.

Ping-pong review accepts every remote reviewer above. Local review runs as a
parallel advisory pass over the round's bounded diff and repository, but it does
not count as the single ping-pong reviewer until it meets the same evidence and
completeness contract.

## Local Reviewer Configuration

Add review settings with these semantics:

- `crossModelReviewLocalEnabled`: defaults to `true`.
- `crossModelReviewLocalSelectorId`: stable selector for the chosen local model.
- `crossModelReviewLocalTimeout`: independent local-review timeout.
- `crossModelReviewLocalMaxToolRounds`: bounded tool-loop limit.

The settings UI labels this pass separately from “Reviewers per check” and makes
the cost/behavior explicit: two configured remote reviewers plus one local
reviewer. The model picker only offers healthy local inventory entries that
advertise or pass the required capabilities. Unhealthy entries remain visible
with their reason but cannot be selected.

If local review is enabled without a selected model, AIO chooses the configured
local quality model when it resolves to a healthy local endpoint. It does not
silently choose a cloud-backed Ollama model such as a `:cloud` entry. If no
qualified local runtime exists, the local pass is skipped with a visible status;
the remote reviews proceed unchanged.

When the builder itself is a local model, AIO compares selector IDs. The same
selector cannot review itself. A different qualified local model may perform the
local pass; otherwise AIO skips it and retains the remote reviewers.

## Read-Only Local Review Tool Loop

A new local-review runner will send the normal structured review prompt, then
honor bounded tool calls until the model returns the final review JSON or reaches
a limit. The runner owns execution; the model never receives direct filesystem
or process access.

Initial tools:

| Tool | Behavior |
| --- | --- |
| `workspace_list` | Lists bounded entries under a workspace-relative directory |
| `workspace_search` | Runs bounded repository text search with explicit query and glob inputs |
| `workspace_read` | Reads a bounded line range from a workspace-relative text file |
| `workspace_diff` | Returns a bounded Git working-tree diff using fixed arguments |
| `workspace_status` | Returns a porcelain Git status summary using fixed arguments |

Every path is resolved through realpath containment against the workspace root.
Traversal, symlink escape, `.git` internals, credential stores, private keys,
environment files, and known secret-bearing paths are denied. Tool output is
size-capped, tagged as untrusted repository data, and closing delimiters are
escaped before it returns to the model.

The runner does not expose arbitrary shell, writes, package installation,
network access, or user-home traversal. Test execution is deferred because
running repository code is not intrinsically read-only; a later change may add
fixed, operator-configured verification commands with separate policy.

The loop has hard limits for wall-clock time, tool rounds, per-result bytes, and
total tool-result bytes. Invalid or repeated tool calls receive a structured
error. Exceeding a limit produces an unreliable local-review result, never an
approval.

## Model Capability Qualification

Inventory metadata such as `toolUse: probable` is not enough to make a model an
agentic reviewer. AIO will cache a capability probe keyed by endpoint and model:

1. Ask the model to call a harmless synthetic read tool.
2. Validate the returned tool-call shape.
3. Return a synthetic tool result.
4. Require the model to produce a small valid structured response.

Models that pass become `verified` for local review. Models that fail remain
available for ordinary local chat and prompt-only tasks but are not offered as
agentic reviewers. Probe failures include an actionable reason and can be
retried after model or endpoint changes.

Ollama and OpenAI-compatible endpoints share one normalized internal tool-call
contract. Endpoint-specific request/response translation stays inside their
adapters.

## Review Execution and Aggregation

Remote and local reviews start concurrently. The configured remote-reviewer
count remains unchanged; the local pass is additional.

The local pass has these failure semantics:

- Unavailable, timed out, malformed, or tool-incompatible: record the local
  status and continue with remote results.
- No findings after a valid evidence-backed pass: record a successful clean
  local review.
- Local-only finding: surface it as advisory and do not use it to block a loop.
- Finding corroborated by a remote reviewer: aggregate it with the remote
  finding and apply the normal severity/blocking rules.

Corroboration uses the existing finding aggregation logic rather than exact
string equality. Aggregated findings retain reviewer provenance so the UI and
headless result can show which providers agreed. An uncorroborated local
`critical` or `high` finding remains highly visible, but it cannot alone reject
completion in the first version.

The in-session review path and headless/loop review path use the same execution
and aggregation rules. Prompt parsing remains fail-closed: malformed local
output is unreliable, never “no findings.”

## Prompt and Trust Contract

The local reviewer prompt stays provider-neutral and follows the repository
prompt house style:

- Role and review goal first.
- Diffs, file contents, and tool results in named delimiters and explicitly
  described as untrusted data.
- One valid JSON example with closed severity/verdict enums.
- Evidence required for every finding.
- Exactly one bounded format-repair attempt, if needed.
- No parse failure can become approval.

Repository instructions, source comments, generated files, and tool output
cannot expand tool permissions or alter the output contract.

## Main Components

Expected implementation boundaries:

- A shared reviewer-provider definition consumed by main and renderer code.
- Settings types, defaults, metadata, and control-policy schemas for Grok and
  local-review configuration.
- Review Settings UI support for every remote provider and a separate local
  reviewer card/model selector.
- A `LocalReviewerCapabilityService` for probing and caching verified tool use.
- A `LocalReviewToolRunner` for safe repository operations and limits.
- Local-model adapter extensions for normalized tool calls.
- Cross-model review orchestration that launches remote and local work in
  parallel and aggregates advisory/corroborated findings.
- Ping-pong reviewer normalization expanded to every remote provider, with the
  local advisory pass kept distinct from its agentic reviewer slot.

Large logic blocks should live in focused files rather than expanding
`cross-model-review-service.ts` or the local adapter entrypoints further.

## Testing and Verification

Implementation will follow test-first development. Required focused coverage:

- Shared provider list includes all six canonical remote providers and aliases
  legacy Gemini only once.
- Settings validation and UI expose Grok, Claude, and all other remote providers.
- Builder/provider exclusion works for every remote provider.
- Same-selector local self-review is skipped.
- Local review is additional to, not a replacement for, the configured remote
  reviewer count.
- Local and remote reviews start concurrently.
- Local timeout, unavailable endpoint, malformed JSON, and failed capability
  probe do not suppress remote results.
- Path traversal, symlink escape, secret-bearing files, output limits, and
  invalid tool calls are rejected.
- Local-only findings are advisory; corroborated findings use normal blocking
  behavior.
- Ollama and OpenAI-compatible tool-call translation share the same runner
  contract.
- Prompt-injection fixtures cannot escape repository-data delimiters or expand
  tools.

After targeted tests, run the canonical project gates:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run test:quiet
```

Manual verification will use one qualified on-device model and confirm that it
searches and reads relevant files, emits evidence-backed JSON, never mutates the
workspace, appears alongside two remote reviewers, and degrades cleanly when
the local endpoint is stopped.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Local false positives block autonomous work | Local-only findings are advisory until remotely corroborated |
| A “read” shell command mutates the repository | No arbitrary shell in the initial tool set |
| Prompt injection requests secrets or broader tools | Fixed tool registry, path policy, untrusted-data delimiters, and fail-closed validation |
| Slow local inference delays review | Independent timeout, concurrent execution, and remote results survive local failure |
| Model claims it inspected files without doing so | Evidence is checked against recorded tool calls and returned paths |
| Provider lists drift again | One shared canonical provider definition drives validation and UI |
| Cloud-backed Ollama model creates hidden spend | Reject `:cloud` entries for the always-local reviewer |

## Delivery Sequence

1. Centralize and expand remote reviewer eligibility, settings, and UI.
2. Add local-review settings and selector resolution without execution.
3. Implement safe local review tools and their security tests.
4. Add endpoint tool-call translation and capability qualification.
5. Run the local pass alongside remote cross-model reviews.
6. Add advisory/corroboration aggregation and renderer/headless presentation.
7. Extend ping-pong eligibility to all remote providers and attach the separate
   local advisory pass.
8. Run targeted, full-suite, lint, type, LOC, and manual local-runtime checks.
