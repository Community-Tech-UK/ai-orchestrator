# Edit Last Message: Fork-in-Place Resend

**Date:** 2026-03-21
**Status:** Approved
**Scope:** `input-panel.component.ts`, `instance-detail.component.ts`

## Problem

After sending a message to an AI instance, users often want to immediately tweak what they said — fix a typo, add context, or rephrase. Currently the only option is "Fork from here" via right-click context menu, which creates a separate instance. This is heavyweight for the common case of "I just sent this, let me fix it."

## Solution

**Press UP arrow to load the last user message into the input, edit it, press Enter to rewind the conversation and resend.** The rewind uses the existing `forkSession` machinery under the hood (fork at the message index, send edited text to the new instance, swap the UI, terminate the old instance). The user sees a seamless conversation rewind.

## Design

### 1. Trigger: UP Arrow

UP arrow loads the last user message into the input when the cursor is at **position 0** (the very start of the text, or the input is empty). If the cursor is elsewhere in a multi-line input, UP moves the cursor normally (standard textarea behavior).

- Only loads the **last** user message. No cycling through history.
- Works regardless of whether the input has text or is empty.
- If the input has text, it is stashed as a draft before loading the last message.
- If there are no user messages in the output buffer, UP does nothing.
- The UP handler must be placed **after** the existing command suggestion and ghost text guards in `onKeyDown()`, so those features take priority when active.

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

- Default text: **"Editing last message · Enter to resend · Esc to cancel"**
- When instance is busy: **"Instance is busy — wait for completion before resending · Esc to cancel"** (send action is visually disabled)
- Styled subtly — same visual weight as existing inline status indicators in the component. Uses existing design tokens (`--text-muted`, `--separator-color`, small monospace text).
- No modal, no overlay, no dramatic color shift.

### 4. Exiting Edit Mode

Two ways to exit:

| Action | Behavior |
|--------|----------|
| **Enter** (send) | Emit `resendEdited` event with `{ messageIndex, text }`. Parent handles fork+swap+send (see Section 5). Input clears, edit mode exits. If the edited text is empty after trimming, Enter is a no-op (the existing `canSend()` guard applies in edit mode). |
| **Escape** | Cancel edit. Restore stashed draft to input (or empty string if no draft). Edit mode exits. |

### 5. Fork-in-Place: The Resend Mechanism

When the user sends the edited message, `InstanceDetailComponent` handles the `resendEdited` event:

1. **Fork** — Call `this.ipc.forkSession(instanceId, messageIndex)` via the existing `ElectronIpcService` injection (`this.ipc`). The `messageIndex` is passed directly as `atMessageIndex`, which uses exclusive indexing (keeps messages 0 through messageIndex-1). This truncates to just before the last user message, which is exactly what we want. The existing fork machinery handles message deduplication and tool_use/tool_result pair preservation.
2. **Send** — Send the edited message text to the new instance via `this.store.sendInput(newInstanceId, editedText)`, consistent with how the existing `onSendMessage()` method works.
3. **Swap** — Select the new instance via `this.store.setSelectedInstance(newInstanceId)`. The `forkSession` IPC response includes the new instance data and the store is updated synchronously in the handler (consistent with how `OutputStreamComponent.forkFromMessage()` calls `this.instanceStore.setSelectedInstance(data.id)` immediately after the fork response).
4. **Cleanup** — Terminate the old instance via `this.store.terminateInstance(oldInstanceId)`. This kills the CLI process and triggers the `onInstanceRemoved` listener for store cleanup. The old conversation can still be recovered from session archives if needed, since the fork preserves the source.

This approach reuses the battle-tested `forkSession` path rather than building a new "rewind" capability in the instance lifecycle.

### 6. Finding the Last User Message

The input panel needs to find the last user message from the output buffer. The input panel already receives the output buffer via its existing `outputMessages = input<OutputMessage[]>([])` input, which the parent binds as `[outputMessages]="inst.outputBuffer"`.

**Approach:** Compute `lastUserMessage` as a `computed()` signal inside `InputPanelComponent`, derived from the existing `outputMessages` input:

```typescript
private lastUserMessage = computed(() => {
  const msgs = this.outputMessages();
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].type === 'user') {
      return { text: msgs[i].content, bufferIndex: i };
    }
  }
  return null;
});
```

This avoids adding a new input or coupling the parent to the edit-mode feature. When UP is pressed, the input panel reads `lastUserMessage()` to get the text and buffer index.

### 7. Edge Cases

- **Instance is busy:** UP still works (loads the message). If the instance is busy (`isBusy()` — the existing input on `InputPanelComponent`), the edit bar shows a busy warning and send is disabled. The user can still Escape to cancel.
- **Empty output buffer:** UP does nothing. No error, no feedback.
- **Empty message after editing:** If the user loads the last message, deletes all the text, and presses Enter, it's a no-op — the existing `canSend()` guard applies in edit mode.
- **Conversation loss after edit point:** The last user message may not be the last message in the buffer — assistant responses, tool_use, and tool_result messages may follow it. Forking at the user message's buffer index correctly excludes all subsequent messages. The user loses all conversation after the edit point. This is the expected behavior (the spec title says "rewind") and is consistent with how "Fork from here" works in the context menu.
- **Last message has file attachments:** The text is loaded but attachments are not restored. This is acceptable — the user is editing the text, and re-attaching files is a separate action.
- **Rapid UP/Escape/UP:** Each UP press re-stashes the current input. If the user is already in edit mode and presses UP again, it's a no-op (already showing the last message).

## Files Changed

### `src/renderer/app/features/instance-detail/input-panel.component.ts`

**Component class changes:**
- Add `editMode = signal(false)` — tracks whether input is in edit mode
- Add `stashedDraft = signal<string | null>(null)` — preserves text that was in input before UP
- Add `editMessageIndex = signal<number | null>(null)` — buffer index for fork truncation
- Add `lastUserMessage` private computed — scans existing `outputMessages` input for last user message, returns `{ text, bufferIndex }` or null
- Add `resendEdited = output<{ messageIndex: number; text: string }>()` — emitted on send in edit mode

**Keyboard handler changes (in `onKeyDown()`):**
- Add UP arrow handler **after** existing command suggestion and ghost text guards: if cursor at position 0 and `lastUserMessage()` exists, enter edit mode
- Add Escape handler: if in edit mode, cancel edit mode and restore draft
- Modify Enter handler: if in edit mode and `canSend()` and not `isBusy()`, emit `resendEdited` instead of `sendMessage`

**Template changes:**
- Add edit mode indicator bar above the textarea (conditionally rendered via `@if (editMode())`)
- Bar text changes based on `isBusy()` state

**Style changes:**
- Add `.edit-mode-bar` styling — subtle background, small text, matches existing component aesthetic

### `src/renderer/app/features/instance-detail/instance-detail.component.ts`

**Template changes:**
- Bind `(resendEdited)` output event to handler on `<app-input-panel>`

**Component class changes:**
- Add `onResendEdited(event: { messageIndex: number; text: string })` handler — implements fork+send+swap+cleanup flow using `this.ipc.forkSession()`, `this.store.sendInput()`, `this.store.setSelectedInstance()`, and `this.store.terminateInstance()`

## Testing

### Unit Tests (InputPanelComponent logic)

- UP at position 0 with empty input → enters edit mode, loads last message
- UP at position 0 with existing text → stashes draft, loads last message
- UP with no user messages in buffer → no-op
- UP when cursor is not at position 0 → no-op (normal cursor movement)
- Escape in edit mode → restores stashed draft, exits edit mode
- Enter in edit mode → emits `resendEdited` with correct messageIndex and text
- Enter in edit mode while instance is busy → blocked (no emit)
- Enter in edit mode with empty text → blocked (canSend guard)
- Repeated UP in edit mode → no-op
- `lastUserMessage` computed returns last user-type message from outputMessages

### Unit Tests (InstanceDetailComponent logic)

- `onResendEdited` calls fork → send → swap → cleanup in order
- `onResendEdited` handles fork failure gracefully (no swap/cleanup if fork fails)
- `onResendEdited` is blocked when instance is busy

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
- Undo after resend (the old instance is terminated; session archives provide recovery)
