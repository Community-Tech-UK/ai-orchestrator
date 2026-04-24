/**
 * Verification Dashboard Component
 *
 * Main entry point for multi-agent verification:
 * - Available agents overview with status
 * - Quick start verification form
 * - Recent verification sessions
 * - Navigation to monitor and results views
 */

import {
  Component,
  inject,
  signal,
  computed,
  ChangeDetectionStrategy,
  OnDestroy,
  ElementRef,
  viewChild,
  AfterViewInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { VerificationStore } from '../../../core/state/verification.store';
import { CliStore } from '../../../core/state/cli.store';
import { ElectronIpcService } from '../../../core/services/ipc';
import { TaskIpcService } from '../../../core/services/ipc/task-ipc.service';
import { DraftService, VERIFICATION_DRAFT_KEY } from '../../../core/services/draft.service';
import { AgentCardComponent } from '../shared/components/agent-card.component';
import { AgentConfigPanelComponent } from '../config/agent-config-panel.component';
import { VerificationMonitorComponent } from '../execution/verification-monitor.component';
import { VerificationResultsComponent } from '../results/verification-results.component';
import { DropZoneComponent } from '../../file-drop/drop-zone.component';
import type { CliType } from '../../../../../shared/types/unified-cli-response';
import type { SynthesisStrategy } from '../../../../../shared/types/verification.types';
import type { TaskPreflightReport } from '../../../../../shared/types/task-preflight.types';
import { TaskPreflightCardComponent } from '../../../shared/components/task-preflight-card.component';

@Component({
  selector: 'app-verification-dashboard',
  standalone: true,
  imports: [
    FormsModule,
    AgentCardComponent,
    AgentConfigPanelComponent,
    VerificationMonitorComponent,
    VerificationResultsComponent,
    DropZoneComponent,
    TaskPreflightCardComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './verification-dashboard.component.html',
  styleUrl: './verification-dashboard.component.scss',
})
export class VerificationDashboardComponent implements OnDestroy, AfterViewInit {
  private router = inject(Router);
  private draftService = inject(DraftService);
  private ipc = inject(ElectronIpcService);
  private taskIpc = inject(TaskIpcService);
  store = inject(VerificationStore);
  cliStore = inject(CliStore);

  // ViewChild for auto-expanding textarea
  private promptTextarea = viewChild<ElementRef<HTMLTextAreaElement>>('promptTextarea');

  // Form state
  promptInput = '';
  selectedStrategy: SynthesisStrategy = 'debate';
  workingDirectory = signal<string | null>(null);
  preflight = signal<TaskPreflightReport | null>(null);
  preflightLoading = signal(false);
  pendingFiles = signal<File[]>([]);
  private filePreviewUrls = new Map<File, string>();

  // UI state
  agentsCollapsed = signal(true);
  isPromptExpanded = signal(false);

  // Computed preview data for pending files
  pendingFilePreviews = computed(() => {
    const files = this.pendingFiles();
    return files.map(file => ({
      file,
      isImage: file.type.startsWith('image/'),
      previewUrl: this.getOrCreatePreviewUrl(file),
      size: this.formatFileSize(file.size),
      icon: this.getFileIcon(file),
    }));
  });

  private getOrCreatePreviewUrl(file: File): string {
    if (!this.filePreviewUrls.has(file)) {
      const url = URL.createObjectURL(file);
      this.filePreviewUrls.set(file, url);
    }
    return this.filePreviewUrls.get(file)!;
  }

  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  // Strategy options with descriptions
  strategies: { value: SynthesisStrategy; label: string; description: string }[] = [
    { value: 'consensus', label: 'Consensus', description: 'Only returns points all agents agree on' },
    { value: 'debate', label: 'Debate', description: 'Agents critique each other over multiple rounds' },
    { value: 'best-of', label: 'Best-of', description: 'Picks the single best response from all agents' },
    { value: 'merge', label: 'Merge', description: 'Combines best parts from each agent response' },
  ];

  // Computed from CliStore
  availableClis = computed(() => this.cliStore.availableClis());

  unavailableClis = computed(() =>
    this.cliStore.clis().filter(cli => !cli.installed)
  );

  totalClis = computed(() => this.cliStore.clis().length);

  isScanning = computed(() => this.cliStore.loading());

  // Filter selected agents to only include available (installed) CLIs
  validSelectedAgents = computed(() => {
    const selected = this.store.selectedAgents();
    const availableNames = this.availableClis().map(cli => cli.name);
    return selected.filter(agent => availableNames.includes(agent));
  });

  constructor() {
    // Load draft on init
    this.promptInput = this.draftService.getDraft(VERIFICATION_DRAFT_KEY);

    // Initialize CLI detection if not already done
    if (!this.cliStore.initialized()) {
      this.cliStore.initialize();
    }

    // Load saved strategy from store config
    const config = this.store.defaultConfig();
    if (config.synthesisStrategy) {
      this.selectedStrategy = config.synthesisStrategy;
    }
  }

  ngAfterViewInit(): void {
    // Auto-expand textarea on initial load if there's content
    setTimeout(() => this.autoExpandTextarea(), 0);
  }

  ngOnDestroy(): void {
    // Save draft when leaving the view
    this.draftService.setDraft(VERIFICATION_DRAFT_KEY, this.promptInput);

    // Clean up all preview URLs
    for (const url of this.filePreviewUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this.filePreviewUrls.clear();
  }

  // ============================================
  // Agent Selection
  // ============================================

  isAgentSelected(name: string): boolean {
    return this.store.selectedAgents().includes(name as CliType);
  }

  toggleAgentSelection(name: string): void {
    const cliType = name as CliType;
    if (this.isAgentSelected(name)) {
      this.store.removeSelectedAgent(cliType);
    } else {
      this.store.addSelectedAgent(cliType);
    }
  }

  canAddMoreAgents(): boolean {
    return this.validSelectedAgents().length < this.availableClis().length;
  }

  showAgentPicker(): void {
    // Show a dropdown or modal to pick additional agents
    // For now, just toggle config panel
    this.store.toggleConfigPanel();
  }

  getAgentDisplayName(agent: string): string {
    const displayNames: Record<string, string> = {
      claude: 'Claude',
      codex: 'Codex',
      gemini: 'Gemini',
      ollama: 'Ollama',
      aider: 'Aider',
      continue: 'Continue',
      cursor: 'Cursor',
      copilot: 'Copilot',
    };
    return displayNames[agent] || agent;
  }

  // ============================================
  // CLI Management
  // ============================================

  rescanClis(): void {
    this.cliStore.refresh();
  }

  openAgentConfig(name: string): void {
    // Open config panel with specific agent selected
    // TODO: Use 'name' to pre-select specific agent in config panel
    void name;
    this.store.toggleConfigPanel();
  }

  openInstallGuide(name: string): void {
    void name;
  }

  // ============================================
  // Working Directory
  // ============================================

  async selectWorkingDirectory(): Promise<void> {
    const folder = await this.ipc.selectFolder();
    if (folder) {
      this.workingDirectory.set(folder);
      await this.refreshPreflight();
    }
  }

  clearWorkingDirectory(): void {
    this.workingDirectory.set(null);
    this.preflight.set(null);
  }

  // ============================================
  // Prompt Textarea
  // ============================================

  autoExpandTextarea(): void {
    const textarea = this.promptTextarea()?.nativeElement;
    if (!textarea) return;

    // Reset height to auto to get the correct scrollHeight
    textarea.style.height = 'auto';

    // Calculate new height (with min and max constraints handled by CSS)
    const newHeight = Math.min(Math.max(textarea.scrollHeight, 100), 500);
    textarea.style.height = `${newHeight}px`;
  }

  toggleExpandedPrompt(): void {
    this.isPromptExpanded.update(v => !v);
    const textarea = this.promptTextarea()?.nativeElement;
    if (textarea) {
      if (this.isPromptExpanded()) {
        textarea.classList.add('expanded');
        textarea.style.height = '300px';
      } else {
        textarea.classList.remove('expanded');
        this.autoExpandTextarea();
      }
    }
  }

  // ============================================
  // Verification
  // ============================================

  canStartVerification(): boolean {
    return (
      this.promptInput.trim().length > 0 &&
      this.validSelectedAgents().length >= 2 &&
      (!this.workingDirectory() || !this.preflightLoading()) &&
      (!this.workingDirectory() || (this.preflight()?.blockers.length || 0) === 0) &&
      !this.store.isRunning()
    );
  }

  onStrategyChange(strategy: SynthesisStrategy): void {
    // Persist to localStorage immediately when user changes strategy
    this.store.setDefaultConfig({ synthesisStrategy: strategy });
    void this.refreshPreflight();
  }

  async startVerification(): Promise<void> {
    if (!this.canStartVerification()) return;

    // Update config with selected strategy
    this.store.setDefaultConfig({
      synthesisStrategy: this.selectedStrategy,
    });

    // Get pending files and working directory before clearing
    const files = this.pendingFiles();
    const workingDir = this.workingDirectory();

    // Start verification with files and working directory
    await this.store.startVerification(
      this.promptInput.trim(),
      undefined,
      files.length > 0 ? files : undefined,
      workingDir || undefined
    );

    // Clear input and draft
    this.promptInput = '';
    this.draftService.clearDraft(VERIFICATION_DRAFT_KEY);
    this.pendingFiles.set([]);
    this.workingDirectory.set(null);
    this.isPromptExpanded.set(false);

    // Reset textarea height
    const textarea = this.promptTextarea()?.nativeElement;
    if (textarea) {
      textarea.classList.remove('expanded');
      textarea.style.height = 'auto';
    }
  }

  // ============================================
  // Session Management
  // ============================================

  viewSession(sessionId: string): void {
    this.store.viewSessionResults(sessionId);
  }

  deleteSession(sessionId: string, event: Event): void {
    event.stopPropagation(); // Don't trigger viewSession
    this.store.deleteSession(sessionId);
  }

  truncatePrompt(prompt: string): string {
    return prompt.length > 60 ? prompt.substring(0, 60) + '...' : prompt;
  }

  formatTimeAgo(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);

    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)} days ago`;
    return new Date(timestamp).toLocaleDateString();
  }

  // ============================================
  // Navigation
  // ============================================

  navigateBack(): void {
    this.router.navigate(['/']);
  }

  toggleAgentsCollapsed(): void {
    this.agentsCollapsed.update(v => !v);
  }

  // ============================================
  // Settings & Help
  // ============================================

  openSettings(): void {
    this.store.toggleConfigPanel();
  }

  showHelp(): void {
    // Reserved for a help modal or documentation route.
  }

  // ============================================
  // Draft & File Handling
  // ============================================

  onPromptChange(value: string): void {
    this.promptInput = value;
    this.draftService.setDraft(VERIFICATION_DRAFT_KEY, value);
  }

  onEnterKey(event: Event): void {
    const keyEvent = event as KeyboardEvent;
    // Enter without Shift sends, Shift+Enter adds newline
    if (!keyEvent.shiftKey && this.canStartVerification()) {
      event.preventDefault();
      this.startVerification();
    }
  }

  onFilesDropped(files: File[]): void {
    this.pendingFiles.update(current => [...current, ...files]);
  }

  onImagesPasted(images: File[]): void {
    this.pendingFiles.update(current => [...current, ...images]);
  }

  removeFile(file: File): void {
    // Revoke the preview URL
    const url = this.filePreviewUrls.get(file);
    if (url) {
      URL.revokeObjectURL(url);
      this.filePreviewUrls.delete(file);
    }
    this.pendingFiles.update(current => current.filter(f => f !== file));
  }

  getFileIcon(file: File): string {
    if (file.type.startsWith('image/')) return '🖼️';
    if (file.type.includes('pdf')) return '📄';
    if (file.type.includes('text')) return '📝';
    if (file.type.includes('json') || file.type.includes('javascript')) return '📋';
    return '📎';
  }

  private async refreshPreflight(): Promise<void> {
    const workingDirectory = this.workingDirectory()?.trim();
    if (!workingDirectory) {
      this.preflight.set(null);
      this.preflightLoading.set(false);
      return;
    }

    this.preflightLoading.set(true);
    try {
      const response = await this.taskIpc.taskGetPreflight({
        workingDirectory,
        surface: 'verification',
        taskType: `verification:${this.selectedStrategy}`,
        requiresNetwork: true,
      });

      if (response.success && response.data) {
        this.preflight.set(response.data);
        return;
      }

      this.preflight.set(null);
    } finally {
      this.preflightLoading.set(false);
    }
  }
}
