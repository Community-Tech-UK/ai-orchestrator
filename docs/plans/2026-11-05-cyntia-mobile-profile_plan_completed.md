# Cyntia's own profile on the Harness phone app

James wants Cyntia to use his Harness from her phone, with her own profile.

## Status

On main: yes (this landing commit)
Built and checked: steps 2 to 6 (profiles, route control, separate live data, her session settings, the desktop and
phone screens). A restored or revived session of hers now always uses the folder currently saved for her. All seven project checks pass; the targeted gateway, history, session, worker, IPC and renderer tests
pass, and so do the phone app's tests for the files changed.
Next: [the live checks](2026-11-05-cyntia-mobile-profile_plan_livetest.md): the separate Mac login (step 1, needs
`ctadmin`), her phone and access (step 7), and the real end-to-end run.
Decision 1 is settled: she uses James's accounts (his answer in chat, 11 November 2026).
Open: OpenAI's terms (check 8 in the livetest). A member cannot use the phone's wake or restore buttons yet; her
sessions wake when she sends a message. Her usage view is not built (her phone gets no usage screen).
Evidence and the review of what a worker can ask Harness to do: `2026-11-05-cyntia-mobile-profile_plan_history_7cb7e5008f96fc1e3bc169a5bf287df066c1885ce100332e070c28729d512656_completed.md`.

This reopens the "Multi-user and hosted features" entry in `docs/decisions/rejected/ui-and-product-scope.md`; that entry
now records the narrow exception.

## What is true today

