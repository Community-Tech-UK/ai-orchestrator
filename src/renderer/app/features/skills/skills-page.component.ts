/**
 * Skills Page
 * Container that wires the skills browser to backend discovery/loading APIs.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import type { SkillBundle, SkillMatch } from '../../../../shared/types/skill.types';
import { SkillBrowserComponent } from './skill-browser.component';
import { OrchestrationIpcService } from '../../core/services/ipc/orchestration-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';

interface SkillCardState {
  bundle: SkillBundle;
  installed: boolean;
  loading?: boolean;
}

interface SkillMemorySummary {
  totalSkills: number;
  loadedSkills: number;
  estimatedTokens: number;
}

const DEFAULT_DISCOVERY_PATHS = '.claude/skills\n.codex/skills\nskills';

@Component({
  selector: 'app-skills-page',
  standalone: true,
  imports: [CommonModule, SkillBrowserComponent],
  template: `
    <div class="skills-page">
      <div class="page-header">
        <div class="header-title">
          <span class="title">Skills</span>
          <span class="subtitle">Discover, load, and match skill bundles</span>
        </div>
      </div>

      <div class="controls">
        <label class="field field-wide">
          <span class="label">Discovery Paths</span>
          <textarea
            class="textarea"
            [value]="discoveryPaths()"
            placeholder=".claude/skills"
            (input)="onDiscoveryPathsInput($event)"
          ></textarea>
        </label>

        <div class="actions">
          <button class="btn primary" type="button" [disabled]="working()" (click)="discoverSkills()">
            {{ working() ? 'Working...' : 'Discover Skills' }}
          </button>
          <button class="btn" type="button" [disabled]="working()" (click)="refreshSkills()">
            Refresh List
          </button>
          <button class="btn" type="button" [disabled]="working()" (click)="refreshMemory()">
            Refresh Memory
          </button>
        </div>
      </div>

      @if (errorMessage()) {
        <div class="error-banner">{{ errorMessage() }}</div>
      }

      <div class="layout">
        <div class="main-panel">
          <app-skill-browser
            [skills]="skills()"
            (install)="installSkill($event)"
            (uninstall)="uninstallSkill($event)"
            (details)="loadPreview($event)"
          />
        </div>

        <div class="side-panel">
          <div class="panel-card">
            <div class="panel-title">Skill Matching</div>
            <textarea
              class="textarea small"
              [value]="matchText()"
              placeholder="Describe your task to get trigger recommendations"
              (input)="onMatchTextInput($event)"
            ></textarea>
            <div class="button-row">
              <button class="btn" type="button" [disabled]="working() || matchText().trim().length === 0" (click)="matchSkills()">
                Match Skills
              </button>
            </div>

            @if (matches().length > 0) {
              <div class="matches">
                @for (match of matches(); track match.skill.id + ':' + match.trigger) {
                  <div class="match-item">
                    <span class="match-name">{{ match.skill.metadata.name }}</span>
                    <span class="match-trigger">{{ match.trigger }}</span>
                    <span class="match-confidence">{{ (match.confidence * 100).toFixed(0) }}%</span>
                  </div>
                }
              </div>
            } @else {
              <div class="hint">No match results yet.</div>
            }
          </div>

          <div class="panel-card">
            <div class="panel-title">Skill Memory</div>
            @if (memory(); as mem) {
              <div class="memory-grid">
                <div class="memory-item">
                  <span class="memory-label">Discovered</span>
                  <span class="memory-value">{{ mem.totalSkills }}</span>
                </div>
                <div class="memory-item">
                  <span class="memory-label">Loaded</span>
                  <span class="memory-value">{{ mem.loadedSkills }}</span>
                </div>
                <div class="memory-item">
                  <span class="memory-label">Token Estimate</span>
                  <span class="memory-value">{{ formatNumber(mem.estimatedTokens) }}</span>
                </div>
              </div>
            } @else {
              <div class="hint">Memory summary unavailable.</div>
            }
          </div>

          <div class="panel-card">
            <div class="panel-title">Loaded Preview</div>
            @if (previewTitle()) {
              <div class="preview-title">{{ previewTitle() }}</div>
            }
            @if (previewContent()) {
              <pre class="preview">{{ previewContent() }}</pre>
            } @else {
              <div class="hint">Load a skill and open Details to preview reference/example content.</div>
            }
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: flex;
      width: 100%;
      height: 100%;
    }

    .skills-page {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      gap: var(--spacing-md);
      padding: var(--spacing-lg);
      background: var(--bg-primary);
      color: var(--text-primary);
    }

    .page-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
    }

    .header-title {
      display: flex;
      flex-direction: column;
    }

    .title {
      font-size: 18px;
      font-weight: 700;
    }

    .subtitle {
      font-size: 12px;
      color: var(--text-muted);
    }

    .controls {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      padding: var(--spacing-md);
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .field-wide {
      width: 100%;
    }

    .label {
      font-size: 12px;
      color: var(--text-muted);
    }

    .textarea {
      width: 100%;
      min-height: 72px;
      resize: vertical;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: 12px;
      padding: var(--spacing-xs) var(--spacing-sm);
      font-family: var(--font-family-mono);
    }

    .textarea.small {
      min-height: 62px;
      font-family: var(--font-family-sans);
    }

    .actions {
      display: flex;
      gap: var(--spacing-sm);
      flex-wrap: wrap;
    }

    .btn {
      padding: var(--spacing-xs) var(--spacing-md);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      cursor: pointer;
      font-size: 12px;
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

    .error-banner {
      padding: var(--spacing-sm) var(--spacing-md);
      border: 1px solid color-mix(in srgb, var(--error-color) 60%, transparent);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--error-color) 14%, transparent);
      color: var(--error-color);
      font-size: 12px;
    }

    .layout {
      flex: 1;
      min-height: 0;
      display: grid;
      grid-template-columns: minmax(0, 2fr) minmax(300px, 1fr);
      gap: var(--spacing-md);
    }

    .main-panel {
      min-height: 0;
    }

    .side-panel {
      min-height: 0;
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
    }

    .panel-card {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      padding: var(--spacing-md);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }

    .panel-title {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .button-row {
      display: flex;
      gap: var(--spacing-sm);
    }

    .matches {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .match-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: var(--spacing-xs);
      align-items: center;
      padding: 6px 8px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      font-size: 11px;
    }

    .match-name {
      font-weight: 600;
      color: var(--text-primary);
    }

    .match-trigger {
      color: var(--text-muted);
    }

    .match-confidence {
      color: var(--primary-color);
      font-weight: 700;
    }

    .memory-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: var(--spacing-xs);
    }

    .memory-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 8px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      font-size: 12px;
    }

    .memory-label {
      color: var(--text-muted);
    }

    .memory-value {
      font-weight: 700;
      color: var(--text-primary);
    }

    .preview-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .preview {
      margin: 0;
      max-height: 260px;
      overflow: auto;
      padding: var(--spacing-sm);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-primary);
      white-space: pre-wrap;
      font-size: 12px;
      line-height: 1.5;
    }

    .hint {
      font-size: 12px;
      color: var(--text-muted);
    }

    @media (max-width: 1080px) {
      .layout {
        grid-template-columns: 1fr;
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SkillsPageComponent implements OnInit {
  private readonly orchestrationIpc = inject(OrchestrationIpcService);

  readonly skills = signal<SkillCardState[]>([]);
  readonly installedSkillIds = signal(new Set<string>());
  readonly matches = signal<SkillMatch[]>([]);
  readonly memory = signal<SkillMemorySummary | null>(null);
  readonly discoveryPaths = signal(DEFAULT_DISCOVERY_PATHS);
  readonly matchText = signal('');
  readonly previewTitle = signal('');
  readonly previewContent = signal('');
  readonly errorMessage = signal<string | null>(null);
  readonly working = signal(false);

  readonly discoveredCount = computed(() => this.skills().length);

  async ngOnInit(): Promise<void> {
    await this.refreshSkills();
    await this.refreshMemory();
    if (this.discoveredCount() === 0) {
      await this.discoverSkills();
    }
  }

  async discoverSkills(): Promise<void> {
    const searchPaths = this.parsePaths(this.discoveryPaths());
    if (searchPaths.length === 0 || this.working()) {
      return;
    }

    this.errorMessage.set(null);
    this.working.set(true);
    try {
      const response = await this.orchestrationIpc.skillsDiscover(searchPaths);
      if (!response.success) {
        this.setErrorFromResponse(response, 'Failed to discover skills.');
        return;
      }

      const bundles = this.extractData<SkillBundle[]>(response) || [];
      this.skills.set(this.mapSkillCards(bundles, this.installedSkillIds(), null));
      await this.refreshMemory();
    } finally {
      this.working.set(false);
    }
  }

  async refreshSkills(): Promise<void> {
    if (this.working()) {
      return;
    }

    this.errorMessage.set(null);
    this.working.set(true);
    try {
      const response = await this.orchestrationIpc.skillsList();
      if (!response.success) {
        this.setErrorFromResponse(response, 'Failed to load skills.');
        return;
      }

      const bundles = this.extractData<SkillBundle[]>(response) || [];
      this.skills.set(this.mapSkillCards(bundles, this.installedSkillIds(), null));
    } finally {
      this.working.set(false);
    }
  }

  async installSkill(skill: SkillBundle): Promise<void> {
    if (this.working()) {
      return;
    }

    this.errorMessage.set(null);
    this.markLoading(skill.id, true);
    try {
      const response = await this.orchestrationIpc.skillsLoad(skill.id);
      if (!response.success) {
        this.setErrorFromResponse(response, `Failed to load skill ${skill.metadata.name}.`);
        return;
      }

      this.installedSkillIds.update((prev) => {
        const next = new Set(prev);
        next.add(skill.id);
        return next;
      });
      this.updateInstalledFlags();
      await this.refreshMemory();
    } finally {
      this.markLoading(skill.id, false);
    }
  }

  async uninstallSkill(skill: SkillBundle): Promise<void> {
    if (this.working()) {
      return;
    }

    this.errorMessage.set(null);
    this.markLoading(skill.id, true);
    try {
      const response = await this.orchestrationIpc.skillsUnload(skill.id);
      if (!response.success) {
        this.setErrorFromResponse(response, `Failed to unload skill ${skill.metadata.name}.`);
        return;
      }

      this.installedSkillIds.update((prev) => {
        const next = new Set(prev);
        next.delete(skill.id);
        return next;
      });
      this.updateInstalledFlags();
      await this.refreshMemory();
    } finally {
      this.markLoading(skill.id, false);
    }
  }

  async matchSkills(): Promise<void> {
    const text = this.matchText().trim();
    if (!text || this.working()) {
      return;
    }

    this.errorMessage.set(null);
    this.working.set(true);
    try {
      const response = await this.orchestrationIpc.skillsMatch(text, 10);
      if (!response.success) {
        this.setErrorFromResponse(response, 'Failed to match skills.');
        return;
      }

      const matches = this.extractData<SkillMatch[]>(response) || [];
      this.matches.set(matches);
    } finally {
      this.working.set(false);
    }
  }

  async refreshMemory(): Promise<void> {
    const response = await this.orchestrationIpc.skillsGetMemory();
    if (!response.success) {
      this.memory.set(null);
      return;
    }

    const memory = this.extractData<SkillMemorySummary>(response);
    this.memory.set(memory || null);
  }

  async loadPreview(skill: SkillBundle): Promise<void> {
    this.previewTitle.set('');
    this.previewContent.set('');

    if (!this.installedSkillIds().has(skill.id)) {
      this.previewTitle.set(skill.metadata.name);
      this.previewContent.set('Load this skill first to preview reference or example content.');
      return;
    }

    const referencePath = skill.referencePaths[0];
    if (referencePath) {
      const referenceResponse = await this.orchestrationIpc.skillsLoadReference(
        skill.id,
        referencePath
      );
      if (referenceResponse.success && typeof referenceResponse.data === 'string') {
        this.previewTitle.set(`${skill.metadata.name} • Reference`);
        this.previewContent.set(referenceResponse.data.slice(0, 3000));
        return;
      }
    }

    const examplePath = skill.examplePaths[0];
    if (examplePath) {
      const exampleResponse = await this.orchestrationIpc.skillsLoadExample(
        skill.id,
        examplePath
      );
      if (exampleResponse.success && typeof exampleResponse.data === 'string') {
        this.previewTitle.set(`${skill.metadata.name} • Example`);
        this.previewContent.set(exampleResponse.data.slice(0, 3000));
        return;
      }
    }

    this.previewTitle.set(skill.metadata.name);
    this.previewContent.set('No reference/example preview available for this skill.');
  }

  onDiscoveryPathsInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.discoveryPaths.set(target.value);
  }

  onMatchTextInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.matchText.set(target.value);
  }

  formatNumber(value: number): string {
    if (value >= 1_000_000) {
      return `${(value / 1_000_000).toFixed(1)}M`;
    }
    if (value >= 1_000) {
      return `${(value / 1_000).toFixed(1)}K`;
    }
    return value.toString();
  }

  private parsePaths(raw: string): string[] {
    return raw
      .split(/\n|,/g)
      .map((path) => path.trim())
      .filter((path) => path.length > 0);
  }

  private mapSkillCards(
    bundles: SkillBundle[],
    installedSkillIds: Set<string>,
    loadingSkillId: string | null
  ): SkillCardState[] {
    return bundles.map((bundle) => ({
      bundle,
      installed: installedSkillIds.has(bundle.id),
      loading: loadingSkillId === bundle.id,
    }));
  }

  private markLoading(skillId: string, loading: boolean): void {
    this.skills.update((cards) =>
      cards.map((card) => {
        if (card.bundle.id !== skillId) {
          return card;
        }
        return { ...card, loading };
      })
    );
  }

  private updateInstalledFlags(): void {
    const installedIds = this.installedSkillIds();
    this.skills.update((cards) =>
      cards.map((card) => ({ ...card, installed: installedIds.has(card.bundle.id) }))
    );
  }

  private setErrorFromResponse(response: IpcResponse, fallback: string): void {
    this.errorMessage.set(response.error?.message || fallback);
  }

  private extractData<T>(response: IpcResponse): T | null {
    return response.success ? (response.data as T) : null;
  }
}
