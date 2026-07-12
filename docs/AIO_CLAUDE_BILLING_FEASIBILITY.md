# AIO + Claude Code billing: feasibility and compliance verdict

**Date:** 2026-06-11
**Question:** Can AI Orchestrator (AIO) keep driving Claude Code on the interactive
subscription pool, instead of the metered Agent SDK credit, by embedding and driving a
real interactive Claude Code session inside a pseudo-terminal rather than calling
`claude -p`?

**Short answer: No. Don't build this.** It is technically possible on macOS, but it is
circumvention of Anthropic's billing split and a direct breach of the Consumer Terms and
the Claude Code authentication policy. The detection surface is wider than the TTY check
the trick relies on, enforcement is already active and happens without notice, and the
downside is account suspension across our whole Anthropic footprint. We should route
AIO's programmatic Claude usage through a direct API key (Agent SDK, pay-as-you-go), keep
genuinely interactive work on the subscription, and use the new Agent SDK credit as a free
allowance for light scheduled jobs.

For context: AIO is our Electron + Angular + TypeScript desktop app that orchestrates
multiple AI coding CLIs (Claude, Gemini, Codex, Copilot), with multi-agent coordination,
verification, scheduling, and session recovery. The Claude path is the one affected here.

---

## 1. The billing split is real, confirmed, and on track

