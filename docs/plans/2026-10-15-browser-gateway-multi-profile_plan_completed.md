# Browser Gateway: many Chrome profiles on one machine

Status: completed 2026-10-15; re-reviewed and hardened 2026-10-16. Live checks are deferred to
[2026-10-15-browser-gateway-multi-profile_livetest.md](2026-10-15-browser-gateway-multi-profile_livetest.md).

## Completion notes (as built)

- Implemented as designed below. Instance routing lives in
  `browser-extension-instance-routing.ts`; local RPC payload helpers live in
  `browser-extension-rpc-payloads.ts`; pre-delivery tracking moved beside delivery health. All
  were moved out to keep the files within their size ceilings.
- Final gates (2026-10-15): `tsc --noEmit` (app and worker), `typecheck:spec`, `lint`,
  `check:ts-max-loc`, `build:main`, `build:worker-agent` and `build:renderer` all exit 0.
  `test:quiet`: 2,535 files, 32,361 tests passed. One earlier full run had a single
  timing failure in `codex-exec-native-outcome.spec.ts`. That is outside this change, in
  another session's in-progress codex work; it passed 3 of 3 runs in isolation and on the
  clean rerun.
- Five fresh-eyes reviews; the fifth passed. Each actionable finding was fixed, and the tests
  added for it were mutation-checked (they fail with the fix removed).
- Not committed. Committing, pushing, rebuilding Harness and updating windows-pc need
  James's go-ahead.

## Problem

James runs two Chrome profiles on `windows-pc`, both with the Harness extension. Browser
Gateway only worked once he switched the extension off in one of them.

Nothing between the extension and the coordinator identifies which Chrome profile sent a
message. Every per-machine structure therefore mixes the profiles:

1. **One command queue per machine** (`node:<id>`, or `local`). Every profile's extension
   long-polls it and any poller takes any command, so a command for a tab in profile A is
   handed to profile B. B cannot see the tab and fails with a raw Chrome error, while
   `close_tab` reports `alreadyClosed` success and the coordinator detaches a tab that is
   still open. Reproduced in a unit test.
2. **One runtime-trust record per machine.** `BrowserExtensionContactState` keeps a single
   service-worker generation watermark per node. The profile whose service worker started
   later owns the watermark, so the other profile's evidence is ignored. When the newer
   profile's native host disconnects, the generation is tombstoned and the older profile is
   refused (`browser_extension_runtime_incompatible`) until the newer one returns. This was
   reproduced in a unit test, and the coordinator log shows the same rejections on
   `windows-pc` at 14:58 today.
3. **Tab suspension is node-wide.** One profile that fails the runtime check suspends every
   tab on the machine, and the next good poll restores them all, so the state flaps.
4. **`open_tab` / `report_inventory` reach one arbitrary profile.** Inventory refresh and the
   secret-protection push only reach whichever profile polls first.

## Design

Give each extension install (one per Chrome profile) a stable random **extension
instance id**, generated once and kept in `chrome.storage.local`, which Chrome keeps
separate for each profile. Stamp it on every native message beside `extensionVersion` and
`extensionStartedAt`, carry it through the native host and the worker relay, and use it on
the coordinator as follows:

- **Routing.** Attachments record their instance. Commands for an attachment carry
  `target.extensionInstanceId`. The command store only hands a bound command to a poller
  from the same instance, and does not let one bound command block others from being
  delivered. Unbound commands (`open_tab`, legacy) go to any capable poller, and the store
  reports which instance took the command so `open_tab` attaches its new tab correctly.
- **Trust per instance.** Contact state keys runtime generations by node plus instance. A
  disconnect carrying an instance tombstones only that instance. A node-wide drop (worker
  WebSocket closed, legacy host) still tombstones all of them. The per-poll credential
  gate uses the polling instance's own evidence. Queries that give no instance use the
  most recently contacted instance, which is exactly the old behaviour.
- **Tab identity.** When the instance is known, the profile id becomes
  `existing-tab:n.<node>:p.<instance>:<window>:<tab>`, or `existing-tab:p.<instance>:…`
  locally. This keeps `existingTabGrantNodeId` parsing intact, so grants and credential
  scopes stay per machine. A legacy id for the same window and tab is replaced and reported
  as rebound when the instance-aware attach arrives (one-time upgrade). Suspend, restore
  and rebound are scoped to the instance for polls that carry one. An id-less poll (an
  extension older than 0.2.42) still acts on the whole node.
- **Id-less polls speak only for id-less tabs.** An incompatible poll without an id (an
  extension older than 0.2.42) suspends and restores only attachments without an id, so an
  old profile cannot flap a current profile's tabs. Only a node drop (`expireNode`) acts on
  the whole node.
