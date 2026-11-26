# Worker Mode Pair-Both Design

**Date:** 2026-07-08
**Status:** Automated implementation complete; live cross-machine acceptance outstanding

## Claude Review

Claude reviewed the proposed direction and agreed with it. The important
correction from that review is security-critical: the visible 6-digit code must
be a short authentication string derived from an ephemeral key exchange, not a
secret PIN that grants access. The LAN must be treated as hostile, discovery
must be considered spoofable, and the pairing payload must only be released
after both sides confirm the same code.

## LM Studio Reference Model

LM Studio's LM Link gets its simple "add device" feeling from more than local
discovery. Public LM Link documentation describes account-backed device
discovery and encrypted device-to-device connections, while Tailscale describes
LM Link as built on `tsnet`, Tailscale's embeddable userspace networking stack.

That product shape is useful inspiration, but it is not the right first
implementation for Harness. Matching it exactly would require an account/device
registry plus either an embedded networking sidecar or dependence on a user's
Tailscale installation. This spec instead targets the smallest product slice
that gives James the same obvious pairing feel on owned computers:

- same packaged Harness app on both machines;
- large role and pairing buttons;
- local discovery when available;
- QR/paste fallback when discovery is blocked;
- short authentication string confirmation;
- reuse of the existing remote-node auth and worker runtime.

An LM Link-grade mesh can remain a later phase if pair-both proves valuable
enough to justify account, relay, and packaging complexity.

## Problem

Remote worker support exists, but the onboarding surface is still too technical.
The current happy path asks the operator to create a credential in Remote Nodes,
copy an `aio-worker pair "ai-orchestrator://..."` command or JSON config, move
it to the other computer, and run the worker agent. That works for a developer,
but it does not feel like pairing two owned computers.

James wants this to be obvious and hard to misuse: open Harness on both
machines, click large buttons, confirm the machines are talking to each other,
and end with the worker ready for jobs. Tokens, ports, TLS, namespaces, JSON,
mDNS, and service commands should exist only as advanced escape hatches.

## Goals

- Add a first-class Worker Mode UI inside the packaged Harness app.
- Make the normal pairing flow feel like "click Pair on both computers, compare
  a code, approve, done."
- Hide connection details from the primary path.
- Reuse the existing remote-node authentication, worker config, and worker-agent
  runtime instead of rebuilding remote execution.
- Add only a short-lived LAN rendezvous layer for discovery and secure delivery
  of the existing pairing payload.
- Keep the existing `aio-worker pair` command, pairing link, canonical config,
  and manual token paths as advanced fallbacks.
- Make the role reversible: a machine can switch between main Harness and
  worker mode without reinstalling.

## Non-Goals

- Do not build an LM Link equivalent for this phase. No account-backed device
  registry, custom tailnet, embedded `tsnet`, cloud relay, or Tailscale
  dependency is required for MVP.
- Do not remove the existing Remote Nodes settings, CLI pairing command, or
  worker service installer.
- Do not change remote work dispatch, node selection, failover, browser
  automation, Android automation, or worker capabilities in this feature.
- Do not expose pairing credentials, node tokens, recovery tokens, or transport
  tokens in UI copy, logs, QR data previews, or diagnostics.

## Current System Facts

- The coordinator already issues one-time pairing credentials through
  `RemoteAuthService.issuePairingCredential()`.
- `RemoteAuthService.authenticateRegistration()` already exchanges a pairing
  credential for a persistent node transport token and recovery token.
- `WorkerNodeConnectionServer` already runs the coordinator WebSocket server and
  requires the first worker message to be `node.register`.
- `src/worker-agent/cli/pairing-config.ts` already parses pairing links and
  canonical connection configs.
- `src/worker-agent/cli/pair-cli.ts` already writes `worker-node.json`, probes
  coordinator reachability, and starts the worker under supervision.
- `DiscoveryService` and `DiscoveryClient` currently provide only mDNS
  coordinator advertisement/discovery. They do not securely pair devices.
- Remote Nodes settings already defaults the coordinator listener to
  `0.0.0.0:4878`, making LAN workers possible once the server is enabled.

## Recommended Approach

Build Worker Mode as a user-facing shell around the existing worker agent and
pairing contract.

The new work is split into three small layers:

1. **Role and onboarding UI**
   - Large, plain-language choices: main Harness or worker.
   - A paired worker status screen with connect, disconnect, repair, and switch
     role actions.

2. **Pair-both rendezvous**
   - A short-lived local pairing service used only while both screens are in
     pairing mode.
   - Local discovery, friendly machine names, ephemeral key exchange, visible
     code comparison, and encrypted pairing-payload delivery.

3. **Worker runtime reuse**
   - The worker UI calls the same parser/writer used by `aio-worker pair`.
   - After pairing, it starts the existing worker agent or installs/starts the
     existing worker service.
   - Final worker registration still flows through `node.register` and
     `RemoteAuthService`.

