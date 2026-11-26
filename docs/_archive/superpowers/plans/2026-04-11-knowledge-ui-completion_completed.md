# Knowledge UI Completion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add all missing write/management UI for knowledge graph facts, wake context management, and conversation import — the existing Knowledge Graph page is read-only and needs forms, inline editing, and a conversation import panel.

**Architecture:** Extend the existing knowledge-page.component.ts with inline forms (add fact, invalidate fact), add a new wake-management.component.ts for identity editing + hint CRUD, and a new conversation-import.component.ts for file/string import with format auto-detect. Add a `WAKE_LIST_HINTS` backend endpoint (the only missing backend piece) with the full channel → schema → handler → preload → service → store pipeline.

**Tech Stack:** Angular 21 (standalone, OnPush, signals, FormsModule, template-driven), Electron IPC, Zod validation, better-sqlite3

---

## File Structure

### New files
| File | Responsibility |
|------|---------------|
| `src/renderer/app/features/knowledge/wake-management.component.ts` | Wake context management — identity editor, hint list with add/remove, wing-filtered regeneration |
| `src/renderer/app/features/knowledge/conversation-import.component.ts` | Conversation import — paste text or enter file path, format auto-detect, wing selector |

### Modified files
| File | What changes |
|------|-------------|
| `src/main/memory/wake-context-builder.ts` | Add `listHints(room?)` method |
| `src/main/ipc/handlers/wake-context-handlers.ts` | Add `WAKE_LIST_HINTS` handler |
| `packages/contracts/src/channels/memory.channels.ts` | Add `WAKE_LIST_HINTS` channel |
| `src/shared/types/ipc.types.ts` | Add `WAKE_LIST_HINTS` channel |
| `src/shared/validation/ipc-schemas.ts` | Add `WakeListHintsPayloadSchema` |
| `src/preload/domains/memory.preload.ts` | Add `wakeListHints` invoke method |
| `src/renderer/app/core/services/ipc/memory-ipc.service.ts` | Add `wakeListHints()` method |
| `src/renderer/app/core/state/knowledge.store.ts` | Add hints state, listHints/addHint/removeHint/setIdentity/queryRelationship/addFact/invalidateFact actions, convo import actions |
| `src/renderer/app/features/knowledge/knowledge-page.component.ts` | Add inline "Add Fact" form, per-row "Invalidate" button, relationship query input, embed sub-components |
| `src/renderer/app/app.routes.ts` | No changes needed — `/knowledge` route already exists |

---

## Task 1: Add WAKE_LIST_HINTS Backend Endpoint

There's no way to list existing wake hints. The UI needs this to show a manageable hint list. Add the full pipeline: backend method → channel → schema → handler → preload → Angular service.

**Files:**
- Modify: `src/main/memory/wake-context-builder.ts`
- Modify: `packages/contracts/src/channels/memory.channels.ts`
- Modify: `src/shared/types/ipc.types.ts`
- Modify: `src/shared/validation/ipc-schemas.ts`
- Modify: `src/main/ipc/handlers/wake-context-handlers.ts`
- Modify: `src/preload/domains/memory.preload.ts`
- Modify: `src/renderer/app/core/services/ipc/memory-ipc.service.ts`

- [ ] **Step 1: Add `listHints` method to WakeContextBuilder**

In `src/main/memory/wake-context-builder.ts`, after the `removeHint(id)` method (line 134) and before the `// ============ Essential Story (L1) ============` comment (line 136), add:

```typescript
  listHints(room?: string): WakeHint[] {
    const rows = room
      ? this.db.prepare(`
          SELECT * FROM wake_hints
          WHERE room = ? OR room = 'general'
          ORDER BY importance DESC, created_at DESC
        `).all(room) as WakeHintRow[]
      : this.db.prepare(`
          SELECT * FROM wake_hints
          ORDER BY importance DESC, created_at DESC
        `).all() as WakeHintRow[];
    return rows.map(rowToHint);
  }
```

- [ ] **Step 2: Add channel to contracts**

In `packages/contracts/src/channels/memory.channels.ts`, after the `WAKE_SET_IDENTITY` line (line 103) and before the `// Codebase Mining operations` comment (line 105), add:

```typescript
  WAKE_LIST_HINTS: 'wake:list-hints',
```

- [ ] **Step 3: Add channel to ipc.types.ts**

In `src/shared/types/ipc.types.ts`, after the `WAKE_SET_IDENTITY` entry and before `// Codebase Mining`, add:

```typescript
  WAKE_LIST_HINTS: 'wake:list-hints',
```

- [ ] **Step 4: Regenerate IPC channels**

Run: `npm run generate:ipc`
Expected: `src/preload/generated/channels.ts` is regenerated with `WAKE_LIST_HINTS`

- [ ] **Step 5: Add Zod schema**

In `src/shared/validation/ipc-schemas.ts`, after the `WakeSetIdentityPayloadSchema` (line 2242) and before the `// ============ Codebase Mining Schemas ============` comment (line 2244), add:

```typescript

export const WakeListHintsPayloadSchema = z.object({
  room: z.string().optional(),
});
```

- [ ] **Step 6: Add IPC handler**

In `src/main/ipc/handlers/wake-context-handlers.ts`, add import for the new schema — update the import block (line 6-10) to:

```typescript
import {
  WakeGeneratePayloadSchema,
  WakeAddHintPayloadSchema,
  WakeRemoveHintPayloadSchema,
  WakeSetIdentityPayloadSchema,
  WakeListHintsPayloadSchema,
} from '../../../shared/validation/ipc-schemas';
```

Then after the `WAKE_SET_IDENTITY` handler (after line 125, before `logger.info(...)` on line 128), add:

```typescript

  ipcMain.handle(
    IPC_CHANNELS.WAKE_LIST_HINTS,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const data = WakeListHintsPayloadSchema.parse(payload);
        const hints = builder.listHints(data.room);
        return { success: true, data: hints };
      } catch (error) {
        logger.error('WAKE_LIST_HINTS failed', error as Error);
        return {
          success: false,
          error: {
            code: 'WAKE_LIST_HINTS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );
```

- [ ] **Step 7: Add preload bridge method**

In `src/preload/domains/memory.preload.ts`, after the `wakeSetIdentity` invoke (line 630) and before the `// Codebase Mining` comment (line 632), add:

```typescript

    wakeListHints: (payload: unknown): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.WAKE_LIST_HINTS, payload),
```

- [ ] **Step 8: Add Angular service method**

In `src/renderer/app/core/services/ipc/memory-ipc.service.ts`, after the `wakeSetIdentity` method and before the `// ============================================ // Codebase Mining` section, add:

```typescript

  async wakeListHints(payload: { room?: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.wakeListHints(payload);
  }
```