- **Local rate limits per profile and traffic class.** The Mac's local RPC server keyed
  its 30-requests-per-10s budget by extension origin, which every profile shares, and tab
  reports (one RPC per tab, up to 40 per inventory) spent the same budget as polls. So even
  one profile with more than 30 tabs lost tab reports, and polls in that window, which was
  reproduced in a test. Budgets are now per profile, with tab reports in their own bucket
  (120 per 10s; byte cap unchanged). The bucket map is bounded: once it reaches 256 live
  buckets, idle ones are swept, and a caller still creating keys is refused.
- **Unanswered-command health per instance.** Delivery outcomes are recorded against the
  instance that took the command. A tab command checks its own profile's history, so a
  wedged profile (polling but not executing) no longer blocks a healthy one. Machine-level
  readers (health, open-tab prechecks) report unanswered only when every profile that has
  history is unanswered.
- **Fan-out.** Inventory refresh and the secret-protection push send one bound command to
  each instance seen polling recently, so every profile reports. A queue with zero or one
  recent instance keeps today's single unbound command.
- **Unbound refusals wait for a working profile.** An unbound command is not refused through
  an incapable profile's poll while another profile polled capably within 30s. It waits for
  that profile instead.
- **Extension safety net.** The extension refuses a command whose
  `target.extensionInstanceId` names a different instance
  (`browser_extension_wrong_profile`). A coordinator routing bug then cannot act on a
  same-numbered tab in another profile.
- **Relay health.** The worker relay updates `extensionReloadedAt` only when a given
  instance restarts or a new instance appears. Interleaved polls from two profiles no
  longer inflate the "service worker restarts" counter.

### Compatibility

- An old extension sends no instance id, so it gets exactly today's behaviour.
- The native host and the relay ship in the same worker bundle. On the Mac, the native host
  and the RPC server ship in the same app. An old native host drops the new top-level field.
  The new relay strips it from the tab payload before the strict attach schema sees it.
- An old coordinator receiving the field from a new relay ignores it. The relay router
  validates params but passes the raw params on, and the old bridge reads only named
  fields, never the new top-level one.
- A new native host behind a not-yet-restarted old relay leaves the id inside the tab
  payload. The coordinator's attach schema and bridge drop a nested id, so that node stays
  on pre-id behaviour, consistent with its id-less polls, until the relay restarts.

### Known limits (accepted)

- Freshness stays per machine. A command for a tab in a profile that closed without its
  native host reporting EOF waits out the undelivered budget (90s), then fails as
  `not_delivered`. The superseded sweep removes that profile's tabs about 10 minutes later.
- `open_tab` with no target opens in whichever working profile polls first. There is no
  profile preference yet.
- After the upgrade, a *session* (non-persistent) shared-tab grant or a pending saved-login
  request made before it names the old id-less tab id, so it needs one fresh approval.
  Persistent grants and credential authorizations are per machine and survive.
- Reinstalling the unpacked extension in a profile mints a new id; that profile's old-id
  tabs linger as duplicates until the superseded sweep (~10 minutes).
- Copying a Chrome profile folder also copies the stored id, so the two copies would act as
  one profile. Chrome's own "add profile" creates a fresh one.
- Update order: the coordinator should be updated before (or with) the worker. An *old*
  coordinator receiving a tab report from a new native host behind a not-yet-restarted
  old relay rejects that report until the relay restarts. Polls and commands are
  unaffected.
- Some machine-level summaries still merge profiles: the pre-delivery capability
  (`commandsDeliverable`), the secret-observation report (last profile to report wins), and
  the relay's reported extension version (last profile to poll wins). These are display and
  diagnosis only; routing and trust are per profile. The machine-level freshness used by
  open-tab and stale-flag checks follows the "unanswered only when every profile with
  history is unanswered" rule, so a healthy profile with no command history yet cannot open a
  tab while another profile is wedged, until it answers once or `browser.recover_extension`
  runs.
- The stale flag on `list_targets` entries and `browser.recover_extension` still read
  machine-level delivery health, because a listed target does not carry its profile. A
  wedged profile next to one that has answered shows as healthy there; that profile's own
  tab commands still fail with `commands_unanswered`. Per-tab prechecks (commands,
  find-or-open on an existing tab, the challenge probe) are per profile.
- A trust check for an id-less poll reads the most recently seen profile's record (the poll's
  own version evidence is still checked). This only matters on a machine mixing an
  extension older than 0.2.42 with a new one.
- Mixed versions on one machine (one profile below 0.2.42, one on 0.2.42): the old profile's
  tabs carry no id, so their commands are unbound and any working profile's poll may take
  them, as today. Chrome tab ids are unique within one Chrome process, so in practice this
  fails cleanly rather than touching another tab. Updating every profile removes it.
- Install ids are only bounded by their format. If extension storage failed on every start,
  each service-worker restart would mint a new id and the per-instance maps would grow
  slowly until the node is forgotten.
- The fan-out helpers take the recent-instance lookup as optional. A store passed without
  it falls back to one unbound command, which is today's behaviour. The real store
  provides it.

