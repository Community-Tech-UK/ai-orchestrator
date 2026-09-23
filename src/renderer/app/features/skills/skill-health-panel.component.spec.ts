import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { SkillStore } from '../../core/state/skill.store';
import { OrchestrationIpcService } from '../../core/services/ipc/orchestration-ipc.service';
import { SkillHealthPanelComponent } from './skill-health-panel.component';

describe('SkillHealthPanelComponent', () => {
  it('shows the latest oversized skip for a discovered skill with no activation', async () => {
    TestBed.configureTestingModule({
      imports: [SkillHealthPanelComponent],
      providers: [
        { provide: SkillStore, useValue: { controls: signal(new Map()), refreshControls: vi.fn(async () => undefined) } },
        { provide: OrchestrationIpcService, useValue: {
          skillsHealthSummary: vi.fn(async () => ({ success: true, data: {
            summary: [], controls: [],
            catalog: [{ skillName: 'ui-ux-pro-max', source: 'global', effectiveMode: 'enabled' }],
            budgetSkips: [{ id: 'skip-1', skillName: 'ui-ux-pro-max', skillSource: 'global',
              instanceId: 'inst-547', sessionId: 'sess-547', turnKey: 'turn-547',
              reason: 'budget-exceeded', tokens: 10932, budget: 5000, createdAt: Date.now() }],
          } })),
        } },
      ],
    });
    const fixture = TestBed.createComponent(SkillHealthPanelComponent);
    await fixture.componentInstance.refresh();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('not injected');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('10,932');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('5,000');
  });
  it('offers a control for a discovered suggest-only skill with no activations', async () => {
    const controls = signal(new Map());
    const setSkillControl = vi.fn(async () => true);
    TestBed.configureTestingModule({
      imports: [SkillHealthPanelComponent],
      providers: [
        { provide: SkillStore, useValue: { controls, refreshControls: vi.fn(async () => undefined), setSkillControl } },
        { provide: OrchestrationIpcService, useValue: {
          skillsHealthSummary: vi.fn(async () => ({
            success: true,
            data: {
              summary: [],
              controls: [],
              catalog: [{ skillName: 'list-mcp-servers', source: 'global', effectiveMode: 'suggest-only' }],
            },
          })),
        } },
      ],
    });

    const fixture = TestBed.createComponent(SkillHealthPanelComponent);
    await fixture.componentInstance.refresh();
    fixture.detectChanges();

    expect(fixture.componentInstance.rows()).toHaveLength(1);
    expect(fixture.componentInstance.rows()[0].mode).toBe('suggest-only');
    const buttons = [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.mode-btn')];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['On', 'Suggest', 'Off']);
    expect(buttons[1].classList.contains('active')).toBe(true);

    buttons[0].click();
    expect(setSkillControl).toHaveBeenCalledWith('list-mcp-servers', 'enabled', 'set from skill health panel');
  });
});