- [ ] **Step 9: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 10: Commit**

```bash
git add packages/contracts/src/channels/memory.channels.ts \
       src/preload/generated/channels.ts \
       src/shared/types/ipc.types.ts \
       src/shared/validation/ipc-schemas.ts \
       src/main/memory/wake-context-builder.ts \
       src/main/ipc/handlers/wake-context-handlers.ts \
       src/preload/domains/memory.preload.ts \
       src/renderer/app/core/services/ipc/memory-ipc.service.ts
git commit -m "feat: add WAKE_LIST_HINTS endpoint — full pipeline from backend to Angular service"
```

---

## Task 2: Extend KnowledgeStore with Write Actions

The store currently only has read actions. Add actions for: addFact, invalidateFact, queryRelationship, setIdentity, addHint, removeHint, listHints, importString, importFile, detectFormat.

**Files:**
- Modify: `src/renderer/app/core/state/knowledge.store.ts`

- [ ] **Step 1: Add new state signals and actions**

In `src/renderer/app/core/state/knowledge.store.ts`, read the full file first.

Add new imports — update the `WakeHint` type import. Change line 7:

```typescript
import type { WakeContext, WakeHint } from '../../../../shared/types/wake-context.types';
```

After the existing `ImportEvent` interface (line 18) and before the `RecentFactEvent` interface (line 20), add:

```typescript

interface ConvoImportResult {
  segmentsCreated: number;
  filesProcessed: number;
  formatDetected: string;
  errors: string[];
  duration: number;
}
```

After the `_importEvents` signal (line 40) and before the `_loading` signal (line 41), add:

```typescript
  private _wakeHints = signal<WakeHint[]>([]);
  private _wakeIdentity = signal('');
  private _relationshipResults = signal<KGQueryResult[]>([]);
  private _selectedPredicate = signal('');
```

After the `readonly importEvents` line (line 51) and before the `readonly loading` line (line 52), add:

```typescript
  readonly wakeHints = this._wakeHints.asReadonly();
  readonly wakeIdentity = this._wakeIdentity.asReadonly();
  readonly relationshipResults = this._relationshipResults.asReadonly();
  readonly selectedPredicate = this._selectedPredicate.asReadonly();
```

After the `readonly entityCount` computed (line 61) and before the `constructor()` (line 63), add:

```typescript
  readonly hintCount = computed(() => this._wakeHints().length);
```

After the `clearError()` method (line 149) and before the `private subscribeToEvents()` method (line 151), add the new actions:

```typescript

  // --- Write Actions ---

  async addFact(payload: {
    subject: string;
    predicate: string;
    object: string;
    confidence?: number;
    validFrom?: string;
    sourceFile?: string;
  }): Promise<boolean> {
    const response = await this.memoryIpc.kgAddFact(payload);
    if (response.success) {
      await this.loadStats();
      const entity = this._selectedEntity();
      if (entity && (payload.subject === entity || payload.object === entity)) {
        await this.queryEntity(entity);
      }
      return true;
    }
    this._error.set(response.error?.message ?? 'Failed to add fact');
    return false;
  }

  async invalidateFact(payload: {
    subject: string;
    predicate: string;
    object: string;
  }): Promise<boolean> {
    const response = await this.memoryIpc.kgInvalidateFact(payload);
    if (response.success) {
      await this.loadStats();
      const entity = this._selectedEntity();
      if (entity) {
        await Promise.all([
          this.queryEntity(entity),
          this.loadTimeline(entity),
        ]);
      }
      return true;
    }
    this._error.set(response.error?.message ?? 'Failed to invalidate fact');
    return false;
  }

  async queryRelationship(predicate: string, asOf?: string): Promise<void> {
    this._loading.set(true);
    this._error.set(null);
    this._selectedPredicate.set(predicate);
    try {
      const response = await this.memoryIpc.kgQueryRelationship({ predicate, asOf });
      if (response.success) {
        this._relationshipResults.set(response.data as KGQueryResult[]);
      } else {
        this._error.set(response.error?.message ?? 'Relationship query failed');
      }
    } finally {
      this._loading.set(false);
    }
  }

  // --- Wake Write Actions ---

  async listHints(room?: string): Promise<void> {
    const response = await this.memoryIpc.wakeListHints({ room });
    if (response.success) {
      this._wakeHints.set(response.data as WakeHint[]);
    } else {
      this._error.set(response.error?.message ?? 'Failed to list hints');
    }
  }

  async addHint(content: string, importance?: number, room?: string): Promise<boolean> {
    const response = await this.memoryIpc.wakeAddHint({ content, importance, room });
    if (response.success) {
      await this.listHints();
      return true;
    }
    this._error.set(response.error?.message ?? 'Failed to add hint');
    return false;
  }

  async removeHint(id: string): Promise<boolean> {
    const response = await this.memoryIpc.wakeRemoveHint({ id });
    if (response.success) {
      await this.listHints();
      return true;
    }
    this._error.set(response.error?.message ?? 'Failed to remove hint');
    return false;
  }

  async setIdentity(text: string): Promise<boolean> {
    const response = await this.memoryIpc.wakeSetIdentity({ text });
    if (response.success) {
      this._wakeIdentity.set(text);
      await this.loadWakeContext(this.wakeWing);
      return true;
    }
    this._error.set(response.error?.message ?? 'Failed to set identity');
    return false;
  }

  async loadIdentity(): Promise<void> {
    const response = await this.memoryIpc.wakeGenerate({});
    if (response.success) {
      const data = response.data as WakeContext;
      this._wakeIdentity.set(data.identity.content);
    }
  }

  // --- Conversation Import Actions ---

  async importConversationString(content: string, wing: string, sourceFile: string, format?: string): Promise<ConvoImportResult | null> {
    this._loading.set(true);
    this._error.set(null);
    try {
      const response = await this.memoryIpc.convoImportString({ content, wing, sourceFile, format });
      if (response.success) {
        await this.loadStats();
        return response.data as ConvoImportResult;
      }
      this._error.set(response.error?.message ?? 'Import failed');
      return null;
    } finally {
      this._loading.set(false);
    }
  }

  async importConversationFile(filePath: string, wing: string): Promise<ConvoImportResult | null> {
    this._loading.set(true);
    this._error.set(null);
    try {
      const response = await this.memoryIpc.convoImportFile({ filePath, wing });
      if (response.success) {
        await this.loadStats();
        return response.data as ConvoImportResult;
      }
      this._error.set(response.error?.message ?? 'Import failed');
      return null;
    } finally {
      this._loading.set(false);
    }
  }

  async detectFormat(content: string): Promise<string | null> {
    const response = await this.memoryIpc.convoDetectFormat({ content });
    if (response.success) {
      return response.data as string;
    }
    return null;
  }
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/app/core/state/knowledge.store.ts
git commit -m "feat(store): add write actions — addFact, invalidateFact, wake hints CRUD, conversation import"
```

