# Edit Last Message: Fork-in-Place Resend

**Date:** 2026-03-21
**Status:** Approved
**Scope:** `input-panel.component.ts`, `instance-detail.component.ts`

## Problem

After sending a message to an AI instance, users often want to immediately tweak what they said — fix a typo, add context, or rephrase. Currently the only option is "Fork from here" via right-click context menu, which creates a separate instance. This is heavyweight for the common case of "I just sent this, let me fix it."

## Solution

**Press UP arrow to load the last user message into the input, edit it, press Enter to rewind the conversation and resend.** The rewind uses the existing `forkSession` machinery under the hood (fork at the message index, send edited text to the new instance, swap the UI, remove the old instance). The user sees a seamless conversation rewind.

## Design

### 1. Trigger: UP Arrow

UP arrow loads the last user message into the input when the cursor is at **position 0** (the very start of the text, or the input is empty). If the cursor is elsewhere in a multi-line input, UP moves the cursor normally (standard textarea behavior).

- Only loads the **last** user message. No cycling through history.
- Works regardless of whether the input has text or is empty.
- If the input has text, it is stashed as a draft before loading the last message.
- If there are no user messages in the output buffer, UP does nothing.

### 2. Edit Mode State

When UP successfully loads the last message, the input enters "edit mode" — a distinct state tracked by signals in `InputPanelComponent`:

| Signal | Type | Purpose |
|--------|------|---------|
| `editMode` | `signal(false)` | Whether the input is in edit mode |
| `stashedDraft` | `signal<string \| null>(null)` | Text that was in the input before UP was pressed, restored on cancel |
| `editMessageIndex` | `signal<number \| null>(null)` | Buffer index of the message being edited, used for fork truncation |

The cursor is placed at the end of the loaded text so the user can immediately start editing from the end.

### 3. Edit Mode Visual Indicator

A small info bar rendered above the textarea when `editMode()` is true:

- Text: **"Editing last message · Enter to resend · Esc to cancel"**
- Styled subtly — same visual weight as existing inline status indicators in the component. Uses existing design tokens (`--text-muted`, `--separator-color`, small monospace text).
- No modal, no overlay, no dramatic color shift.

### 4. Exiting Edit Mode

Three ways to exit:

| Action | Behavior |
|--------|----------|
| **Enter** (send) | Emit `resendEdited` event with `{ messageIndex, text }`. Parent handles fork+swap+send (see Section 5). Input clears, edit mode exits. |
| **Escape** | Cancel edit. Restore stashed draft to input (or empty string if no draft). Edit mode exits. |
| **DOWN** (cursor at end of text) | Same as Escape — cancel and restore draft. Only triggers when cursor is at the very end of the text, mirroring the UP trigger logic. |

### 5. Fork-in-Place: The Resend Mechanism

When the user sends the edited message, `InstanceDetailComponent` handles the `resendEdited` event:

1. **Fork** — Call `forkSession(instanceId, messageIndex)` via `HistoryIpcService`. This creates a new instance with conversation history truncated to just before the edited message. The existing fork machinery handles message deduplication and tool_use/tool_result pair preservation.
2. **Send** — Send the edited message text to the new instance via `InstanceMessagingStore.sendInput()`.
3. **Swap** — Select the new instance in the UI via `InstanceStore`. The user sees the conversation seamlessly rewind to the edit point.
4. **Cleanup** — Remove the old instance via `InstanceStore`. The old conversation is gone from the UI (it can still be recovered from session archives if needed, since the fork preserves the source).

This approach reuses the battle-tested `forkSession` path rather than building a new "rewind" capability in the instance lifecycle.

### 6. Finding the Last User Message

The input panel needs to find the last user message from the output buffer. The output buffer is owned by `OutputStreamComponent`, not the input panel. Two options:

**Approach:** The parent `InstanceDetailComponent` passes the output buffer (or a computed signal of the last user message info) to the input panel as an `input()`. The input panel reads it when UP is pressed. This avoids coupling the input panel directly to the output stream.