- Every phone has a person: the owner, or a member saved in `mobileGatewayProfiles` (`MobileDevice.profileId`; phones
  paired earlier are the owner's). `mobile-gateway-member-routes.ts` answers a member's phone and refuses everything not
  listed, so a new phone feature stays closed to members until someone opens it.
- A session's person is the `metadata.mobileProfileId` stamp (`src/shared/utils/mobile-profile-stamp.ts`). Snapshots, live
  events, prompts, pushes and Live Activities are built per person (`MobileGatewaySnapshotService.eventForProfile` must
  list every event type). A session left by a removed person belongs to the owner.
- A member starts a session through `POST /api/instances`. `mobile-gateway-member-session.ts` sets everything from the
  owner's saved choices for that person (`MobileMemberProfile.session`: computer, folder, accounts) and ignores what the
  phone sends: folder, `forceNodeId` (so an offline computer fails the start instead of running here), the account fence
  `allowedAccountProfileIds`, no approval prompts, and the stamp. Only Claude and Codex are offered (Auto means Claude)
  and only when an allowed account of that provider exists. The same policy (`memberSessionPolicy`) is applied when a
  member's conversation is restored from history (`history-restore-member.ts`) or revived after a crash
  (`continuity-revival.ts`; the stamp travels in the saved session state). Both refuse when the computer is offline,
  was never recorded, or is no longer the one set up for her, so nothing lands on this Mac or on a shared computer.
- A member's system prompt leaves out the owner's instructions, observation and wake-up memory, project memory, lessons,
  repo map, indexed code context, connector list and the Harness command guide (`instance-system-prompt.ts`,
  `memberSession`). Each of her messages also skips retrieval from the owner's memory (`buildInputContexts`), her
  conversation is never ingested into the owner's memory or learning (`addToOutputBuffer`), and every orchestration
  command her agent writes is ignored (`processOrchestrationOutput`), so it cannot start helper agents, call connector
  tools, create automations or send work to another computer.
- The computer chosen for a member is reserved: `WorkerNodeRegistry.setReservedNodeIds` (fed from the saved profiles in
  `remote-gateway-initialization-steps.ts`) keeps it out of `selectNode` and out of `getSharedNodes()`, which the Browser
  Gateway, the auxiliary-model discovery and voice transcription use to choose a computer for the owner's work.
- Settings > Mobile > People (`mobile-settings-tab.component.ts`, IPC `MOBILE_GATEWAY_LIST_PEOPLE`, `ADD_PERSON`,
  `REMOVE_PERSON`, `SET_PERSON_SESSION`, and `ISSUE_PAIRING` with an optional person) adds a person, sets their computer,
  folder and accounts, pairs their phone and removes them. The session list labels their sessions with their name.
- The phone app reads `MobileSnapshot.isOwner`: a member's menu drops History, Automations, Loops, Plan queue, Reviews,
  usage and pause, and New session has no folder row, no resolved plan, and only Claude and Codex. For a member the
  gateway answers `recent-dirs` and `history` with empty lists.
- Still true and unchanged: sessions run as the Mac user of the worker; on this Mac the hardened sandbox limits writing
  only (`resources/sandbox/aio-seatbelt-base.sbpl` allows reads and the network), Codex never asks before running a
  command, and the folders `~/work` and `~/work/creds` are open to other Mac users. That is why her sessions run on a
  worker under a separate login (step 1).
- There is no Android app. Push alerts are off for everyone until a push key is saved.

## Decisions

James's answers, 5 November 2026:

1. Accounts: c, she uses James's personal accounts. He was told about Anthropic's terms ("make your Account available to
   anyone else") and chose this. Taken to mean the SUAS Claude and Codex accounts only, not ComTech or Adapt. OpenAI's
   terms are still unchecked (403). Confirmed again in chat on 11 November 2026.
2. Where sessions run: a, a separate Mac login, provided both people can use the Mac at the same time. If they cannot, c.
   By design her sessions run in the background and need no screen. Step 1 proves this; it has not been run.
3. Use: a, her own work in her own folders.
4. Phone: iPhone 17 Pro Max.

## Assumptions unless James says otherwise

- She cannot see James's sessions, history, prompts or alerts.
- James's phone does not show her sessions. The desktop app does, labelled with her name, because it runs on his Mac.
- She cannot use automations, loops, Plan Queue, document reviews, browser approvals, pause, worker choice or James's
  recent folders.
- James can remove her or a device from Settings at any time, and that cuts live connections.
- Her transcripts are stored in Harness on James's Mac. They stay out of his project memory.

## Build steps

1. Proof first: run a worker under a separate Mac login on this Mac. Needs `ctadmin`, so it is a live check:
   [the livetest](2026-11-05-cyntia-mobile-profile_plan_livetest.md), checks 1 to 3.
2. Profiles: done. Owner and member profiles, pairing for a named person, removal that revokes their phones.
3. Access control: done. Members are refused by default; another person's session is reported as not found.
4. Separate live data: done. Snapshots, live output, prompts, pushes and Live Activities per person.
5. Her session settings: done for new sessions, restore and crash revival, the system prompt, the reserved computer and
   no approval prompts. Waking an existing session goes back to the computer it ran on (`wakeInstance` keeps the
   session's remote location; read, not live-tested); it has no way back to this Mac.
6. Screens: done (Settings > Mobile > People, the name on her sessions in the desktop list, and the phone app's member
   view). All text follows `docs/screen-and-wording-guide.md`.
7. Setup (Tailscale limits, installing the app, pairing, push alerts): live checks 6 and 7 in the livetest.

## Checks

- Done: tests that a member is refused on every owner-only route and cannot read or control James's sessions by guessing
  an ID, including over the live connection; that her session starts only with the owner's settings and never on this Mac;
  that automatic placement and the browser computer choice never pick her computer; and the full project gates.
- A real run with a test second profile (her session cannot read `~/work/creds`; James's data never appears in her
  snapshot, pushes or system prompt): livetest check 4.

## Risks

- Her use counts against James's usage limits, and Harness can move her work between accounts unless her profile is
  locked to the SUAS ones. The lock is the account choice in People: only the ticked accounts are ever used.
- Her access depends on James's Harness running, because the gateway lives inside it. Quitting or restarting Harness,
  the Mac sleeping, or Tailscale being off on the Mac all cut her off.
- Step 1 may fail because of the Keychain. The fallback is a spare machine, or James's option c. Option c leaves her
  agents able to read most of James's files, so it needs his fresh agreement if it comes to that.
- Any phone route missed in step 3 stays closed, which is the safe way to fail.
- Tightening permissions on `~/work` could affect anything else that reads those folders as another user, including the
  `ctadmin` login. Check before changing them.
- Un-ticking an account in People does not move her existing conversations off it. A session keeps the account it
  runs on (`provider-account-routing-service.spec.ts`: "a live thread never moves"); only new sessions use the ticked
  accounts. Remove her or end her sessions to cut an account off at once.
- Her sessions' memory, helper agents and connectors are blocked by the checks listed above, not by the separate login,
  so a new way for an agent to reach the owner's memory or tools would need the same gate. Check 4 in the livetest asks
  her agent to try.
