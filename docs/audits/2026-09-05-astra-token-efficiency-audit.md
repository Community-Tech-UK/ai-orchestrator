# Astra usage and AIO token-efficiency audit

Date: 5 September 2026. Scope: read-only investigation of the Codex/Astra execution path, local usage evidence, memory delivery, context controls, and current official documentation. Recommendations are not implemented. Existing working-tree changes were preserved.

## 1. What explains the 33 minutes

There is substantial real consumption, alongside several AIO defects and limitations. Prompt caching is functioning. The largest measured driver is repeated processing of large contexts across concurrent Astra sessions and subagents.

I reconstructed the 33 minutes immediately before the investigation message: **11:46:57–12:19:57 BST**, or **10:46:57–11:19:57 UTC**. This is an inferred observation window, not a timestamp extracted from the screenshot. It excludes this audit's subsequent usage.

| Metric | Observed |
|---|---:|
| Astra threads with new usage | 13 |
| Root threads / native subagent threads | 6 / 7 |
| Positive model-usage counter updates | 582 |
| Input tokens, including cached input | 68,512,446 |
| Cached input tokens | 65,618,560 |
| Uncached input tokens | 2,893,886 |
| Cache hit ratio by input tokens | 95.8% |
| Output tokens, including reasoning | 239,692 |
| Reasoning tokens, already included above | 62,435 |
| Recorded compaction items during these threads' window | 5 |
| Largest observed individual input | 240,709 tokens |
| Reasoning effort on the counted Astra usage | High |

These are cumulative-counter deltas, not the sum of repeated cumulative snapshots. Unchanged notifications are ignored; counter resets start a new accounting epoch. Model identity is tracked through turn-context records. One resumed thread first used Sol, then Astra; its Sol call is excluded. Native subagent rollouts are counted independently using their parent metadata. The 582 updates are an approximation to underlying model requests, not a network-level request trace.

The screenshot's 14% is a **Codex account weekly allowance**, not a measurement of one conversation or a proven Astra-only quota. A read-only check of the account endpoint during the investigation returned a 604,800-second primary window, no secondary window, and a separate Spark limit. The main weekly percentage had reached 18% by that later check. Other sessions were continuing to work.

AIO copies the provider's `used_percent`; it does not derive this bar from its own estimated dollar costs. See [quota parsing](../../src/main/core/system/provider-quota/codex-usage-endpoint-probe.ts#L165). Therefore the accounting bugs below do not themselves manufacture the weekly percentage.

## 2. Why a good cache ratio still costs a lot

OpenAI currently lists Astra at 250 credits per million uncached input tokens, 25 per million cached input tokens, and 1,250 per million output tokens. The equivalent Sol rates are 100 / 10 / 500. Astra Fast mode multiplies its Standard rates by 2.5. These are published rates, not a disclosed conversion from this account's weekly percentage to tokens. [Official pricing](https://learn.chatgpt.com/docs/pricing)

Applying Standard rates to the observed workload gives this **comparison estimate**, not an invoice:

| Component | Credits at Standard rates | Share |
|---|---:|---:|
| Repeated cached input | 1,640.46 | 61.6% |
| Uncached input | 723.47 | 27.2% |
| Output, including reasoning | 299.62 | 11.2% |
| Total | 2,663.55 | 100% |

The same counts correspond to approximately $106.54 at Astra's Standard API token rates. This is an API-equivalent comparison, not an additional charge to the subscription. Cache-write counts in these rollouts were zero. Observed inputs were below the documented 272K long-context pricing threshold. [Astra model rates and threshold](https://developers.openai.com/api/docs/models/gpt-6-astra)

Seven subagent threads account for approximately **32.8%** of this Standard-rate comparison. Six were fresh review/gate agents; the seventh was a longer-running worker. The root thread for that worker plus the worker account for roughly 35.8% of the total. This is why elapsed time is a poor guide: multiple agents can spend simultaneously, and each tool round processes the accumulated context again.

Fast mode was investigated rather than assumed. The user's Codex config contains `service_tier = "priority"`, while AIO's global Fast default is false. AIO sends `serviceTier: null` for a fresh non-Fast thread. A no-inference experiment with installed Codex 0.153.4, an isolated temporary home, and that exact request returned `serviceTier: "default"`. The temporary thread was ephemeral and no `turn/start` was sent. **A hidden Fast-mode multiplier is not established for the measured workload.** Existing resumed threads require their own effective-tier evidence; the rollout turn-context format here does not contain that field.

## 3. High: Codex cost and cache accounting loses most internal calls