---

## Task 3: Add Fact Form + Invalidate Buttons to Knowledge Page

Add an inline "Add Fact" collapsible form at the top of the entity facts panel, and an "Invalidate" button on each current (non-expired) fact row.

**Files:**
- Modify: `src/renderer/app/features/knowledge/knowledge-page.component.ts`

- [ ] **Step 1: Read the current component**

Read `src/renderer/app/features/knowledge/knowledge-page.component.ts` fully (622 lines).

- [ ] **Step 2: Add FormsModule import and new signals**

Update the imports array (line 15) to include `FormsModule`:

```typescript
import { FormsModule } from '@angular/forms';
```

And change `imports: [CommonModule],` (line 15) to:

```typescript
  imports: [CommonModule, FormsModule],
```

After the `mineDir` signal (line 560), add new signals for the add-fact form and relationship query:

```typescript

  // Add-fact form state
  protected showAddFact = signal(false);
  protected newSubject = signal('');
  protected newPredicate = signal('');
  protected newObject = signal('');
  protected newConfidence = signal('');
  protected newValidFrom = signal('');

  // Relationship query
  protected predicateQuery = signal('');
```

- [ ] **Step 3: Add the "Add Fact" form in the template**

In the template, find the entity facts panel title block. Replace the `panel-title` div (lines 60-66) with:

```html
            <div class="panel-title" style="display: flex; justify-content: space-between; align-items: center;">
              <span>
                @if (store.selectedEntity(); as entity) {
                  Facts for "{{ entity }}"
                } @else {
                  Entity Facts
                }
              </span>
              <button class="btn btn-sm" type="button" (click)="showAddFact.set(!showAddFact())">
                {{ showAddFact() ? 'Cancel' : '+ Add Fact' }}
              </button>
            </div>

            @if (showAddFact()) {
              <div class="inline-form">
                <div class="form-row">
                  <label class="field">
                    <span class="label">Subject</span>
                    <input class="input" type="text" [(ngModel)]="newSubject" placeholder="e.g. my_project" />
                  </label>
                  <label class="field">
                    <span class="label">Predicate</span>
                    <input class="input" type="text" [(ngModel)]="newPredicate" placeholder="e.g. uses_database" />
                  </label>
                  <label class="field">
                    <span class="label">Object</span>
                    <input class="input" type="text" [(ngModel)]="newObject" placeholder="e.g. PostgreSQL" />
                  </label>
                </div>
                <div class="form-row">
                  <label class="field">
                    <span class="label">Confidence (0-1)</span>
                    <input class="input" type="number" [(ngModel)]="newConfidence" min="0" max="1" step="0.1" placeholder="0.9" />
                  </label>
                  <label class="field">
                    <span class="label">Valid From (ISO)</span>
                    <input class="input" type="text" [(ngModel)]="newValidFrom" placeholder="2025-01-01" />
                  </label>
                  <div class="field" style="justify-content: flex-end;">
                    <button class="btn primary" type="button"
                      [disabled]="!newSubject() || !newPredicate() || !newObject() || store.loading()"
                      (click)="addFact()">
                      Add Fact
                    </button>
                  </div>
                </div>
              </div>
            }
```

- [ ] **Step 4: Add "Invalidate" button to fact table rows**

In the fact table header row (line 73-79), add a new column after `Validity`:

```html
                    <th>Actions</th>
```

In the fact table body row, after the validity `<td>` (lines 90-99), add:

```html
                      <td>
                        @if (!fact.validTo) {
                          <button class="btn btn-sm btn-danger" type="button"
                            (click)="invalidateFact(fact)">
                            Invalidate
                          </button>
                        }
                      </td>
```

- [ ] **Step 5: Add relationship query section in the toolbar**

After the entity query `<label>` block (lines 35-44) and before the `<div class="actions">` (line 46), add:

```html

        <label class="field">
          <span class="label">Query by Predicate</span>
          <input
            class="input"
            type="text"
            [(ngModel)]="predicateQuery"
            placeholder="e.g. uses_database"
            (keyup.enter)="queryRelationship()"
          />
        </label>
```

- [ ] **Step 6: Add relationship results panel in main-panel**

After the "Recent Facts (Live)" panel (after line 140, before `</div>` closing `.main-panel`), add:

```html

          @if (store.relationshipResults().length > 0) {
            <div class="panel-card full-width">
              <div class="panel-title">Relationship: "{{ store.selectedPredicate() }}"</div>
              <table class="fact-table">
                <thead>
                  <tr>
                    <th>Subject</th>
                    <th>Object</th>
                    <th>Confidence</th>
                    <th>Current</th>
                  </tr>
                </thead>
                <tbody>
                  @for (result of store.relationshipResults(); track $index) {
                    <tr>
                      <td class="mono">{{ result.subject }}</td>
                      <td>{{ result.object }}</td>
                      <td class="num">{{ result.confidence != null ? (result.confidence * 100).toFixed(0) + '%' : '-' }}</td>
                      <td>
                        <span [class]="result.current ? 'badge-success' : 'muted'">
                          {{ result.current ? 'Yes' : 'No' }}
                        </span>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
```

- [ ] **Step 7: Add new styles**

In the styles block, before the `@media` query (line 538), add:

```css

    .btn-sm {
      padding: 2px 6px;
      font-size: 10px;
    }

    .btn-danger {
      background: rgba(239, 68, 68, 0.15);
      border-color: rgba(239, 68, 68, 0.3);
      color: #f87171;
    }

    .inline-form {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
      padding: var(--spacing-sm);
      margin-bottom: var(--spacing-sm);
      border: 1px dashed var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-primary);
    }

    .form-row {
      display: flex;
      gap: var(--spacing-sm);
      align-items: end;
    }

    .form-row .field {
      flex: 1;
    }
```

- [ ] **Step 8: Add component methods**

After the `triggerMine()` method (line 620) and before the closing `}` of the class (line 621), add:

```typescript

  async addFact(): Promise<void> {
    const subject = this.newSubject().trim();
    const predicate = this.newPredicate().trim();
    const object = this.newObject().trim();
    if (!subject || !predicate || !object) return;

    const payload: {
      subject: string;
      predicate: string;
      object: string;
      confidence?: number;
      validFrom?: string;
    } = { subject, predicate, object };

    const conf = this.newConfidence().toString().trim();
    if (conf) {
      payload.confidence = parseFloat(conf);
    }
    const vf = this.newValidFrom().trim();
    if (vf) {
      payload.validFrom = vf;
    }

    const ok = await this.store.addFact(payload);
    if (ok) {
      this.newSubject.set('');
      this.newPredicate.set('');
      this.newObject.set('');
      this.newConfidence.set('');
      this.newValidFrom.set('');
      this.showAddFact.set(false);
    }
  }

  async invalidateFact(fact: { subject: string; predicate: string; object: string }): Promise<void> {
    await this.store.invalidateFact({
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
    });
  }

  async queryRelationship(): Promise<void> {
    const predicate = this.predicateQuery().trim();
    if (!predicate) return;
    await this.store.queryRelationship(predicate);
  }
```

