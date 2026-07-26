# Local AI Guard Specification

**Status:** Approved; implementation planned  
**Date:** 2026-07-25  
**Scope:** Coordinator-local and worker-node local AI health, routing safety, cost visibility, incident management, and recovery

**Implementation plan:** [2026-07-26-local-ai-guard_plan.md](../plans/2026-07-26-local-ai-guard_plan.md)

## 1. Summary

AI Orchestrator already knows whether a worker node is connected, whether a worker advertises a local-model endpoint, and whether an auxiliary request ran locally or escalated toward a frontier provider. Those signals are not currently combined into a visible operational verdict.

Local AI Guard makes configured local AI capacity observable and enforceable. It monitors only explicitly enrolled endpoints, validates the full path from worker connectivity through real inference, prevents unhealthy endpoints from receiving work, makes every paid fallback visible, and records the operational and token impact of local-AI incidents.

The initial release is the complete subsystem. It includes endpoint enrolment, passive and active checks, functional canaries, routing policies, budgets, incidents, notifications, historical effectiveness reporting, diagnostics, and guided recovery.

## 2. Goals

1. Distinguish “worker connected” from “local AI capable of useful inference.”
2. Monitor only endpoints that the operator explicitly configures and enrols.
3. Remove an endpoint from routing as soon as its current health cannot be trusted.
4. Make every local-to-frontier escalation attributable to an endpoint, helper task, reason, token estimate, and cost outcome.
5. Provide configurable fallback controls without forcing all workflows to fail closed.
6. Detect configuration drift, missing models, excessive latency, malformed output, and endpoint flapping.
7. Give the operator a single current-health view and durable incident/effectiveness history.
8. Provide safe diagnostics and recovery without arbitrary remote command execution.
9. Reuse existing worker health, auxiliary routing, cost attribution, notification, and IPC patterns.

## 3. Non-goals

1. Local AI Guard does not monitor machines merely because they are paired workers.
2. It does not automatically enrol every discovered Ollama or OpenAI-compatible endpoint.
3. It does not estimate cloud cost and present that estimate as a provider billing fact.
4. It does not execute unrestricted shell commands as a repair mechanism.
5. It does not route primary interactive agents to local models unless an existing routing feature already permits that.
6. It does not replace worker-node transport health, provider diagnostics, or global cost tracking; it consumes and correlates those systems.

## 4. Existing Foundations

The design builds on these existing behaviours:

- `WorkerNodeHealth` checks node heartbeat freshness and latency, marking nodes degraded or disconnected.
- Remote instance monitoring surfaces stale active turns independently from node connectivity.
- Worker capability records include local-model endpoints, advertised models, loaded models, and a health flag.
- `AuxiliaryLlmService` probes coordinator-local endpoints and consults worker-advertised endpoint health.
- Auxiliary routing already records local routing and frontier-escalation intent through cost attribution.
- Per-instance and one-shot invocation paths already record normalized token and cost data.
- The renderer already has remote-node status surfaces and local-model inventory.

Local AI Guard adds an enrolled-target registry, a health-state engine, durable operational history, synchronous routing verdicts, policy enforcement, and user-facing status.

## 5. Terminology

### 5.1 Discovered endpoint

An endpoint observed through a worker capability advertisement or a one-time setup probe. Discovery is informational and does not cause recurring polling.

### 5.2 Enrolled target

An operator-approved expectation that a particular local-model endpoint, selected models, and a canary model should remain usable. Only enrolled targets are monitored and scored.

### 5.3 Health sample

The result of one check at one layer, including timestamp, duration, success, failure classification, and non-secret evidence.

### 5.4 Incident

A durable record opened when an enrolled target crosses an incident threshold or exhibits configuration drift. Repeated failures update the existing incident rather than generating duplicates.

### 5.5 Escalation

An auxiliary task that could not run on its intended local target and is permitted or proposed to run on a paid frontier provider.

## 6. Enrolment Lifecycle

Each candidate endpoint has exactly one lifecycle state:

- **Unmanaged:** discoverable but not monitored, scored, alerted on, or protected by Local AI Guard.
- **Enrolled:** actively monitored and eligible for protected routing.
- **Paused:** retained in configuration and history, but not polled or routed to. A pause may be indefinite or expire at a specified time.
- **Retired:** removed from active inventory. Historical samples, incidents, and routing records remain queryable.

Setup performs a one-time validation before enrolment:

1. Confirm the coordinator or worker is reachable.
2. Confirm the endpoint responds with the expected protocol.
3. Read the endpoint version when supported.
4. Confirm the selected expected models are advertised.
5. Run a functional inference canary using the selected canary model.
6. Save check cadence, expected models, routing roles, fallback policy, and optional recovery policy.

An absent Ollama capability on an unmanaged worker is neutral. If a previously enrolled worker endpoint stops being advertised, Local AI Guard records configuration drift and treats the target as unavailable.

Pausing or retiring a target cancels its scheduled checks immediately and excludes it from aggregate health.

## 7. Health Layers

Every enrolled target is evaluated across five independent layers.

### 7.1 Worker layer

For worker-hosted endpoints:

- authenticated connection state;
- heartbeat freshness;
- connection degradation;
- RPC reachability;
- measured coordinator-to-worker latency.

Coordinator-local endpoints treat this layer as healthy while the main process is running.

### 7.2 Endpoint layer

- Ollama or compatible API reachability;
- valid protocol response;
- endpoint version where available;
- request latency;
- authentication or authorization failure for compatible endpoints;
- malformed or oversized response protection.

### 7.3 Model layer

- all configured expected models are advertised;
- the selected canary model is present;
- load state is reported where available;
- loaded context length satisfies the target's configured minimum where available.

A missing optional model degrades only the routing roles that require it. A missing canary model or required routing model makes the affected target unavailable for those roles.

### 7.4 Inference layer

A small deterministic prompt validates real generation. The canary:

- runs only against the local endpoint;
- never falls back to a paid provider;
- requests a bounded output;
- validates completion time, response shape, and expected content;
- is deferred while the target has active model work;
- times out within its target-specific limit;
- records local token counts when available.

### 7.5 Effectiveness layer

The service correlates real auxiliary decisions with target health:

- local tasks completed;
- local tokens processed;
- frontier escalations proposed, allowed, blocked, or deferred;
- estimated tokens sent to frontier providers;
- provider-reported cost where available;
- estimated cost where pricing is known but provider billing is not;
- avoided frontier usage, labelled as an estimate.

## 8. Scheduling and Freshness

Default schedules are:

- endpoint and model check: every 60 seconds;
- functional inference canary: every 10 minutes;
- pre-route freshness limit: two minutes.

The operator may configure target-specific intervals within safe bounds.

Rules:

1. Functional checks defer while the target is busy and run after a bounded quiet period.
2. Only one check may be in flight per target and check type.
3. Extended outages use exponential backoff with jitter, capped at 15 minutes.
4. Manual rechecks bypass outage backoff but still respect the single-flight guard.
5. A routing request whose relevant verdict is older than the freshness limit triggers an immediate lightweight check.
6. The scheduler is cancelled on pause, retirement, shutdown, or worker deregistration.
7. Resume and worker reconnection trigger an immediate lightweight check before the target becomes routable.

## 9. Health State Machine

An enrolled target exposes:

- **Checking:** no current verdict is available.
- **Healthy:** all required layers are passing and the target is routable.
- **Degraded:** the target remains partially useful, but one or more non-critical checks are failing or latency exceeds its warning threshold.
- **Unavailable:** required work cannot be trusted or completed.
- **Paused:** monitoring and routing are intentionally suspended.

Routing safety and UI incident state use different timing:

- The first failed required check immediately removes the affected capability from routing.
- Two consecutive failures set the visible state to Degraded.
- Three consecutive failures set the state to Unavailable and open an incident.
- An unambiguous worker disconnect, authentication failure, missing required model, or failed pre-route check may set Unavailable immediately.
- Recovery requires two consecutive successful required checks.
- A target that repeatedly changes state is marked as flapping and quarantined from routing until it passes the configured consecutive-success threshold.

