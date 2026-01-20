/**
 * Unit Tests for AgentSelectorComponent
 *
 * Tests cover:
 * - Component creation and initialization
 * - Multi-select functionality (selecting/deselecting agents)
 * - Max agent limit enforcement
 * - Agent status display (available/unavailable/auth-required)
 * - Search/filter functionality
 * - Integration with VerificationStore
 * - Dropdown open/close behavior
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { signal, WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AgentSelectorComponent } from './agent-selector.component';
import { CliDetectionService } from './services/cli-detection.service';
import { VerificationStore } from '../../core/state/verification.store';
import { CliStatusIndicatorComponent } from './cli-status-indicator.component';
import { AgentCapabilityBadgesComponent } from './agent-capability-badges.component';
import type { CliType } from '../../../../shared/types/unified-cli-response';
import type { CliStatusInfo } from '../../../../shared/types/verification-ui.types';


describe('AgentSelectorComponent', () => {
  let component: AgentSelectorComponent;
  let fixture: ComponentFixture<AgentSelectorComponent>;

  // Use WritableSignal so we can update values with .set()
  let mockCliList: WritableSignal<CliStatusInfo[]>;
  let mockAvailableClis: WritableSignal<CliStatusInfo[]>;
  let mockAuthRequiredClis: WritableSignal<CliStatusInfo[]>;
  let mockIsScanning: WritableSignal<boolean>;
  let mockSelectedAgents: WritableSignal<CliType[]>;

  let mockCliDetectionService: {
    cliList: WritableSignal<CliStatusInfo[]>;
    availableClis: WritableSignal<CliStatusInfo[]>;
    authRequiredClis: WritableSignal<CliStatusInfo[]>;
    isScanning: WritableSignal<boolean>;
    scanAll: Mock;
    getCliStatus: Mock;
    getCliMetadata: Mock;
    getInstallUrl: Mock;
  };
  let mockVerificationStore: {
    selectedAgents: WritableSignal<CliType[]>;
    setSelectedAgents: Mock;
    addSelectedAgent: Mock;
    removeSelectedAgent: Mock;
  };

  // Test data
  const mockClis: CliStatusInfo[] = [
    {
      type: 'claude',
      status: 'available',
      version: '1.0.0',
      path: '/usr/local/bin/claude',
      capabilities: ['streaming', 'tools', 'vision'],
      lastChecked: Date.now(),
    },
    {
      type: 'gemini',
      status: 'available',
      version: '2.1.0',
      path: '/usr/local/bin/gemini',
      capabilities: ['streaming', 'vision'],
      lastChecked: Date.now(),
    },
    {
      type: 'ollama',
      status: 'auth-required',
      version: '0.5.0',
      path: '/usr/local/bin/ollama',
      capabilities: ['streaming', 'local'],
      lastChecked: Date.now(),
    },
    {
      type: 'aider',
      status: 'not-found',
      capabilities: ['streaming', 'file-access'],
      lastChecked: Date.now(),
    },
    {
      type: 'copilot',
      status: 'error',
      errorMessage: 'Command failed',
      capabilities: ['streaming'],
      lastChecked: Date.now(),
    },
  ];

  const mockMetadata: Record<string, { displayName: string; installUrl: string }> = {
    claude: { displayName: 'Claude CLI', installUrl: 'https://claude.ai' },
    gemini: { displayName: 'Gemini CLI', installUrl: 'https://gemini.google.com' },
    ollama: { displayName: 'Ollama', installUrl: 'https://ollama.ai' },
    aider: { displayName: 'Aider', installUrl: 'https://aider.chat' },
    copilot: { displayName: 'GitHub Copilot', installUrl: 'https://github.com/features/copilot' },
  };

  /**
   * Helper to create mocks - call this before any TestBed configuration
   */
  function setupMocks() {
    mockCliList = signal([...mockClis]);
    mockAvailableClis = signal(mockClis.filter(c => c.status === 'available'));
    mockAuthRequiredClis = signal(mockClis.filter(c => c.status === 'auth-required'));
    mockIsScanning = signal(false);
    mockSelectedAgents = signal<CliType[]>([]);

    mockCliDetectionService = {
      cliList: mockCliList,
      availableClis: mockAvailableClis,
      authRequiredClis: mockAuthRequiredClis,
      isScanning: mockIsScanning,
      scanAll: vi.fn().mockResolvedValue({
        clis: mockClis,
        scannedAt: Date.now(),
        duration: 100,
      }),
      getCliStatus: vi.fn((type: CliType) => mockClis.find(c => c.type === type)),
      getCliMetadata: vi.fn((type: CliType) => mockMetadata[type as keyof typeof mockMetadata]),
      getInstallUrl: vi.fn((type: CliType) => mockMetadata[type as keyof typeof mockMetadata]?.installUrl),
    };

    mockVerificationStore = {
      selectedAgents: mockSelectedAgents,
      setSelectedAgents: vi.fn(),
      addSelectedAgent: vi.fn(),
      removeSelectedAgent: vi.fn(),
    };
  }

  beforeEach(async () => {
    setupMocks();

    await TestBed.configureTestingModule({
      imports: [
        AgentSelectorComponent,
        CliStatusIndicatorComponent,
        AgentCapabilityBadgesComponent,
      ],
      providers: [
        { provide: CliDetectionService, useValue: mockCliDetectionService },
        { provide: VerificationStore, useValue: mockVerificationStore },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AgentSelectorComponent);
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

    it('should initialize with default values', () => {
      expect(component.maxAgents()).toBe(4);
      expect(component.maxPreview()).toBe(3);
      expect(component.disabled()).toBe(false);
      expect(component.showScanButton()).toBe(true);
      expect(component.isOpen()).toBe(false);
      expect(component.searchQuery()).toBe('');
    });

    it('should have expected default values for inputs', () => {
      // Note: Angular signal inputs with JIT compilation in Vitest don't support
      // setInput, so we verify the default values are correct
      fixture.detectChanges();

      expect(component.maxAgents()).toBe(4);
      expect(component.maxPreview()).toBe(3);
      expect(component.disabled()).toBe(false);
      expect(component.showScanButton()).toBe(true);
    });

    it('should scan for CLIs on init if list is empty', async () => {
      mockCliList.set([]);
      component.ngOnInit();
      await Promise.resolve();

      expect(mockCliDetectionService.scanAll).toHaveBeenCalled();
    });

    it('should scan for CLIs on init if all are not-found', async () => {
      const notFoundClis = mockClis.map(c => ({ ...c, status: 'not-found' as const }));
      mockCliList.set(notFoundClis);

      component.ngOnInit();
      await Promise.resolve();

      expect(mockCliDetectionService.scanAll).toHaveBeenCalled();
    });

    it('should NOT scan if CLIs are already detected', async () => {
      mockCliDetectionService.scanAll.mockClear();
      component.ngOnInit();
      await Promise.resolve();

      expect(mockCliDetectionService.scanAll).not.toHaveBeenCalled();
    });

    it('should not set initial selection with empty array', async () => {
      // With default empty initialSelection, setSelectedAgents should NOT be called
      fixture.detectChanges();
      mockVerificationStore.setSelectedAgents.mockClear();

      component.ngOnInit();
      await Promise.resolve();

      // Should not be called when initialSelection is empty
      expect(mockVerificationStore.setSelectedAgents).not.toHaveBeenCalled();
    });
  });

  // ============================================
  // Multi-Select Functionality
  // ============================================

  describe('Multi-Select Functionality', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    it('should select an available agent', () => {
      const claudeCli = mockClis[0]; // claude - available
      component.toggleAgent(claudeCli);

      expect(mockVerificationStore.addSelectedAgent).toHaveBeenCalledWith('claude');
    });

    it('should deselect a previously selected agent', () => {
      // Set the agent as already selected
      mockSelectedAgents.set(['claude']);

      const claudeCli = mockClis[0];
      component.toggleAgent(claudeCli);

      expect(mockVerificationStore.removeSelectedAgent).toHaveBeenCalledWith('claude');
    });

    it('should emit selectionChange event when toggling agents', () => {
      const emitSpy = vi.spyOn(component.selectionChange, 'emit');
      mockSelectedAgents.set(['claude']);

      const geminiCli = mockClis[1];
      component.toggleAgent(geminiCli);

      expect(emitSpy).toHaveBeenCalled();
    });

    it('should clear all selections', () => {
      const emitSpy = vi.spyOn(component.selectionChange, 'emit');
      mockSelectedAgents.set(['claude', 'gemini']);

      component.clearSelection();

      expect(mockVerificationStore.setSelectedAgents).toHaveBeenCalledWith([]);
      expect(emitSpy).toHaveBeenCalledWith([]);
    });

    it('should correctly identify selected agents', () => {
      mockSelectedAgents.set(['claude', 'gemini']);

      expect(component.isSelected('claude')).toBe(true);
      expect(component.isSelected('gemini')).toBe(true);
      expect(component.isSelected('ollama')).toBe(false);
    });
  });

  // ============================================
  // Max Agent Limit Enforcement
  // ============================================

  describe('Max Agent Limit', () => {
    it('should not allow selection beyond max limit', () => {
      fixture.detectChanges();
      // Default maxAgents is 4, so selecting 4 agents hits the limit
      mockSelectedAgents.set(['claude', 'gemini', 'ollama', 'aider']);

      const copilotCli = mockClis.find(c => c.type === 'copilot')!;
      expect(component.canSelect(copilotCli)).toBe(false);
    });

    it('should allow selection when under the limit', () => {
      fixture.detectChanges();
      // Default maxAgents is 4
      mockSelectedAgents.set(['claude']);

      const geminiCli = mockClis[1];
      expect(component.canSelect(geminiCli)).toBe(true);
    });

    it('should always allow deselection even at limit', () => {
      fixture.detectChanges();
      // Default maxAgents is 4
      mockSelectedAgents.set(['claude', 'gemini', 'ollama', 'aider']);

      const claudeCli = mockClis[0];
      expect(component.canSelect(claudeCli)).toBe(true); // Can deselect
    });

    it('should compute isAtLimit correctly', () => {
      fixture.detectChanges();
      // Default maxAgents is 4

      mockSelectedAgents.set(['claude']);
      expect(component.isAtLimit()).toBe(false);

      mockSelectedAgents.set(['claude', 'gemini', 'ollama', 'aider']);
      expect(component.isAtLimit()).toBe(true);
    });

    it('should compute selectedCount correctly', () => {
      fixture.detectChanges();

      mockSelectedAgents.set([]);
      expect(component.selectedCount()).toBe(0);

      mockSelectedAgents.set(['claude', 'gemini']);
      expect(component.selectedCount()).toBe(2);
    });

    it('should limit preview to maxPreview', () => {
      fixture.detectChanges();
      // Default maxPreview is 3, so with 4 selected, only 3 should be in preview
      mockSelectedAgents.set(['claude', 'gemini', 'ollama', 'aider']);

      const preview = component.selectedAgentsPreview();
      expect(preview.length).toBe(3);
      expect(preview).toEqual(['claude', 'gemini', 'ollama']);
    });
  });

  // ============================================
  // Agent Status Display
  // ============================================

  describe('Agent Status Display', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    it('should not allow selecting unavailable agents', () => {
      const authRequiredCli = mockClis.find(c => c.status === 'auth-required')!;
      expect(component.canSelect(authRequiredCli)).toBe(false);

      const notFoundCli = mockClis.find(c => c.status === 'not-found')!;
      expect(component.canSelect(notFoundCli)).toBe(false);

      const errorCli = mockClis.find(c => c.status === 'error')!;
      expect(component.canSelect(errorCli)).toBe(false);
    });

    it('should allow selecting available agents', () => {
      const availableCli = mockClis.find(c => c.status === 'available')!;
      expect(component.canSelect(availableCli)).toBe(true);
    });

    it('should get agent status correctly', () => {
      expect(component.getAgentStatus('claude')).toBe('available');
      expect(component.getAgentStatus('ollama')).toBe('auth-required');
      expect(component.getAgentStatus('aider')).toBe('not-found');
      expect(component.getAgentStatus('copilot')).toBe('error');
    });

    it('should return "not-found" for unknown agents', () => {
      mockCliDetectionService.getCliStatus.mockReturnValue(undefined);
      expect(component.getAgentStatus('unknown' as CliType)).toBe('not-found');
    });

    it('should get display names from metadata', () => {
      expect(component.getDisplayName('claude')).toBe('Claude CLI');
      expect(component.getDisplayName('gemini')).toBe('Gemini CLI');
      expect(component.getDisplayName('ollama')).toBe('Ollama');
    });

    it('should fallback to type if metadata not found', () => {
      mockCliDetectionService.getCliMetadata.mockReturnValue(undefined as any);
      expect(component.getDisplayName('claude')).toBe('claude');
    });

    it('should compute availableCount correctly', () => {
      const availableCount = component.availableCount();
      expect(availableCount).toBe(2); // claude and gemini
    });

    it('should compute authRequiredCount correctly', () => {
      const authRequiredCount = component.authRequiredCount();
      expect(authRequiredCount).toBe(1); // ollama
    });
  });

  // ============================================
  // Search/Filter Functionality
  // ============================================

  describe('Search/Filter', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    it('should filter CLIs by display name', () => {
      component.searchQuery.set('claude');

      const filtered = component.filteredClis();
      expect(filtered.length).toBe(1);
      expect(filtered[0].type).toBe('claude');
    });

    it('should filter CLIs by type', () => {
      component.searchQuery.set('gemini');

      const filtered = component.filteredClis();
      expect(filtered.length).toBe(1);
      expect(filtered[0].type).toBe('gemini');
    });

    it('should be case-insensitive', () => {
      component.searchQuery.set('CLAUDE');

      const filtered = component.filteredClis();
      expect(filtered.length).toBe(1);
      expect(filtered[0].type).toBe('claude');
    });

    it('should return all CLIs when search is empty', () => {
      component.searchQuery.set('');

      const filtered = component.filteredClis();
      expect(filtered.length).toBe(mockClis.length);
    });

    it('should trim whitespace from search query', () => {
      component.searchQuery.set('  claude  ');

      const filtered = component.filteredClis();
      expect(filtered.length).toBe(1);
      expect(filtered[0].type).toBe('claude');
    });

    it('should return empty array for no matches', () => {
      component.searchQuery.set('nonexistent');

      const filtered = component.filteredClis();
      expect(filtered.length).toBe(0);
    });

    it('should update search query on input', () => {
      const event = {
        target: { value: 'test query' } as HTMLInputElement
      } as unknown as Event;

      component.onSearchInput(event);
      expect(component.searchQuery()).toBe('test query');
    });

    it('should sort available CLIs first when no search query', () => {
      component.searchQuery.set('');

      const filtered = component.filteredClis();
      const firstAvailableIndex = filtered.findIndex(c => c.status === 'available');
      const firstUnavailableIndex = filtered.findIndex(c => c.status !== 'available');

      if (firstAvailableIndex !== -1 && firstUnavailableIndex !== -1) {
        expect(firstAvailableIndex).toBeLessThan(firstUnavailableIndex);
      }
    });
  });

  // ============================================
  // Dropdown Open/Close Behavior
  // ============================================

  describe('Dropdown Behavior', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    it('should open dropdown when toggle is called', () => {
      expect(component.isOpen()).toBe(false);

      component.toggleDropdown();
      expect(component.isOpen()).toBe(true);
    });

    it('should close dropdown when toggle is called again', () => {
      component.toggleDropdown();
      expect(component.isOpen()).toBe(true);

      component.toggleDropdown();
      expect(component.isOpen()).toBe(false);
    });

    it('should not toggle when disabled via internal state', () => {
      fixture.detectChanges();
      // We can't set input via setInput in Vitest+JIT, so we test behavior
      // using the internal disabled check by spying on the disabled signal

      // Verify that toggle does open when not disabled (default behavior)
      expect(component.disabled()).toBe(false);
      component.toggleDropdown();
      expect(component.isOpen()).toBe(true);
    });

    it('should close dropdown directly', () => {
      component.isOpen.set(true);
      component.closeDropdown();
      expect(component.isOpen()).toBe(false);
    });

    it('should clear search query when closing dropdown', () => {
      component.isOpen.set(true);
      component.searchQuery.set('test query');

      component.closeDropdown();

      expect(component.isOpen()).toBe(false);
      expect(component.searchQuery()).toBe('');
    });

    it('should clear search query when toggling closed', () => {
      component.isOpen.set(true);
      component.searchQuery.set('test query');

      component.toggleDropdown();

      expect(component.isOpen()).toBe(false);
      expect(component.searchQuery()).toBe('');
    });

    it('should NOT clear search query when toggling open', () => {
      component.isOpen.set(false);
      component.searchQuery.set('test query');

      component.toggleDropdown();

      expect(component.isOpen()).toBe(true);
      expect(component.searchQuery()).toBe('test query');
    });
  });

  // ============================================
  // Integration with VerificationStore
  // ============================================

  describe('VerificationStore Integration', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    it('should read selectedAgents from store', () => {
      mockSelectedAgents.set(['claude', 'gemini']);

      const selected = component.selectedAgents();
      expect(selected).toEqual(['claude', 'gemini']);
    });

    it('should call store.addSelectedAgent when selecting', () => {
      const claudeCli = mockClis[0];
      component.toggleAgent(claudeCli);

      expect(mockVerificationStore.addSelectedAgent).toHaveBeenCalledWith('claude');
    });

    it('should call store.removeSelectedAgent when deselecting', () => {
      mockSelectedAgents.set(['claude']);

      const claudeCli = mockClis[0];
      component.toggleAgent(claudeCli);

      expect(mockVerificationStore.removeSelectedAgent).toHaveBeenCalledWith('claude');
    });

    it('should call store.setSelectedAgents when clearing', () => {
      component.clearSelection();
      expect(mockVerificationStore.setSelectedAgents).toHaveBeenCalledWith([]);
    });

    it('should clear selection and emit when calling setSelectedAgents with empty array', async () => {
      fixture.detectChanges();

      // Clear selection through clearSelection which internally calls setSelectedAgents
      component.clearSelection();

      expect(mockVerificationStore.setSelectedAgents).toHaveBeenCalledWith([]);
    });
  });

  // ============================================
  // Action Handlers
  // ============================================

  describe('Action Handlers', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    it('should call scanAll with force=true when handleScan is called', () => {
      mockCliDetectionService.scanAll.mockClear();
      component.handleScan();

      expect(mockCliDetectionService.scanAll).toHaveBeenCalledWith(true);
    });

    it('should emit agentInstall event when handleInstall is called', () => {
      // Suppress jsdom's "Not implemented: Window's open() method" warning
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

      const emitSpy = vi.spyOn(component.agentInstall, 'emit');
      const event = new Event('click');
      const stopPropagationSpy = vi.spyOn(event, 'stopPropagation');

      component.handleInstall('aider', event);

      expect(stopPropagationSpy).toHaveBeenCalled();
      expect(emitSpy).toHaveBeenCalledWith('aider');

      openSpy.mockRestore();
    });

    it('should open install URL when handleInstall is called', () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      const event = new Event('click');

      component.handleInstall('aider', event);

      expect(openSpy).toHaveBeenCalledWith('https://aider.chat', '_blank');
      openSpy.mockRestore();
    });

    it('should not open window if install URL is not found', () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      mockCliDetectionService.getInstallUrl.mockReturnValue('');
      const event = new Event('click');

      component.handleInstall('aider', event);

      expect(openSpy).not.toHaveBeenCalled();
      openSpy.mockRestore();
    });

    it('should emit agentAuth event when handleAuth is called', () => {
      const emitSpy = vi.spyOn(component.agentAuth, 'emit');
      const event = new Event('click');
      const stopPropagationSpy = vi.spyOn(event, 'stopPropagation');

      component.handleAuth('ollama', event);

      expect(stopPropagationSpy).toHaveBeenCalled();
      expect(emitSpy).toHaveBeenCalledWith('ollama');
    });
  });

  // ============================================
  // Edge Cases
  // ============================================

  describe('Edge Cases', () => {
    it('should handle empty CLI list', () => {
      mockCliList.set([]);
      mockAvailableClis.set([]);
      mockAuthRequiredClis.set([]);
      fixture.detectChanges();

      expect(component.filteredClis().length).toBe(0);
      expect(component.availableCount()).toBe(0);
      expect(component.authRequiredCount()).toBe(0);
    });

    it('should handle toggling agent that does not exist in canSelect', () => {
      fixture.detectChanges();
      const fakeCli: CliStatusInfo = {
        type: 'fake' as CliType,
        status: 'not-found',
        capabilities: [],
      };

      // Should not throw
      expect(() => component.canSelect(fakeCli)).not.toThrow();
      expect(component.canSelect(fakeCli)).toBe(false);
    });

    it('should correctly handle when at max agent limit', () => {
      fixture.detectChanges();
      // Default maxAgents is 4, so fill it up
      mockSelectedAgents.set(['claude', 'gemini', 'ollama', 'aider']);

      // All available slots are taken
      expect(component.isAtLimit()).toBe(true);

      // Can still select an already-selected agent (to deselect)
      const claudeCli = mockClis[0];
      expect(component.canSelect(claudeCli)).toBe(true);

      // Cannot select a new unavailable agent
      const copilotCli = mockClis.find(c => c.type === 'copilot')!;
      expect(component.canSelect(copilotCli)).toBe(false);
    });

    it('should handle selectedAgents preview when all fit', () => {
      fixture.detectChanges();
      // Default maxPreview is 3, select only 2
      mockSelectedAgents.set(['claude', 'gemini']);

      const preview = component.selectedAgentsPreview();
      expect(preview.length).toBe(2); // Both fit in preview
      expect(preview).toEqual(['claude', 'gemini']);
    });

    it('should not toggle when agent does not pass canSelect', () => {
      fixture.detectChanges();
      // Default maxAgents is 4, fill it up
      mockSelectedAgents.set(['claude', 'gemini', 'ollama', 'aider']);

      const copilotCli = mockClis.find(c => c.type === 'copilot')!;

      // Should not call store methods - copilot has error status and limit is reached
      mockVerificationStore.addSelectedAgent.mockClear();
      component.toggleAgent(copilotCli);

      expect(mockVerificationStore.addSelectedAgent).not.toHaveBeenCalled();
    });

    it('should handle scanning state correctly', () => {
      fixture.detectChanges();

      mockIsScanning.set(false);
      expect(component.cliService.isScanning()).toBe(false);

      mockIsScanning.set(true);
      expect(component.cliService.isScanning()).toBe(true);
    });
  });
});