- [ ] **Step 9: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 10: Commit**

```bash
git add src/renderer/app/features/knowledge/knowledge-page.component.ts
git commit -m "feat(ui): add fact creation form, invalidation buttons, and relationship query to knowledge page"
```

---

## Task 4: Wake Management Component

Create a new component for wake context management: identity editor, hint list with add/remove, and wing-filtered regeneration.

**Files:**
- Create: `src/renderer/app/features/knowledge/wake-management.component.ts`

- [ ] **Step 1: Create the wake management component**

Create `src/renderer/app/features/knowledge/wake-management.component.ts`:

```typescript
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { KnowledgeStore } from '../../core/state/knowledge.store';

@Component({
  selector: 'app-wake-management',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wake-mgmt">
      <!-- Identity Editor -->
      <div class="panel-card">
        <div class="panel-title" style="display: flex; justify-content: space-between; align-items: center;">
          <span>L0 Identity</span>
          <button class="btn btn-sm" type="button" (click)="editingIdentity.set(!editingIdentity())">
            {{ editingIdentity() ? 'Cancel' : 'Edit' }}
          </button>
        </div>

        @if (editingIdentity()) {
          <div class="identity-editor">
            <textarea
              class="input textarea"
              [(ngModel)]="identityDraft"
              placeholder="Describe the project/persona identity (max 500 chars)"
              maxlength="500"
              rows="3"
            ></textarea>
            <div class="form-footer">
              <span class="muted">{{ identityDraft().length }}/500</span>
              <button class="btn primary" type="button"
                [disabled]="!identityDraft().trim() || store.loading()"
                (click)="saveIdentity()">
                Save Identity
              </button>
            </div>
          </div>
        } @else {
          @if (store.wakeIdentity(); as identity) {
            <pre class="wake-text">{{ identity }}</pre>
          } @else {
            <div class="hint">No identity set. Click "Edit" to define one.</div>
          }
        }
      </div>

      <!-- Wing-Filtered Regeneration -->
      <div class="panel-card">
        <div class="panel-title">Regenerate Wake Context</div>
        <div class="regen-row">
          <label class="field field-wide">
            <span class="label">Wing (optional)</span>
            <input class="input" type="text" [(ngModel)]="wakeWing" placeholder="e.g. my_project" />
          </label>
          <button class="btn primary" type="button"
            [disabled]="store.loading()"
            (click)="regenerate()">
            Regenerate
          </button>
        </div>

        @if (store.wakeContext(); as ctx) {
          <div class="stat-row"><span>Tokens</span><span class="num">~{{ ctx.totalTokens }}</span></div>
          @if (ctx.wing) {
            <div class="stat-row"><span>Wing</span><span>{{ ctx.wing }}</span></div>
          }
          <details class="wake-details">
            <summary>L0 Identity</summary>
            <pre class="wake-text">{{ ctx.identity.content }}</pre>
          </details>
          <details class="wake-details">
            <summary>L1 Essential Story</summary>
            <pre class="wake-text">{{ ctx.essentialStory.content }}</pre>
          </details>
        }
      </div>

      <!-- Hints Management -->
      <div class="panel-card">
        <div class="panel-title" style="display: flex; justify-content: space-between; align-items: center;">
          <span>Wake Hints ({{ store.hintCount() }})</span>
          <button class="btn btn-sm" type="button" (click)="showAddHint.set(!showAddHint())">
            {{ showAddHint() ? 'Cancel' : '+ Add Hint' }}
          </button>
        </div>

        @if (showAddHint()) {
          <div class="inline-form">
            <label class="field">
              <span class="label">Content</span>
              <textarea class="input textarea" [(ngModel)]="newHintContent" rows="2"
                placeholder="Describe a fact, pattern, or guideline..."></textarea>
            </label>
            <div class="form-row">
              <label class="field">
                <span class="label">Importance (0-10)</span>
                <input class="input" type="number" [(ngModel)]="newHintImportance"
                  min="0" max="10" step="1" placeholder="5" />
              </label>
              <label class="field">
                <span class="label">Room</span>
                <input class="input" type="text" [(ngModel)]="newHintRoom"
                  placeholder="e.g. architecture, security" />
              </label>
              <div class="field" style="justify-content: flex-end;">
                <button class="btn primary" type="button"
                  [disabled]="!newHintContent().trim() || store.loading()"
                  (click)="addHint()">
                  Add
                </button>
              </div>
            </div>
          </div>
        }

        @if (store.wakeHints().length > 0) {
          <ul class="hint-list">
            @for (hint of store.wakeHints(); track hint.id) {
              <li class="hint-item">
                <div class="hint-main">
                  <span class="hint-content">{{ hint.content }}</span>
                  <div class="hint-meta">
                    <span class="badge">{{ hint.room }}</span>
                    <span class="muted">imp: {{ hint.importance }}</span>
                    <span class="muted">used: {{ hint.usageCount }}x</span>
                  </div>
                </div>
                <button class="btn btn-sm btn-danger" type="button"
                  (click)="removeHint(hint.id)">
                  Remove
                </button>
              </li>
            }
          </ul>
        } @else {
          <div class="hint">No hints yet. Add hints to shape the wake context.</div>
        }
      </div>
    </div>
  `,
  styles: [`
    .wake-mgmt {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
    }

    .panel-card {
      padding: var(--spacing-md);
      border-radius: var(--radius-md);
      border: 1px solid var(--border-color);
      background: var(--bg-secondary);
    }

    .panel-title {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: var(--spacing-sm);
    }

    .stat-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 2px 0;
      font-size: 12px;
    }

    .num {
      font-variant-numeric: tabular-nums;
      font-weight: 600;
    }

    .btn {
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      padding: var(--spacing-xs) var(--spacing-sm);
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }

    .btn.primary {
      background: var(--primary-color);
      border-color: var(--primary-color);
      color: #fff;
    }

    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .btn-sm {
      padding: 2px 6px;
      font-size: 10px;
    }

    .btn-danger {
      background: rgba(239, 68, 68, 0.15);
      border-color: rgba(239, 68, 68, 0.3);
      color: #f87171;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .field-wide {
      flex: 1;
    }

    .label {
      font-size: 11px;
      color: var(--text-muted);
    }

    .input {
      width: 100%;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-primary);
      color: var(--text-primary);
      padding: var(--spacing-xs) var(--spacing-sm);
      font-size: 12px;
    }

    .textarea {
      resize: vertical;
      font-family: inherit;
      min-height: 40px;
    }

    .inline-form {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
      padding: var(--spacing-sm);
      margin-bottom: var(--spacing-sm);
      border: 1px dashed var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-primary);
    }

    .form-row {
      display: flex;
      gap: var(--spacing-sm);
      align-items: end;
    }

    .form-row .field {
      flex: 1;
    }

    .form-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .identity-editor {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .regen-row {
      display: flex;
      gap: var(--spacing-sm);
      align-items: end;
      margin-bottom: var(--spacing-sm);
    }

    .hint {
      font-size: 12px;
      color: var(--text-muted);
      font-style: italic;
    }

    .muted {
      color: var(--text-muted);
      font-size: 11px;
    }

    .wake-details {
      margin-top: var(--spacing-xs);
    }

    .wake-details summary {
      font-size: 12px;
      cursor: pointer;
      color: var(--primary-color);
    }

    .wake-text {
      font-size: 11px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 200px;
      overflow-y: auto;
      padding: var(--spacing-sm);
      background: var(--bg-primary);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      margin-top: var(--spacing-xs);
    }

    .hint-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }

    .hint-item {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: var(--spacing-sm);
      padding: var(--spacing-xs) 0;
      border-bottom: 1px solid var(--border-color);
    }

    .hint-item:last-child {
      border-bottom: none;
    }

    .hint-main {
      flex: 1;
      min-width: 0;
    }

    .hint-content {
      font-size: 12px;
      display: block;
      word-break: break-word;
    }

    .hint-meta {
      display: flex;
      gap: var(--spacing-sm);
      margin-top: 2px;
    }

    .badge {
      font-size: 10px;
      padding: 1px 4px;
      border-radius: 3px;
      background: var(--bg-tertiary);
      color: var(--text-muted);
    }
  `],
})
export class WakeManagementComponent implements OnInit {
  protected store = inject(KnowledgeStore);