I confirmed this against Anthropic's own help article rather than the blog summaries, which
mostly editorialize. The primary source is
[Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
(Claude Help Center) and the
[Claude Code Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
page. Both are unambiguous.

Effective **June 15, 2026** (four days from now), Claude Agent SDK usage and the `claude -p`
command no longer count toward a subscription plan's usage limits. Subscription limits stay
the same and stay "reserved for interactive use of Claude Code, Claude Cowork, and Claude."
Four surfaces move to a separate, dollar-denominated monthly Agent SDK credit metered at
standard API list rates with no rollover:

- Claude Agent SDK usage in your own projects (Python or TypeScript)
- `claude -p` (non-interactive / headless mode)
- Claude Code GitHub Actions
- Third-party apps that authenticate with a Claude subscription through the Agent SDK

The credit is $20/mo on Pro, $100 on Max 5x, $200 on Max 20x (per the help article). It is
per-user, not pooled, opt-in once, drains before any other source, does not roll over, and
when exhausted either spills to usage credits at full API rates (if enabled) or hard-stops.
Anthropic's help article explicitly steers teams running shared production automation to
"use Claude Platform with an API key for predictable pay-as-you-go billing." That sentence
is, in effect, describing AIO.

No reversal, delay, or softening has been published since the May 13/14, 2026 announcement.
As of this week the timeline and amounts are unchanged. One correction to the brief's framing:
the split has not happened yet. Today is June 11, so it takes effect in four days, and a check
for "any reversal or clarification dated after June 15" cannot be satisfied yet. The
[help article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
should be re-checked the week of June 15, since several edge cases (hooks, subagents, MCP calls
fired from interactive sessions) are still undocumented. With that caveat, the premise holds.

---

## 2. Gating question: is driving an interactive session programmatically permitted?

**Verdict: this is circumvention, not interactive use. It breaches the terms.** I'll give
the reasoning, the detection mechanics, and the prior art, because the brief rightly asked
for all three.

### 2a. What the terms actually say

Three documents converge on the same line, and none of them turn on whether a TTY is
attached. They turn on whether a human is driving and whether the credential is being used
as intended.

The **Claude Code Legal and compliance** page states that OAuth authentication "is intended
exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans
and is designed to support ordinary use of Claude Code and other native Anthropic
applications," and that "Anthropic does not permit third-party developers to offer Claude.ai
login or to route requests through Free, Pro, or Max plan credentials on behalf of their
users." To be precise about what that clause does and doesn't cover: it is aimed at
third-party products serving *their* users through someone's subscription credential. AIO
driving our own credential for our own work isn't squarely that case, and an honest reading
shouldn't pretend it is. The clauses that do bite are the ones around it: the same page says
OAuth is designed for "ordinary use of Claude Code and other native Anthropic applications,"
that advertised Pro/Max limits "assume ordinary, individual usage," and that "Anthropic
reserves the right to take measures to enforce these restrictions and may do so without prior
notice." A scheduler firing parallel Claude sessions around the clock is not ordinary
individual usage on any reading.

The **Consumer Terms** (Section 3.7, quoted across the incident reporting) prohibit accessing
the services "through automated or non-human means, whether through a bot, script, or
otherwise," except via API key or explicit authorization. A pseudo-terminal that types a
prompt and presses Enter on a schedule is automated, non-human access by definition. The fact
that the keystrokes flow through a real PTY does not make a machine into a human. The carve-out
the terms grant for automation is "via API key," which is precisely the path the PTY trick is
trying to avoid.

The whole design of the billing split is a line between human-driven and machine-driven use.
Anthropic's framing ("reserved for interactive use") and the community's shorthand ("the Enter
Key Test": if a human presses Enter it's interactive, if a robot presses Enter for you it's
programmatic) point the same way. A PTY wrapper exists specifically to make a robot's Enter
keypress look like a human's. That is the thing the policy is drawing a line against, not an
edge case it forgot to cover.

So the honest characterization is not "a clever interpretation of interactive use." It is
"making automated usage look interactive to land on the cheaper pool." That is circumvention.

Worth marking where the legitimate side of the line actually sits, because it is closer than
it looks. [Zed's official guidance](https://zed.dev/blog/anthropic-subscription-changes) after
the announcement is that users who want to stay on their subscription can "run Anthropic's
official `claude` CLI in a terminal inside Zed instead of through ACP," and Zed is building
"Terminal Threads" around exactly this. So embedding a real terminal inside a third-party app
is fine **when a human is the one typing**. The split does not turn on which app hosts the
terminal; it turns on who presses Enter. That means AIO can legitimately embed human-driven
Claude Code terminals (and arguably should, see recommendation 2). What it cannot do is have
the scheduler press Enter.

### 2b. How interactive vs programmatic is really detected

The PTY trick rests on one true fact: the interactive/headless decision is made **client-side**
inside the Claude Code binary, by checking whether stdin/stdout are a TTY. Hand the binary a
real PTY (via `node-pty`, `tmux`, or the `zmux`-based `smithersai/claude-p`) and it boots its
interactive TUI and uses the subscription OAuth path. That part genuinely works today.

The mistake is assuming the TTY check is the only signal. It is not. Anthropic's enforcement
operates server-side and behaviorally, and it is already live:

- **Harness / client fingerprinting via telemetry.** Anthropic's Thariq Shihipar stated
  publicly that third-party harnesses "generate unusual traffic patterns without any of the
  usual telemetry that the Claude Code harness provides," and that Anthropic "tightened
  safeguards against spoofing the Claude Code harness." A PTY makes the TTY check pass; it does
  not reproduce the full, evolving telemetry signature of a human-driven session.
- **System-prompt / git-status keyword scanning.** In a documented incident, Claude Code
  ingested git status into the system prompt and matched strings like `hermes.md` and `OpenClaw`
  in commit messages, then routed those sessions to API billing, charging a Max 20x user
  ~$200 even though 86% of the plan was unused. Anthropic confirmed it as "a bug with the
  third-party harness detection," refunded under public pressure, and, tellingly, kept the
  detection. The signal is staying and getting more behavioral, per Anthropic's own framing.
- **Behavioral analysis.** Inhuman speed, repetitive request structure, and bot-like cadence
  are explicitly described as triggers. An orchestrator firing prompts in tight loops is the
  archetype.
- **IP and billing-anomaly review.** Datacenter/VPN IP patterns and plan/payment changes
  trigger automated review, with documented false-positive bans.

Two implications matter for us. First, the PTY masks exactly one of several signals, so it does
not reliably keep us on the subscription pool even on its own terms: a behavioral or telemetry
flag can silently re-route our sessions to API billing anyway, which is the worst case (we pay
API rates *and* run the compliance risk). Second, Anthropic has both the technical means and a
stated intent to detect and penalize this class of usage, and they reserve the right to act
without notice.

### 2c. Prior art and what happens to accounts that try it

The history here is not theoretical. Starting January 2026, Anthropic disabled accounts using
subscription OAuth in third-party tools (OpenCode, OpenClaw, Roo Code, Cline). On January 9,
2026 a server-side switch began rejecting subscription OAuth tokens from non-Claude-Code clients
with "This credential is only authorized for use with Claude Code and cannot be used for other
API requests." Bans arrived with no warning and no grace period, and some were false positives
triggered by routine actions like a plan upgrade. The February 2026 Legal and compliance update
formalized the OAuth restriction.

The specific PTY tools exist and are openly framed as gray-area. `smithersai/claude-p` (a
drop-in `claude -p` replacement that drives the real TUI inside a `zmux` PTY) carries an explicit
disclaimer that it exists "for educational purposes and demonstrates why client-side restrictions
are fundamentally unenforceable," and even its proponents (for example the `node-pty + tmux`
writeups) concede it is "a workaround, not an officially blessed path," that "Anthropic can add an
extra check at any moment: parent process verification, device fingerprint, timing patterns," and
that "nothing guarantees this lasts six months." Community guidance consistently ranks the PTY
approach as the riskiest option and says to exhaust the sanctioned paths first.

The asymmetry is the deciding factor. The upside of the trick is avoiding a metered credit. The
downside is suspension of the Anthropic account, applied without notice, potentially taking down
interactive Claude Code, Cowork, and chat for whoever's credential AIO uses, with an appeals
process measured in days to weeks and no guaranteed outcome. For a tool we maintain and presumably
want others to run, that is not a risk worth carrying to save API spend.

**Conclusion on permissibility: impermissible. We should stop here and not design around it.**
Per the brief, I'm not going to optimize for dodging billing at the expense of getting the account
flagged.

---

## 3. Technical feasibility (for completeness, not a recommendation)

The brief asked to treat permissibility and feasibility as separate questions, so briefly: yes,
the mechanism is buildable, and that is exactly why it is tempting and why the line has to be held
on policy rather than on "it won't work."

`node-pty` spawns `claude` in a real PTY; the binary sees a TTY and starts its Ink-based TUI. The
known-hard parts are all solved in existing implementations: answering the terminal capability
probes (DA1/DA2/DSR/XTVERSION/window-size) that Ink issues at startup or the TUI hangs; injecting
the prompt and Enter via a `SessionStart` hook; detecting turn completion via the `Stop` hook; and
reading the final assistant message plus usage from the session JSONL transcript rather than
scraping ANSI output. The robust pattern drives state from the transcript JSONL (the same file
`claude /resume` uses), not from raw `pty.onData`, and uses `tmux` for crash/SSH/reboot survival.

The real engineering costs, separate from compliance:

- **Cross-platform breaks on Windows, which we require.** AIO targets macOS (M5 Max) and Windows.
  The reference PTY wrappers are macOS/Linux only because they rely on `forkpty`; `smithersai/claude-p`
  states "No Windows (no `forkpty`)." `node-pty` itself does support Windows via ConPTY, so it is not
  strictly impossible, but the interactive TUI + hook + probe-answering stack is materially less proven
  there, and we'd be maintaining two fragile terminal backends.
- **No structured output.** There is no `--output-format json` contract guarantee for a human TUI and
  no programmatic tool callbacks; we parse text/JSONL and own the brittleness. That fights AIO's whole
  design, which is built on Zod-validated IPC and structured results.
- **Brittleness by construction.** As the `claude-p` README puts it, "`claude` is not designed to be
  driven this way," and any release that changes the hook schema or adds a startup probe can break us.
  We'd be pinning Claude Code versions and chasing its TUI.
- **Capacity is unchanged anyway.** The trick changes which pool you bill, not how much you can use.
  Subscription 5-hour windows and weekly Opus/Sonnet caps still bind, so heavy AIO fan-out would hit
  rate limits regardless.

Net: feasible on macOS, awkward-to-fragile on Windows, structurally at odds with how AIO consumes
results, and pointless to pursue given section 2.

---

## 4. The sanctioned alternatives, compared

| Option | What it is | Cost model | Reliability for AIO | Compliance risk | Cross-platform |
|---|---|---|---|---|---|
| **PTY-driven interactive session** | Drive real `claude` TUI in a PTY on subscription OAuth | "Free" until flagged; silently flips to API rates if detected | Brittle: text/JSONL parsing, version-pinned, no structured contract | **High: breaches Consumer Terms + CC auth policy; bans without notice** | Poor (no `forkpty` on Windows) |
| **Agent SDK on a direct API key (PAYG)** | Official `@anthropic-ai/claude-agent-sdk` or API, Console key | Standard API list rates, predictable, prompt caching helps 2-3x | High: structured output, tool callbacks, parallel sessions, supported | **None: this is the sanctioned path** | Full (pure Node/TS) |
| **Move eligible automation into Cowork** | Run light/scheduled jobs as Cowork tasks | Stays on subscription (excluded from the split) | Medium: Cowork is a desktop file/task agent, not a multi-repo orchestration backend | Low: sanctioned, but only if a human-facing Cowork workflow genuinely fits | macOS/Windows desktop app |
| **Hybrid (recommended)** | Light/scheduled jobs on the Agent SDK credit; heavy jobs on a direct API key | $20/$100/$200 free credit first, API PAYG for overflow | High | None | Full |

On cost specifically: the change is a real increase for heavy programmatic use (community math
puts the effective jump anywhere from ~12x for light Pro+harness usage to ~150-175x for
Sonnet-fleet operators, because subscription was previously subsidizing those tokens). That is
the actual problem to solve, and the honest fix is to reduce token burn and route work
deliberately, not to hide the burn behind a PTY. AIO is well-placed for this because it already
speaks multiple providers: heavy background passes can go to a cheaper model or a non-Claude
provider, with Claude reserved for the work that needs it.

---

## 5. Recommendation

Adopt the **hybrid**, and design AIO's Claude path around a direct API key from day one.

1. **Make the Claude adapter API-key-first.** Use the official Agent SDK / Messages API with an
   Anthropic Console key for all of AIO's automated, scheduled, and fan-out work. This is the path
   Anthropic explicitly names for production automation, it gives us the structured output and
   parallelism AIO depends on, and it is the same pure-Node/TS story on both macOS and Windows. A
   Console account is also separate from any consumer subscription, so a billing issue on one side
   never takes down the other.
2. **Keep genuinely interactive Claude Code on the subscription.** When a human is actually sitting
   in an AIO session driving Claude Code by hand, that is interactive use and stays on the plan. Don't
   automate that surface.
3. **Use the Agent SDK credit as a free allowance, not an architecture.** Claim it, point light or
   low-frequency scheduled jobs at it, and leave overflow billing on a deliberate, capped setting so a
   runaway loop hard-stops rather than silently billing API rates. Treat $20/$100/$200 as the first
   bucket the API-key path draws from, not as a thing to engineer around.
4. **Lean on AIO's multi-provider strength to control cost.** Route heavy/iterative background work to
   cheaper models or other providers; reserve Claude (and especially Opus) for steps that need it. Add
   per-job token budgets and model routing. This attacks the actual cost driver.
5. **Consider Cowork only where a human-facing Cowork workflow genuinely fits** (light scheduled tasks a
   person would otherwise click through). It is excluded from the split and stays on subscription, but it
   is not a backend AIO can drive programmatically at scale, so don't force orchestration into it.

What we should not do is ship the PTY approach, or a `claude -p` wrapper dressed up as interactive, in
a tool we maintain. It breaks the terms, it can be flagged and re-billed or banned without notice, and
it trades a predictable, supportable line item for an existential account risk.

---

## Sources

- Anthropic Help Center, [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) (primary, billing split mechanics and credit terms)
- Claude Code docs, [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) (OAuth-intended-use, no third-party routing of plan credentials, enforcement without notice)
- Anthropic Consumer Terms of Service (Section 3.7 automated-access prohibition; Section 2 credential sharing), quoted verbatim in [The Register, Feb 20 2026](https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546) and [autonomee.ai analysis](https://autonomee.ai/blog/claude-code-account-suspended-banned-safe-usage/)
- [The Register, "Anthropic: No, absolutely not, you may not use third-party harnesses with Claude subs"](https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546) (Feb 2026 legal-language tightening; Thariq Shihipar telemetry/spoofing quotes; OpenCode removing subscription auth under legal request)
- [Zed, "What Anthropic's New Claude Billing Means for Zed Users"](https://zed.dev/blog/anthropic-subscription-changes) (official `claude` CLI in an embedded terminal stays on subscription for human use; ~15-30x prior subsidy figure)
- [The New Stack, "Anthropic splits billing again"](https://thenewstack.io/anthropic-agent-sdk-credits/) (announcement, interactive vs programmatic line)
- [HN thread #48126281](https://news.ycombinator.com/item?id=48126281) (community read: "tmux send-keys is still free," predicted cat-and-mouse on faking interactivity, misclassification fears)
- [MindStudio, "How Anthropic's Harness Detection Actually Works"](https://www.mindstudio.ai/blog/anthropic-harness-detection-git-commit-billing-overcharge) (git-status/system-prompt keyword routing; Thariq and Cherny quotes)
- [autonomee.ai, "Claude Code Account Suspended? How to Stay Safe"](https://autonomee.ai/blog/claude-code-account-suspended-banned-safe-usage/) (Jan 2026 bans, detection signals, OAuth lockout, appeals)
- [smithersai/claude-p](https://github.com/smithersai/claude-p) (PTY/zmux drop-in; "educational purposes," no Windows, API-instability caveats)
- [Mike Codeur, node-pty + tmux workaround](https://blog.mikecodeur.com/en/post/anthropic-strips-programmatic-mode-pro-max-node-pty-tmux) (client-side TTY detection; "workaround, not blessed path"; honest loophole limits)
- [GenAI Unplugged, billing-change workarounds](https://genaiunplugged.substack.com/p/claude-billing-change-workarounds-free-ai-automations) ("Enter Key Test"; Cowork explicitly excluded; names "clarp" as the gray-area workaround and warns to exhaust sanctioned options first; its full risk ranking is paywalled, so treat that part as directional)
- [MagnaCapax gist, canonical $200-credit reference](https://gist.github.com/MagnaCapax/d9177e35b355853f03c730dfcaa693ef) (effective-price-increase math, edge cases, timeline)