The notification handler correctly receives `last` and `total` usage. It preserves only the latest input/output/cache/reasoning breakdown in `lastTurnUsageBreakdown`. When `turn/completed` has no aggregate usage, the completion path prices that single latest call as the entire user turn. It also drops the cached-input and reasoning fields when constructing `CliResponse.usage`.

Evidence: [notification handler](../../src/main/cli/adapters/codex-app-server-notification-adapter.ts#L138), [completion fallback](../../src/main/cli/adapters/codex-app-server-turn-adapter.ts#L238), [cost recording and cache analytics](../../src/main/instance/communication-completion-cost.ts#L19).

This is visible in a completed runtime example, not just inferred from source:

| Completed thread ending `92b9` | Native rollout | AIO completion |
|---|---:|---:|
| Input tokens | 4,079,980 | 111,268 |
| Cached input tokens | 3,968,768 | Omitted |
| Output tokens | 8,235 | 127 |
| Standard API-equivalent cost | $5.492638 | $1.11903 |

Its AIO completion exactly matches the last native call. Separately, the cost database contains seven Astra entries in the observation window, totaling 718,862 input tokens, 1,871 output tokens, **zero cache-read tokens**, and $7.28217. That database-window total is not directly comparable to all native spend because some turns were still active and children have separate attribution, but it confirms the missing cache fields in persisted telemetry.

There are errors in both directions: counting only the last call undercounts the turn; pricing cached tokens as uncached overprices that call. The net discrepancy varies by workload. The shared pricing helper expects disjoint uncached/cache buckets, whereas OpenAI input counts include cached input. Simply forwarding the cache field without subtracting it from input would introduce double counting. Reasoning is also a subset of OpenAI output, not an extra quantity to add again.

**Recommended fix:** maintain per-native-thread usage deltas across every internal call, deduplicate notifications, handle resets and resumed baselines, and record partial/failed/interrupted spend. Aggregate child spend once into a parent view while preserving separate rows. Preserve cache and reasoning breakdowns and the effective service tier. Feed cache analytics from this normalized stream.

The existing LT-090 test uses one notification where `last` equals `total`, so it cannot expose this defect. Add a multiple-call case with different `last`/`total`, cache subsets, duplicate notifications, a counter reset, interruption, and a child thread. [Existing test](../../src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts#L728)

## 4. High: startup memory is assembled and then cut out

AIO assembles instructions, output style, observation memory, project brief, lessons, repo map, wake context, MCP context, and tool permissions, in that order. Codex subsequently keeps the first **3,200 characters** and last **800 characters**, replacing everything between them with a truncation marker.

Evidence: [assembly](../../src/main/instance/instance-system-prompt.ts#L151), [block order](../../src/main/context/prompt-injection-contract.ts#L63), [truncation](../../src/main/cli/adapters/codex-exec-adapter.ts#L453), [app-server use](../../src/main/cli/adapters/codex-app-server-turn-adapter.ts#L58).

For the fresh 11:47:31 BST session, app logs say the project brief, a 64-file repo map, and wake context were injected. The actual first user-message wrapper in its native rollout is about 4,072 characters and contains the middle-truncation marker. Its retained headings are global instruction headings; the project-memory and repo-map material did not survive in that wrapper. This also explains the visibly truncated system-instructions block in this investigation's input.

This is not proof that all memory is absent. Indexed initial context travels separately, and per-turn RLM/unified-memory retrieval has a separate input-context path. Native Codex instructions and memory directories also remain available through the isolated home. But the startup manifest describes what AIO assembled, not everything actually delivered after adapter truncation.

**Recommended fix:** use a provider-aware budget per block, remove duplicated native instruction content deliberately, reserve space for a short relevant memory brief, and record a post-adapter manifest. Keep memory advisory and preserve permission boundaries. Do not solve this by blindly increasing the entire prompt cap: excess instructions would then be reprocessed on every call.

## 5. High: AIO's extra context policy is off in the current configuration

The live settings have `contextEvidenceModeByProvider.codex = "off"`. `CompactionCoordinator.onContextUpdate()` returns before evaluating the shared policy in this mode. `cumulativeTokenCompactionTrigger` is also zero. The shared policy contains occupancy, cumulative-spend, and recovery decisions, but those decisions are not active for these Codex instances.

Evidence: [runtime guard](../../src/main/context/compaction-coordinator.ts#L238), [policy execution gate](../../src/main/context/context-policy-runtime.ts#L149), [threshold policy](../../src/main/context-evidence/context-safety-policy.ts#L278).

**Native compaction is working:** five compaction records appear in the measured Astra window. AIO uses persistent app-server threads, advertises native compaction, and leaves Codex in control of its own transcript. The reported context window is 258,400 tokens, rather than an observed million-token working context. There is no evidence here that AIO expanded Astra to an expensive million-token prompt.

**Recommended fix:** implement an observable, price-weighted per-task/session governor that counts parent and children. Trial context intervention in shadow mode before enforcement. The existing cumulative thresholds count cached and uncached tokens alike; turning them on aggressively could create repeated paid compactions and cache rebuilds. Native compaction should preserve constraints, decisions, outstanding work, citations, and completed actions rather than trigger full rereads.

## 6. Medium: tool and output reduction is only partially effective

**Browser deferral:** the setting is true, but `supportsDeferredBrowserGatewayTools()` explicitly excludes Codex and Cursor. AIO's implementation depends on MCP `tools/list_changed`; its compatibility guard says those clients do not install newly revealed callable wrappers. Browser Gateway health reported 42 exposed tools for the sampled AIO sessions. [Compatibility guard](../../src/main/browser-gateway/browser-mcp-config.ts#L49)

This is a deliberate compatibility workaround. Do not remove the guard without proving discovery, loading, and invocation against the installed client. AIO's eager MCP surface and Codex's own model-side tool discovery are separate layers; this finding does not prove every full tool schema is serialized into every model request.

**RTK:** enabled, available, and prompted on the first turn. Codex integration here is prompt-based; the enforceable command-rewrite hook belongs to the Claude path. Across the observed native custom-tool calls, 452 `exec` batches referenced shell execution, 451 contained `rtk`, and 416 contained `rtk proxy`. These are batch-level string counts, not individual-command coverage. `proxy` intentionally bypasses compression. [Codex injection](../../src/main/cli/adapters/codex-app-server-turn-adapter.ts#L70), [RTK awareness](../../src/main/cli/rtk/rtk-awareness.ts)

Tool-result payloads in the window contained approximately **6.58 million characters**, including 142 results above 20,000 characters and a largest result of 112,851 characters. These are serialized native tool-result sizes, not tokenizer counts. Full-file reading requirements and repeated verification contribute legitimate output too; not all of this is avoidable waste.

**Retention:** the Codex adapter explicitly reports `toolResultControl: "post-retention"`. AIO sees native outputs after Codex retains them. Applying a renderer truncation, AIO buffer microcompaction, or local summary after that point does not remove those tokens from the provider's next prompt. [Capabilities](../../src/main/cli/adapters/codex-app-server-adapter.ts#L619)

**Recommended fix:** use bounded output at the producer, compact test/build summaries with full logs retained locally, targeted file selection, and stable evidence references for large results. For MCP, trial a small stable search/describe/validated-execute surface or native supported tool search. Preserve all current approval and secret-handling checks. Browser auxiliary extraction is currently off and is a separate optional experiment with evidence-fidelity checks.

## 7. Techniques to retain, improve, and research

| Technique | Present state | Recommendation |
|---|---|---|
| Persistent native threads and resume | Wired and observed | Retain; avoid unnecessary fresh sessions and replay |
| Prompt caching | 95.8% observed | Retain; optimize context volume and call count as well as hit ratio |
| Native compaction | Observed | Preserve; measure compaction and reread costs |
| Stable prompt block ordering | Implemented | Retain; budget content after adapter transformation |
| Project brief and repo map | Assembled, then vulnerable to truncation | Repair actual delivery |
| Per-turn RLM/unified/indexed retrieval | Wired, budgeted, deadline-bounded | Measure relevance, delivered bytes, reuse, and later rereads |
| Native Codex home assets | Mirrored, histories isolated | Preserve; mirroring is not proof that native memory retrieval ran |
| Local auxiliary models | Enabled, local-first | Use for bounded extraction/summaries with source references and quality checks |
| RTK | Mostly invoked, often through raw proxy | Improve actual output reduction without hiding failures |
| Browser dynamic deferral | Bypassed for Codex | Validate a compatible approach |
| Dollar/credit attribution | Incorrect on the fallback path | Fix before claiming savings |
| Model/effort routing | All measured Astra usage was High | Benchmark cheaper models and lower effort for bounded tasks |

Current official research supports these additions:

1. **Explicit cache breakpoints and stable prefixes.** Modern OpenAI caching supports placing breakpoints after reusable content and stable cache keys. Dynamic material should follow the stable prefix. This matters most for fresh sessions, forks, and compaction boundaries. API controls are not automatically available through Codex app-server; verify protocol support before attempting passthrough fields. [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
2. **Native deferred tool search.** The Responses API supports deferred functions and MCP namespaces with `tool_search` and `defer_loading`. This differs from AIO's dynamic MCP-list approach. Prefer a demonstrated supported mechanism over adding both full schemas and discovery descriptions. [Tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)
3. **Cache-preserving effort changes.** Astra supports `configuration_update` for changing reasoning effort without rewriting the initial prompt prefix, subject to compatibility limits. Investigate Codex support; do not assume AIO's per-turn `effort` parameter produces this behavior. [Astra guidance](https://developers.openai.com/api/docs/guides/latest-model)
4. **Scope verification and agent delegation deliberately.** OpenAI specifically notes that Astra can over-test smaller tasks. James's fresh-review requirement explains several of the measured child agents. Preserve that requirement while evaluating an appropriate cheaper verifier, narrow acceptance criteria, and reuse of unchanged deterministic test evidence. Any relaxation of James's review rules remains a policy decision, not an automatic optimization. [Astra testing and delegation guidance](https://developers.openai.com/api/docs/guides/latest-model#testing-and-verification)
5. **Compact working sets with durable evidence.** Native compaction reduces retained history, while external files preserve detailed evidence for selective retrieval. Benchmark information loss and repeated investigation, not just summary size. Compaction itself uses model work. [Compaction](https://developers.openai.com/api/docs/guides/compaction)

Do not add periodic paid keep-alive prompts simply to keep a cache warm. Do not turn on a million-token context as a token-saving measure. Async tools can improve elapsed time but do not inherently reduce consumption. Batch/Flex API pricing and custom Responses parameters are not drop-in subscription-Codex settings.

## 8. Recommended order and validation

1. **Correct usage accounting and effective-tier visibility.** Acceptance: native rollout deltas reconcile with persisted per-call/turn costs, including children, cached input, failures, and resets. Display quota separately from API-equivalent cost.
2. **Repair post-adapter memory delivery.** Acceptance: exact delivered prompt contains the selected short memory blocks and governing constraints, with per-block accounting and no unwanted duplicated instruction files.
3. **Reduce routine Astra fan-out.** Benchmark the same bounded extraction/review tasks on Sol/Terra or lower Astra effort. Compare successful completion, findings quality, total credits, elapsed time, and rereads. Leave frontier reasoning available for difficult integration and architectural decisions.
4. **Reduce source/tool-output size.** Keep full logs on disk, return bounded evidence, and resolve missing details on demand. Audit blanket whole-file-reading and repeated-test requirements with James before changing them.
5. **Trial a cache-aware cost governor and compatible tool discovery.** Start with recorded decisions and measurable before/after samples. Avoid forced frequent compaction based only on gross cached token volume.

The baseline already has excellent cache reuse. The biggest likely gains are fewer expensive parallel agents, smaller repeatedly processed contexts, and shorter/less repetitive tool round trips. The two confirmed accounting and memory-delivery defects should be repaired before judging AIO's optimization dashboard.

## 9. Evidence and investigation status

Canonical local evidence sources:

- Native rollouts under `~/.ai-orchestrator/codex/sessions/2026/09/04/` and `2026/09/05/`; relevant thread ids are listed in the generated aggregate evidence file under `.aio-review/2026-09-05-astra-usage-evidence.json`.
- Read-only queries against `~/Library/Application Support/harness/conversation-ledger/conversation-ledger.db` (`provider_event_captures`) and `rlm/rlm.db` (`cost_entries`).
- Allowlisted settings from `~/Library/Application Support/harness/settings.json` and `~/.codex/config.toml`; no credential values copied into artifacts.
- App logs for startup memory assembly and adapter/resume mode. Official pricing was also opened and read through the Browser Gateway on `windows-pc`.
- Source references above are for the existing checkout. Several files already had changes from other work; this audit made no application-source or settings changes. Other agents continued working during this investigation.

Verification run: `npm run test:quiet -- src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts src/main/core/system/provider-quota/codex-usage-endpoint-probe.spec.ts src/main/browser-gateway/browser-mcp-config.spec.ts src/main/context/prompt-injection-contract.spec.ts` — **4 files, 101 tests passed**. Log: `_scratch/test-run.pid-64890.log`. Existing passing tests do not disprove the runtime accounting defect; their coverage gap is described above.

The isolated Codex thread-start experiment verified `serviceTier: null` resolves to `default` on the installed CLI without running inference. No paid model experiment, production setting change, source fix, commit, or push was performed. This is a scoped consumption audit, not a whole-repository security/build certification.

- [x] Reconstruct usage in a clearly stated 33-minute window.
- [x] Trace quota reporting and distinguish it from AIO cost estimates.
- [x] Inspect live Codex mode, caching, memory delivery, RTK, compaction, and tool deferral.
- [x] Research applicable current techniques using official sources.
- [x] Run relevant existing tests and a no-inference protocol experiment.
- [x] Provide prioritized recommendations and review artifacts.
- [ ] Implement and independently verify the recommended changes; outside this investigation's scope.