  protected editingIdentity = signal(false);
  protected identityDraft = signal('');
  protected wakeWing = signal('');

  protected showAddHint = signal(false);
  protected newHintContent = signal('');
  protected newHintImportance = signal(5);
  protected newHintRoom = signal('');

  async ngOnInit(): Promise<void> {
    await Promise.all([
      this.store.loadIdentity(),
      this.store.listHints(),
      this.store.loadWakeContext(),
    ]);
    this.identityDraft.set(this.store.wakeIdentity());
  }

  async saveIdentity(): Promise<void> {
    const text = this.identityDraft().trim();
    if (!text) return;
    const ok = await this.store.setIdentity(text);
    if (ok) {
      this.editingIdentity.set(false);
    }
  }

  async regenerate(): Promise<void> {
    const wing = this.wakeWing().trim() || undefined;
    await this.store.loadWakeContext(wing);
  }

  async addHint(): Promise<void> {
    const content = this.newHintContent().trim();
    if (!content) return;
    const importance = this.newHintImportance();
    const room = this.newHintRoom().trim() || undefined;
    const ok = await this.store.addHint(content, importance, room);
    if (ok) {
      this.newHintContent.set('');
      this.newHintImportance.set(5);
      this.newHintRoom.set('');
      this.showAddHint.set(false);
    }
  }

