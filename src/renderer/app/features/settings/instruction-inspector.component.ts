import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { ElectronIpcService } from '../../core/services/ipc';
import { InstructionIpcService } from '../../core/services/ipc/instruction-ipc.service';
import type {
  InstructionResolution,
  ResolvedInstructionSource,
} from '../../../../shared/types/instruction-source.types';

@Component({
  selector: 'app-instruction-inspector',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="instruction-panel">
      <div class="instruction-header">
        <div>
          <div class="instruction-eyebrow">Instructions</div>
          <div class="instruction-title">Resolved Instruction Stack</div>
        </div>
        <div class="instruction-actions">
          <button class="btn" (click)="reloadInstructions()" [disabled]="instructionLoading() || !workingDirectory()">
            Refresh
          </button>
          <button class="btn primary" (click)="generateInstructionDraft()" [disabled]="instructionLoading() || !workingDirectory()">
            Generate Draft
          </button>
          @if (instructionDraftPath()) {
            <button class="btn" (click)="saveInstructionDraft()" [disabled]="instructionSaving()">
              Save Draft
            </button>
          }
        </div>
      </div>

      @if (instructionError()) {
        <div class="error">{{ instructionError() }}</div>
      }

      @if (instructionResolution(); as resolution) {
        <div class="instruction-meta">
          <div class="instruction-pill">Project root: {{ resolution.projectRoot }}</div>
          <div class="instruction-pill">Applied: {{ appliedInstructionCount() }}</div>
          <div class="instruction-pill">Loaded: {{ loadedInstructionCount() }}</div>
        </div>

        @if (resolution.warnings.length > 0) {
          <div class="instruction-warnings">
            @for (warning of resolution.warnings; track warning) {
              <div class="warn">{{ warning }}</div>
            }
          </div>
        }

        <div class="instruction-grid">
          <div class="instruction-sources">
            <div class="instruction-subtitle">Sources</div>
            <div class="instruction-source-list">
              @for (source of resolution.sources; track source.path) {
                <div class="instruction-source" [class.applied]="source.applied">
                  <div class="instruction-source-main">
                    <span class="instruction-source-state" [class.applied]="source.applied" [class.missing]="!source.loaded">
                      {{ instructionSourceState(source) }}
                    </span>
                    <span class="instruction-source-label">{{ source.label }}</span>
                  </div>
                  <div class="instruction-source-path">{{ source.path }}</div>
                  <div class="instruction-source-meta">
                    <span>{{ source.kind }}</span>
                    <span>{{ source.scope }}</span>
                    <span>priority {{ source.priority }}</span>
                  </div>
                  @if (source.matchPatterns?.length) {
                    <div class="instruction-source-detail">
                      applyTo: {{ source.matchPatterns!.join(', ') }}
                    </div>
                  }
                  @if (source.reason) {
                    <div class="instruction-source-detail muted">{{ source.reason }}</div>
                  }
                  @if (source.matchedPaths?.length) {
                    <div class="instruction-source-detail">
                      matched: {{ source.matchedPaths!.join(', ') }}
                    </div>
                  }
                </div>
              }
            </div>
          </div>

          <div class="instruction-preview">
            <div class="instruction-subtitle">Merged Preview</div>
            @if (resolution.mergedContent) {
              <pre class="instruction-pre">{{ resolution.mergedContent }}</pre>
            } @else {
              <div class="placeholder small">No active instruction content resolved for this directory.</div>
            }
          </div>
        </div>
      }

      @if (instructionDraftPath()) {
        <div class="instruction-draft">
          <div class="instruction-subtitle">Migration Draft</div>
          <div class="instruction-draft-path">{{ instructionDraftPath() }}</div>
          <textarea
            class="editor"
            [value]="instructionDraftContent()"
            (input)="onInstructionDraftEdit($event)"
            spellcheck="false"
          ></textarea>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .instruction-panel {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        padding: 14px;
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-lg);
        background: linear-gradient(
          180deg,
          rgba(var(--primary-rgb), 0.08) 0%,
          rgba(0, 0, 0, 0.08) 100%
        );
      }

      .instruction-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--spacing-md);
      }

      .instruction-eyebrow {
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--text-muted);
      }

      .instruction-title {
        margin-top: 4px;
        font-family: var(--font-display);
        font-size: 16px;
        font-weight: 800;
        color: var(--text-primary);
      }

      .instruction-actions {
        display: flex;
        gap: var(--spacing-sm);
        flex-wrap: wrap;
        justify-content: flex-end;
      }

      .instruction-meta {
        display: flex;
        gap: var(--spacing-sm);
        flex-wrap: wrap;
      }

      .instruction-pill {
        padding: 6px 10px;
        border: 1px solid var(--border-subtle);
        border-radius: 999px;
        background: rgba(0, 0, 0, 0.18);
        font-size: 12px;
        color: var(--text-secondary);
      }

      .instruction-warnings {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .instruction-grid {
        display: grid;
        grid-template-columns: minmax(280px, 0.9fr) minmax(0, 1.4fr);
        gap: var(--spacing-md);
      }

      .instruction-sources,
      .instruction-preview,
      .instruction-draft {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      .instruction-subtitle {
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--text-muted);
      }

      .instruction-source-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-height: 320px;
        overflow: auto;
      }

      .instruction-source {
        padding: 10px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: var(--radius-md);
        background: rgba(0, 0, 0, 0.14);
      }

      .instruction-source.applied {
        border-color: rgba(var(--primary-rgb), 0.35);
        background: rgba(var(--primary-rgb), 0.09);
      }

      .instruction-source-main {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
      }

      .instruction-source-state {
        padding: 2px 8px;
        border-radius: 999px;
        background: rgba(245, 158, 11, 0.15);
        color: #fbbf24;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }

      .instruction-source-state.applied {
        background: rgba(16, 185, 129, 0.18);
        color: #6ee7b7;
      }

      .instruction-source-state.missing {
        background: rgba(239, 68, 68, 0.15);
        color: #fca5a5;
      }

      .instruction-source-label {
        font-size: 13px;
        font-weight: 700;
        color: var(--text-primary);
      }

      .instruction-source-path,
      .instruction-draft-path {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
        font-size: 11px;
        color: var(--text-secondary);
        word-break: break-word;
      }

      .instruction-source-meta,
      .instruction-source-detail {
        margin-top: 4px;
        font-size: 11px;
        color: var(--text-muted);
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }

      .instruction-source-detail.muted {
        color: var(--text-muted);
      }

      .instruction-pre {
        margin: 0;
        padding: 12px;
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        background: rgba(0, 0, 0, 0.18);
        color: var(--text-primary);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
        font-size: 12px;
        line-height: 1.45;
        white-space: pre-wrap;
        max-height: 320px;
        overflow: auto;
      }

      .placeholder.small {
        padding: 12px;
        font-size: 12px;
        color: var(--text-muted);
      }

      .btn {
        padding: 8px 12px;
        border: 1px solid var(--border-subtle);
        background: var(--bg-secondary);
        color: var(--text-primary);
        border-radius: var(--radius-md);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .btn:hover:not(:disabled) {
        border-color: var(--primary-color);
        background: rgba(var(--primary-rgb), 0.08);
      }

      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn.primary {
        border-color: transparent;
        background: linear-gradient(
          135deg,
          var(--primary-color) 0%,
          var(--primary-hover) 100%
        );
        color: var(--bg-primary);
      }

      .error {
        margin-top: 8px;
        font-size: 12px;
        color: var(--error-color);
      }

      .warn {
        padding: 10px;
        border-radius: var(--radius-md);
        border: 1px solid rgba(245, 158, 11, 0.35);
        background: rgba(245, 158, 11, 0.08);
        color: #fbbf24;
        font-size: 12px;
      }

      .editor {
        width: 100%;
        height: 340px;
        resize: vertical;
        padding: 12px;
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        background: rgba(0, 0, 0, 0.2);
        color: var(--text-primary);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
          'Liberation Mono', 'Courier New', monospace;
        font-size: 12px;
        line-height: 1.45;
      }

      @media (max-width: 1100px) {
        .instruction-grid {
          grid-template-columns: 1fr;
        }
      }
    `
  ]
})
export class InstructionInspectorComponent {
  private ipc = inject(ElectronIpcService);
  private instructionIpc = inject(InstructionIpcService);

  workingDirectory = input.required<string>();

  instructionResolution = signal<InstructionResolution | null>(null);
  instructionError = signal<string | null>(null);
  instructionLoading = signal(false);
  instructionDraftPath = signal('');
  instructionDraftContent = signal('');
  instructionSaving = signal(false);

  appliedInstructionCount = computed(
    () => this.instructionResolution()?.sources.filter((source) => source.loaded && source.applied).length ?? 0,
  );
  loadedInstructionCount = computed(
    () => this.instructionResolution()?.sources.filter((source) => source.loaded).length ?? 0,
  );

  constructor() {
    effect(() => {
      const wd = this.workingDirectory();
      if (!wd) return;
      void this.reloadInstructions();
    });
  }

  async reloadInstructions(): Promise<void> {
    const wd = this.workingDirectory();
    if (!wd) return;

    this.instructionLoading.set(true);
    this.instructionError.set(null);
    try {
      const response = await this.instructionIpc.resolveInstructions(wd);
      if (!response.success || !response.data) {
        this.instructionError.set(response.error?.message || 'Failed to resolve instructions');
        return;
      }
      this.instructionResolution.set(response.data);
    } catch (error) {
      this.instructionError.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.instructionLoading.set(false);
    }
  }

  async generateInstructionDraft(): Promise<void> {
    const wd = this.workingDirectory();
    if (!wd) return;

    this.instructionLoading.set(true);
    this.instructionError.set(null);
    try {
      const response = await this.instructionIpc.createInstructionDraft(wd);
      if (!response.success || !response.data) {
        this.instructionError.set(response.error?.message || 'Failed to generate instruction draft');
        return;
      }
      this.instructionDraftPath.set(response.data.outputPath);
      this.instructionDraftContent.set(response.data.content);
      this.instructionResolution.set(response.data.resolution);
    } catch (error) {
      this.instructionError.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.instructionLoading.set(false);
    }
  }

  onInstructionDraftEdit(event: Event): void {
    this.instructionDraftContent.set((event.target as HTMLTextAreaElement).value);
  }

  async saveInstructionDraft(): Promise<void> {
    const outputPath = this.instructionDraftPath();
    if (!outputPath) return;

    this.instructionSaving.set(true);
    this.instructionError.set(null);
    try {
      const response = await this.ipc.getApi()?.writeTextFile({
        path: outputPath,
        content: this.instructionDraftContent(),
        createDirs: true,
      });
      if (!response?.success) {
        this.instructionError.set(response?.error?.message || 'Failed to save instruction draft');
        return;
      }
      await this.reloadInstructions();
    } catch (error) {
      this.instructionError.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.instructionSaving.set(false);
    }
  }

  instructionSourceState(source: ResolvedInstructionSource): string {
    if (!source.loaded) return 'missing';
    return source.applied ? 'applied' : 'skipped';
  }
}
