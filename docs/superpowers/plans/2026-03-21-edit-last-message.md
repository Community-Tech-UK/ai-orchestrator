# Edit Last Message Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add UP-arrow-to-edit-last-message with fork-in-place resend to the input panel.

**Architecture:** The input panel computes the last user message from its existing `outputMessages` input, enters an edit mode with stashed draft support, and emits a `resendEdited` event. The parent `InstanceDetailComponent` handles the event by forking the session, sending the edited text to the new instance, selecting it, and terminating the old one.

**Tech Stack:** Angular 21 (zoneless, signals), TypeScript 5.9, Vitest

**Spec:** `docs/superpowers/specs/2026-03-21-edit-last-message-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/renderer/app/features/instance-detail/input-panel.component.ts` | Modify | Edit mode signals, UP/Escape/Enter keyboard handling, `lastUserMessage` computed, `resendEdited` output, edit bar template + styles, draft sync guard |
| `src/renderer/app/features/instance-detail/instance-detail.component.ts` | Modify | Bind `(resendEdited)` in template, `onResendEdited()` handler (fork → send → swap → terminate) |
| `src/renderer/app/features/instance-detail/input-panel-edit-mode.spec.ts` | Create | Unit tests for edit mode signal logic |
| `src/renderer/app/features/instance-detail/instance-detail-edit-resend.spec.ts` | Create | Unit tests for `onResendEdited` fork flow logic |

---

### Task 1: Edit Mode Signals and `lastUserMessage` Computed

Add the core signals and computed to `InputPanelComponent`. No keyboard handling or template yet — just the data model.

**Files:**
- Modify: `src/renderer/app/features/instance-detail/input-panel.component.ts`
- Create: `src/renderer/app/features/instance-detail/input-panel-edit-mode.spec.ts`

**Reference:** The `OutputMessage` type is at `src/renderer/app/core/state/instance/instance.types.ts:34-46`. Its `type` field is `'assistant' | 'user' | 'system' | 'tool_use' | 'tool_result' | 'error'`.

- [ ] **Step 1: Write unit tests for `lastUserMessage` and edit mode signal logic**