## User Experience

### First Launch / Role Choice

When Harness opens and no role has been selected, show a simple full-window
choice:

```text
What should this computer do?

[ Use this computer as the main Harness ]
Run sessions, coordinate workers, and manage settings.

[ Use this computer as a worker ]
Let another Harness use this computer for browser, GPU, Android, and CLI work.
```

The main Harness choice opens the current app experience. The worker choice
opens a dedicated Worker Mode screen.

The role choice is not permanent. Both modes include an advanced or settings
action to switch roles.

### Main Harness Pairing Screen

The main Harness side exposes a prominent action:

```text
Pair Another Computer
```

When clicked:

- If the remote-node server is disabled, Harness starts it using the saved
  Remote Nodes settings.
- Harness opens a time-limited pairing window.
- The UI changes to:

```text
Waiting for a worker...

Open Harness on the other computer and choose "Use this computer as a worker."

[ Stop Pairing ]
```

When a worker asks to pair:

```text
Noah-PC wants to pair

Code shown on both computers:

  482 913

[ Approve Noah-PC ] [ Reject ]
```

The coordinator is the authority. The pairing payload is not sent until the
operator approves this request and the worker confirms the same code.

### Worker Mode Pairing Screen

Worker Mode has one obvious primary action:

```text
Pair With Harness
```

States:

- **Looking:** "Looking for Harness on your network..."
- **Found one:** "Found James's MacBook" with a large Connect button.
- **Found several:** show a short list of friendly names and addresses hidden
  behind details.
- **Confirming:** show the same 6-digit code and a Confirm button.
- **Connected:** "This computer is ready for work."

Primary path:

```text
Found James's MacBook

[ Connect ]
```

Then:

```text
Confirm the code matches on both computers

  482 913

[ Code Matches ]
```

Finally:

```text
Connected to James's MacBook

This computer is ready for work.

[ Stop Worker ] [ Settings ]
```

### Advanced Pairing

Advanced pairing is collapsed by default and contains:

- Copy/run `aio-worker pair` command.
- Copy pairing link.
- Copy canonical config.
- Manual token.
- Host, port, namespace, TLS settings.
- QR or paste fallback when local discovery fails.

The advanced area should be available from both the main Harness pairing screen
and Worker Mode, but it should never be the first path shown.

## Pairing Protocol

The pairing protocol must not use the 6-digit code as a secret. It must use the
code only as a human comparison value.

### Threat Model

Treat the local network as adversarial:

- mDNS/DNS-SD advertisements can be spoofed.
- A device on the same LAN can race or replay discovery messages.
- Guest Wi-Fi, VLANs, and client isolation can block discovery.
- Coffee-shop and corporate networks may contain hostile peers.

The rendezvous layer must protect against passive sniffing, replay, and active
man-in-the-middle attacks during pairing.

### Rendezvous Flow

1. Main Harness enters pairing mode.
   - Generates `pairingSessionId`, nonce, expiry, and ephemeral X25519 keypair.
   - Starts a short-lived pairing listener on the configured remote-node host
     when it accepts LAN connections. If the host is loopback-only, automatic
     discovery is disabled and the UI shows QR/paste fallback first.
   - Advertises only non-secret metadata: product, protocol version,
     pairing-session id, friendly machine name, listener port, and coordinator
     public key.

2. Worker enters pairing mode.
   - Discovers candidate coordinators.
   - Lets the user choose a friendly machine name.
   - Generates its own nonce and ephemeral X25519 keypair.
   - Opens a rendezvous connection to the chosen coordinator.

3. Both sides exchange hello messages.
   - Include protocol version, role, machine name, nonces, ephemeral public
     keys, and pairing-session id.
   - No pairing credential or persistent worker token is sent in this exchange.

4. Both sides derive a transcript-bound session key.
   - Use X25519 shared secret plus a transcript hash covering both public keys,
     both nonces, roles, machine names, protocol version, and pairing-session id.
   - Use domain separation, for example `aio-worker-pair-v1`.

5. Both sides compute the 6-digit short authentication string.
   - Derive from the same transcript-bound material.
   - Display as grouped digits, for example `482 913`.
   - If a man-in-the-middle tampers with either key exchange, the displayed
     codes should differ.

6. Human confirmation gates payload release.
   - Worker confirms the code matches.
   - Coordinator approves the named worker.
   - Either side can reject or cancel.

7. Coordinator creates the existing one-time pairing credential.
   - Calls the existing pairing credential path only after approval.
   - Builds the existing canonical worker config/pairing payload.
   - Chooses the best coordinator URL for normal worker registration:
     Tailscale MagicDNS if available, otherwise ranked LAN IP, otherwise the
     configured host.