Aggregate Local AI Guard status is the worst active state among enrolled, unpaused targets. With no enrolled targets, the status is **Not configured**, not unhealthy.

## 10. Routing Guard

Auxiliary routing asks Local AI Guard for a verdict before choosing an enrolled local target. The verdict contains:

- target and routing-role eligibility;
- verdict freshness;
- failed layer and reason;
- applicable fallback policy;
- token and cost estimates;
- active budget state;
- whether user confirmation is required.

Supported policies are:

- **Allow silently**
- **Notify and allow**
- **Require confirmation**
- **Defer locally**
- **Block paid fallback**

Policies exist globally and per auxiliary slot. The per-slot value overrides the global value.

The default is **Notify and allow** to preserve continuity while eliminating silent fallback. The notification includes the intended target, affected slot, failure reason, estimated input tokens, selected frontier provider/model when known, and known or estimated cost.

Background work that requires confirmation becomes pending with a typed wait reason. It does not silently choose on the user's behalf. The operator can allow once, allow for the incident, defer, or change the governing policy.

### 10.1 Budgets

Local AI Guard supports:

- a daily paid-fallback budget;
- a per-incident fallback ceiling;
- an optional estimated-token threshold above which confirmation is required.

Crossing a warning threshold upgrades **Allow silently** or **Notify and allow** to **Require confirmation**. Crossing a hard ceiling upgrades the decision to **Block paid fallback**. Provider-reported spend is preferred; reservations and estimates are used conservatively when final cost is not yet known.

## 11. Incidents and Alerts

An incident records:

- target and endpoint identity;
- affected health layers and routing roles;
- first failure, latest failure, and recovery timestamps;
- non-secret evidence and failure classification;
- affected helper tasks;
- fallback decisions and cloud impact;
- diagnostics and repair attempts;
- operator acknowledgements and policy overrides;
- final resolution.

Alerts are transition-based and deduplicated:

- one incident notification when paid fallback first becomes possible;
- immediate notification when paid fallback is actually used;
- escalation when a budget threshold is crossed;
- recovery notification containing duration and cloud impact;
- no repeated toast for identical failures within an open incident.

The in-app status remains persistent even when desktop notifications are dismissed.

## 12. Operator Experience

### 12.1 Global indicator

The application header exposes the aggregate state and count of enrolled targets. It distinguishes Healthy, Degraded, Unavailable, Checking, Paused, and Not configured.

### 12.2 Health centre

The health centre includes:

- target cards with layer-by-layer status and evidence timestamps;
- expected and currently advertised models;
- last endpoint check and functional canary;
- routing roles and current policy;
- active incidents and recent recoveries;
- manual recheck, pause, resume, edit, and retire actions.

### 12.3 Effectiveness dashboard

For 24-hour, 7-day, and 30-day periods:

- percentage and count of eligible work completed locally;
- tasks and tokens processed locally;
- proposed, allowed, deferred, and blocked escalations;
- measured cloud cost;
- estimated cloud cost, visually distinguished;
- estimated avoided frontier tokens and cost;
- breakdown by endpoint, worker, model, helper slot, and incident.

### 12.4 Setup

The setup flow supports:

- auto-discovered worker endpoints;
- coordinator-local endpoints;
- manually entered private/LAN compatible endpoints where already supported;
- expected-model selection;
- canary-model selection;
- cadence and latency thresholds;
- routing-role assignment;
- fallback and budget policy;
- optional guided or automatic recovery.

## 13. Diagnostics and Recovery

Diagnostics classify at least:

- worker offline or degraded;
- RPC unavailable;
- endpoint not advertised;
- endpoint connection refused;
- endpoint timeout;
- protocol or authentication error;
- missing required model;
- insufficient reported context capacity;
- inference timeout;
- malformed inference output;
- latency threshold exceeded;
- endpoint flapping.

