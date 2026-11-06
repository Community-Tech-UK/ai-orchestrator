/**
 * Spec: CostHistoryRestoreComponent — LT-707 maintenance surface.
 *
 * Drives the explicit restore/undo flow against a mocked CostIpcService:
 * status preview, confirm-before-apply, outcome messages and refresh.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CostHistoryRestoreComponent } from './cost-history-restore.component';
import { CostIpcService } from '../../core/services/ipc/cost-ipc.service';
import type { CostRestoreInspection } from '../../../../shared/types/cost-history-restore.types';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const componentSource = readFileSync(resolve(specDirectory, './cost-history-restore.component.ts'), 'utf8');
const themeSource = readFileSync(resolve(specDirectory, '../../../styles/_theme.scss'), 'utf8');

const STATUS_WITH_DAMAGE: CostRestoreInspection = {
  claudeCutoff: 1_792_222_279_000,
  scopedRows: 913,
  mismatchedRows: 338,
  originalUsd: 4_477.681085460001,
  currentUsd: 3_801.4430545550003,
  unverifiedRows: 0,
};
const STATUS_CLEAN: CostRestoreInspection = {
  claudeCutoff: 1_792_222_279_000,
  scopedRows: 913,
  mismatchedRows: 0,
  originalUsd: 4_477.681085460001,
  currentUsd: 4_477.681085460001,
  unverifiedRows: 0,
};
const STATUS_NO_EVIDENCE: CostRestoreInspection = {
  claudeCutoff: null,
  scopedRows: 0,
  mismatchedRows: 0,
  originalUsd: 0,
  currentUsd: 0,
  unverifiedRows: 0,
};
const STATUS_WITH_UNVERIFIED: CostRestoreInspection = {
  ...STATUS_WITH_DAMAGE,
  unverifiedRows: 8,
};

// The restore and undo summaries cover only the rows the run changed; the
// status preview's dollars cover the whole checked scope. The mock totals are
// deliberately different from the preview's ($3801.44/$4477.68) so a message
// that borrowed the wrong pair fails here.
const CHANGED_ROWS_BEFORE_USD = 3_201.44;
const CHANGED_ROWS_AFTER_USD = 3_877.68;

function buildMockIpc() {
  return {
    costHistoryRestoreStatus: vi.fn().mockResolvedValue({ success: true, data: STATUS_WITH_DAMAGE }),
    costHistoryRestoreApply: vi.fn().mockResolvedValue({
      success: true,
      data: { status: 'restored', rows: 338, beforeUsd: CHANGED_ROWS_BEFORE_USD, afterUsd: CHANGED_ROWS_AFTER_USD },
    }),
    costHistoryRestoreRollback: vi.fn().mockResolvedValue({
      success: true,
      data: { status: 'rolled-back', rows: 338, beforeUsd: CHANGED_ROWS_AFTER_USD, afterUsd: CHANGED_ROWS_BEFORE_USD },
    }),
  };
}

describe('CostHistoryRestoreComponent', () => {
  let component: CostHistoryRestoreComponent;
  let fixture: ComponentFixture<CostHistoryRestoreComponent>;
  let mockIpc: ReturnType<typeof buildMockIpc>;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    mockIpc = buildMockIpc();
    await TestBed.configureTestingModule({
      imports: [CostHistoryRestoreComponent],
      providers: [{ provide: CostIpcService, useValue: mockIpc }],
    }).compileComponents();
    fixture = TestBed.createComponent(CostHistoryRestoreComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('previews the damaged totals and offers a restore', () => {
    expect(mockIpc.costHistoryRestoreStatus).toHaveBeenCalled();
    expect(component.canRestore()).toBe(true);
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('338 of 913');
    expect(text).toContain('$3801.44 recorded versus');
    expect(text).toContain('$4477.68 original');
    expect(text).toContain('Restore original costs');
  });

  it('does not offer a restore when every checked row matches', async () => {
    mockIpc.costHistoryRestoreStatus.mockResolvedValue({ success: true, data: STATUS_CLEAN });
    await component.refresh();
    fixture.detectChanges();
    expect(component.canRestore()).toBe(false);
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('already match');
  });

  it('refuses to offer a restore when the boundary evidence is missing', async () => {
    mockIpc.costHistoryRestoreStatus.mockResolvedValue({ success: true, data: STATUS_NO_EVIDENCE });
    await component.refresh();
    fixture.detectChanges();
    expect(component.canRestore()).toBe(false);
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('cannot be resolved');
  });

  it('confirms before applying, reports the restored totals and refreshes', async () => {
    component.confirming.set(true);
    await component.apply();
    expect(mockIpc.costHistoryRestoreApply).toHaveBeenCalledTimes(1);
    expect(component.confirming()).toBe(false);
    expect(component.message()).toContain('Restored 338 rows ($3201.44 → $3877.68)');
    // The result message reports the changed rows' totals, never the preview's
    // whole-scope sums ($3801.44 → $4477.68).
    expect(component.message()).not.toContain('$3801.44');
    expect(component.message()).not.toContain('$4477.68');
    expect(mockIpc.costHistoryRestoreStatus).toHaveBeenCalledTimes(2);
  });

  it('discloses rows that fail closed on unverifiable evidence', async () => {
    mockIpc.costHistoryRestoreStatus.mockResolvedValue({ success: true, data: STATUS_WITH_UNVERIFIED });
    await component.refresh();
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('8 rows cannot be identified as affected Claude rows');
    expect(text).toContain('stay as they are');
  });

  it('does not disclose unverifiable rows when every row is classified', () => {
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).not.toContain('cannot be identified');
  });

  it('reports a rolled-back failure without claiming restoration', async () => {
    mockIpc.costHistoryRestoreApply.mockResolvedValue({
      success: true,
      data: { status: 'failed', rows: 0, beforeUsd: 0, afterUsd: 0 },
    });
    component.confirming.set(true);
    await component.apply();
    expect(component.message()).toContain('failed and was rolled back');
    expect(component.messageIsError()).toBe(true);
  });

  it('undoes a restoration and says so', async () => {
    await component.rollback();
    expect(mockIpc.costHistoryRestoreRollback).toHaveBeenCalledTimes(1);
    expect(component.message()).toContain('Undid the restoration of 338 rows');
    expect(component.messageIsError()).toBe(false);
  });

  it('reports when there is nothing to undo', async () => {
    mockIpc.costHistoryRestoreRollback.mockResolvedValue({
      success: true,
      data: { status: 'noop', rows: 0, beforeUsd: 0, afterUsd: 0 },
    });
    await component.rollback();
    expect(component.message()).toContain('No restoration to undo');
  });

  it('surfaces IPC errors instead of inventing an outcome', async () => {
    mockIpc.costHistoryRestoreStatus.mockResolvedValue({
      success: false,
      error: { message: 'boom' },
    });
    await component.refresh();
    expect(component.message()).toBe('boom');
    expect(component.messageIsError()).toBe(true);
    expect(component.status()).toBeNull();
  });

  it('keeps a persistent status region in the DOM before any outcome', () => {
    const region = (fixture.nativeElement as HTMLElement).querySelector('.restore-message');
    expect(region).not.toBeNull();
    expect(region!.getAttribute('role')).toBe('status');
    expect(region!.getAttribute('aria-live')).toBe('polite');
    expect(region!.textContent?.trim()).toBe('');
  });

  it('announces a successful restore in the polite status region', async () => {
    component.confirming.set(true);
    await component.apply();
    fixture.detectChanges();
    const region = (fixture.nativeElement as HTMLElement).querySelector('.restore-message')!;
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.classList.contains('error')).toBe(false);
    expect(region.textContent).toContain('Restored 338 rows');
  });

  it('announces a successful undo in the polite status region', async () => {
    await component.rollback();
    fixture.detectChanges();
    const region = (fixture.nativeElement as HTMLElement).querySelector('.restore-message')!;
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toContain('Undid the restoration of 338 rows');
  });

  it('announces a rolled-back restore failure in an assertive alert region', async () => {
    mockIpc.costHistoryRestoreApply.mockResolvedValue({
      success: true,
      data: { status: 'failed', rows: 0, beforeUsd: 0, afterUsd: 0 },
    });
    component.confirming.set(true);
    await component.apply();
    fixture.detectChanges();
    const region = (fixture.nativeElement as HTMLElement).querySelector('.restore-message')!;
    expect(region.getAttribute('role')).toBe('alert');
    expect(region.getAttribute('aria-live')).toBe('assertive');
    expect(region.classList.contains('error')).toBe(true);
    expect(region.textContent).toContain('failed and was rolled back');
  });

  it('announces the missing-boundary refusal in an assertive alert region', async () => {
    mockIpc.costHistoryRestoreApply.mockResolvedValue({
      success: true,
      data: { status: 'missing-cutoff', rows: 0, beforeUsd: 0, afterUsd: 0 },
    });
    component.confirming.set(true);
    await component.apply();
    fixture.detectChanges();
    const region = (fixture.nativeElement as HTMLElement).querySelector('.restore-message')!;
    expect(region.getAttribute('role')).toBe('alert');
    expect(region.getAttribute('aria-live')).toBe('assertive');
    expect(region.textContent).toContain('boundary is unavailable');
  });

  it('announces an undo failure in an assertive alert region', async () => {
    mockIpc.costHistoryRestoreRollback.mockResolvedValue({
      success: true,
      data: { status: 'failed', rows: 0, beforeUsd: 0, afterUsd: 0 },
    });
    await component.rollback();
    fixture.detectChanges();
    const region = (fixture.nativeElement as HTMLElement).querySelector('.restore-message')!;
    expect(region.getAttribute('role')).toBe('alert');
    expect(region.getAttribute('aria-live')).toBe('assertive');
    expect(region.textContent).toContain('Undo failed and was rolled back');
  });

  it('announces a failed status read in an assertive alert region', async () => {
    mockIpc.costHistoryRestoreStatus.mockResolvedValue({
      success: false,
      error: { message: 'boom' },
    });
    await component.refresh();
    fixture.detectChanges();
    const region = (fixture.nativeElement as HTMLElement).querySelector('.restore-message')!;
    expect(region.getAttribute('role')).toBe('alert');
    expect(region.getAttribute('aria-live')).toBe('assertive');
    expect(region.textContent).toBe('boom');
  });
});

function channel(hex: string, offset: number): number {
  const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function contrast(foreground: string, background: string): number {
  const luminance = (hex: string) => (
    0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5)
  );
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

// WCAG pairs for the tokens the card paints from on the Costs page background
// (--bg-primary). Each declaration must still exist in _theme.scss, so a theme
// edit that changes a colour fails here before it can drop contrast unnoticed.
const STATUS_COLOUR_PAIRS = [
  {
    name: 'dark warning text on the Costs page background',
    fg: '#d9a13d',
    fgDeclaration: '--warning-color: #d9a13d',
    bg: '#07100e',
    bgDeclaration: '--bg-primary: #07100e',
  },
  {
    name: 'dark success text on the Costs page background',
    fg: '#4aa06f',
    fgDeclaration: '--success-color: #4aa06f',
    bg: '#07100e',
    bgDeclaration: '--bg-primary: #07100e',
  },
  {
    name: 'dark error text on the Costs page background',
    fg: '#d05f4e',
    fgDeclaration: '--error-color: #d05f4e',
    bg: '#07100e',
    bgDeclaration: '--bg-primary: #07100e',
  },
  {
    name: 'light warning text on the Costs page background',
    fg: '#92400e',
    fgDeclaration: '--pill-warn-fg: #92400e',
    bg: '#fafafa',
    bgDeclaration: '--bg-primary: #fafafa',
  },
  {
    name: 'light success text on the Costs page background',
    fg: '#14532d',
    fgDeclaration: '--pill-ok-fg: #14532d',
    bg: '#fafafa',
    bgDeclaration: '--bg-primary: #fafafa',
  },
  {
    name: 'light error text on the Costs page background',
    fg: '#b91c1c',
    fgDeclaration: '--pill-error-fg: #b91c1c',
    bg: '#fafafa',
    bgDeclaration: '--bg-primary: #fafafa',
  },
];

describe('CostHistoryRestoreComponent status colours', () => {
  it.each(STATUS_COLOUR_PAIRS)('$name clears the 4.5:1 minimum', ({
    fg,
    fgDeclaration,
    bg,
    bgDeclaration,
  }) => {
    expect(themeSource).toContain(fgDeclaration);
    expect(themeSource).toContain(bgDeclaration);
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('paints status text from theme tokens rather than hard-coded colours', () => {
    expect(componentSource).toContain('color: var(--pill-warn-fg)');
    expect(componentSource).toContain('color: var(--pill-ok-fg)');
    expect(componentSource).toContain('color: var(--pill-error-fg)');
    expect(componentSource).not.toContain('#b25000');
    expect(componentSource).not.toContain('#1c7c3c');
  });
});
