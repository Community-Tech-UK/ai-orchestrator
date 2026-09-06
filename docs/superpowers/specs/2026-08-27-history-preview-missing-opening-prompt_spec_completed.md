# History Preview Missing Opening Prompt Specification

## Status

Completed. Claude history archives with a missing native opening prompt are repaired with provider-safe ownership checks, and history previews no longer query live storage with synthetic IDs.

## Problem

The affected history entry is linked to a native Claude session whose first user prompt still exists on disk. Its Harness archive contains exactly the bounded 1,000-message window, begins later with subagent/tool activity, and has no copy of the native opening prompt. The history preview also supplies a synthetic `history-preview:*` identifier to `OutputStreamComponent` without a custom older-message probe, so the component queries live instance output storage for an identifier that cannot exist.

The current native repair accepts legacy-redacted archives and strict transcript tails. The affected archive is not a strict tail because app-captured subagent activity is absent from the root native transcript.

## Required Behaviour

1. For an existing app-owned Claude history entry with the same provider session ID as a native transcript, repair the archive when the native opening user prompt is absent from every archived user message.
2. Use the parsed native transcript as the repaired transcript, consistent with the existing strict-tail repair path.
3. Create a one-time backup with a repair-specific suffix before overwriting the archive.
4. Refresh `messageCount`, first/last user previews, timestamps, working directory, and snippets from the native transcript while preserving app-owned entry identity and metadata.
5. Leave a healthy archive untouched when it contains the native opening prompt, even if message IDs or other transcript details differ.
6. History preview rendering must not query live instance output storage with its synthetic preview ID. It must report that the already-loaded history conversation has no separate older live-storage page.
7. The real affected history entry must show the recovered opening prompt after restart/rebuild.

## Non-Goals

- Do not introduce paginated history-file storage; history IPC already loads the complete archive.
- Do not merge subagent-only app stream events into the authoritative native transcript during repair.
- Do not repair non-Claude providers or native transcript files that cannot be tied to an existing app entry by provider session ID.
- Do not alter unrelated history restore, fork, or live-instance pagination behaviour.

## Verification

- Rebuild/restart the development app and confirm the affected history preview begins with the recovered user prompt.
- Confirm the history preview does not issue an `INSTANCE_LOAD_OLDER_MESSAGES` request for a `history-preview:*` ID.
- Add regression coverage for a non-tail archive missing the native opening prompt, the backup and metadata update, a healthy archive that remains unchanged, and the preview-specific no-older-page probe.
- Run targeted specs and the repository's canonical verification checklist.

## Implementation Plan

[Completed History Preview Missing Opening Prompt Implementation Plan](../plans/2026-08-27-history-preview-missing-opening-prompt_plan_completed.md)

## As-Built Result

All required behaviours are implemented and verified. The affected live archive now begins with the recovered opening prompt, retains a one-time backup of the previous bounded archive, and preserves its app-owned identity. An isolated rebuilt Electron preview rendered the repaired transcript without a misleading earlier-message control. The canonical verification checklist and a fresh independent completion gate passed.