Available actions include:

1. Re-run the failed layer.
2. Run a complete deep check.
3. Validate expected models.
4. Reconnect or repair worker service using existing remote-worker repair facilities.
5. Show platform-specific Ollama recovery instructions.
6. Restart Ollama through an explicit, supported platform adapter when the target has opted into automatic repair.

Automatic repair is off by default. It has bounded attempts, cooldown, audit records, and no arbitrary command field. Failure returns the incident to operator action without retry loops.

## 14. Persistence

Use the existing SQLite persistence and migration conventions rather than storing operational history in settings.

Conceptual records:

### 14.1 `local_ai_targets`

- stable target ID;
- location and worker ID;
- endpoint provider, non-secret endpoint identity, and base URL;
- lifecycle state;
- expected models and canary configuration;
- check cadence and thresholds;
- routing roles;
- fallback and recovery policies;
- created, updated, paused, and retired timestamps.

### 14.2 `local_ai_health_samples`

- target ID;
- layer and check type;
- timestamp and duration;
- success and classification;
- structured non-secret evidence;
- scheduler or manual origin.

### 14.3 `local_ai_incidents`

- incident state and severity;
- target ID;
- opened, acknowledged, and resolved timestamps;
- initial and latest classification;
- repair and cloud-impact summary.

### 14.4 `local_ai_routing_events`

- task/slot correlation;
- intended and actual route;
- policy decision;
- fallback state;
- normalized tokens;
- known cost and estimated cost in separate fields;
- associated target and incident.

Raw samples and routing events are retained for 90 days. Daily aggregates are retained for long-term trends. Retirement does not erase historical incidents or aggregates.

## 15. Components and Boundaries

### 15.1 Main process

- **LocalAiTargetRepository:** target lifecycle and configuration.
- **LocalAiHealthRepository:** samples, incidents, routing events, retention, and aggregates.
- **LocalAiProbeService:** coordinator-local HTTP checks and worker RPC checks.
- **LocalAiHealthScheduler:** cadence, single-flight execution, busy deferral, and outage backoff.
- **LocalAiHealthEngine:** state transitions, hysteresis, configuration drift, and aggregate status.
- **LocalAiRoutingGuard:** synchronous eligibility, policy, confirmation, and budget decisions.
- **LocalAiIncidentService:** incident deduplication, notifications, acknowledgement, and recovery.
- **LocalAiRecoveryService:** diagnostics and bounded supported repairs.

These units communicate through typed results and events. Probe code does not decide routing policy; routing code does not perform repairs.

### 15.2 Worker process

Add authenticated service RPC methods for:

- endpoint metadata and model validation;
- bounded functional canary;
- supported diagnostic actions;
- supported Ollama restart where implemented.

RPC schemas reject arbitrary URLs, commands, models outside the enrolled target, and oversized responses.

### 15.3 Shared contracts

Define Zod-backed types for target configuration, health samples, current status, incidents, routing decisions, diagnostics, and renderer IPC payloads.

### 15.4 Renderer

- Local AI Guard signal store;
- header indicator;
- health-centre route and components;
- setup/edit flow;
- incident and confirmation surfaces;
- effectiveness charts and filters;
- accessible live-state announcements without repeated screen-reader noise.

## 16. Data Flow

### 16.1 Scheduled check

1. Scheduler selects an enrolled, due, non-busy target.
2. Probe service runs the relevant local or worker check.
3. Health repository records the sample.
4. Health engine derives the target verdict.
5. Incident service opens, updates, or closes an incident.
6. Renderer receives a bounded status update.

### 16.2 Auxiliary routing

1. Auxiliary service resolves candidate local targets.
2. Routing guard checks enrolment, role, health, freshness, policy, and budget.
3. A stale verdict triggers a lightweight pre-route check.
4. Healthy eligible targets proceed locally.
5. Failed local execution records a new sample and invalidates routing immediately.
6. Fallback policy allows, notifies, waits for confirmation, defers, or blocks.
7. Routing and cost results update the event and incident records.