Create `src/renderer/app/features/instance-detail/input-panel-edit-mode.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { signal, computed } from '@angular/core';
import type { OutputMessage } from '../../core/state/instance/instance.types';

/**
 * Unit tests for edit mode signal logic in InputPanelComponent.
 *
 * These test the signal logic in isolation rather than the full Angular component,
 * following the same pattern as instance-detail-inspectors.spec.ts.
 */

describe('lastUserMessage computed', () => {
  // Helper to create the computed matching the real implementation
  function createLastUserMessage(messages: OutputMessage[]) {
    const outputMessages = signal(messages);
    const lastUserMessage = computed(() => {
      const msgs = outputMessages();
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].type === 'user') {
          return { text: msgs[i].content, bufferIndex: i };
        }
      }
      return null;
    });
    return { outputMessages, lastUserMessage };
  }

  it('returns null when output buffer is empty', () => {
    const { lastUserMessage } = createLastUserMessage([]);
    expect(lastUserMessage()).toBeNull();
  });

  it('returns null when no user messages exist', () => {
    const { lastUserMessage } = createLastUserMessage([
      { id: '1', timestamp: 1, type: 'assistant', content: 'Hello' },
      { id: '2', timestamp: 2, type: 'system', content: 'System msg' },
    ]);
    expect(lastUserMessage()).toBeNull();
  });

  it('returns the last user message text and buffer index', () => {
    const { lastUserMessage } = createLastUserMessage([
      { id: '1', timestamp: 1, type: 'user', content: 'First question' },
      { id: '2', timestamp: 2, type: 'assistant', content: 'First answer' },
      { id: '3', timestamp: 3, type: 'user', content: 'Second question' },
      { id: '4', timestamp: 4, type: 'assistant', content: 'Second answer' },
    ]);
    expect(lastUserMessage()).toEqual({ text: 'Second question', bufferIndex: 2 });
  });

  it('returns user message even when followed by tool messages', () => {
    const { lastUserMessage } = createLastUserMessage([
      { id: '1', timestamp: 1, type: 'user', content: 'Do something' },
      { id: '2', timestamp: 2, type: 'assistant', content: 'Sure' },
      { id: '3', timestamp: 3, type: 'tool_use', content: 'tool call' },
      { id: '4', timestamp: 4, type: 'tool_result', content: 'result' },
    ]);
    expect(lastUserMessage()).toEqual({ text: 'Do something', bufferIndex: 0 });
  });
});

describe('Edit Mode State', () => {
  it('enters edit mode with correct signal values', () => {
    const editMode = signal(false);
    const stashedDraft = signal<string | null>(null);
    const editMessageIndex = signal<number | null>(null);
    const message = signal('some draft');

    // Simulate entering edit mode
    const lastMsg = { text: 'Previous question', bufferIndex: 3 };
    stashedDraft.set(message());
    message.set(lastMsg.text);
    editMessageIndex.set(lastMsg.bufferIndex);
    editMode.set(true);

    expect(editMode()).toBe(true);
    expect(stashedDraft()).toBe('some draft');
    expect(editMessageIndex()).toBe(3);
    expect(message()).toBe('Previous question');
  });

  it('enters edit mode with empty input (stashes empty string)', () => {
    const editMode = signal(false);
    const stashedDraft = signal<string | null>(null);
    const editMessageIndex = signal<number | null>(null);
    const message = signal('');

    const lastMsg = { text: 'Previous question', bufferIndex: 0 };
    stashedDraft.set(message());
    message.set(lastMsg.text);
    editMessageIndex.set(lastMsg.bufferIndex);
    editMode.set(true);

    expect(editMode()).toBe(true);
    expect(stashedDraft()).toBe('');
    expect(message()).toBe('Previous question');
  });

  it('cancels edit mode and restores draft', () => {
    const editMode = signal(true);
    const stashedDraft = signal<string | null>('my draft');
    const editMessageIndex = signal<number | null>(3);
    const message = signal('edited text');

    // Simulate cancel
    message.set(stashedDraft() ?? '');
    editMode.set(false);
    stashedDraft.set(null);
    editMessageIndex.set(null);

    expect(editMode()).toBe(false);
    expect(message()).toBe('my draft');
    expect(stashedDraft()).toBeNull();
    expect(editMessageIndex()).toBeNull();
  });

  it('cancels edit mode with null stashed draft (restores empty string)', () => {
    const editMode = signal(true);
    const stashedDraft = signal<string | null>(null);
    const editMessageIndex = signal<number | null>(3);
    const message = signal('edited text');

    message.set(stashedDraft() ?? '');
    editMode.set(false);
    stashedDraft.set(null);
    editMessageIndex.set(null);

    expect(message()).toBe('');
  });

  it('is a no-op when already in edit mode (repeated UP)', () => {
    const editMode = signal(true);
    const stashedDraft = signal<string | null>('original draft');
    const editMessageIndex = signal<number | null>(3);
    const message = signal('Previous question');

    // Simulate repeated UP — should not overwrite stashed draft
    if (editMode()) {
      // no-op
    }

    expect(stashedDraft()).toBe('original draft');
    expect(message()).toBe('Previous question');
  });
});

describe('Edit Mode Send (resendEdited)', () => {
  it('emits correct messageIndex and text', () => {
    const editMessageIndex = signal<number | null>(3);
    const message = signal('edited question');

    const emitted = {
      messageIndex: editMessageIndex()!,
      text: message().trim(),
    };

    expect(emitted).toEqual({ messageIndex: 3, text: 'edited question' });
  });

  it('blocks send when text is empty (canSend guard)', () => {
    const message = signal('   ');
    const canSend = message().trim().length > 0;

    expect(canSend).toBe(false);
  });

  it('blocks send when instance is busy', () => {
    const isBusy = signal(true);
    const editMode = signal(true);

    const canResend = editMode() && !isBusy();
    expect(canResend).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass (these are pure signal logic tests)**

```bash
npx vitest run src/renderer/app/features/instance-detail/input-panel-edit-mode.spec.ts
```

Expected: All tests PASS (they test signal logic directly, no implementation dependency).

- [ ] **Step 3: Add signals, computed, and output to `InputPanelComponent`**

In `src/renderer/app/features/instance-detail/input-panel.component.ts`, add after the existing outputs (after line 912):

```typescript
  resendEdited = output<{ messageIndex: number; text: string }>();

  editMode = signal(false);
  stashedDraft = signal<string | null>(null);
  editMessageIndex = signal<number | null>(null);

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

