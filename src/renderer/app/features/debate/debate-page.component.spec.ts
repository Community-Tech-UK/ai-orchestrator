import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DebatePageComponent } from './debate-page.component';
import { OrchestrationIpcService } from '../../core/services/ipc/orchestration-ipc.service';

describe('DebatePageComponent', () => {
  let fixture: ComponentFixture<DebatePageComponent>;
  let component: DebatePageComponent;
  let orchestrationIpc: {
    debateStart: ReturnType<typeof vi.fn>;
    debateGetActive: ReturnType<typeof vi.fn>;
    debateGetStats: ReturnType<typeof vi.fn>;
    debateGetResult: ReturnType<typeof vi.fn>;
    debateCancel: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    orchestrationIpc = {
      debateStart: vi.fn(),
      debateGetActive: vi.fn().mockResolvedValue({ success: true, data: [] }),
      debateGetStats: vi.fn().mockResolvedValue({ success: true, data: null }),
      debateGetResult: vi.fn().mockResolvedValue({ success: true, data: null }),
      debateCancel: vi.fn().mockResolvedValue({ success: true, data: true }),
    };

    await TestBed.configureTestingModule({
      imports: [DebatePageComponent],
      providers: [
        { provide: Router, useValue: { navigate: vi.fn() } },
        { provide: OrchestrationIpcService, useValue: orchestrationIpc },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(DebatePageComponent);
    component = fixture.componentInstance;
  });

  it('defaults debate fanout to 2 agents and 2 rounds', () => {
    expect(component.agents()).toBe(2);
    expect(component.maxRounds()).toBe(2);
  });

  it('falls back invalid input to the bounded debate defaults', () => {
    component.onAgentsChange({ target: { value: 'not-a-number' } } as unknown as Event);
    component.onRoundsChange({ target: { value: 'not-a-number' } } as unknown as Event);

    expect(component.agents()).toBe(2);
    expect(component.maxRounds()).toBe(2);
  });

  it('starts debates with the default 2-agent, 2-round config', async () => {
    vi.useFakeTimers();
    orchestrationIpc.debateStart.mockResolvedValue({ success: true, data: 'debate-1' });
    component.query.set('Should we merge this?');

    try {
      await component.startDebate();

      expect(orchestrationIpc.debateStart).toHaveBeenCalledWith({
        query: 'Should we merge this?',
        context: undefined,
        config: {
          agents: 2,
          maxRounds: 2,
          convergenceThreshold: 0.8,
        },
      });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