  async removeHint(id: string): Promise<void> {
    await this.store.removeHint(id);
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/app/features/knowledge/wake-management.component.ts
git commit -m "feat(ui): add wake management component — identity editor, hint CRUD, wing regeneration"
```

---

## Task 5: Conversation Import Component

Create a component for importing conversations — paste text or enter file path, with format auto-detection and wing selection.

**Files:**
- Create: `src/renderer/app/features/knowledge/conversation-import.component.ts`

- [ ] **Step 1: Create the conversation import component**

Create `src/renderer/app/features/knowledge/conversation-import.component.ts`:

```typescript
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { KnowledgeStore } from '../../core/state/knowledge.store';

@Component({
  selector: 'app-conversation-import',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="import-panel">
      <div class="panel-card">
        <div class="panel-title">Import Conversation</div>

        <!-- Mode Toggle -->
        <div class="mode-toggle">
          <button class="toggle-btn" type="button"
            [class.active]="mode() === 'text'"
            (click)="mode.set('text')">
            Paste Text
          </button>
          <button class="toggle-btn" type="button"
            [class.active]="mode() === 'file'"
            (click)="mode.set('file')">
            File Path
          </button>
        </div>

        <!-- Common: Wing -->
        <label class="field">
          <span class="label">Wing (project namespace)</span>
          <input class="input" type="text" [(ngModel)]="wing"
            placeholder="e.g. my_project" />
        </label>

        @if (mode() === 'text') {
          <!-- Text Mode -->
          <label class="field">
            <span class="label">Source Name</span>
            <input class="input" type="text" [(ngModel)]="sourceName"
              placeholder="e.g. planning-session.txt" />
          </label>

          <label class="field">
            <span class="label">Conversation Content</span>
            <textarea class="input textarea"
              [(ngModel)]="textContent"
              rows="8"
              placeholder="Paste conversation here...
> Question 1
Answer 1

> Question 2
Answer 2"
              (input)="onTextChange()"
            ></textarea>
          </label>

          @if (detectedFormat()) {
            <div class="format-badge">
              Detected format: <strong>{{ detectedFormat() }}</strong>
            </div>
          }

          <label class="field">
            <span class="label">Format (optional override)</span>
            <select class="input" [(ngModel)]="formatOverride">
              <option value="">Auto-detect</option>
              <option value="plain-text">Plain Text (Q&A)</option>
              <option value="claude-code-jsonl">Claude Code JSONL</option>
              <option value="codex-jsonl">Codex JSONL</option>
              <option value="claude-ai-json">Claude.ai JSON</option>
              <option value="chatgpt-json">ChatGPT JSON</option>
              <option value="slack-json">Slack JSON</option>
            </select>
          </label>

          <button class="btn primary" type="button"
            [disabled]="!textContent().trim() || !wing().trim() || !sourceName().trim() || store.loading()"
            (click)="importText()">
            Import Text
          </button>
        } @else {
          <!-- File Mode -->
          <label class="field">
            <span class="label">File Path (absolute)</span>
            <input class="input" type="text" [(ngModel)]="filePath"
              placeholder="/path/to/conversation.jsonl" />
          </label>

          <button class="btn primary" type="button"
            [disabled]="!filePath().trim() || !wing().trim() || store.loading()"
            (click)="importFile()">
            Import File
          </button>
        }

        @if (store.loading()) {
          <div class="hint">Importing...</div>
        }

        @if (lastResult()) {
          <div class="result-card">
            <div class="panel-title">Import Result</div>
            <div class="stat-row"><span>Segments</span><span class="num">{{ lastResult()!.segmentsCreated }}</span></div>
            <div class="stat-row"><span>Format</span><span>{{ lastResult()!.formatDetected }}</span></div>
            <div class="stat-row"><span>Duration</span><span>{{ lastResult()!.duration }}ms</span></div>
            @if (lastResult()!.errors.length > 0) {
              <div class="error-list">
                @for (err of lastResult()!.errors; track $index) {
                  <div class="error-line">{{ err }}</div>
                }
              </div>
            }
          </div>
        }
      </div>

      <!-- Recent Imports Feed -->
      @if (store.importEvents().length > 0) {
        <div class="panel-card">
          <div class="panel-title">Recent Imports</div>
          <ul class="list compact">
            @for (evt of store.importEvents(); track $index) {
              <li>
                <span class="mono small">{{ evt.sourceFile }}</span>
                <span class="muted">{{ evt.segmentsCreated }} segments ({{ evt.format }})</span>
              </li>
            }
          </ul>
        </div>
      }
    </div>
  `,
  styles: [`
    .import-panel {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
    }

    .panel-card {
      padding: var(--spacing-md);
      border-radius: var(--radius-md);
      border: 1px solid var(--border-color);
      background: var(--bg-secondary);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }

    .panel-title {
      font-size: 13px;
      font-weight: 600;
    }

    .mode-toggle {
      display: flex;
      gap: 0;
      border-radius: var(--radius-sm);
      overflow: hidden;
      border: 1px solid var(--border-color);
      width: fit-content;
    }

    .toggle-btn {
      padding: var(--spacing-xs) var(--spacing-md);
      font-size: 12px;
      border: none;
      background: var(--bg-primary);
      color: var(--text-muted);
      cursor: pointer;
    }

    .toggle-btn.active {
      background: var(--primary-color);
      color: #fff;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .label {
      font-size: 11px;
      color: var(--text-muted);
    }

    .input {
      width: 100%;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-primary);
      color: var(--text-primary);
      padding: var(--spacing-xs) var(--spacing-sm);
      font-size: 12px;
    }

    .textarea {
      resize: vertical;
      font-family: var(--font-mono, monospace);
      min-height: 120px;
    }

    select.input {
      appearance: auto;
    }

    .btn {
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      padding: var(--spacing-xs) var(--spacing-sm);
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
      align-self: flex-start;
    }

    .btn.primary {
      background: var(--primary-color);
      border-color: var(--primary-color);
      color: #fff;
    }

    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .format-badge {
      font-size: 11px;
      padding: var(--spacing-xs) var(--spacing-sm);
      border-radius: var(--radius-sm);
      background: rgba(74, 222, 128, 0.1);
      border: 1px solid rgba(74, 222, 128, 0.2);
      color: #4ade80;
      width: fit-content;
    }

    .result-card {
      padding: var(--spacing-sm);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-primary);
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .stat-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 2px 0;
      font-size: 12px;
    }

    .num {
      font-variant-numeric: tabular-nums;
      font-weight: 600;
    }

    .hint {
      font-size: 12px;
      color: var(--text-muted);
      font-style: italic;
    }

    .muted {
      color: var(--text-muted);
      font-size: 11px;
    }

    .mono {
      font-family: var(--font-mono, monospace);
      font-size: 11px;
    }

    .small {
      font-size: 10px;
      word-break: break-all;
    }

    .error-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .error-line {
      font-size: 11px;
      color: #f87171;
    }

    .list {
      list-style: none;
      padding: 0;
      margin: 0;
    }

    .list li {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-xs);
      padding: 4px 0;
      font-size: 12px;
      border-bottom: 1px solid var(--border-color);
    }

