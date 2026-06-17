import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_VERIFICATION_CONFIG } from './verification.types';
import { VerificationConfigStore } from './verification-config.store';
import { VerificationStateService } from './verification-state.service';
import type { CliType } from './verification.types';

describe('VerificationConfigStore', () => {
  let configStore: VerificationConfigStore;
  let stateService: VerificationStateService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    configStore = TestBed.inject(VerificationConfigStore);
    stateService = TestBed.inject(VerificationStateService);
  });

  afterEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('initializes selected agents from the verification default config', () => {
    expect(stateService.state().defaultConfig.cliAgents).toEqual(DEFAULT_VERIFICATION_CONFIG.cliAgents);
    expect(stateService.state().selectedAgents).toEqual(DEFAULT_VERIFICATION_CONFIG.cliAgents);
  });

  it('uses stored default CLI agents as the selected agents when loading preferences', () => {
    const cliAgents: CliType[] = ['gemini', 'codex', 'copilot'];
    localStorage.setItem('verification-store', JSON.stringify({
      defaultConfig: {
        ...DEFAULT_VERIFICATION_CONFIG,
        agentCount: 1,
        cliAgents,
      },
      selectedAgents: ['claude', 'codex'],
      sessions: [],
    }));

    configStore.loadStoredState();

    expect(stateService.state().defaultConfig.cliAgents).toEqual(cliAgents);
    expect(stateService.state().selectedAgents).toEqual(['gemini']);
  });

  it('falls back to stored selected agents for older preferences without CLI agents', () => {
    const selectedAgents: CliType[] = ['codex', 'copilot'];
    localStorage.setItem('verification-store', JSON.stringify({
      defaultConfig: {
        agentCount: selectedAgents.length,
      },
      selectedAgents,
      sessions: [],
    }));

    configStore.loadStoredState();

    expect(stateService.state().defaultConfig.cliAgents).toEqual(selectedAgents);
    expect(stateService.state().selectedAgents).toEqual(selectedAgents);
  });
});