## Steps

- [x] Contracts and schemas: `extensionInstanceId` in the relay evidence schema and the
      command target type
- [x] Extension: generate, persist and stamp the instance id; add the wrong-profile guard;
      bump the manifest to 0.2.42 and add a bundle-history entry
- [x] Native host: parse and forward the id; remember the last evidence for the disconnect
      signal
- [x] Worker relay: forward and strip the id; per-instance restart tracking
- [x] Contact state: per-instance runtime generations; scoped disconnect
- [x] Command store: instance-aware dispatch, delivery-instance reporting, recent-instance
      listing
- [x] Tab store: instance-aware ids, legacy-id migration, scoped suspend, restore and rebound
- [x] Remote bridge and local RPC server: thread the instance through contact, poll, attach
      and disconnect
- [x] Command senders: add the instance to every attachment-targeted command; `open_tab`
      attaches with the delivering instance
- [x] Fan-out for inventory refresh and the secret-protection push
- [x] Tests for each layer, including the two reproductions as regression tests
- [x] Full gates and a fresh-eyes completion review. Review 1 returned FAIL with 4
      should-fix items and some nits, all addressed: the wrong-profile refusal was
      mislabelled as "may have applied", the relay reload time was lost after a disconnect,
      two credential pre-checks read the last-polled profile, there was a lint issue, and
      the notes covered the unbound-refusal wait, the storage-read overwrite and relay skew.
      Review 2 returned FAIL with 2 should-fix items: no tests pinned the tab's profile
      in the credential checks, and one wedged profile could make a healthy profile's tabs
      unusable. Both fixed, the second with per-instance delivery health; all the
      tests were mutation-checked. Its nits were addressed or recorded under Known limits.
      Review 3 found no logic defects and one should-fix test gap: the timer-driven
      unanswered paths (the receipt window and the execution timeout) were not pinned per
      profile. Fixed with mutation-checked tests. Nits were fixed (a vanished tab now fails
      the fill pre-check closed; a dispatch comment was corrected) or recorded above.
      Review 4 found no logic defects and 2 should-fix test gaps: re-attach and the
      safety reads (sentinel scan, timeout probe) were not pinned to the profile, and the
      skew rule was not tested through the real Zod schema. Both closed with
      mutation-checked tests. Nits fixed: per-profile find-or-open and challenge-probe
      prechecks, the extension awaits its id on every bridge start or reconnect, the tab
      store normalizes ids itself, a catch on the protection fan-out, and corrected
      comments and live-test wording. The rest are recorded above.
      Review 5: **VERDICT: PASS**, no blocking or should-fix findings. Its nits were
      addressed: a moved comment and the two Known-limit entries above.
- [x] 2026-10-16 end-to-end flow review (James asked for a fresh-eyes check). Unlike the earlier
      diff reviews, it traced the real flows across every layer under varied input states,
      and it passed. Two should-fix items were fixed after reproducing each in a test that
      failed first: the local rate limit, and an old id-less profile flapping a current
      profile's tabs. Both are described under Design. Its nits on session-grant
      re-approval and reinstall duplicates were recorded under Known limits. Separately
      checked: the longest new ids (~147 characters) fit every 200-character id schema.
- [x] Fresh review of those two fixes: **PASS**. Its should-fix items were addressed: the bucket
      map is now bounded (mutation-checked test), and there are new real-store tests for
      `null`-scoped suspend/restore and for a node drop followed by per-profile restore.
- [x] Fresh review of that final delta: **PASS**. Its nit was taken: the extension origin is
      capped at 200 characters in the bucket key.
- [x] Gates on 2026-10-16: `tsc` (app and worker), `typecheck:spec`, `lint`,
      `check:ts-max-loc`, `build:main`, `build:worker-agent` and `build:renderer` all exit 0.
      The full `test:quiet` run passed 32,459 of 32,460. The one failure was
      `orchestrator-host-process-tools.spec.ts`, a new untracked file from another session's
      in-progress work, which passes 3 of 3 in isolation. Earlier runs that day showed one
      similar unrelated flake each (`worktree-port.spec.ts`, which collided with a concurrent
      suite run), also 3 of 3 in isolation. After the final one-line origin cap, the
      rpc-server spec, `tsc`, `lint`, `check:ts-max-loc` and `build:main` were rerun and pass.
- [x] Gates after review 5: `tsc` (app and worker), `typecheck:spec`, `lint`,
      `check:ts-max-loc`, `build:main`, `build:worker-agent`, `build:renderer` and
      `test:quiet` (see the completion notes).
- [x] Live check on `windows-pc` with two profiles deferred to
      [2026-10-15-browser-gateway-multi-profile_livetest.md](2026-10-15-browser-gateway-multi-profile_livetest.md).
      It needs a rebuilt coordinator, an updated worker and extension 0.2.42 in both profiles.
