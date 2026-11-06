import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CostBiggestTurn, CostCodexCreditsSummary } from '../../../../shared/types/cost-purpose.types';
import { InstanceStateService } from '../../core/state/instance/instance-state.service';
import { BiggestTurnsComponent, biggestTurnKindLabel, formatTurnTokens } from './biggest-turns.component';

const M = 1_000_000;
const turn = (overrides: Partial<CostBiggestTurn> = {}): CostBiggestTurn => ({
  at: Date.UTC(2026, 9, 20, 9, 30), instanceId: 'abcdef1234567890', kind: 'plan-queue', provider: 'codex', processedTokens: 310 * M,
  helperTokens: 110 * M, helperShare: 110 / 310, stopRequested: true, source: 'codex-round', ...overrides,
});
const credits = (overrides: Partial<CostCodexCreditsSummary> = {}): CostCodexCreditsSummary =>
  ({ threads: 2, credits: 12.34, estimatedUsd: 2.1, byKind: [{ kind: 'plan-queue', threads: 1, credits: 9 }, { kind: 'chat', threads: 1, credits: 3.34 }], ...overrides });

describe('token and kind wording', () => {
  it('keeps token figures short and names the kinds in plain words', () => {
    expect(formatTurnTokens(310 * M)).toBe('310M');
    expect(formatTurnTokens(46.5 * M)).toBe('46.5M');
    expect(formatTurnTokens(1_840 * M)).toBe('1.84B');
    expect(formatTurnTokens(12_300)).toBe('12K');
    expect(formatTurnTokens(40)).toBe('40');
    expect([biggestTurnKindLabel('chat'), biggestTurnKindLabel('child'), biggestTurnKindLabel('automation'), biggestTurnKindLabel('unknown')])
      .toEqual(['Your chat', 'Helper', 'Scheduled job', 'Other']);
  });
});

describe('BiggestTurnsComponent', () => {
  let fixture: ComponentFixture<BiggestTurnsComponent>;
  const text = (): string => (fixture.nativeElement as HTMLElement).textContent!.replace(/\s+/g, ' ');
  const mount = async (turns: CostBiggestTurn[] | null, summary: CostCodexCreditsSummary | null = null, names: Record<string, string> = {}) => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), { provide: InstanceStateService, useValue: { getInstance: (id: string) => names[id] ? { displayName: names[id] } : undefined } }],
    });
    fixture = TestBed.createComponent(BiggestTurnsComponent);
    fixture.componentRef.setInput('turns', turns);
    fixture.componentRef.setInput('credits', summary);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  beforeEach(() => TestBed.resetTestingModule());

  it('shows each turn with its session, kind, tokens, helpers\' part and whether Harness stopped it', async () => {
    await mount([turn(), turn({ instanceId: 'zzzzzzzz9999', kind: 'child', provider: 'claude', processedTokens: 46.5 * M, helperTokens: undefined, helperShare: undefined, stopRequested: undefined, source: 'turn-cost' })],
      null, { abcdef1234567890: 'Oct plan run' });
    const rows = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('tbody tr')).map((row) => row.textContent!.replace(/\s+/g, ' ').trim());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Oct plan run');
    expect(rows[0]).toContain('Plan queue');
    expect(rows[0]).toContain('310M');
    expect(rows[0]).toContain('110M (35%)');
    expect(rows[0]).toContain('Stopped by Harness');
    expect(rows[1]).toContain('Closed session');
    expect(rows[1]).not.toContain('zzzzzzzz');
    expect(rows[1]).toContain('Helper');
    expect(rows[1]).toContain('46.5M');
    expect(rows[1]).not.toContain('Stopped by Harness');
  });

  it('says so plainly when nothing was recorded', async () => {
    await mount([]);
    expect(text()).toContain('No turns recorded in the last seven days.');
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="codex-credits"]')).toBeNull();
  });

  it('does not say nothing was recorded when the turns did not arrive', async () => {
    await mount(null);
    expect(text()).toContain('Biggest turns are not available right now.');
    expect(text()).not.toContain('No turns recorded');
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="biggest-turns-table"]')).toBeNull();
  });

  it('shows no raw session id when the session is no longer listed', async () => {
    await mount([turn({ instanceId: 'zzzzzzzz9999' })]);
    expect(text()).not.toContain('zzzzzzzz');
    expect(text()).toContain('Closed session');
  });

  it('reports the Codex credits for the week, with the dollar figure only when Codex gave one', async () => {
    await mount([turn()], credits());
    expect(text()).toContain('Codex reports 12.3 credits used by 2 sessions that ended this week (about $2.10 where it gave a dollar figure).');
    expect(text()).toContain('By kind: plan queue 9, your chat 3.3.');
  });

  it('leaves out the dollar clause and the kind split when there is nothing to say', async () => {
    await mount([turn()], credits({ threads: 1, estimatedUsd: null, byKind: [{ kind: 'chat', threads: 1, credits: 3.34 }] }));
    expect(text()).toContain('Codex reports 12.3 credits used by 1 session that ended this week.');
    expect(text()).not.toContain('dollar figure');
    expect(text()).not.toContain('By kind');
  });
});
