/**
 * Verification Config Store - Manages configuration state
 */

import { Injectable, inject } from '@angular/core';
import { VerificationStateService } from './verification-state.service';
import type { VerificationUIConfig, CliType } from './verification.types';

@Injectable({ providedIn: 'root' })
export class VerificationConfigStore {
  private stateService = inject(VerificationStateService);

  /**
   * Update default configuration
   */
  setDefaultConfig(config: Partial<VerificationUIConfig>): void {
    this.stateService.updateConfig(config);
    this.saveStoredState();
  }

  /**
   * Alias for setDefaultConfig (used by settings components)
   */
  updateConfig(config: Partial<VerificationUIConfig>): void {
    this.setDefaultConfig(config);
  }

  /**
   * Set selected agents
   */
  setSelectedAgents(agents: CliType[]): void {
    this.stateService.setSelectedAgents(agents);
    this.saveStoredState();
  }

  /**
   * Add agent to selection
   */
  addSelectedAgent(agent: CliType): void {
    const state = this.stateService.state();
    if (state.selectedAgents.includes(agent)) return;

    const newAgents = [...state.selectedAgents, agent];
    this.stateService.setSelectedAgents(newAgents);
    this.saveStoredState();
  }

  /**
   * Remove agent from selection
   */
  removeSelectedAgent(agent: CliType): void {
    const state = this.stateService.state();
    const newAgents = state.selectedAgents.filter((a) => a !== agent);
    this.stateService.setSelectedAgents(newAgents);
    this.saveStoredState();
  }

  /**
   * Load stored state from localStorage
   */
  loadStoredState(): void {
    try {
      const stored = localStorage.getItem('verification-store');
      if (stored) {
        const parsed = JSON.parse(stored);
        const state = this.stateService.state();
        const storedDefaultConfig = parsed.defaultConfig || {};
        const defaultConfig = { ...state.defaultConfig, ...storedDefaultConfig };
        const cliAgentPool = Array.isArray(storedDefaultConfig.cliAgents)
          ? storedDefaultConfig.cliAgents
          : (Array.isArray(parsed.selectedAgents) ? parsed.selectedAgents : defaultConfig.cliAgents);
        const agentCount = Math.max(1, defaultConfig.agentCount ?? 1);
        this.stateService.mergeState({
          defaultConfig: { ...defaultConfig, cliAgents: cliAgentPool },
          selectedAgents: cliAgentPool.slice(0, agentCount),
          sessions: (parsed.sessions || []).map((session: Record<string, unknown>) => ({
            ...session,
            agentProgress: new Map(),
          })),
        });
      }
    } catch (error) {
      console.warn('Failed to load verification store state:', error);
    }
  }

  /**
   * Save state to localStorage
   */
  saveStoredState(): void {
    try {
      const state = this.stateService.state();
      const toStore = {
        defaultConfig: state.defaultConfig,
        selectedAgents: state.selectedAgents,
        sessions: state.sessions.map((s) => ({
          ...s,
          agentProgress: [], // Don't persist progress maps
        })),
      };
      localStorage.setItem('verification-store', JSON.stringify(toStore));
    } catch (error) {
      console.warn('Failed to save verification store state:', error);
    }
  }
}