    .list.compact li {
      padding: 2px 0;
      font-size: 11px;
    }
  `],
})
export class ConversationImportComponent {
  protected store = inject(KnowledgeStore);

  protected mode = signal<'text' | 'file'>('text');
  protected wing = signal('');
  protected sourceName = signal('');
  protected textContent = signal('');
  protected formatOverride = signal('');
  protected filePath = signal('');
  protected detectedFormat = signal('');
  protected lastResult = signal<{
    segmentsCreated: number;
    filesProcessed: number;
    formatDetected: string;
    errors: string[];
    duration: number;
  } | null>(null);

  private detectTimeout: ReturnType<typeof setTimeout> | null = null;

  onTextChange(): void {
    const content = this.textContent().trim();
    if (content.length < 20) {
      this.detectedFormat.set('');
      return;
    }

    // Debounce format detection
    if (this.detectTimeout) {
      clearTimeout(this.detectTimeout);
    }
    this.detectTimeout = setTimeout(async () => {
      const format = await this.store.detectFormat(content);
      this.detectedFormat.set(format ?? '');
    }, 500);
  }

  async importText(): Promise<void> {
    const content = this.textContent().trim();
    const wingVal = this.wing().trim();
    const sourceFile = this.sourceName().trim();
    if (!content || !wingVal || !sourceFile) return;

    const format = this.formatOverride() || undefined;
    const result = await this.store.importConversationString(content, wingVal, sourceFile, format);
    if (result) {
      this.lastResult.set(result);
      this.textContent.set('');
      this.detectedFormat.set('');
    }
  }

  async importFile(): Promise<void> {
    const path = this.filePath().trim();
    const wingVal = this.wing().trim();
    if (!path || !wingVal) return;

    const result = await this.store.importConversationFile(path, wingVal);
    if (result) {
      this.lastResult.set(result);
      this.filePath.set('');
    }
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/app/features/knowledge/conversation-import.component.ts
git commit -m "feat(ui): add conversation import component — text paste, file import, format auto-detect"
```

---

## Task 6: Integrate Sub-Components into Knowledge Page

Embed the wake management and conversation import components into the knowledge page, replacing the old view-only panels. Add tab navigation to organize the growing page.

**Files:**
- Modify: `src/renderer/app/features/knowledge/knowledge-page.component.ts`

- [ ] **Step 1: Read the current component state**

Read `src/renderer/app/features/knowledge/knowledge-page.component.ts` fully to see the state after Task 3 edits.

- [ ] **Step 2: Add imports for sub-components**

Update the imports at the top of the file. After the existing imports, add:

```typescript
import { WakeManagementComponent } from './wake-management.component';
import { ConversationImportComponent } from './conversation-import.component';
```

Update the `imports` array in the `@Component` decorator to:

```typescript
  imports: [CommonModule, FormsModule, WakeManagementComponent, ConversationImportComponent],
```

- [ ] **Step 3: Add tab navigation state**

After the existing `predicateQuery` signal (added in Task 3), add:

```typescript
  protected activeTab = signal<'graph' | 'wake' | 'import'>('graph');
```

- [ ] **Step 4: Replace the template**

Replace the entire template (everything between `template: \`` and the closing `` \``, ``) with the new tabbed layout. The template structure is:

Replace the opening of the `<div class="content">` section and everything inside it (the `.main-panel` and `.side-panel` divs) with the tabbed version. Specifically, find:

```html
      <div class="content">
```

And replace from there through the closing `</div>` of `.content` (this is the div containing `.main-panel` and `.side-panel`) with:

```html
      <!-- Tab Bar -->
      <div class="tab-bar">
        <button class="tab" type="button"
          [class.active]="activeTab() === 'graph'"
          (click)="activeTab.set('graph')">
          Knowledge Graph
        </button>
        <button class="tab" type="button"
          [class.active]="activeTab() === 'wake'"
          (click)="activeTab.set('wake')">
          Wake Context
        </button>
        <button class="tab" type="button"
          [class.active]="activeTab() === 'import'"
          (click)="activeTab.set('import')">
          Conversation Import
        </button>
      </div>

      <div class="content">
        @switch (activeTab()) {
          @case ('graph') {
            <div class="main-panel">
              <!-- Entity Facts (existing) -->
              <div class="panel-card full-width">
                <div class="panel-title" style="display: flex; justify-content: space-between; align-items: center;">
                  <span>
                    @if (store.selectedEntity(); as entity) {
                      Facts for "{{ entity }}"
                    } @else {
                      Entity Facts
                    }
                  </span>
                  <button class="btn btn-sm" type="button" (click)="showAddFact.set(!showAddFact())">
                    {{ showAddFact() ? 'Cancel' : '+ Add Fact' }}
                  </button>
                </div>

                @if (showAddFact()) {
                  <div class="inline-form">
                    <div class="form-row">
                      <label class="field">
                        <span class="label">Subject</span>
                        <input class="input" type="text" [(ngModel)]="newSubject" placeholder="e.g. my_project" />
                      </label>
                      <label class="field">
                        <span class="label">Predicate</span>
                        <input class="input" type="text" [(ngModel)]="newPredicate" placeholder="e.g. uses_database" />
                      </label>
                      <label class="field">
                        <span class="label">Object</span>
                        <input class="input" type="text" [(ngModel)]="newObject" placeholder="e.g. PostgreSQL" />
                      </label>
                    </div>
                    <div class="form-row">
                      <label class="field">
                        <span class="label">Confidence (0-1)</span>
                        <input class="input" type="number" [(ngModel)]="newConfidence" min="0" max="1" step="0.1" placeholder="0.9" />
                      </label>
                      <label class="field">
                        <span class="label">Valid From (ISO)</span>
                        <input class="input" type="text" [(ngModel)]="newValidFrom" placeholder="2025-01-01" />
                      </label>
                      <div class="field" style="justify-content: flex-end;">
                        <button class="btn primary" type="button"
                          [disabled]="!newSubject() || !newPredicate() || !newObject() || store.loading()"
                          (click)="addFact()">
                          Add Fact
                        </button>
                      </div>
                    </div>
                  </div>
                }

                @if (store.loading()) {
                  <div class="hint">Loading...</div>
                } @else if (store.entityFacts().length > 0) {
                  <table class="fact-table">
                    <thead>
                      <tr>
                        <th>Subject</th>
                        <th>Predicate</th>
                        <th>Object</th>
                        <th>Confidence</th>
                        <th>Validity</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (fact of store.entityFacts(); track $index) {
                        <tr>
                          <td class="mono">{{ fact.subject }}</td>
                          <td class="mono predicate">{{ fact.predicate }}</td>
                          <td>{{ fact.object }}</td>
                          <td class="num">
                            {{ fact.confidence !== null && fact.confidence !== undefined ? (fact.confidence * 100).toFixed(0) + '%' : '-' }}
                          </td>
                          <td class="muted">
                            @if (fact.validFrom) {
                              {{ fact.validFrom }}
                            } @else {
                              now
                            }
                            @if (fact.validTo) {
                              - {{ fact.validTo }}
                            }
                          </td>
                          <td>
                            @if (!fact.validTo) {
                              <button class="btn btn-sm btn-danger" type="button"
                                (click)="invalidateFact(fact)">
                                Invalidate
                              </button>
                            }
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                } @else {
                  <div class="hint">Search for an entity to inspect its facts and timeline.</div>
                }
              </div>

              <!-- Timeline -->
              @if (store.timeline().length > 0) {
                <div class="panel-card full-width">
                  <div class="panel-title">Timeline for "{{ store.selectedEntity() }}"</div>
                  <div class="timeline">
                    @for (entry of store.timeline(); track $index) {
                      <div class="timeline-entry">
                        <span class="timeline-dot"></span>
                        <span class="mono">{{ entry.predicate }}</span>
                        <span>-> {{ entry.object }}</span>
                        @if (entry.validFrom) {
                          <span class="muted">({{ entry.validFrom }})</span>
                        }
                      </div>
                    }
                  </div>
                </div>
              }

              <!-- Relationship Results -->
              @if (store.relationshipResults().length > 0) {
                <div class="panel-card full-width">
                  <div class="panel-title">Relationship: "{{ store.selectedPredicate() }}"</div>
                  <table class="fact-table">
                    <thead>
                      <tr>
                        <th>Subject</th>
                        <th>Object</th>
                        <th>Confidence</th>
                        <th>Current</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (result of store.relationshipResults(); track $index) {
                        <tr>
                          <td class="mono">{{ result.subject }}</td>
                          <td>{{ result.object }}</td>
                          <td class="num">{{ result.confidence != null ? (result.confidence * 100).toFixed(0) + '%' : '-' }}</td>
                          <td>
                            <span [class]="result.current ? 'badge-success' : 'muted'">
                              {{ result.current ? 'Yes' : 'No' }}
                            </span>
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              }

              <!-- Recent Facts (live feed) -->
              @if (store.recentFacts().length > 0) {
                <div class="panel-card full-width">
                  <div class="panel-title">Recent Facts (Live)</div>
                  <ul class="list">
                    @for (fact of store.recentFacts(); track fact.tripleId) {
                      <li>
                        <span class="mono">{{ fact.subject }}</span>
                        <span class="predicate">{{ fact.predicate }}</span>
                        <span>{{ fact.object }}</span>
                      </li>
                    }
                  </ul>
                </div>
              }
            </div>

            <div class="side-panel">
              <!-- KG Stats -->
              <div class="panel-card">
                <div class="panel-title">Graph Stats</div>
                @if (store.stats(); as stats) {
                  <div class="stat-row"><span>Entities</span><span class="num">{{ stats.entities }}</span></div>
                  <div class="stat-row"><span>Facts</span><span class="num">{{ stats.triples }}</span></div>
                  <div class="stat-row"><span>Current facts</span><span class="num">{{ stats.currentFacts }}</span></div>
                  <div class="stat-row"><span>Expired facts</span><span class="num">{{ stats.expiredFacts }}</span></div>
                } @else {
                  <div class="hint">Stats unavailable.</div>
                }
              </div>

              <!-- Mining Status -->
              <div class="panel-card">
                <div class="panel-title">Codebase Mining</div>
                @if (store.miningStatus(); as miningStatus) {
                  <div class="stat-row">
                    <span>Status</span>
                    <span [class]="miningStatus.mined ? 'badge-success' : 'badge-pending'">
                      {{ miningStatus.mined ? 'Mined' : 'Pending' }}
                    </span>
                  </div>
                  <div class="stat-row">
                    <span>Path</span>
                    <span class="mono small">{{ miningStatus.normalizedPath }}</span>
                  </div>
                } @else {
                  <div class="hint">No mining status available.</div>
                }

                <div class="mine-actions">
                  <label class="field">
                    <span class="label">Directory</span>
                    <input
                      class="input"
                      type="text"
                      [(ngModel)]="mineDir"
                      placeholder="/path/to/project"
                    />
                  </label>
                  <button class="btn" type="button" [disabled]="store.loading() || !mineDir()" (click)="triggerMine()">
                    Mine
                  </button>
                </div>
              </div>
            </div>
          }

          @case ('wake') {
            <div class="tab-content-full">
              <app-wake-management />
            </div>
          }

          @case ('import') {
            <div class="tab-content-full">
              <app-conversation-import />
            </div>
          }
        }
      </div>
```

- [ ] **Step 5: Add tab styles**

In the styles block, before the `@media` query, add:

```css

    .tab-bar {
      display: flex;
      gap: 0;
      border-bottom: 1px solid var(--border-color);
    }

    .tab {
      padding: var(--spacing-sm) var(--spacing-md);
      font-size: 13px;
      border: none;
      background: none;
      color: var(--text-muted);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: color 0.15s, border-color 0.15s;
    }

    .tab.active {
      color: var(--text-primary);
      border-bottom-color: var(--primary-color);
    }

    .tab:hover {
      color: var(--text-primary);
    }

    .tab-content-full {
      grid-column: 1 / -1;
      max-width: 700px;
    }
```

- [ ] **Step 6: Update the `.content` grid to handle the tab views**

The existing `.content` grid style needs to stay as-is for the `graph` tab (2-column layout), but the `wake` and `import` tabs use `.tab-content-full` which spans full width. No CSS changes needed — the `grid-column: 1 / -1` on `.tab-content-full` handles it. However, update the `.content` rule to use `min-height: 0` to prevent overflow:

The existing `.content` CSS (around line 351) already has `min-height: 0` and `flex: 1` — no changes needed.

- [ ] **Step 7: Remove old wake context and import panels from the graph side-panel**

Since wake context management moved to its own tab, remove the old view-only "Wake Context" panel from the graph tab's side-panel. In the side-panel section of the template (inside `@case ('graph')`), the old wake context panel and import events panel should NOT be included — they're now in their own tabs. The template in Step 4 already handles this correctly (the side-panel only contains "Graph Stats" and "Codebase Mining").

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 9: Commit**

```bash
git add src/renderer/app/features/knowledge/knowledge-page.component.ts
git commit -m "feat(ui): integrate wake management and conversation import tabs into knowledge page"
```

---

## Task 7: Final Verification

- [ ] **Step 1: Typecheck both configs**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 2: Run all memory tests**

Run: `npx vitest run src/tests/unit/memory/ src/tests/integration/memory/`
Expected: All pass (66+ tests)

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 4: Run full test suite**

Run: `npm run test`
Expected: No NEW failures beyond the pre-existing 8

- [ ] **Step 5: Verify WAKE_LIST_HINTS pipeline**

Trace:
1. `WakeContextBuilder.listHints(room?)` — queries wake_hints table, returns `WakeHint[]`
2. `WAKE_LIST_HINTS` channel in `memory.channels.ts` and `ipc.types.ts`
3. `WakeListHintsPayloadSchema` in `ipc-schemas.ts`
4. `registerWakeContextHandlers()` handles `WAKE_LIST_HINTS`
5. `memory.preload.ts` has `wakeListHints` invoke
6. `MemoryIpcService.wakeListHints()` calls preload
7. `KnowledgeStore.listHints()` calls service, updates `_wakeHints` signal

- [ ] **Step 6: Verify all write paths exist**

Check each write action has the full chain:
- Add fact: store.addFact → memoryIpc.kgAddFact → preload → handler → KnowledgeGraphService
- Invalidate fact: store.invalidateFact → memoryIpc.kgInvalidateFact → preload → handler
- Query relationship: store.queryRelationship → memoryIpc.kgQueryRelationship → preload → handler
- Set identity: store.setIdentity → memoryIpc.wakeSetIdentity → preload → handler
- Add hint: store.addHint → memoryIpc.wakeAddHint → preload → handler
- Remove hint: store.removeHint → memoryIpc.wakeRemoveHint → preload → handler
- List hints: store.listHints → memoryIpc.wakeListHints → preload → handler
- Import string: store.importConversationString → memoryIpc.convoImportString → preload → handler
- Import file: store.importConversationFile → memoryIpc.convoImportFile → preload → handler
- Detect format: store.detectFormat → memoryIpc.convoDetectFormat → preload → handler

- [ ] **Step 7: Verify tab navigation**

Confirm the knowledge page has three tabs:
- "Knowledge Graph" — entity browser, facts table with add/invalidate, timeline, relationship query, side panel with stats + mining
- "Wake Context" — identity editor, hints CRUD, wing regeneration
- "Conversation Import" — text paste with format auto-detect, file path import, results display

- [ ] **Step 8: Commit if cleanup needed**

```bash
git add -A
git commit -m "chore: final verification — knowledge UI completion"
```

---

## Summary

| Task | Type | What |
|------|------|------|
| 1 | Backend + wiring | WAKE_LIST_HINTS endpoint — full pipeline from backend to Angular |
| 2 | Store | KnowledgeStore write actions — addFact, invalidateFact, wake CRUD, convo import |
| 3 | UI | Add Fact form + Invalidate buttons + relationship query on knowledge page |
| 4 | UI | Wake management component — identity editor, hint CRUD, wing regeneration |
| 5 | UI | Conversation import component — text paste, file import, format auto-detect |
| 6 | UI | Integrate sub-components with tab navigation into knowledge page |
| 7 | Verify | Final verification — typecheck, tests, lint, pipeline tracing |