Specifically, add an `input()` to `InputPanelComponent`:
```typescript
lastUserMessage = input<{ text: string; bufferIndex: number } | null>(null);
```

The parent computes this from the output buffer and passes it down. When UP is pressed, the input panel reads `lastUserMessage()` to get the text and buffer index.

### 7. Edge Cases

- **Instance is busy:** UP still works (loads the message). If the user sends while busy, the edited message goes through the normal message queue. However, forking a busy instance may fail or produce unexpected results. **Guard:** If the instance is busy, show a brief warning in the edit bar ("Instance is busy — wait for it to finish before resending") and disable the send action while in edit mode. The user can still Escape to cancel.
- **Empty output buffer:** UP does nothing. No error, no feedback.
- **Last message has file attachments:** The text is loaded but attachments are not restored. This is acceptable — the user is editing the text, and re-attaching files is a separate action.
- **Rapid UP/Escape/UP:** Each UP press re-stashes the current input. If the user is already in edit mode and presses UP again, it's a no-op (already showing the last message).

## Files Changed

### `src/renderer/app/features/instance-detail/input-panel.component.ts`

**Component class changes:**
- Add `editMode = signal(false)` — tracks whether input is in edit mode
- Add `stashedDraft = signal<string | null>(null)` — preserves text that was in input before UP
- Add `editMessageIndex = signal<number | null>(null)` — buffer index for fork truncation
- Add `lastUserMessage = input<{ text: string; bufferIndex: number } | null>(null)` — provided by parent
- Add `resendEdited = output<{ messageIndex: number; text: string }>()` — emitted on send in edit mode
- Add `busyInstance = input(false)` — whether the instance is currently busy (disables send in edit mode)

**Keyboard handler changes (in `onKeyDown()`):**
- Add UP arrow handler: if cursor at position 0 and `lastUserMessage()` exists, enter edit mode
- Add DOWN arrow handler: if in edit mode and cursor at end of text, cancel edit mode
- Add Escape handler: if in edit mode, cancel edit mode and restore draft
- Modify Enter handler: if in edit mode, emit `resendEdited` instead of `sendMessage`

**Template changes:**
- Add edit mode indicator bar above the textarea (conditionally rendered via `@if (editMode())`)

**Style changes:**
- Add `.edit-mode-bar` styling — subtle background, small text, matches existing component aesthetic

### `src/renderer/app/features/instance-detail/instance-detail.component.ts`

**Template changes:**
- Pass `lastUserMessage` input to `<app-input-panel>` — computed from output buffer
- Pass `busyInstance` input — computed from `inst.status === 'busy'`
- Bind `(resendEdited)` output event to handler

**Component class changes:**
- Add `lastUserMessage` computed signal — scans output buffer for last user message, returns `{ text, bufferIndex }`
- Add `onResendEdited(event: { messageIndex: number; text: string })` handler — implements fork+send+swap+cleanup flow

## Testing

### Unit Tests

- UP at position 0 with empty input → enters edit mode, loads last message
- UP at position 0 with existing text → stashes draft, loads last message
- UP with no user messages in buffer → no-op
- UP when cursor is not at position 0 → no-op (normal cursor movement)
- Escape in edit mode → restores stashed draft, exits edit mode
- DOWN at end of text in edit mode → restores stashed draft, exits edit mode
- Enter in edit mode → emits `resendEdited` with correct messageIndex and text
- Enter in edit mode while instance is busy → blocked (no emit)
- Repeated UP in edit mode → no-op

### Manual Testing

1. Send a message → press UP → verify last message loads with edit bar visible
2. Edit the text → press Enter → verify conversation rewinds and new message is sent
3. Press UP → press Escape → verify original draft is restored
4. Type a draft → press UP → verify draft is stashed → Escape → verify draft is restored
5. With cursor in middle of multi-line text → press UP → verify normal cursor movement (no edit mode)

## Out of Scope

- Cycling through message history (UP/DOWN for older messages)
- Editing messages other than the last user message
- Restoring file attachments from the edited message
- Inline message editing in the output stream (click to edit)
- Undo after resend (the old instance is removed; session archives provide recovery)