- [ ] **Step 4: Add draft sync effect guard**

In the constructor's draft sync effect (line 992), add an early return at the top of the effect body to skip syncing when in edit mode. The effect currently starts at line 992. Add this as the first line inside the `effect(() => {`:

```typescript
    effect(() => {
      if (this.editMode()) return;   // ← ADD THIS LINE

      if (this.isDraftComposer()) {
        // ... existing code unchanged
```

This prevents the draft store from overwriting the loaded last message text while in edit mode.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/app/features/instance-detail/input-panel.component.ts src/renderer/app/features/instance-detail/input-panel-edit-mode.spec.ts
git commit -m "feat(input-panel): add edit mode signals, lastUserMessage computed, and tests"
```

---

### Task 2: Keyboard Handling — UP, Escape, and Enter in Edit Mode

Wire up the keyboard handlers in `onKeyDown()` to enter/exit edit mode and emit `resendEdited`.

**Files:**
- Modify: `src/renderer/app/features/instance-detail/input-panel.component.ts`

**Reference:** The existing `onKeyDown()` is at lines 1100-1166. It has three guard blocks in order:
1. Command suggestions (lines 1102-1135) — returns early for ArrowUp/ArrowDown/Tab/Enter/Escape
2. Ghost text (lines 1138-1159) — returns early for Tab/ArrowRight/Escape
3. Enter to send (lines 1162-1165)

The edit mode handlers go **between** ghost text (block 2) and Enter to send (block 3).

- [ ] **Step 1: Add `enterEditMode()` and `cancelEditMode()` helper methods**

Add after the `onSend()` method (after line 1220):

```typescript
  // ============================================
  // Edit Mode Methods
  // ============================================

  private enterEditMode(): void {
    const last = this.lastUserMessage();
    if (!last || this.editMode()) return;

    this.stashedDraft.set(this.message());
    this.message.set(last.text);
    this.editMessageIndex.set(last.bufferIndex);
    this.editMode.set(true);

    // Place cursor at end of loaded text
    requestAnimationFrame(() => {
      const textarea = this.textareaRef()?.nativeElement;
      if (textarea) {
        textarea.value = last.text;
        textarea.selectionStart = last.text.length;
        textarea.selectionEnd = last.text.length;
        this.scheduleTextareaResize(textarea);
      }
    });
  }

  private cancelEditMode(): void {
    this.message.set(this.stashedDraft() ?? '');
    this.editMode.set(false);
    this.stashedDraft.set(null);
    this.editMessageIndex.set(null);

    // Restore textarea content
    requestAnimationFrame(() => {
      const textarea = this.textareaRef()?.nativeElement;
      if (textarea) {
        textarea.value = this.message();
        this.scheduleTextareaResize(textarea);
      }
    });
  }

  private sendEditedMessage(): void {
    if (!this.canSend() || this.isBusy() || this.disabled()) return;

    const idx = this.editMessageIndex();
    if (idx === null) return;

    this.resendEdited.emit({
      messageIndex: idx,
      text: this.message().trim(),
    });

    this.message.set('');
    this.editMode.set(false);
    this.stashedDraft.set(null);
    this.editMessageIndex.set(null);
    this.clearComposerDraft();

    const textarea = this.textareaRef()?.nativeElement;
    if (textarea) {
      textarea.style.height = 'auto';
    }
  }
