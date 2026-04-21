/**
 * Unit Tests for VerificationResultsComponent
 *
 * Tests cover:
 * - Component creation and initialization
 * - Tab navigation (summary, comparison, debate, raw)
 * - Synthesized response display with confidence
 * - Agreement summary rendering
 * - Consensus heatmap display
 * - Debate rounds viewer
 * - Raw response display
 * - Copy to clipboard functionality
 * - Export button integration
 * - Empty state handling
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { Component, Input, signal, WritableSignal } from '@angular/core';
import {
  ComponentFixture,
  TestBed
} from '@angular/core/testing';
import { VerificationResultsComponent } from './verification-results.component';
import { VerificationStore } from '../../../core/state/verification.store';
import type { VerificationResult } from '../../../../../shared/types/verification.types';

@Component({
  selector: 'app-consensus-heatmap',
  standalone: true,
  template: ''
})
class ConsensusHeatmapStubComponent {
  @Input() agents: unknown;
  @Input() matrix: unknown;
}

@Component({
  selector: 'app-streaming-text',
  standalone: true,
  template: '<div class="streaming-text-stub">{{ text }}</div>'
})
class StreamingTextStubComponent {
  @Input() text = '';
  @Input() isStreaming = false;
  @Input() options: unknown;
}

describe('VerificationResultsComponent', () => {
  let component: VerificationResultsComponent;
  let fixture: ComponentFixture<VerificationResultsComponent>;

  // Mock store signals
  let mockResult: WritableSignal<VerificationResult | null>;
  let mockIsRunning: WritableSignal<boolean>;

  let mockVerificationStore: {
    result: WritableSignal<VerificationResult | null>;
    isRunning: WritableSignal<boolean>;
    clearResult: Mock;
    setSelectedTab: Mock;
  };

  // Test data - using correct types from verification.types.ts
  const mockVerificationResult: VerificationResult = {
    id: 'test-verification-123',
    request: {
      id: 'req-123',
      instanceId: 'inst-123',
      prompt: 'What is the best programming language?',
      config: {
        agentCount: 3,
        timeout: 60000,
        synthesisStrategy: 'debate'
      }
    },
    synthesizedResponse:
      'Based on the multi-agent verification, Python is recommended for beginners due to its readability and versatility.',
    synthesisConfidence: 0.85,
    synthesisMethod: 'debate',
    completedAt: Date.now(),
    totalDuration: 45000,
    totalTokens: 470,
    totalCost: 0.0234,
    responses: [
      {
        agentId: 'agent-1',
        agentIndex: 0,
        model: 'claude-3.5-sonnet',
        personality: 'methodical-analyst',
        response:
          'Python offers excellent readability and a gentle learning curve...',
        keyPoints: [
          {
            id: 'kp-1',
            content: 'Python is beginner-friendly',
            category: 'conclusion',
            confidence: 0.9
          }
        ],
        confidence: 0.9,
        duration: 15000,
        tokens: 150,
        cost: 0.0078
      },
      {
        agentId: 'agent-2',
        agentIndex: 1,
        model: 'gemini-2.0-flash',
        personality: 'creative-solver',
        response: 'JavaScript is incredibly versatile for web development...',
        keyPoints: [
          {
            id: 'kp-2',
            content: 'JavaScript is versatile',
            category: 'conclusion',
            confidence: 0.75
          }
        ],
        confidence: 0.75,
        duration: 12000,
        tokens: 120,
        cost: 0.0056
      },
      {
        agentId: 'agent-3',
        agentIndex: 2,
        model: 'llama3.3:70b',
        personality: 'devils-advocate',
        response:
          'The "best" language depends entirely on context and goals...',
        keyPoints: [
          {
            id: 'kp-3',
            content: 'Context matters',
            category: 'opinion',
            confidence: 0.8
          }
        ],
        confidence: 0.8,
        duration: 18000,
        tokens: 200,
        cost: 0.01
      }
    ],
    debateRounds: [
      {
        roundNumber: 1,
        type: 'initial',
        contributions: [
          {
            agentId: 'agent-1',
            content: 'Python is the clear winner for beginners.',
            confidence: 0.9,
            reasoning: 'Based on syntax simplicity'
          },
          {
            agentId: 'agent-2',
            content: 'JavaScript has broader applicability.',
            confidence: 0.8,
            reasoning: 'Runs everywhere'
          },
          {
            agentId: 'agent-3',
            content: 'Context matters more than any single answer.',
            confidence: 0.85,
            reasoning: 'Different use cases'
          }
        ],
        consensusScore: 0.6,
        timestamp: Date.now(),
        durationMs: 10000
      },
      {
        roundNumber: 2,
        type: 'critique',
        contributions: [
          {
            agentId: 'agent-1',
            content: 'While JavaScript is useful, Python has simpler syntax.',
            confidence: 0.85,
            reasoning: 'Comparing syntax complexity',
            critiques: [
              {
                targetAgentId: 'agent-2',
                issue: 'JavaScript setup is complex',
                severity: 'minor'
              }
            ]
          },
          {
            agentId: 'agent-2',
            content: 'But JavaScript runs everywhere without setup.',
            confidence: 0.75,
            reasoning: 'Browser-native execution'
          }
        ],
        consensusScore: 0.7,
        timestamp: Date.now(),
        durationMs: 8000
      }
    ],
    analysis: {
      agreements: [
        {
          point: 'All languages have trade-offs',
          category: 'conclusion',
          strength: 0.9,
          agentIds: ['agent-1', 'agent-2', 'agent-3'],
          combinedConfidence: 0.85
        },
        {
          point: 'Python is beginner-friendly',
          category: 'conclusion',
          strength: 0.7,
          agentIds: ['agent-1', 'agent-3'],
          combinedConfidence: 0.8
        }
      ],
      disagreements: [
        {
          topic: 'Best for web development',
          positions: [
            { agentId: 'agent-1', position: 'Python', confidence: 0.7 },
            { agentId: 'agent-2', position: 'JavaScript', confidence: 0.9 }
          ],
          requiresHumanReview: false
        }
      ],
      uniqueInsights: [],
      responseRankings: [
        {
          agentId: 'agent-1',
          rank: 1,
          score: 0.9,
          criteria: {
            completeness: 0.9,
            accuracy: 0.9,
            clarity: 0.85,
            reasoning: 0.9
          }
        },
        {
          agentId: 'agent-2',
          rank: 2,
          score: 0.8,
          criteria: {
            completeness: 0.8,
            accuracy: 0.8,
            clarity: 0.8,
            reasoning: 0.8
          }
        },
        {
          agentId: 'agent-3',
          rank: 3,
          score: 0.75,
          criteria: {
            completeness: 0.7,
            accuracy: 0.8,
            clarity: 0.75,
            reasoning: 0.75
          }
        }
      ],
      overallConfidence: 0.85,
      outlierAgents: [],
      consensusStrength: 0.8
    }
  };

  /**
   * Helper to create mocks
   */
  function setupMocks() {
    mockResult = signal<VerificationResult | null>(mockVerificationResult);
    mockIsRunning = signal(false);

    mockVerificationStore = {
      result: mockResult,
      isRunning: mockIsRunning,
      clearResult: vi.fn(),
      setSelectedTab: vi.fn()
    };
  }

  beforeEach(async () => {
    setupMocks();

    // Mock clipboard API
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined)
      }
    });

    // Mock URL API for export functionality
    global.URL.createObjectURL = vi.fn().mockReturnValue('blob:test-url');
    global.URL.revokeObjectURL = vi.fn();

    await TestBed.configureTestingModule({
      imports: [VerificationResultsComponent],
      providers: [
        { provide: VerificationStore, useValue: mockVerificationStore }
      ]
    })
      .overrideComponent(VerificationResultsComponent, {
        set: {
          imports: [ConsensusHeatmapStubComponent, StreamingTextStubComponent],
        }
      })
      .compileComponents();

    fixture = TestBed.createComponent(VerificationResultsComponent);
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

    it('should initialize with summary tab selected', () => {
      fixture.detectChanges();
      expect(component.selectedTab()).toBe('summary');
    });

    it('should display result when available', () => {
      fixture.detectChanges();
      const resultEl =
        fixture.nativeElement.querySelector('.results-container');
      expect(resultEl).toBeTruthy();
    });

    it('should show empty state when no result', () => {
      mockResult.set(null);
      fixture.detectChanges();
      const emptyState = fixture.nativeElement.querySelector('.empty-state');
      expect(emptyState).toBeTruthy();
    });
  });

  // ============================================
  // Tab Navigation
  // ============================================

  describe('Tab Navigation', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    it('should have all expected tabs', () => {
      const tabs = fixture.nativeElement.querySelectorAll('.tab-btn');
      expect(tabs.length).toBeGreaterThanOrEqual(3); // summary, comparison, raw (debate only if applicable)
    });

    it('should switch to comparison tab', () => {
      component.selectTab('comparison');
      expect(component.selectedTab()).toBe('comparison');
    });

    it('should switch to debate tab when debate rounds exist', () => {
      component.selectTab('debate');
      expect(component.selectedTab()).toBe('debate');
    });

    it('should switch to raw tab', () => {
      component.selectTab('raw');
      expect(component.selectedTab()).toBe('raw');
    });

    it('should show debate tab only when debate rounds exist', () => {
      const tabNav = fixture.nativeElement.querySelector('.tab-navigation');
      expect(tabNav.textContent).toContain('Debate');
    });

    it('should hide debate tab when no debate rounds', () => {
      mockResult.set({
        ...mockVerificationResult,
        debateRounds: undefined
      });
      fixture.detectChanges();
      const tabNav = fixture.nativeElement.querySelector('.tab-navigation');
      expect(tabNav.textContent).not.toContain('Debate');
    });
  });

  // ============================================
  // Summary Tab Content
  // ============================================

  describe('Summary Tab', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    it('should display synthesized response', () => {
      const synthesis =
        fixture.nativeElement.querySelector('.synthesis-content');
      expect(synthesis).toBeTruthy();
      // The actual text is rendered by StreamingTextComponent (stubbed in tests);
      // verify the component's data has the expected content
      expect(component.result()?.synthesizedResponse).toContain('Python is recommended');
    });

    it('should display confidence badge', () => {
      const badge = fixture.nativeElement.querySelector('.confidence-badge');
      expect(badge?.textContent).toContain('85%');
    });

    it('should apply correct confidence class for high confidence', () => {
      const badge = fixture.nativeElement.querySelector('.confidence-badge');
      expect(badge?.classList.contains('high')).toBe(true);
    });

    it('should apply medium class for medium confidence', () => {
      mockResult.set({
        ...mockVerificationResult,
        synthesisConfidence: 0.55
      });
      fixture.detectChanges();
      const badge = fixture.nativeElement.querySelector('.confidence-badge');
      expect(badge?.classList.contains('medium')).toBe(true);
    });

    it('should apply low class for low confidence', () => {
      mockResult.set({
        ...mockVerificationResult,
        synthesisConfidence: 0.3
      });
      fixture.detectChanges();
      const badge = fixture.nativeElement.querySelector('.confidence-badge');
      expect(badge?.classList.contains('low')).toBe(true);
    });

    it('should display synthesis method', () => {
      const info = fixture.nativeElement.querySelector('.synthesis-info');
      expect(info?.textContent).toContain('debate');
    });

    it('should display agreement summary', () => {
      const agreements =
        fixture.nativeElement.querySelectorAll('.agreement-item');
      expect(agreements.length).toBeGreaterThan(0);
    });
  });

  // ============================================
  // Comparison Tab Content
  // ============================================

  describe('Comparison Tab', () => {
    beforeEach(() => {
      fixture.detectChanges();
      component.selectTab('comparison');
      fixture.detectChanges();
    });

    it('should display agent comparison cards', () => {
      const cards = fixture.nativeElement.querySelectorAll('.comparison-card');
      expect(cards.length).toBe(3); // 3 agents
    });

    it('should show agent names', () => {
      const agentNames = fixture.nativeElement.querySelectorAll('.agent-name');
      const names = Array.from(agentNames).map(
        (el) => (el as HTMLElement).textContent
      );
      expect(names).toContain('claude-3.5-sonnet');
    });

    it('should show agent personalities', () => {
      const personalities =
        fixture.nativeElement.querySelectorAll('.agent-personality');
      expect(personalities.length).toBe(3);
    });

    it('should display comparison cards', () => {
      const comparisonCards = fixture.nativeElement.querySelectorAll(
        '.comparison-card'
      );
      expect(comparisonCards.length).toBe(3); // 3 agents in mock data
    });
  });

  // ============================================
  // Debate Tab Content
  // ============================================

  describe('Debate Tab', () => {
    beforeEach(() => {
      fixture.detectChanges();
      component.selectTab('debate');
      fixture.detectChanges();
    });

    it('should display debate rounds', () => {
      // The component uses round-btn for round selection
      const roundBtns = fixture.nativeElement.querySelectorAll('.round-btn');
      expect(roundBtns.length).toBe(2);
    });

    it('should show round numbers', () => {
      const roundBtns =
        fixture.nativeElement.querySelectorAll('.round-btn');
      expect(roundBtns[0]?.textContent).toContain('Round');
    });

    it('should display round info when selected', () => {
      // Round info shows when a round is selected
      const roundInfo = fixture.nativeElement.querySelector('.round-info');
      expect(roundInfo).toBeTruthy();
    });
  });

  // ============================================
  // Raw Responses Tab
  // ============================================

  describe('Raw Responses Tab', () => {
    beforeEach(() => {
      fixture.detectChanges();
      component.selectTab('raw');
      fixture.detectChanges();
    });

    it('should display all raw responses', () => {
      const rawResponses =
        fixture.nativeElement.querySelectorAll('.raw-response');
      expect(rawResponses.length).toBe(3);
    });

    it('should show full response content', () => {
      const content = fixture.nativeElement.querySelector('.response-content');
      expect(content?.textContent).toContain(
        'Python offers excellent readability'
      );
    });

    it('should have copy button for each response', () => {
      const copyBtns = fixture.nativeElement.querySelectorAll(
        '.raw-response .copy-btn'
      );
      expect(copyBtns.length).toBe(3);
    });
  });

  // ============================================
  // Copy Functionality
  // ============================================

  describe('Copy Functionality', () => {
    beforeEach(() => {
      fixture.detectChanges();
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should copy summary to clipboard', async () => {
      await component.copyContent(
        'summary',
        mockVerificationResult.synthesizedResponse
      );

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        mockVerificationResult.synthesizedResponse
      );
    });

    it('should show copied state after copying', async () => {
      await component.copyContent('summary', 'test content');
      expect(component.isCopied('summary')).toBe(true);
    });

    it('should reset copied state after timeout', async () => {
      await component.copyContent('summary', 'test content');
      expect(component.isCopied('summary')).toBe(true);

      vi.advanceTimersByTime(2500);
      expect(component.isCopied('summary')).toBe(false);
    });

    it('should format agreements text correctly', () => {
      const formatted = component.formatAgreementsText(
        mockVerificationResult.analysis.agreements
      );
      expect(formatted).toContain('All languages have trade-offs');
      // Check for agent names instead of count
      expect(formatted).toContain('agent-1');
    });
  });

  // ============================================
  // Helper Methods
  // ============================================

  describe('Helper Methods', () => {
    it('should format time correctly', () => {
      const formatted = component.formatTime(
        mockVerificationResult.completedAt
      );
      expect(formatted).toBeTruthy();
      expect(typeof formatted).toBe('string');
    });

    it('should format duration correctly', () => {
      const formatted = component.formatDuration(45000);
      expect(formatted).toContain('45');
    });

    it('should format cost correctly', () => {
      const formatted = component.formatCost(0.0234);
      expect(formatted).toContain('0.02');
    });

    it('should get correct confidence class', () => {
      expect(component.getConfidenceClass(0.9)).toBe('high');
      expect(component.getConfidenceClass(0.6)).toBe('medium');
      expect(component.getConfidenceClass(0.3)).toBe('low');
    });

    it('should get agreement icon based on strength', () => {
      expect(component.getAgreementIcon(0.9)).toBeTruthy();
      expect(component.getAgreementIcon(0.6)).toBeTruthy();
      expect(component.getAgreementIcon(0.3)).toBeTruthy();
    });

    it('should format personality correctly', () => {
      const formatted = component.formatPersonality('methodical-analyst');
      expect(formatted).toContain('Methodical');
    });
  });

  // ============================================
  // Actions
  // ============================================

  describe('Actions', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    it('should trigger export when export button clicked', () => {
      const exportSpy = vi.spyOn(component, 'exportResults');
      const exportBtn = fixture.nativeElement.querySelector(
        '.action-btn.secondary'
      );
      exportBtn?.click();
      expect(exportSpy).toHaveBeenCalled();
    });

    it('should navigate to new verification', () => {
      const newVerifySpy = vi.spyOn(component, 'newVerification');
      const newBtn = fixture.nativeElement.querySelector('.action-btn.primary');
      newBtn?.click();
      expect(newVerifySpy).toHaveBeenCalled();
    });

    it('should switch tab on new verification', () => {
      component.newVerification();
      expect(mockVerificationStore.setSelectedTab).toHaveBeenCalledWith(
        'dashboard'
      );
    });
  });

  // ============================================
  // Metadata Display
  // ============================================

  describe('Metadata Display', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    it('should display completion time', () => {
      const meta = fixture.nativeElement.querySelector('.results-meta');
      expect(meta?.textContent).toContain('Completed');
    });

    it('should display duration', () => {
      const meta = fixture.nativeElement.querySelector('.results-meta');
      expect(meta?.textContent).toContain('Duration');
    });

    it('should display total cost', () => {
      const meta = fixture.nativeElement.querySelector('.results-meta');
      expect(meta?.textContent).toContain('Cost');
    });
  });
});
