import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VerificationStore } from '../../../core/state/verification.store';
import { DEFAULT_VERIFICATION_CONFIG } from '../../../core/state/verification';
import { VerificationPreferencesComponent } from './verification-preferences.component';

describe('VerificationPreferencesComponent', () => {
  let fixture: ComponentFixture<VerificationPreferencesComponent>;
  let component: VerificationPreferencesComponent;
  let store: {
    config: ReturnType<typeof vi.fn>;
    updateConfig: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    store = {
      config: vi.fn(() => DEFAULT_VERIFICATION_CONFIG),
      updateConfig: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [VerificationPreferencesComponent],
      providers: [{ provide: VerificationStore, useValue: store }],
    }).compileComponents();

    fixture = TestBed.createComponent(VerificationPreferencesComponent);
    component = fixture.componentInstance;
  });

  it('defaults verification preferences to one non-Claude agent', () => {
    expect(component.defaultAgentCount()).toBe(1);
    expect(component.preferredAgents()).toEqual(['antigravity', 'codex', 'copilot']);
    expect(component.defaultStrategy()).toBe('merge');
    expect(component.maxDebateRounds()).toBe(2);
    expect(component.defaultPersonalities()).toEqual(['methodical-analyst']);
  });

  it('allows custom personality lists to shrink back to one agent', () => {
    component.applyPreset(component.presets[0]!);

    component.removePersonality(0);
    component.removePersonality(0);

    expect(component.defaultPersonalities()).toHaveLength(1);
    expect(component.defaultAgentCount()).toBe(1);
  });

  it('saves preferred CLI agents with the other defaults', () => {
    component.savePreferences();

    expect(store.updateConfig).toHaveBeenCalledWith(expect.objectContaining({
      agentCount: 1,
      cliAgents: ['antigravity', 'codex', 'copilot'],
      maxDebateRounds: 2,
      synthesisStrategy: 'merge',
      personalities: ['methodical-analyst'],
    }));
  });

  it('reads typed range and checkbox events without $any casts', () => {
    const range = document.createElement('input');
    range.type = 'range';
    range.value = '4';
    component.onNumberInput({ target: range } as unknown as Event, component.defaultAgentCount.set);
    expect(component.defaultAgentCount()).toBe(4);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = false;
    component.onBooleanInput({ target: checkbox } as unknown as Event, component.autoContinueDebate.set);
    expect(component.autoContinueDebate()).toBe(false);

    component.onPreferredAgentChange('claude', { target: Object.assign(document.createElement('input'), { checked: true }) } as unknown as Event);
    expect(component.preferredAgents()).toContain('claude');

    const select = document.createElement('select');
    const option = document.createElement('option');
    option.value = 'creative-solver';
    select.append(option);
    select.value = 'creative-solver';
    component.onPersonalityChange(0, { target: select } as unknown as Event);
    expect(component.defaultPersonalities()[0]).toBe('creative-solver');
  });

  it('loads stored max debate rounds into the preferences form', () => {
    store.config.mockReturnValue({
      ...DEFAULT_VERIFICATION_CONFIG,
      maxDebateRounds: 5,
    });

    component.ngOnInit();

    expect(component.maxDebateRounds()).toBe(5);
  });
});
