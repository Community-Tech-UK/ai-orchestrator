import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WakeHint } from '../../../../shared/types/wake-context.types';
import { KnowledgeStore } from '../../core/state/knowledge.store';
import { WakeManagementComponent } from './wake-management.component';

const now = Date.now();
const notes: WakeHint[] = [
  { id: 'active', content: 'Use const', importance: 8, room: 'general', createdAt: now, lastUsed: now, usageCount: 3 },
  { id: 'duplicate', content: 'use const', importance: 5, room: 'general', createdAt: now, lastUsed: now, usageCount: 0 },
  { id: 'legacy', content: 'Old note', importance: 5, room: 'general', createdAt: 1, lastUsed: 1, usageCount: 1 },
];
const store = {
  wakeHints: signal(notes), hintCount: () => 3, wakeIdentity: signal('Identity'),
  wakeContext: signal(null), loading: signal(false),
  loadIdentity: vi.fn(), listHints: vi.fn(), loadWakeContext: vi.fn(), removeHint: vi.fn().mockResolvedValue(true),
};

describe('WakeManagementComponent', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await TestBed.configureTestingModule({ imports: [WakeManagementComponent], providers: [{ provide: KnowledgeStore, useValue: store }] }).compileComponents();
  });
  it('shows current unique notes, a weekly summary, and exposes legacy/duplicate notes through Hidden', () => {
    const fixture = TestBed.createComponent(WakeManagementComponent);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('3 notes, 2 different, 1 shown this week');
    expect(root.querySelectorAll('.hint-item')).toHaveLength(1);
    expect(root.textContent).toContain('shown: 3x');
    const hidden = [...root.querySelectorAll('button')].find(button => button.textContent?.includes('Hidden'))!;
    hidden.click(); fixture.detectChanges();
    expect(root.querySelectorAll('.hint-item')).toHaveLength(2);
    expect(root.textContent).toContain('Old note');
  });
  it('requires click-time confirmation with the note before removing it', async () => {
    const fixture = TestBed.createComponent(WakeManagementComponent);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    (root.querySelector('.hint-item button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(store.removeHint).not.toHaveBeenCalled();
    expect(root.querySelector('[role="alertdialog"]')?.textContent).toContain('Removes 1 note (9 characters)');
    (root.querySelector('[role="alertdialog"] .btn-danger') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(store.removeHint).toHaveBeenCalledWith('active');
  });
});
