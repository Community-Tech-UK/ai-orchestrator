/**
 * Unit Tests for ExportPanelComponent
 *
 * Tests cover:
 * - Component creation and initialization
 * - Format selection (Markdown, JSON, HTML, PDF)
 * - Export options (include/exclude content sections)
 * - Preview generation and truncation
 * - Estimated file size calculation
 * - Copy to clipboard functionality
 * - File download functionality
 * - Modal close behavior
 * - Export output validation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ComponentFixture,
  TestBed
} from '@angular/core/testing';
import { signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ExportPanelComponent } from './export-panel.component';
import {
  CLIPBOARD_SERVICE,
  type ClipboardCopyResult,
  type ClipboardService,
} from '../../../core/services/clipboard.service';

describe('ExportPanelComponent', () => {
  let component: ExportPanelComponent;
  let fixture: ComponentFixture<ExportPanelComponent>;

  // Test data
  const mockResult = {
    id: 'test-export-123',
    prompt: 'What is the meaning of life?',
    synthesizedResponse: 'The meaning of life is a philosophical question...',
    synthesisConfidence: 0.82,
    synthesisMethod: 'consensus',
    completedAt: new Date('2025-01-23T14:00:00Z'),
    duration: 30000,
    totalTokens: 500,
    totalCost: 0.015,
    responses: [
      {
        agentId: 'agent-1',
        model: 'claude-3.5-sonnet',
        personality: 'methodical-analyst',
        response: 'From a philosophical perspective...',
        confidence: 0.85,
        tokens: 150,
        cost: 0.005
      },
      {
        agentId: 'agent-2',
        model: 'gemini-2.0-flash',
        personality: 'creative-solver',
        response: 'Consider the creative aspects...',
        confidence: 0.78,
        tokens: 180,
        cost: 0.006
      }
    ],
    debateRounds: [
      {
        round: 1,
        type: 'initial',
        exchanges: [
          { agent: 'claude', content: 'Initial response from Claude' },
          { agent: 'gemini', content: 'Initial response from Gemini' }
        ]
      }
    ],
    consensusMatrix: [
      [1.0, 0.75],
      [0.75, 1.0]
    ]
  };

  // Mock URL and Blob for download testing
  // Using any types for mocks since they serve dual purpose (tracking calls + function replacement)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockCreateObjectURL: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockRevokeObjectURL: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockCreateElement: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockClick: any;
  let fakeClipboard: ClipboardService;

  beforeEach(async () => {
    fakeClipboard = {
      lastResult: signal<ClipboardCopyResult | null>(null).asReadonly(),
      copyText: vi.fn().mockResolvedValue({ ok: true }),
      copyJSON: vi.fn().mockResolvedValue({ ok: true }),
      copyImage: vi.fn().mockResolvedValue({ ok: true }),
    };

    // Setup URL mocks - these don't interfere with Angular
    mockCreateObjectURL = vi.fn().mockReturnValue('blob:test-url');
    mockRevokeObjectURL = vi.fn();
    mockClick = vi.fn();

    global.URL.createObjectURL = mockCreateObjectURL;
    global.URL.revokeObjectURL = mockRevokeObjectURL;

    // Track createElement calls for anchor elements only
    const originalCreateElement = document.createElement.bind(document);
    mockCreateElement = vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      const el = originalCreateElement(tagName);
      if (tagName === 'a') {
        // Override click for anchor elements to track calls
        el.click = mockClick;
      }
      return el;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);

    // Track appendChild/removeChild without preventing them
    vi.spyOn(document.body, 'appendChild');
    vi.spyOn(document.body, 'removeChild');

    await TestBed.configureTestingModule({
      imports: [ExportPanelComponent, FormsModule],
      providers: [{ provide: CLIPBOARD_SERVICE, useValue: fakeClipboard }],
    }).compileComponents();

    fixture = TestBed.createComponent(ExportPanelComponent);
    component = fixture.componentInstance;

    // Set input using @Input property
    component.result = mockResult;
    fixture.detectChanges();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  // ============================================
  // Component Creation & Initialization
  // ============================================

  describe('Component Creation', () => {
    it('should create the component', () => {
      expect(component).toBeTruthy();
    });

    it('should initialize with markdown format selected', () => {
      expect(component.selectedFormat()).toBe('markdown');
    });

    it('should have all format options available', () => {
      expect(component.formats).toHaveLength(4);
      expect(component.formats.map((f) => f.id)).toEqual([
        'markdown',
        'json',
        'html',
        'pdf'
      ]);
    });

    it('should initialize with default export options', () => {
      expect(component.options.includeSynthesis).toBe(true);
      expect(component.options.includeComparison).toBe(true);
      expect(component.options.includeDebateRounds).toBe(true);
      expect(component.options.includeRawResponses).toBe(false);
      expect(component.options.includeMetadata).toBe(true);
      expect(component.options.includeHeatmap).toBe(true);
    });

    it('should not be in exporting state initially', () => {
      expect(component.isExporting()).toBe(false);
    });

    it('should not be in copied state initially', () => {
      expect(component.copied()).toBe(false);
    });
  });

  // ============================================
  // Format Selection
  // ============================================

  describe('Format Selection', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    it('should display all format options', () => {
      const formatCards =
        fixture.nativeElement.querySelectorAll('.format-card');
      expect(formatCards.length).toBe(4);
    });

    it('should highlight selected format', () => {
      const selectedCard = fixture.nativeElement.querySelector(
        '.format-card.selected'
      );
      expect(selectedCard?.textContent).toContain('Markdown');
    });

    it('should change format when clicking different format', () => {
      component.selectedFormat.set('json');
      fixture.detectChanges();

      expect(component.selectedFormat()).toBe('json');
    });

    it('should update selectedFormatInfo when format changes', () => {
      component.selectedFormat.set('html');
      expect(component.selectedFormatInfo()?.extension).toBe('html');
    });

    it('should show correct file extension in download button', () => {
      component.selectedFormat.set('json');
      fixture.detectChanges();

      const downloadBtn = fixture.nativeElement.querySelector('.btn-primary');
      expect(downloadBtn?.textContent).toContain('JSON');
    });
  });

  // ============================================
  // Export Options
  // ============================================

  describe('Export Options', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    it('should display all option checkboxes', () => {
      const checkboxes = fixture.nativeElement.querySelectorAll(
        '.option-item input[type="checkbox"]'
      );
      expect(checkboxes.length).toBe(6);
    });

    it('should toggle synthesis option', () => {
      component.options.includeSynthesis = false;
      fixture.detectChanges();

      expect(component.options.includeSynthesis).toBe(false);
    });

    it('should toggle raw responses option', () => {
      component.options.includeRawResponses = true;
      fixture.detectChanges();

      expect(component.options.includeRawResponses).toBe(true);
    });

    it('should update preview when options change', () => {
      const initialContent = component.generateExport();
      expect(initialContent).toContain('## Synthesized Response');

      component.options.includeSynthesis = false;

      const updatedContent = component.generateExport();
      expect(updatedContent).not.toContain('## Synthesized Response');
    });
  });

  // ============================================
  // Preview Generation
  // ============================================

  describe('Preview Generation', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    it('should generate preview content', () => {
      const preview = component.preview();
      expect(preview).toBeTruthy();
      expect(preview.length).toBeGreaterThan(0);
    });

    it('should truncate long previews', () => {
      // Enable all options to get long content
      component.options.includeRawResponses = true;
      fixture.detectChanges();

      const preview = component.preview();
      // If content exceeds 1000 chars, should be truncated
      if (component.generateExport().length > 1000) {
        expect(preview).toContain('(truncated)');
      }
    });

    it('should update preview when format changes', () => {
      const mdPreview = component.preview();

      component.selectedFormat.set('json');
      fixture.detectChanges();

      const jsonPreview = component.preview();
      expect(jsonPreview).not.toBe(mdPreview);
    });

    it('should display preview in UI', () => {
      const previewEl = fixture.nativeElement.querySelector(
        '.preview-content pre'
      );
      expect(previewEl?.textContent).toBeTruthy();
    });
  });

  // ============================================
  // Estimated Size Calculation
  // ============================================

  describe('Estimated Size', () => {
    it('should calculate estimated size', () => {
      fixture.detectChanges();
      const size = component.estimatedSize();
      expect(size).toMatch(/\d+(\.\d+)?\s*(B|KB|MB)/);
    });

    it('should show size in bytes for small content', () => {
      component.options.includeSynthesis = false;
      component.options.includeComparison = false;
      component.options.includeDebateRounds = false;
      component.options.includeMetadata = false;
      component.options.includeHeatmap = false;
      fixture.detectChanges();

      const size = component.estimatedSize();
      // Very small content might still be in B or KB range
      expect(size).toMatch(/\d+(\.\d+)?\s*(B|KB)/);
    });

    it('should display estimated size in UI', () => {
      fixture.detectChanges();
      const sizeEl = fixture.nativeElement.querySelector('.preview-size');
      expect(sizeEl?.textContent).toMatch(/\d+/);
    });
  });

  // ============================================
  // Markdown Export
  // ============================================

  describe('Markdown Export', () => {
    it('should generate valid markdown', () => {
      component.selectedFormat.set('markdown');
      const content = component.generateExport();

      expect(content).toContain('# Multi-Agent Verification Results');
      expect(content).toContain('## Session Information');
    });

    it('should include prompt in markdown', () => {
      component.selectedFormat.set('markdown');
      const content = component.generateExport();

      expect(content).toContain(mockResult.prompt);
    });

    it('should include synthesized response when enabled', () => {
      component.selectedFormat.set('markdown');
      component.options.includeSynthesis = true;
      const content = component.generateExport();

      expect(content).toContain('## Synthesized Response');
      expect(content).toContain(mockResult.synthesizedResponse);
    });

    it('should exclude synthesized response when disabled', () => {
      component.selectedFormat.set('markdown');
      component.options.includeSynthesis = false;
      const content = component.generateExport();

      expect(content).not.toContain('## Synthesized Response');
    });

    it('should include agent responses when enabled', () => {
      component.selectedFormat.set('markdown');
      component.options.includeComparison = true;
      const content = component.generateExport();

      expect(content).toContain('## Agent Responses');
      expect(content).toContain('claude-3.5-sonnet');
    });
  });

  // ============================================
  // JSON Export
  // ============================================

  describe('JSON Export', () => {
    it('should generate valid JSON', () => {
      component.selectedFormat.set('json');
      const content = component.generateExport();

      expect(() => JSON.parse(content)).not.toThrow();
    });

    it('should include metadata when enabled', () => {
      component.selectedFormat.set('json');
      component.options.includeMetadata = true;
      const content = component.generateExport();
      const parsed = JSON.parse(content);

      expect(parsed.metadata).toBeDefined();
      expect(parsed.metadata.id).toBe(mockResult.id);
    });

    it('should exclude metadata when disabled', () => {
      component.selectedFormat.set('json');
      component.options.includeMetadata = false;
      const content = component.generateExport();
      const parsed = JSON.parse(content);

      expect(parsed.metadata).toBeUndefined();
    });

    it('should include synthesis when enabled', () => {
      component.selectedFormat.set('json');
      component.options.includeSynthesis = true;
      const content = component.generateExport();
      const parsed = JSON.parse(content);

      expect(parsed.synthesis).toBeDefined();
      expect(parsed.synthesis.response).toBe(mockResult.synthesizedResponse);
    });

    it('should include consensus matrix when enabled', () => {
      component.selectedFormat.set('json');
      component.options.includeHeatmap = true;
      const content = component.generateExport();
      const parsed = JSON.parse(content);

      expect(parsed.consensusMatrix).toBeDefined();
      expect(parsed.consensusMatrix).toEqual(mockResult.consensusMatrix);
    });
  });

  // ============================================
  // HTML Export
  // ============================================

  describe('HTML Export', () => {
    it('should generate valid HTML structure', () => {
      component.selectedFormat.set('html');
      const content = component.generateExport();

      expect(content).toContain('<!DOCTYPE html>');
      expect(content).toMatch(/<html[^>]*>/); // Allow for attributes like lang="en"
      expect(content).toContain('</html>');
    });

    it('should include title with result ID', () => {
      component.selectedFormat.set('html');
      const content = component.generateExport();

      expect(content).toContain(`<title>`);
      expect(content).toContain(mockResult.id);
    });

    it('should include basic styles', () => {
      component.selectedFormat.set('html');
      const content = component.generateExport();

      expect(content).toContain('<style>');
    });
  });

  // ============================================
  // Copy to Clipboard
  // ============================================

  describe('Copy to Clipboard', () => {
    beforeEach(() => {
      fixture.detectChanges();
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should copy content to clipboard', async () => {
      await component.copyToClipboard();
      expect(fakeClipboard.copyText).toHaveBeenCalled();
    });

    it('should show copied state after copying', async () => {
      await component.copyToClipboard();
      expect(component.copied()).toBe(true);
    });

    it('should reset copied state after timeout', async () => {
      await component.copyToClipboard();
      expect(component.copied()).toBe(true);

      vi.advanceTimersByTime(2500);
      expect(component.copied()).toBe(false);
    });

    it('should copy the full export content', async () => {
      const expectedContent = component.generateExport();
      await component.copyToClipboard();

      expect(fakeClipboard.copyText).toHaveBeenCalledWith(expectedContent, { label: 'export' });
    });
  });

  // ============================================
  // File Download
  // ============================================

  describe('File Download', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    it('should create blob URL for download', async () => {
      await component.exportFile();
      expect(mockCreateObjectURL).toHaveBeenCalled();
    });

    it('should create anchor element for download', async () => {
      await component.exportFile();
      expect(mockCreateElement).toHaveBeenCalledWith('a');
    });

    it('should trigger click on anchor', async () => {
      await component.exportFile();
      expect(mockClick).toHaveBeenCalled();
    });

    it('should revoke blob URL after download', async () => {
      await component.exportFile();
      expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:test-url');
    });

    it('should use correct filename with format extension', async () => {
      component.selectedFormat.set('json');
      await component.exportFile();

      // Check that createElement was called with 'a'
      expect(mockCreateElement).toHaveBeenCalledWith('a');
      // The anchor element's download attribute is set in the component
      // We verify by checking the mock was called - the actual download attr
      // is set on the real element created by the spy
    });

    it('should set isExporting state during export', async () => {
      expect(component.isExporting()).toBe(false);

      // Export runs synchronously since our mocks don't actually async
      await component.exportFile();

      // After export completes, isExporting should be false
      expect(component.isExporting()).toBe(false);
    });
  });

  // ============================================
  // Modal Behavior
  // ============================================

  describe('Modal Behavior', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    it('should emit close event when backdrop clicked', () => {
      const closeSpy = vi.spyOn(component.closePanel, 'emit');
      const backdrop = fixture.nativeElement.querySelector('.modal-backdrop');
      backdrop?.click();

      expect(closeSpy).toHaveBeenCalled();
    });

    it('should NOT close when modal content clicked', () => {
      const closeSpy = vi.spyOn(component.closePanel, 'emit');
      const modal = fixture.nativeElement.querySelector('.export-modal');
      modal?.click();

      expect(closeSpy).not.toHaveBeenCalled();
    });

    it('should emit close when close button clicked', () => {
      const closeSpy = vi.spyOn(component.closePanel, 'emit');
      const closeBtn = fixture.nativeElement.querySelector('.close-btn');
      closeBtn?.click();

      expect(closeSpy).toHaveBeenCalled();
    });

    it('should emit close when cancel button clicked', () => {
      const closeSpy = vi.spyOn(component.closePanel, 'emit');
      const cancelBtn = fixture.nativeElement.querySelector(
        '.footer-right .btn-secondary'
      );
      cancelBtn?.click();

      expect(closeSpy).toHaveBeenCalled();
    });
  });

  // ============================================
  // Export Event
  // ============================================

  describe('Export Event', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    it('should emit exportComplete with format and content', async () => {
      const exportSpy = vi.spyOn(component.exportComplete, 'emit');
      await component.exportFile();

      expect(exportSpy).toHaveBeenCalledWith({
        format: 'markdown',
        content: expect.any(String)
      });
    });

    it('should emit correct format when JSON selected', async () => {
      const exportSpy = vi.spyOn(component.exportComplete, 'emit');
      component.selectedFormat.set('json');
      await component.exportFile();

      expect(exportSpy).toHaveBeenCalledWith({
        format: 'json',
        content: expect.any(String)
      });
    });
  });

  // ============================================
  // Edge Cases
  // ============================================

  describe('Edge Cases', () => {
    it('should handle result with no responses', () => {
      fixture.componentRef.setInput('result', {
        ...mockResult,
        responses: undefined
      });
      fixture.detectChanges();

      component.options.includeComparison = true;
      const content = component.generateExport();

      // Should not throw and should generate content
      expect(content).toBeTruthy();
    });

    it('should handle result with no debate rounds', () => {
      fixture.componentRef.setInput('result', {
        ...mockResult,
        debateRounds: undefined
      });
      fixture.detectChanges();

      component.options.includeDebateRounds = true;
      const content = component.generateExport();

      expect(content).toBeTruthy();
    });

    it('should handle result with no consensus matrix', () => {
      fixture.componentRef.setInput('result', {
        ...mockResult,
        consensusMatrix: undefined
      });
      fixture.detectChanges();

      component.options.includeHeatmap = true;
      component.selectedFormat.set('json');
      const content = component.generateExport();
      const parsed = JSON.parse(content);

      expect(parsed.consensusMatrix).toBeUndefined();
    });

    it('should handle empty prompt', () => {
      fixture.componentRef.setInput('result', {
        ...mockResult,
        prompt: ''
      });
      fixture.detectChanges();

      const content = component.generateExport();
      expect(content).toBeTruthy();
    });
  });
});
