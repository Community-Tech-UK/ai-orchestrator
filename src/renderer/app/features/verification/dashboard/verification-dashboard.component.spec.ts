/**
 * Unit Tests for VerificationDashboardComponent
 *
 * Tests cover:
 * - Component creation and initialization
 * - Tab navigation (dashboard, monitor, results)
 * - Agent selection and display
 * - Quick start form functionality
 * - Strategy selection
 * - Verification launching
 * - Recent sessions display
 * - CLI scanning and status
 * - File drop/paste handling
 * - Draft persistence
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Component,
  EventEmitter,
  Input,
  Output,
  signal,
  ɵresolveComponentResources as resolveComponentResources,
  WritableSignal,
} from '@angular/core';
import {
  ComponentFixture,
  TestBed
} from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { VerificationDashboardComponent } from './verification-dashboard.component';
import { VerificationStore } from '../../../core/state/verification.store';
import { CliStore } from '../../../core/state/cli.store';
import {
  DraftService,
  VERIFICATION_DRAFT_KEY
} from '../../../core/services/draft.service';
import type { CliType } from '../../../../../shared/types/unified-cli-response';
import type {
  SynthesisStrategy,
  VerificationResult
} from '../../../../../shared/types/verification.types';

@Component({
  selector: 'app-agent-card',
  standalone: true,
  template: ''
})
class AgentCardStubComponent {
  @Input() cli: unknown;
  @Input() selected = false;
  @Input() unavailable = false;
  @Output() agentSelect = new EventEmitter<void>();
  @Output() configure = new EventEmitter<void>();
  @Output() install = new EventEmitter<void>();
}

@Component({
  selector: 'app-agent-config-panel',
  standalone: true,
  template: ''
})
class AgentConfigPanelStubComponent {
  @Output() closePanel = new EventEmitter<void>();
}

@Component({
  selector: 'app-verification-monitor',
  standalone: true,
  template: ''
})
class VerificationMonitorStubComponent {}

@Component({
  selector: 'app-verification-results',
  standalone: true,
  template: ''
})
class VerificationResultsStubComponent {}

@Component({
  selector: 'app-drop-zone',
  standalone: true,
  template: '<ng-content></ng-content>'
})
class DropZoneStubComponent {
  @Output() filesDropped = new EventEmitter<File[]>();
  @Output() imagesPasted = new EventEmitter<File[]>();
}

@Component({
  selector: 'app-task-preflight-card',
  standalone: true,
  template: ''
})
class TaskPreflightCardStubComponent {
  @Input() report: unknown;
  @Input() loading = false;
  @Input() title = '';
  @Input() subtitle = '';
  @Input() emptyMessage = '';
}

const specDirectory = dirname(fileURLToPath(import.meta.url));
const dashboardTemplate = readFileSync(
  resolve(specDirectory, './verification-dashboard.component.html'),
  'utf8'
);
const dashboardStyles = readFileSync(
  resolve(specDirectory, './verification-dashboard.component.scss'),
  'utf8'
);
const verificationResultsTemplate = readFileSync(
  resolve(specDirectory, '../results/verification-results.component.html'),
  'utf8'
);
const verificationResultsStyles = readFileSync(
  resolve(specDirectory, '../results/verification-results.component.scss'),
  'utf8'
);

// Vitest does not run Angular CLI's resource inliner, so resolve external
// component resources before TestBed imports this standalone component.
await resolveComponentResources((url) => {
  if (url.endsWith('verification-dashboard.component.html')) {
    return Promise.resolve(dashboardTemplate);
  }

  if (url.endsWith('verification-dashboard.component.scss')) {
    return Promise.resolve(dashboardStyles);
  }

  if (url.endsWith('verification-results.component.html')) {
    return Promise.resolve(verificationResultsTemplate);
  }

  if (url.endsWith('verification-results.component.scss')) {
    return Promise.resolve(verificationResultsStyles);
  }

  return Promise.reject(new Error(`Unexpected component resource: ${url}`));
});

describe('VerificationDashboardComponent', () => {
  let component: VerificationDashboardComponent;
  let fixture: ComponentFixture<VerificationDashboardComponent>;

  // Mock store signals
  let mockSelectedTab: WritableSignal<'dashboard' | 'monitor' | 'results'>;
  let mockIsRunning: WritableSignal<boolean>;
  let mockResult: WritableSignal<VerificationResult | null>;
  let mockSelectedAgents: WritableSignal<CliType[]>;
  let mockConfigPanelOpen: WritableSignal<boolean>;
  let mockDefaultConfig: WritableSignal<{
    synthesisStrategy: SynthesisStrategy;
  }>;
  let mockRecentSessions: WritableSignal<
    {
      id: string;
      prompt: string;
      config: { agentCount: number; synthesisStrategy: string };
      startedAt: Date;
      status: string;
    }[]
  >;

  // Mock CLI store signals
  let mockClis: WritableSignal<
    { name: string; installed: boolean; version?: string }[]
  >;
  let mockAvailableClis: WritableSignal<
    { name: string; installed: boolean; version?: string }[]
  >;
  let mockCliLoading: WritableSignal<boolean>;
  let mockCliInitialized: WritableSignal<boolean>;

  let mockVerificationStore: {
    selectedTab: WritableSignal<'dashboard' | 'monitor' | 'results'>;
    isRunning: WritableSignal<boolean>;
    result: WritableSignal<VerificationResult | null>;
    selectedAgents: WritableSignal<CliType[]>;
    configPanelOpen: WritableSignal<boolean>;
    defaultConfig: WritableSignal<{ synthesisStrategy: SynthesisStrategy }>;
    recentSessions: WritableSignal<
      {
        id: string;
        prompt: string;
        config: { agentCount: number; synthesisStrategy: string };
        startedAt: Date;
        status: string;
      }[]
    >;
    setSelectedTab: Mock;
    toggleConfigPanel: Mock;
    closeConfigPanel: Mock;
    addSelectedAgent: Mock;
    removeSelectedAgent: Mock;
    setDefaultConfig: Mock;
    startVerification: Mock;
    deleteSession: Mock;
    loadSession: Mock;
  };

  let mockCliStore: {
    clis: WritableSignal<
      { name: string; installed: boolean; version?: string }[]
    >;
    availableClis: WritableSignal<
      { name: string; installed: boolean; version?: string }[]
    >;
    loading: WritableSignal<boolean>;
    initialized: WritableSignal<boolean>;
    initialize: Mock;
    refresh: Mock;
  };

  let mockDraftService: {
    getDraft: Mock;
    setDraft: Mock;
    clearDraft: Mock;
  };

  let mockRouter: {
    navigate: Mock;
  };

  // Test data
  const mockCliList = [
    { name: 'claude', installed: true, version: '1.0.0' },
    { name: 'gemini', installed: true, version: '2.0.0' },
    { name: 'ollama', installed: true, version: '0.5.0' },
    { name: 'codex', installed: false },
    { name: 'aider', installed: false }
  ];

  const mockSessionsList = [
    {
      id: 'session-1',
      prompt: 'What is the best framework for building web apps?',
      config: { agentCount: 3, synthesisStrategy: 'debate' },
      startedAt: new Date('2025-01-23T10:00:00Z'),
      status: 'complete'
    },
    {
      id: 'session-2',
      prompt: 'Compare Python vs JavaScript for data analysis',
      config: { agentCount: 2, synthesisStrategy: 'consensus' },
      startedAt: new Date('2025-01-22T15:30:00Z'),
      status: 'complete'
    }
  ];

  /**
   * Helper to create mocks
   */
  function setupMocks() {
    mockSelectedTab = signal<'dashboard' | 'monitor' | 'results'>('dashboard');
    mockIsRunning = signal(false);
    mockResult = signal<VerificationResult | null>(null);
    mockSelectedAgents = signal<CliType[]>(['claude', 'gemini']);
    mockConfigPanelOpen = signal(false);
    mockDefaultConfig = signal({
      synthesisStrategy: 'debate' as SynthesisStrategy
    });
    mockRecentSessions = signal([...mockSessionsList]);

    mockClis = signal([...mockCliList]);
    mockAvailableClis = signal(mockCliList.filter((c) => c.installed));
    mockCliLoading = signal(false);
    mockCliInitialized = signal(true);

    mockVerificationStore = {
      selectedTab: mockSelectedTab,
      isRunning: mockIsRunning,
      result: mockResult,
      selectedAgents: mockSelectedAgents,
      configPanelOpen: mockConfigPanelOpen,
      defaultConfig: mockDefaultConfig,
      recentSessions: mockRecentSessions,
      setSelectedTab: vi.fn((tab) => mockSelectedTab.set(tab)),
      toggleConfigPanel: vi.fn(() => mockConfigPanelOpen.update((v) => !v)),
      closeConfigPanel: vi.fn(() => mockConfigPanelOpen.set(false)),
      addSelectedAgent: vi.fn((agent) =>
        mockSelectedAgents.update((a) => [...a, agent])
      ),
      removeSelectedAgent: vi.fn((agent) =>
        mockSelectedAgents.update((a) => a.filter((x) => x !== agent))
      ),
      setDefaultConfig: vi.fn((config) =>
        mockDefaultConfig.update((c) => ({ ...c, ...config }))
      ),
      startVerification: vi.fn().mockResolvedValue(undefined),
      deleteSession: vi.fn(),
      loadSession: vi.fn()
    };

    mockCliStore = {
      clis: mockClis,
      availableClis: mockAvailableClis,
      loading: mockCliLoading,
      initialized: mockCliInitialized,
      initialize: vi.fn(),
      refresh: vi.fn()
    };

    mockDraftService = {
      getDraft: vi.fn().mockReturnValue(''),
      setDraft: vi.fn(),
      clearDraft: vi.fn()
    };

    mockRouter = {
      navigate: vi.fn()
    };
  }

  beforeEach(async () => {
    setupMocks();

    TestBed.overrideComponent(VerificationDashboardComponent, {
      set: {
        template: dashboardTemplate,
        templateUrl: undefined,
        styles: [dashboardStyles],
        styleUrl: undefined,
        styleUrls: [],
        imports: [
          FormsModule,
          AgentCardStubComponent,
          AgentConfigPanelStubComponent,
          VerificationMonitorStubComponent,
          VerificationResultsStubComponent,
          DropZoneStubComponent,
          TaskPreflightCardStubComponent,
        ],
      }
    });

    await TestBed.configureTestingModule({
      imports: [VerificationDashboardComponent],
      providers: [
        { provide: VerificationStore, useValue: mockVerificationStore },
        { provide: CliStore, useValue: mockCliStore },
        { provide: DraftService, useValue: mockDraftService },
        { provide: Router, useValue: mockRouter }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(VerificationDashboardComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  // ============================================
  // Component Creation & Initialization
  // ============================================

  describe('Component Creation', () => {
    it('should create the component', () => {
      expect(component).toBeTruthy();
    });

    it('should load draft on construction', () => {
      expect(mockDraftService.getDraft).toHaveBeenCalledWith(
        VERIFICATION_DRAFT_KEY
      );
    });

    it('should initialize CLI store if not initialized', () => {
      // Must set before component creation since init happens in constructor
      mockCliInitialized.set(false);
      mockCliStore.initialize.mockClear();
      fixture = TestBed.createComponent(VerificationDashboardComponent);
      component = fixture.componentInstance;
      expect(mockCliStore.initialize).toHaveBeenCalled();
    });

    it('should NOT initialize CLI store if already initialized', () => {
      // initialized is true by default in setupMocks, constructor already ran
      expect(mockCliStore.initialize).not.toHaveBeenCalled();
    });

    it('should load saved strategy from store config', () => {
      // Must set before component creation since init happens in constructor
      mockDefaultConfig.set({ synthesisStrategy: 'consensus' });
      fixture = TestBed.createComponent(VerificationDashboardComponent);
      component = fixture.componentInstance;
      expect(component.selectedStrategy).toBe('consensus');
    });
  });

  // ============================================
  // Tab Navigation
  // ============================================

  describe('Tab Navigation', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    it('should display dashboard tab by default', () => {
      expect(mockSelectedTab()).toBe('dashboard');
    });

    it('should have all navigation tabs', () => {
      const tabs = fixture.nativeElement.querySelectorAll('.tab-btn');
      expect(tabs.length).toBe(3); // dashboard, monitor, results
    });

    it('should highlight active tab', () => {
      const activeTab = fixture.nativeElement.querySelector('.tab-btn.active');
      expect(activeTab?.textContent).toContain('Dashboard');
    });

    it('should disable monitor tab when not running', () => {
      const monitorTab = fixture.nativeElement.querySelectorAll('.tab-btn')[1];
      expect(monitorTab?.disabled).toBe(true);
    });

    it('should enable monitor tab when running', () => {
      mockIsRunning.set(true);
      fixture.detectChanges();
      const monitorTab = fixture.nativeElement.querySelectorAll('.tab-btn')[1];
      expect(monitorTab?.disabled).toBe(false);
    });

    it('should disable results tab when no result', () => {
      const resultsTab = fixture.nativeElement.querySelectorAll('.tab-btn')[2];
      expect(resultsTab?.disabled).toBe(true);
    });

    it('should enable results tab when result exists', () => {
      mockResult.set({ id: 'test' } as VerificationResult);
      fixture.detectChanges();
      const resultsTab = fixture.nativeElement.querySelectorAll('.tab-btn')[2];
      expect(resultsTab?.disabled).toBe(false);
    });

    it('should show running indicator on monitor tab when running', () => {
      mockIsRunning.set(true);
      fixture.detectChanges();
      const indicator =
        fixture.nativeElement.querySelector('.running-indicator');
      expect(indicator).toBeTruthy();
    });
  });

  // ============================================
  // Agent Selection
  // ============================================

  describe('Agent Selection', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    it('should display available agents', () => {
      const availableCount = component.availableClis().length;
      expect(availableCount).toBe(3); // claude, gemini, ollama
    });

    it('should display unavailable agents', () => {
      const unavailableCount = component.unavailableClis().length;
      expect(unavailableCount).toBe(2); // codex, aider
    });

    it('should identify selected agents', () => {
      expect(component.isAgentSelected('claude')).toBe(true);
      expect(component.isAgentSelected('gemini')).toBe(true);
      expect(component.isAgentSelected('ollama')).toBe(false);
    });

    it('should toggle agent selection', () => {
      component.toggleAgentSelection('ollama');
      expect(mockVerificationStore.addSelectedAgent).toHaveBeenCalledWith(
        'ollama'
      );
    });

    it('should remove agent when already selected', () => {
      component.toggleAgentSelection('claude');
      expect(mockVerificationStore.removeSelectedAgent).toHaveBeenCalledWith(
        'claude'
      );
    });

    it('should compute valid selected agents correctly', () => {
      // Select an unavailable agent
      mockSelectedAgents.set(['claude', 'codex']);
      fixture.detectChanges();

      // Only claude should be valid (installed)
      const validAgents = component.validSelectedAgents();
      expect(validAgents).toContain('claude');
      expect(validAgents).not.toContain('codex');
    });

    it('should display agent count badge', () => {
      const badge = fixture.nativeElement.querySelector('.agents-count-badge');
      expect(badge?.textContent).toContain('3/5');
    });
  });

  // ============================================
  // Quick Start Form
  // ============================================

  describe('Quick Start Form', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    it('should have prompt textarea', () => {
      const textarea = fixture.nativeElement.querySelector('.form-textarea');
      expect(textarea).toBeTruthy();
    });

    it('should have strategy selector', () => {
      const selector = fixture.nativeElement.querySelector('.strategy-cards');
      expect(selector).toBeTruthy();
    });

    it('should display all strategies', () => {
      expect(component.strategies.length).toBe(4);
      expect(component.strategies.map((s) => s.value)).toEqual([
        'consensus',
        'debate',
        'best-of',
        'merge'
      ]);
    });

    it('should update strategy on change', () => {
      component.onStrategyChange('consensus');
      expect(mockVerificationStore.setDefaultConfig).toHaveBeenCalledWith({
        synthesisStrategy: 'consensus'
      });
    });

    it('should have start verification button', () => {
      const startBtn = fixture.nativeElement.querySelector(
        '.action-btn.primary'
      );
      expect(startBtn?.textContent).toContain('Start Verification');
    });
  });

  // ============================================
  // Verification Launching
  // ============================================

  describe('Verification Launching', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    it('should NOT allow start with empty prompt', () => {
      component.promptInput = '';
      expect(component.canStartVerification()).toBe(false);
    });

    it('should NOT allow start with less than 2 agents', () => {
      component.promptInput = 'Test prompt';
      mockSelectedAgents.set(['claude']);
      expect(component.canStartVerification()).toBe(false);
    });

    it('should NOT allow start when already running', () => {
      component.promptInput = 'Test prompt';
      mockIsRunning.set(true);
      expect(component.canStartVerification()).toBe(false);
    });

    it('should allow start with valid input', () => {
      component.promptInput = 'Test prompt';
      mockSelectedAgents.set(['claude', 'gemini']);
      mockIsRunning.set(false);
      expect(component.canStartVerification()).toBe(true);
    });

    it('should call startVerification on store', async () => {
      component.promptInput = 'Test prompt for verification';
      component.selectedStrategy = 'debate';
      await component.startVerification();

      expect(mockVerificationStore.startVerification).toHaveBeenCalledWith(
        'Test prompt for verification',
        undefined,
        undefined,
        undefined
      );
    });

    it('should clear prompt after starting', async () => {
      component.promptInput = 'Test prompt';
      await component.startVerification();

      expect(component.promptInput).toBe('');
    });

    it('should clear draft after starting', async () => {
      component.promptInput = 'Test prompt';
      await component.startVerification();

      expect(mockDraftService.clearDraft).toHaveBeenCalledWith(
        VERIFICATION_DRAFT_KEY
      );
    });

    it('should update default config with strategy before starting', async () => {
      component.promptInput = 'Test prompt';
      component.selectedStrategy = 'consensus';
      await component.startVerification();

      expect(mockVerificationStore.setDefaultConfig).toHaveBeenCalledWith({
        synthesisStrategy: 'consensus'
      });
    });
  });

  // ============================================
  // CLI Scanning
  // ============================================

  describe('CLI Scanning', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    // Helper to find the rescan button (second .action-btn.text in DOM)
    const getRescanButton = (): Element | undefined => {
      const buttons: NodeListOf<Element> = fixture.nativeElement.querySelectorAll('.action-btn.text');
      // Find the one containing "Rescan" or "Scanning"
      return Array.from(buttons).find((btn) =>
        btn.textContent?.includes('Rescan') || btn.textContent?.includes('Scanning')
      );
    };

    it('should have rescan button', () => {
      const rescanBtn = getRescanButton();
      expect(rescanBtn?.textContent).toContain('Rescan');
    });

    it('should call refresh on rescan', () => {
      component.rescanClis();
      expect(mockCliStore.refresh).toHaveBeenCalled();
    });

    it('should show scanning state', () => {
      mockCliLoading.set(true);
      fixture.detectChanges();

      const rescanBtn = getRescanButton();
      expect(rescanBtn?.textContent).toContain('Scanning');
    });

    it('should disable rescan button while scanning', () => {
      mockCliLoading.set(true);
      fixture.detectChanges();

      const rescanBtn = getRescanButton();
      expect(rescanBtn?.hasAttribute('disabled')).toBe(true);
    });
  });

  // ============================================
  // Recent Sessions
  // ============================================

  describe('Recent Sessions', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    it('should display recent sessions', () => {
      const sessions = fixture.nativeElement.querySelectorAll('.session-item');
      expect(sessions.length).toBe(2);
    });

    it('should show session prompt', () => {
      const prompts = fixture.nativeElement.querySelectorAll('.session-prompt');
      expect(prompts[0]?.textContent).toContain('framework');
    });

    it('should show session metadata', () => {
      const agents = fixture.nativeElement.querySelector('.session-agents');
      expect(agents?.textContent).toContain('3 agents');
    });

    it('should show session status', () => {
      const status = fixture.nativeElement.querySelector('.session-status');
      expect(status?.textContent).toContain('complete');
    });

    it('should show empty state when no sessions', () => {
      mockRecentSessions.set([]);
      fixture.detectChanges();

      const emptyState = fixture.nativeElement.querySelector('.empty-state');
      expect(emptyState?.textContent).toContain('No verification sessions');
    });

    it('should truncate long prompts', () => {
      const truncated = component.truncatePrompt(
        'This is a very long prompt that should be truncated for display purposes in the session list'
      );
      expect(truncated.length).toBeLessThan(100);
    });

    it('should format time ago correctly', () => {
      const formatted = component.formatTimeAgo(Date.now());
      expect(formatted).toBeTruthy();
    });
  });

  // ============================================
  // Config Panel
  // ============================================

  describe('Config Panel', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    it('should toggle config panel', () => {
      component.store.toggleConfigPanel();
      expect(mockVerificationStore.toggleConfigPanel).toHaveBeenCalled();
    });

    it('should have advanced options button', () => {
      const advancedBtn =
        fixture.nativeElement.querySelector('.action-btn.text');
      expect(advancedBtn).toBeTruthy();
    });
  });

  // ============================================
  // Draft Persistence
  // ============================================

  describe('Draft Persistence', () => {
    it('should load draft on init', () => {
      mockDraftService.getDraft.mockReturnValue('Saved draft prompt');

      // Recreate component to test constructor
      fixture = TestBed.createComponent(VerificationDashboardComponent);
      component = fixture.componentInstance;

      expect(component.promptInput).toBe('Saved draft prompt');
    });

    it('should save draft on destroy', () => {
      component.promptInput = 'Unsaved work';
      component.ngOnDestroy();

      expect(mockDraftService.setDraft).toHaveBeenCalledWith(
        VERIFICATION_DRAFT_KEY,
        'Unsaved work'
      );
    });
  });

  // ============================================
  // Navigation
  // ============================================

  describe('Navigation', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    it('should have back button', () => {
      const backBtn = fixture.nativeElement.querySelector('.back-btn');
      expect(backBtn).toBeTruthy();
    });

    it('should navigate back on back button click', () => {
      const backSpy = vi.spyOn(component, 'navigateBack');
      const backBtn = fixture.nativeElement.querySelector('.back-btn');
      backBtn?.click();

      expect(backSpy).toHaveBeenCalled();
    });
  });

  // ============================================
  // File Handling
  // ============================================

  describe('File Handling', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    it('should handle dropped files', () => {
      const files = [new File(['test'], 'test.txt', { type: 'text/plain' })];
      component.onFilesDropped(files);

      expect(component.pendingFiles().length).toBe(1);
    });

    it('should handle pasted images', () => {
      const images = [new File(['image'], 'image.png', { type: 'image/png' })];
      component.onImagesPasted(images);

      expect(component.pendingFiles().length).toBe(1);
    });

    it('should remove file from pending', () => {
      const file = new File(['test'], 'test.txt', { type: 'text/plain' });
      component.pendingFiles.set([file]);

      component.removeFile(file);

      expect(component.pendingFiles().length).toBe(0);
    });

    it('should clear pending files after verification', async () => {
      const file = new File(['test'], 'test.txt', { type: 'text/plain' });
      component.pendingFiles.set([file]);
      component.promptInput = 'Test with file';

      await component.startVerification();

      expect(component.pendingFiles().length).toBe(0);
    });
  });

  // ============================================
  // Helper Methods
  // ============================================

  describe('Helper Methods', () => {
    it('should get agent display name', () => {
      expect(component.getAgentDisplayName('claude')).toBe('Claude');
      expect(component.getAgentDisplayName('gemini')).toBe('Gemini');
      expect(component.getAgentDisplayName('unknown')).toBe('unknown');
    });

    it('should check if can add more agents', () => {
      mockSelectedAgents.set(['claude', 'gemini']);
      expect(component.canAddMoreAgents()).toBe(true);

      mockSelectedAgents.set(['claude', 'gemini', 'ollama']);
      expect(component.canAddMoreAgents()).toBe(false);
    });
  });

  // ============================================
  // Collapsible Sections
  // ============================================

  describe('Collapsible Sections', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    it('should toggle agents section collapse', () => {
      const initialState = component.agentsCollapsed();
      component.toggleAgentsCollapsed();
      expect(component.agentsCollapsed()).toBe(!initialState);
    });
  });
});