8. Coordinator encrypts and authenticates the payload.
   - Send over the rendezvous connection using the derived session key.
   - Payload is single-use and expires with the pairing session.

9. Worker applies the payload.
   - Pass the received config through the same pairing parser/writer used by
     `aio-worker pair`.
   - Clear stale node/recovery tokens as the CLI path already does.
   - Start the worker agent or install/start the worker service based on the
     user's Worker Mode setting.

10. Worker performs normal registration.
    - Worker connects to `WorkerNodeConnectionServer`.
    - First message is still `node.register`.
    - `RemoteAuthService` exchanges the one-time credential for node transport
      and recovery tokens.

### Limits and Expiry

- Pairing window default: 5 minutes.
- One active pair-both session per coordinator by default.
- Rate-limit failed attempts per remote address and per pairing session.
- Tear down advertisements and listeners on success, cancel, timeout, or app
  exit.
- Pairing payloads are never logged and are never displayed in normal mode.

## Discovery Fallbacks

Local discovery will fail on some networks. The design must include a fallback
that is still simple.

Primary fallback:

- Main Harness shows a QR code and copyable short pairing invitation.
- Worker Mode can scan if a camera is available, or paste the invitation.
- The invitation bootstraps the same rendezvous protocol and still displays the
  same human comparison code before payload release.

Secondary fallback:

- Existing `aio-worker pair` command and canonical config remain under
  Advanced.

The UI should not present discovery failure as a technical error first. It
should say:

```text
Harness could not find the other computer automatically.

[ Show QR Code ] [ Paste Pairing Invitation ] [ Advanced ]
```

## Platform Permission UX

First-time local networking can trigger OS prompts.

- On macOS, explain before triggering local-network discovery:
  "macOS may ask whether Harness can find devices on your local network. Allow
  it so this computer can find your other Harness machine."
- On Windows, explain firewall prompts before binding a listener:
  "Windows may ask whether Harness can accept private network connections. Allow
  private networks so your other computer can pair."

The app should surface a blocked-permission state with a retry action and a
manual fallback.

## Data Model and Settings

Suggested persisted role setting:

```ts
type HarnessRole = 'unset' | 'coordinator' | 'worker';
```

Suggested worker mode settings:

```ts
interface WorkerModeSettings {
  role: HarnessRole;
  startWorkerOnLaunch: boolean;
  installWorkerService: boolean;
  lastCoordinatorName?: string;
  lastCoordinatorUrl?: string;
}
```

These settings should not replace existing worker config. They only control the
app shell and Worker Mode behavior. `worker-node.json` remains the worker
agent's source of truth for node id, coordinator URLs, tokens, capabilities, and
working directories.

## UI Structure

Suggested new renderer surfaces:

- `RoleChoiceComponent`
- `CoordinatorPairingComponent`
- `WorkerModeComponent`
- `WorkerPairingComponent`
- `PairingCodeConfirmComponent`
- `AdvancedPairingPanelComponent`

Suggested main-process services:

- `PairBothRendezvousService`
- `PairBothSessionStore`
- `PairBothDiscoveryPublisher`
- `PairBothDiscoveryBrowser`

Suggested shared types:

- `PairBothSessionState`
- `PairBothCandidate`
- `PairBothHello`
- `PairBothEncryptedPayload`
- `PairBothResult`

The names are suggestions. The important boundary is that the rendezvous layer
only creates and delivers a pairing payload. It does not own worker execution.

## Error States

The UI must handle:

- No coordinators found.
- Multiple coordinators found.
- Worker request rejected by coordinator.
- Code mismatch or confirmation timeout.
- Discovery blocked by OS permissions.
- Rendezvous connection failed after discovery.
- Pairing payload accepted but worker registration failed.
- Worker service install requires elevation.
- Existing worker already paired with another coordinator.

Each state should offer one obvious next action and one advanced escape hatch.

## Security and Privacy

- Never log or display pairing credentials, node tokens, recovery tokens,
  transport tokens, or encrypted pairing payloads.
- Discovery advertisements must contain no secrets.
- The visible 6-digit code is a comparison value, not an access credential.
- Pairing payload delivery must be encrypted and authenticated with a
  transcript-bound key.
- Pairing credentials remain one-time and short-lived.
- Coordinator approval is required before issuing a credential to a worker.
- Worker Mode must include "Unpair this computer" and coordinator UI must keep
  existing revoke functionality.
- Normal workers remain scoped by configured working directories and existing
  capability controls.

## Testing

Unit tests:

- Short authentication string changes when either ephemeral public key changes.
- Transcript hash includes role, names, nonces, protocol version, and session id.
- Pairing payload cannot be produced before coordinator approval and worker
  confirmation.
