/**
 * Agent Store - Manages agent profile state in the renderer
 * Includes per-CLI preferences for the verification feature
 */

import { Injectable, signal, computed } from '@angular/core';
import {
  AgentProfile,
  BUILTIN_AGENTS,
  getDefaultAgent,
  getAgentById,
} from '../../../../shared/types/agent.types';

// ============================================
// Types
// ============================================

/**
 * Per-CLI preference configuration for verification agents
 */
export interface AgentPreference {
  command: string;           // CLI command (claude, gemini, codex, ollama)
  defaultModel?: string;     // Default model to use
  defaultTimeout: number;    // Timeout in seconds
  autoApprove: boolean;      // Auto-approve mode flag
  personality?: string;      // Default personality
  customPath?: string;       // Custom CLI path
}

// Storage key for localStorage persistence
const STORAGE_KEY = 'agent-store';

// Default preferences for common CLIs
const DEFAULT_PREFERENCES: Record<string, AgentPreference> = {
  claude: {
    command: 'claude',
    defaultModel: 'claude-sonnet-4-20250514',
    defaultTimeout: 300,
    autoApprove: false,
    personality: 'methodical-analyst',
  },
  gemini: {
    command: 'gemini',
    defaultModel: 'gemini-2.0-flash',
    defaultTimeout: 300,
    autoApprove: false,
    personality: 'creative-solver',
  },
  codex: {
    command: 'codex',
    defaultModel: 'codex-mini-latest',
    defaultTimeout: 300,
    autoApprove: false,
    personality: 'methodical-analyst',
  },
  ollama: {
    command: 'ollama',
    defaultModel: 'llama3.2',
    defaultTimeout: 600,
    autoApprove: true,
    personality: 'devils-advocate',
  },
};

// ============================================
// Store
// ============================================

@Injectable({ providedIn: 'root' })
export class AgentStore {
  // State - Agent Profile
  private readonly _selectedAgentId = signal<string>(getDefaultAgent().id);
  private readonly _customAgents = signal<AgentProfile[]>([]);

  // State - CLI Preferences
  private readonly _preferences = signal<Record<string, AgentPreference>>(
    structuredClone(DEFAULT_PREFERENCES)
  );

  // Computed values - Agent Profile
  readonly selectedAgentId = this._selectedAgentId.asReadonly();
  readonly customAgents = this._customAgents.asReadonly();

  /**
   * All available agents (built-in + custom)
   */
  readonly allAgents = computed(() => [...BUILTIN_AGENTS, ...this._customAgents()]);

  /**
   * Currently selected agent profile
   */
  readonly selectedAgent = computed(() => {
    const id = this._selectedAgentId();
    return getAgentById(id) || this._customAgents().find((a) => a.id === id) || getDefaultAgent();
  });

  // Computed values - CLI Preferences
  /**
   * All CLI preferences as a readonly record
   */
  readonly preferences = this._preferences.asReadonly();

  /**
   * List of all configured CLI commands
   */
  readonly configuredCommands = computed(() => Object.keys(this._preferences()));

  constructor() {
    this.loadStoredState();
  }

  // ============================================
  // Agent Profile Actions
  // ============================================

  /**
   * Select an agent by ID
   */
  selectAgent(agentId: string): void {
    const agent = getAgentById(agentId) || this._customAgents().find((a) => a.id === agentId);
    if (agent) {
      this._selectedAgentId.set(agentId);
    }
  }

  /**
   * Get an agent by ID
   */
  getAgent(agentId: string): AgentProfile | undefined {
    return getAgentById(agentId) || this._customAgents().find((a) => a.id === agentId);
  }

  /**
   * Add a custom agent
   */
  addCustomAgent(agent: AgentProfile): void {
    if (agent.builtin) {
      throw new Error('Cannot add a built-in agent as custom');
    }
    this._customAgents.update((agents) => [...agents, agent]);
  }

  /**
   * Remove a custom agent
   */
  removeCustomAgent(agentId: string): void {
    this._customAgents.update((agents) => agents.filter((a) => a.id !== agentId));
    // If the removed agent was selected, switch to default
    if (this._selectedAgentId() === agentId) {
      this._selectedAgentId.set(getDefaultAgent().id);
    }
  }

  /**
   * Reset to default agent
   */
  resetToDefault(): void {
    this._selectedAgentId.set(getDefaultAgent().id);
  }

  // ============================================
  // CLI Preference Actions
  // ============================================

  /**
   * Set or update preference for a specific CLI command
   */
  setPreference(command: string, pref: Partial<AgentPreference>): void {
    this._preferences.update((current) => {
      const existing = current[command];
      const updated: AgentPreference = existing
        ? { ...existing, ...pref }
        : {
            command,
            defaultTimeout: 300,
            autoApprove: false,
            ...pref,
          };

      return {
        ...current,
        [command]: updated,
      };
    });
    this.saveStoredState();
  }

  /**
   * Get preference for a specific CLI command
   */
  getPreference(command: string): AgentPreference | undefined {
    return this._preferences()[command];
  }

  /**
   * Get all CLI preferences
   */
  getAllPreferences(): Record<string, AgentPreference> {
    return this._preferences();
  }

  /**
   * Reset preference for a specific CLI command to defaults
   */
  resetPreference(command: string): void {
    this._preferences.update((current) => {
      const defaultPref = DEFAULT_PREFERENCES[command];
      if (defaultPref) {
        return {
          ...current,
          [command]: structuredClone(defaultPref),
        };
      }
      // If no default exists, remove the preference
      const { [command]: _, ...rest } = current;
      return rest;
    });
    this.saveStoredState();
  }

  /**
   * Reset all preferences to defaults
   */
  resetAllPreferences(): void {
    this._preferences.set(structuredClone(DEFAULT_PREFERENCES));
    this.saveStoredState();
  }

  // ============================================
  // Persistence
  // ============================================

  /**
   * Load state from localStorage
   */
  private loadStoredState(): void {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.preferences && typeof parsed.preferences === 'object') {
          // Merge stored preferences with defaults to ensure all required fields
          const mergedPreferences: Record<string, AgentPreference> = {
            ...structuredClone(DEFAULT_PREFERENCES),
          };
          for (const [command, pref] of Object.entries(parsed.preferences)) {
            const defaultPref = DEFAULT_PREFERENCES[command];
            mergedPreferences[command] = {
              // Start with base defaults
              command,
              defaultTimeout: defaultPref?.defaultTimeout ?? 300,
              autoApprove: defaultPref?.autoApprove ?? false,
              // Apply default preference overrides (model, personality, customPath)
              defaultModel: defaultPref?.defaultModel,
              personality: defaultPref?.personality,
              customPath: defaultPref?.customPath,
              // Apply user's stored preference (highest priority)
              ...(pref as Partial<AgentPreference>),
            };
          }
          this._preferences.set(mergedPreferences);
        }
        if (parsed.selectedAgentId) {
          this._selectedAgentId.set(parsed.selectedAgentId);
        }
        if (Array.isArray(parsed.customAgents)) {
          this._customAgents.set(parsed.customAgents);
        }
      }
    } catch (error) {
      console.warn('Failed to load agent store state:', error);
    }
  }

  /**
   * Save state to localStorage
   */
  private saveStoredState(): void {
    try {
      const toStore = {
        preferences: this._preferences(),
        selectedAgentId: this._selectedAgentId(),
        customAgents: this._customAgents(),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
    } catch (error) {
      console.warn('Failed to save agent store state:', error);
    }
  }
}