## 17. Error Handling

- Health monitoring is fail-soft relative to application startup.
- An internal monitoring failure yields **Checking** or a typed monitor error; it never fabricates Healthy.
- Database write failures are logged and surfaced as degraded observability, without bypassing a current in-memory routing safety verdict.
- Worker RPC timeouts are bounded and cancellable.
- Scheduler ticks cannot overlap for the same target/check type.
- Notification failures do not change routing decisions.
- Unknown cost remains unknown.
- Missing or stale evidence is never interpreted as health.
- Application restart reconstructs current targets and open incidents, then performs fresh checks before routing to them.

## 18. Security and Privacy

- Persist no credentials, tokens, prompt bodies, or model responses in health evidence.
- Endpoint URLs follow existing private/LAN validation rules.
- Worker checks use the authenticated coordinator-worker channel.
- Canary prompts contain no user or repository content.
- Diagnostic evidence is allow-listed and size bounded.
- Repair actions are named, platform-specific operations implemented in code.
- Confirmation and policy changes follow existing privileged settings and IPC validation patterns.

## 19. Verification Strategy

### 19.1 Main-process tests

- target lifecycle and migration;
- unmanaged endpoints never scheduled or scored;
- pause, resume, retirement, and restart restoration;
- five-layer probe classification;
- scheduler cadence, busy deferral, cancellation, jitter, backoff, and single flight;
- first-failure routing removal;
- degradation, unavailability, recovery, and flapping thresholds;
- configuration drift;
- pre-route freshness check;
- per-slot policy precedence;
- confirmation waits and responses;
- daily and incident budget enforcement;
- incident deduplication and recovery;
- known versus estimated cost aggregation;
- retention and daily aggregation;
- bounded repair attempts.

### 19.2 Worker and contract tests

- RPC authentication and Zod validation;
- target/model allow-list enforcement;
- timeout and cancellation;
- response-size limits;
- canary success, malformed output, missing model, and endpoint failure;
- unsupported repair action rejection.

### 19.3 Renderer tests

- every aggregate and target state;
- Not configured with zero enrolled targets;
- setup validation and enrolment;
- incident and fallback confirmation flows;
- measured versus estimated cost labelling;
- notification deduplication;
- keyboard navigation, focus management, contrast, and screen-reader announcements.

### 19.4 Integration and live verification

- coordinator-local Ollama healthy to unavailable to recovered;
- worker connected while its Ollama fails;
- worker disconnect and reconnect;
- enrolled capability disappears from heartbeat;
- canary defers during active inference;
- frontier fallback alert and confirmation;
- budget threshold upgrade and hard block;
- application restart with an open incident;
- opted-in supported restart recovery.

Implementation must pass targeted tests and the project canonical verification checklist:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run test:quiet
```

Real UI/runtime checks that require a rebuilt application or live worker are recorded under the project's `_livetest.md` convention rather than claimed as complete.

## 20. Acceptance Criteria

1. A paired worker without enrolled local AI creates no checks, incidents, or unhealthy status.
2. Setup can validate and enrol a coordinator-local or worker-local endpoint.
3. An enrolled endpoint is assessed across worker, endpoint, model, inference, and effectiveness layers.
4. The first failed required check removes the affected capability from routing.
5. State hysteresis and flapping quarantine behave as specified.
6. Paid fallback is never silent under the default policy.
7. Per-slot policies, confirmation, deferral, blocking, and budgets are enforced before paid dispatch.
8. The operator can identify the endpoint, task, reason, token impact, and cost impact for every escalation.
9. Current status, incident history, and 24-hour/7-day/30-day effectiveness are visible.
10. Pausing or retiring a target stops polling immediately.
11. Recovery actions are bounded, audited, and restricted to supported operations.
12. No secret, prompt, or model-response content is stored as health evidence.
13. Tests and canonical project gates pass, followed by the required independent completion-gate review during implementation.