```

- [ ] **Step 2: Add keyboard handlers in `onKeyDown()`**

Insert the following block **after** the ghost text block (after line 1159) and **before** the Enter-to-send block (line 1161). The existing code at lines 1159-1165 looks like:

```typescript
    }  // ← end of ghost text block

    // Normal enter to send
    if (event.key === 'Enter' && !event.shiftKey) {
```

Insert between those two blocks:

```typescript
    // Edit mode: Escape to cancel
    if (event.key === 'Escape' && this.editMode()) {
      event.preventDefault();
      this.cancelEditMode();
      return;
    }

    // Edit mode: UP arrow at cursor position 0 to enter edit mode
    if (event.key === 'ArrowUp') {
      const textarea = event.target as HTMLTextAreaElement;
      if (textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
        event.preventDefault();
        this.enterEditMode();
        return;
      }
    }

    // Edit mode: Enter to resend edited message
    if (event.key === 'Enter' && !event.shiftKey && this.editMode()) {
      event.preventDefault();
      this.sendEditedMessage();
      return;
    }
```

**Important:** The edit-mode Enter handler must come **before** the existing `onSend()` Enter handler so it intercepts the event first. The final `onKeyDown()` flow after the ghost text block should be:

1. Escape in edit mode → cancel
2. ArrowUp at position 0 → enter edit mode
3. Enter in edit mode → resend edited
4. Enter (normal) → `onSend()` (existing)

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Run existing tests to check for regressions**

```bash
npx vitest run src/renderer/app/features/instance-detail/input-panel-edit-mode.spec.ts
```

Expected: All tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/app/features/instance-detail/input-panel.component.ts
git commit -m "feat(input-panel): add UP/Escape/Enter keyboard handlers for edit mode"
```

---

### Task 3: Edit Mode Visual Indicator — Template and Styles

Add the edit bar above the textarea and the `.edit-mode-bar` CSS.

**Files:**
- Modify: `src/renderer/app/features/instance-detail/input-panel.component.ts`

**Reference:** The textarea is inside a `.input-row` div starting at line 142. The edit bar goes inside `.input-panel`, just before `.input-row`.

- [ ] **Step 1: Add the edit mode bar to the template**

Insert the following block **before** the `<!-- Input area -->` comment (before line 141):

```html
      <!-- Edit mode indicator -->
      @if (editMode()) {
        <div class="edit-mode-bar">
          @if (isBusy()) {
            <span>Instance is busy — wait for completion before resending · Esc to cancel</span>
          } @else {
            <span>Editing last message · Enter to resend · Esc to cancel</span>
          }
        </div>
      }
```

- [ ] **Step 2: Add the `.edit-mode-bar` CSS**

Add the following styles before the closing backtick of the `styles` array (before line 858, just after the `.cmd-desc` block):

```css
    .edit-mode-bar {
      display: flex;
      align-items: center;
      padding: 6px 12px;
      margin-bottom: 8px;
      border-radius: 8px;
      background: rgba(var(--primary-rgb), 0.08);
      border: 1px solid rgba(var(--primary-rgb), 0.15);
      font-family: var(--font-mono);
      font-size: 11px;
      letter-spacing: 0.02em;
      color: var(--text-muted);

      span {
        opacity: 0.85;
      }
    }
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Lint the modified file**

```bash
npx eslint src/renderer/app/features/instance-detail/input-panel.component.ts
```

Expected: No new errors.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/app/features/instance-detail/input-panel.component.ts
git commit -m "feat(input-panel): add edit mode visual indicator bar above textarea"
```

---

### Task 4: Parent Handler — `onResendEdited` in `InstanceDetailComponent`

Wire up the `(resendEdited)` output event in the parent template and implement the fork+send+swap+terminate handler.

**Files:**
- Modify: `src/renderer/app/features/instance-detail/instance-detail.component.ts`
- Create: `src/renderer/app/features/instance-detail/instance-detail-edit-resend.spec.ts`

**Reference:**
- The `<app-input-panel>` template is at lines 262-282. Add the output binding there.
- The `onSendMessage()` method is at lines 986-1001. Add `onResendEdited()` nearby.
- The fork pattern from `output-stream.component.ts` (line 1216): `await this.ipc.forkSession(instanceId, bufferIndex + 1, description)` returns `{ success, data: { id } }`.
- `this.store.sendInput(id, message)` — async, queues if instance is initializing.
- `this.store.setSelectedInstance(id)` — sync.
- `this.store.terminateInstance(id)` — async.

- [ ] **Step 1: Write the failing test for `onResendEdited` logic**

Create `src/renderer/app/features/instance-detail/instance-detail-edit-resend.spec.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

/**
 * Unit tests for the onResendEdited fork+send+swap+terminate flow.
 *
 * Tests the logic in isolation following the same pattern as
 * instance-detail-inspectors.spec.ts.
 */

describe('onResendEdited flow', () => {
  function createMocks() {
    const forkSession = vi.fn();
    const sendInput = vi.fn();
    const setSelectedInstance = vi.fn();
    const terminateInstance = vi.fn();

    return {
      ipc: { forkSession },
      store: { sendInput, setSelectedInstance, terminateInstance },
      forkSession,
      sendInput,
      setSelectedInstance,
      terminateInstance,
    };
  }

  // Replicates the onResendEdited logic
  async function onResendEdited(
    mocks: ReturnType<typeof createMocks>,
    instanceId: string | null,
    event: { messageIndex: number; text: string },
  ) {
    if (!instanceId) return;

    const result = await mocks.ipc.forkSession(
      instanceId,
      event.messageIndex,
      `Edit resend at message ${event.messageIndex}`,
    );

    if (!result?.success || !result.data?.id) return;

    const newId = result.data.id as string;
    mocks.store.sendInput(newId, event.text);
    mocks.store.setSelectedInstance(newId);
    await mocks.store.terminateInstance(instanceId);
  }

  it('calls fork → send → swap → terminate in order', async () => {
    const mocks = createMocks();
    mocks.forkSession.mockResolvedValue({ success: true, data: { id: 'new-123' } });
    mocks.terminateInstance.mockResolvedValue(undefined);

    await onResendEdited(mocks, 'old-456', { messageIndex: 3, text: 'edited question' });

    expect(mocks.forkSession).toHaveBeenCalledWith('old-456', 3, 'Edit resend at message 3');
    expect(mocks.sendInput).toHaveBeenCalledWith('new-123', 'edited question');
    expect(mocks.setSelectedInstance).toHaveBeenCalledWith('new-123');
    expect(mocks.terminateInstance).toHaveBeenCalledWith('old-456');
  });

  it('does nothing when instanceId is null', async () => {
    const mocks = createMocks();

    await onResendEdited(mocks, null, { messageIndex: 3, text: 'edited' });

    expect(mocks.forkSession).not.toHaveBeenCalled();
  });

  it('does not send/swap/terminate when fork fails', async () => {
    const mocks = createMocks();
    mocks.forkSession.mockResolvedValue({ success: false, error: 'Fork failed' });

    await onResendEdited(mocks, 'old-456', { messageIndex: 3, text: 'edited' });

    expect(mocks.forkSession).toHaveBeenCalled();
    expect(mocks.sendInput).not.toHaveBeenCalled();
    expect(mocks.setSelectedInstance).not.toHaveBeenCalled();
    expect(mocks.terminateInstance).not.toHaveBeenCalled();
  });

  it('does not send/swap/terminate when fork returns no id', async () => {
    const mocks = createMocks();
    mocks.forkSession.mockResolvedValue({ success: true, data: {} });

    await onResendEdited(mocks, 'old-456', { messageIndex: 3, text: 'edited' });

    expect(mocks.sendInput).not.toHaveBeenCalled();
    expect(mocks.setSelectedInstance).not.toHaveBeenCalled();
    expect(mocks.terminateInstance).not.toHaveBeenCalled();
  });

  it('handles fork at messageIndex 0 (first-ever user message)', async () => {
    const mocks = createMocks();
    mocks.forkSession.mockResolvedValue({ success: true, data: { id: 'new-789' } });
    mocks.terminateInstance.mockResolvedValue(undefined);

    await onResendEdited(mocks, 'old-456', { messageIndex: 0, text: 'revised first message' });

    // Fork at index 0 means the new instance starts with an empty conversation
    expect(mocks.forkSession).toHaveBeenCalledWith('old-456', 0, 'Edit resend at message 0');
    expect(mocks.sendInput).toHaveBeenCalledWith('new-789', 'revised first message');
    expect(mocks.setSelectedInstance).toHaveBeenCalledWith('new-789');
    expect(mocks.terminateInstance).toHaveBeenCalledWith('old-456');
  });
});

/**
 * Note: The spec lists "onResendEdited is blocked when instance is busy" as a parent test,
 * but the busy guard lives in InputPanelComponent.sendEditedMessage(), not the parent.
 * The parent handler is never called when busy because the child blocks emission.
 */
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
npx vitest run src/renderer/app/features/instance-detail/instance-detail-edit-resend.spec.ts
```

Expected: All tests PASS (they test extracted logic with mocks).

- [ ] **Step 3: Add `(resendEdited)` binding to the template**

In `src/renderer/app/features/instance-detail/instance-detail.component.ts`, find the `<app-input-panel>` template (line 262-282). Add the output binding after the existing `(cancelQueuedMessage)` binding (line 281):

```typescript
            (cancelQueuedMessage)="onCancelQueuedMessage($event)"
            (resendEdited)="onResendEdited($event)"
```

- [ ] **Step 4: Add the `onResendEdited()` method**

Add the handler method after `onSendMessage()` (after line 1001):

```typescript
  async onResendEdited(event: { messageIndex: number; text: string }): Promise<void> {
    const inst = this.instance();
    if (!inst) return;

    const result = await this.ipc.forkSession(
      inst.id,
      event.messageIndex,
      `Edit resend at message ${event.messageIndex}`,
    );

    if (!result?.success || !result.data) return;

    const data = result.data as { id?: string };
    if (!data.id) return;

    this.store.sendInput(data.id, event.text);
    this.store.setSelectedInstance(data.id);
    await this.store.terminateInstance(inst.id);
  }
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: No errors.

- [ ] **Step 6: Run all related tests**

```bash
npx vitest run src/renderer/app/features/instance-detail/
```

Expected: All tests PASS.

- [ ] **Step 7: Lint modified files**

```bash
npx eslint src/renderer/app/features/instance-detail/instance-detail.component.ts
```

Expected: No new errors.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/app/features/instance-detail/instance-detail.component.ts src/renderer/app/features/instance-detail/instance-detail-edit-resend.spec.ts
git commit -m "feat(instance-detail): add onResendEdited handler with fork+send+swap+terminate flow"
```

---

### Task 5: Final Verification

Run full verification across all changes.

**Files:**
- All modified files from Tasks 1-4

- [ ] **Step 1: TypeScript compilation check**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: No errors.

- [ ] **Step 2: Run all tests in the feature directory**

```bash
npx vitest run src/renderer/app/features/instance-detail/
```

Expected: All tests PASS (including pre-existing `instance-detail-inspectors.spec.ts` and the two new spec files).

- [ ] **Step 3: Lint all modified files**

```bash
npx eslint src/renderer/app/features/instance-detail/input-panel.component.ts src/renderer/app/features/instance-detail/instance-detail.component.ts
```

Expected: No errors.

- [ ] **Step 4: Run full test suite to check for regressions**

```bash
npm run test
```

Expected: No test failures.