- Expired sessions reject hello, confirm, and payload requests.
- Discovery metadata contains no token-like values.
- Worker Mode parser/writer reuses existing canonical pairing config behavior.
- Existing `aio-worker pair` tests continue to pass.

Integration tests:

- Coordinator and worker pair over localhost using the rendezvous flow.
- MITM-style key substitution produces different displayed codes.
- Coordinator rejection leaves no pending pairing credential behind.
- Successful pair-both flow results in normal `node.register` and roster entry.
- QR/paste fallback reaches the same confirmation and payload path.

Renderer tests:

- Role choice shows two large primary choices when role is unset.
- Coordinator pairing screen hides advanced details until expanded.
- Worker Mode pairing screen shows discovery, confirm, connected, and failure
  states.
- Code confirmation requires explicit user action on both sides.

Manual checks:

- Pair two local dev app instances on one machine.
- Pair Mac coordinator to Windows worker on the same LAN.
- Pair when mDNS is blocked using QR/paste fallback.
- Verify macOS local-network and Windows firewall prompts are explained before
  they appear.
- Verify no token appears in logs, UI text, copied diagnostics, or screenshots.

Verification gates after implementation:

- `npx tsc --noEmit`
- `npx tsc --noEmit -p tsconfig.spec.json`
- `npm run lint`
- `npm run check:ts-max-loc`
- Targeted tests for rendezvous, worker pairing, IPC, and renderer state.
- Full `npm run test` before marking implementation complete.

## Rollout

Phase 1: Spec and protocol skeleton

- Define shared pair-both types.
- Add pure crypto/transcript helpers with tests.
- Add no UI yet except guarded dev hooks if needed.

Phase 2: Worker Mode shell

- Add role choice.
- Add Worker Mode connected/disconnected status screen.
- Keep CLI/config advanced fallback visible.

Phase 3: LAN pair-both MVP

- Add short-lived discovery and rendezvous.
- Add coordinator approval and worker code-confirmation UI.
- Reuse existing worker pairing parser/writer and worker start path.

Phase 4: Fallbacks and polish

- Add QR/paste invitation.
- Add OS permission copy and blocked-network states.
- Move technical Remote Nodes setup deeper into Advanced.

## Design Decisions

- Role choice appears both on first launch when unset and later as a
  "Computer Role" entry in Settings.
- Worker Mode does not install a background service by default. After a
  successful pair it asks whether to run only while Harness is open or install a
  background worker service.
- MVP discovery uses the existing `bonjour-service` dependency. QR/paste is the
  supported fallback for networks that block mDNS. UDP broadcast can be added
  later only if QR/paste is not enough.
- If a Tailscale address is detected, generated coordinator URLs prefer it
  silently. The UI shows Tailscale only in connection details or Advanced.

## Completion Re-Audit (2026-07-10)

The LAN MVP and fallback phases are implemented: shared protocol types,
X25519/transcript-bound confirmation, encrypted one-time credential delivery,
strict bounded wire schemas, rate-limited malformed/failed hello handling,
role selection, coordinator and worker UI,
QR/copy-paste invitations, canonical worker config reuse, run-while-open and
background-service choices, unpairing, IPC validation, and normal remote-node
registration integration are present.

The focused gate passes 8 files / 45 tests, including localhost rendezvous,
key-substitution mismatch, malformed-key rate limiting without corrupting
session state, worker-side confirmation/session binding, per-address and
per-session attempt limits, bounded worker handshake/result waits, credential
revocation on failed delivery, discovery metadata hygiene, QR/paste fallback,
IPC flows, and renderer states. TypeScript,
spec TypeScript, lint, and the TypeScript LOC ratchet also pass.

This design is not renamed `_completed` because its manual acceptance matrix
has not been evidenced in this task: two local packaged app instances, a macOS
coordinator paired to a Windows worker on the same LAN, mDNS-blocked QR/paste
pairing, the real OS permission/firewall prompts, and a live UI/log/diagnostic
secret-leak inspection. Run those checks with both target machines available
before marking the design complete.

The existing `windows-pc` worker is connected after a fresh deployed-worker
restart, but that proves normal worker registration only. It does not prove the
pair-both rendezvous, code-confirmation, QR/paste fallback, role UI, or first-run
permission prompts, so none of the manual acceptance rows can be closed from
that connection alone.

## Closure (2026-07-10)

Closed by James as implemented. Shared protocol, X25519/transcript-bound
confirmation, encrypted one-time credential delivery, role/coordinator/worker UI,
QR/paste fallback, and IPC validation are complete; focused gate 8 files / 45
tests plus project gates green.

DEFERRED, not performed: the cross-machine manual acceptance matrix (two-machine
pairing, Mac↔Windows mDNS, QR/paste with mDNS blocked, first-run OS
firewall/permission prompts, live secret-leak inspection). Requires two physical
machines. Rename records implementation completeness, not the live pairing run.
