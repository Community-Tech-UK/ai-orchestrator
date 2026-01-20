/**
 * Unit tests for AgentStore - focusing on AgentPreference functionality
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentStore, AgentPreference } from './agent.store';

// Mock localStorage for testing
class LocalStorageMock {
  private store: Record<string, string> = {};

  getItem(key: string): string | null {
    return this.store[key] || null;
  }

  setItem(key: string, value: string): void {
    this.store[key] = value;
  }

  removeItem(key: string): void {
    delete this.store[key];
  }

  clear(): void {
    this.store = {};
  }

  get length(): number {
    return Object.keys(this.store).length;
  }

  key(index: number): string | null {
    const keys = Object.keys(this.store);
    return keys[index] || null;
  }
}

// Set up localStorage mock globally
const localStorageMock = new LocalStorageMock();
global.localStorage = localStorageMock as Storage;

describe('AgentStore', () => {
  let store: AgentStore;

  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();

    // Create a fresh instance of the store for each test
    store = new AgentStore();
  });

  afterEach(() => {
    // Clean up localStorage after each test
    localStorage.clear();
  });

  describe('preferences', () => {
    describe('default preferences', () => {
      it('should initialize with default preferences for claude', () => {
        const claudePreference = store.getPreference('claude');

        expect(claudePreference).toBeDefined();
        expect(claudePreference?.command).toBe('claude');
        expect(claudePreference?.defaultModel).toBe('claude-sonnet-4-20250514');
        expect(claudePreference?.defaultTimeout).toBe(300);
        expect(claudePreference?.autoApprove).toBe(false);
        expect(claudePreference?.personality).toBe('methodical-analyst');
      });

      it('should initialize with default preferences for gemini', () => {
        const geminiPreference = store.getPreference('gemini');

        expect(geminiPreference).toBeDefined();
        expect(geminiPreference?.command).toBe('gemini');
        expect(geminiPreference?.defaultModel).toBe('gemini-2.0-flash');
        expect(geminiPreference?.defaultTimeout).toBe(300);
        expect(geminiPreference?.autoApprove).toBe(false);
        expect(geminiPreference?.personality).toBe('creative-solver');
      });

      it('should initialize with default preferences for codex', () => {
        const codexPreference = store.getPreference('codex');

        expect(codexPreference).toBeDefined();
        expect(codexPreference?.command).toBe('codex');
        expect(codexPreference?.defaultModel).toBe('codex-mini-latest');
        expect(codexPreference?.defaultTimeout).toBe(300);
        expect(codexPreference?.autoApprove).toBe(false);
        expect(codexPreference?.personality).toBe('methodical-analyst');
      });

      it('should initialize with default preferences for ollama', () => {
        const ollamaPreference = store.getPreference('ollama');

        expect(ollamaPreference).toBeDefined();
        expect(ollamaPreference?.command).toBe('ollama');
        expect(ollamaPreference?.defaultModel).toBe('llama3.2');
        expect(ollamaPreference?.defaultTimeout).toBe(600);
        expect(ollamaPreference?.autoApprove).toBe(true);
        expect(ollamaPreference?.personality).toBe('devils-advocate');
      });

      it('should have all four default commands configured', () => {
        const commands = store.configuredCommands();

        expect(commands).toContain('claude');
        expect(commands).toContain('gemini');
        expect(commands).toContain('codex');
        expect(commands).toContain('ollama');
        expect(commands.length).toBe(4);
      });
    });

    describe('setPreference()', () => {
      it('should update existing preference with partial data', () => {
        store.setPreference('claude', { defaultTimeout: 600 });

        const updated = store.getPreference('claude');
        expect(updated?.defaultTimeout).toBe(600);
        // Other properties should remain unchanged
        expect(updated?.command).toBe('claude');
        expect(updated?.defaultModel).toBe('claude-sonnet-4-20250514');
        expect(updated?.autoApprove).toBe(false);
        expect(updated?.personality).toBe('methodical-analyst');
      });

      it('should update multiple properties at once', () => {
        store.setPreference('gemini', {
          defaultTimeout: 450,
          autoApprove: true,
          defaultModel: 'gemini-3.0-ultra',
        });

        const updated = store.getPreference('gemini');
        expect(updated?.defaultTimeout).toBe(450);
        expect(updated?.autoApprove).toBe(true);
        expect(updated?.defaultModel).toBe('gemini-3.0-ultra');
        // Unchanged properties
        expect(updated?.command).toBe('gemini');
        expect(updated?.personality).toBe('creative-solver');
      });

      it('should create new preference for unknown command', () => {
        store.setPreference('newcli', {
          defaultModel: 'new-model-1.0',
          personality: 'test-personality',
        });

        const newPreference = store.getPreference('newcli');
        expect(newPreference).toBeDefined();
        expect(newPreference?.command).toBe('newcli');
        expect(newPreference?.defaultModel).toBe('new-model-1.0');
        expect(newPreference?.personality).toBe('test-personality');
        // Should use default values for non-provided fields
        expect(newPreference?.defaultTimeout).toBe(300);
        expect(newPreference?.autoApprove).toBe(false);
      });

      it('should create new preference with custom timeout and autoApprove', () => {
        store.setPreference('customcli', {
          defaultTimeout: 1200,
          autoApprove: true,
        });

        const newPreference = store.getPreference('customcli');
        expect(newPreference).toBeDefined();
        expect(newPreference?.command).toBe('customcli');
        expect(newPreference?.defaultTimeout).toBe(1200);
        expect(newPreference?.autoApprove).toBe(true);
      });

      it('should handle customPath field', () => {
        store.setPreference('claude', {
          customPath: '/custom/path/to/claude',
        });

        const updated = store.getPreference('claude');
        expect(updated?.customPath).toBe('/custom/path/to/claude');
      });

      it('should not affect other preferences when updating one', () => {
        const originalGemini = store.getPreference('gemini');

        store.setPreference('claude', { defaultTimeout: 999 });

        const updatedGemini = store.getPreference('gemini');
        expect(updatedGemini).toEqual(originalGemini);
      });
    });

    describe('getPreference()', () => {
      it('should return correct preference for existing command', () => {
        const claudePreference = store.getPreference('claude');

        expect(claudePreference).toBeDefined();
        expect(claudePreference?.command).toBe('claude');
      });

      it('should return undefined for non-existent command', () => {
        const nonExistent = store.getPreference('nonexistent');

        expect(nonExistent).toBeUndefined();
      });

      it('should return updated preference after modification', () => {
        store.setPreference('ollama', { defaultTimeout: 1000 });

        const updated = store.getPreference('ollama');
        expect(updated?.defaultTimeout).toBe(1000);
      });
    });

    describe('getAllPreferences()', () => {
      it('should return all default preferences', () => {
        const allPrefs = store.getAllPreferences();

        expect(Object.keys(allPrefs).length).toBe(4);
        expect(allPrefs['claude']).toBeDefined();
        expect(allPrefs['gemini']).toBeDefined();
        expect(allPrefs['codex']).toBeDefined();
        expect(allPrefs['ollama']).toBeDefined();
      });

      it('should include newly added preferences', () => {
        store.setPreference('newcli', { defaultTimeout: 500 });

        const allPrefs = store.getAllPreferences();
        expect(Object.keys(allPrefs).length).toBe(5);
        expect(allPrefs['newcli']).toBeDefined();
      });

      it('should return preferences with correct structure', () => {
        const allPrefs = store.getAllPreferences();

        Object.values(allPrefs).forEach((pref) => {
          expect(pref).toHaveProperty('command');
          expect(pref).toHaveProperty('defaultTimeout');
          expect(pref).toHaveProperty('autoApprove');
        });
      });
    });

    describe('resetPreference()', () => {
      it('should reset existing preference to default for claude', () => {
        // Modify the preference
        store.setPreference('claude', {
          defaultTimeout: 999,
          autoApprove: true,
          defaultModel: 'custom-model',
        });

        // Reset it
        store.resetPreference('claude');

        // Verify it's back to defaults
        const reset = store.getPreference('claude');
        expect(reset?.defaultTimeout).toBe(300);
        expect(reset?.autoApprove).toBe(false);
        expect(reset?.defaultModel).toBe('claude-sonnet-4-20250514');
        expect(reset?.personality).toBe('methodical-analyst');
      });

      it('should reset existing preference to default for ollama', () => {
        store.setPreference('ollama', {
          defaultTimeout: 100,
          autoApprove: false,
        });

        store.resetPreference('ollama');

        const reset = store.getPreference('ollama');
        expect(reset?.defaultTimeout).toBe(600);
        expect(reset?.autoApprove).toBe(true);
      });

      it('should remove preference if no default exists', () => {
        // Create a custom preference
        store.setPreference('customcli', { defaultTimeout: 500 });
        expect(store.getPreference('customcli')).toBeDefined();

        // Reset it (should remove it since no default exists)
        store.resetPreference('customcli');

        expect(store.getPreference('customcli')).toBeUndefined();
      });

      it('should not affect other preferences when resetting one', () => {
        const originalGemini = store.getPreference('gemini');

        store.setPreference('claude', { defaultTimeout: 999 });
        store.resetPreference('claude');

        const geminiAfterReset = store.getPreference('gemini');
        expect(geminiAfterReset).toEqual(originalGemini);
      });
    });

    describe('resetAllPreferences()', () => {
      it('should reset all preferences to defaults', () => {
        // Modify multiple preferences
        store.setPreference('claude', { defaultTimeout: 999 });
        store.setPreference('gemini', { autoApprove: true });
        store.setPreference('ollama', { defaultModel: 'custom-model' });

        // Reset all
        store.resetAllPreferences();

        // Verify all are back to defaults
        const claude = store.getPreference('claude');
        expect(claude?.defaultTimeout).toBe(300);

        const gemini = store.getPreference('gemini');
        expect(gemini?.autoApprove).toBe(false);

        const ollama = store.getPreference('ollama');
        expect(ollama?.defaultModel).toBe('llama3.2');
      });

      it('should remove custom preferences that have no defaults', () => {
        store.setPreference('customcli', { defaultTimeout: 500 });
        expect(store.getPreference('customcli')).toBeDefined();

        store.resetAllPreferences();

        expect(store.getPreference('customcli')).toBeUndefined();
        expect(store.configuredCommands().length).toBe(4);
      });

      it('should restore all four default commands', () => {
        store.resetAllPreferences();

        const commands = store.configuredCommands();
        expect(commands).toContain('claude');
        expect(commands).toContain('gemini');
        expect(commands).toContain('codex');
        expect(commands).toContain('ollama');
        expect(commands.length).toBe(4);
      });
    });

    describe('localStorage persistence', () => {
      it('should save preferences to localStorage when updated', () => {
        store.setPreference('claude', { defaultTimeout: 777 });

        const stored = localStorage.getItem('agent-store');
        expect(stored).toBeTruthy();

        const parsed = JSON.parse(stored!);
        expect(parsed.preferences).toBeDefined();
        expect(parsed.preferences.claude.defaultTimeout).toBe(777);
      });

      it('should load preferences from localStorage on initialization', () => {
        // Manually set localStorage data
        const testData = {
          preferences: {
            claude: {
              command: 'claude',
              defaultModel: 'claude-sonnet-4-20250514',
              defaultTimeout: 888,
              autoApprove: true,
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
          },
          selectedAgentId: 'build',
          customAgents: [],
        };
        localStorage.setItem('agent-store', JSON.stringify(testData));

        // Create new store instance to trigger loading
        const newStore = new AgentStore();

        const claudePreference = newStore.getPreference('claude');
        expect(claudePreference?.defaultTimeout).toBe(888);
        expect(claudePreference?.autoApprove).toBe(true);
      });

      it('should merge stored preferences with defaults on load', () => {
        // Store partial preference data (missing some fields)
        const partialData = {
          preferences: {
            claude: {
              command: 'claude',
              defaultTimeout: 555,
              // Missing defaultModel, autoApprove, personality
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
          },
          selectedAgentId: 'build',
          customAgents: [],
        };
        localStorage.setItem('agent-store', JSON.stringify(partialData));

        const newStore = new AgentStore();

        const claudePreference = newStore.getPreference('claude');
        // Should have stored timeout
        expect(claudePreference?.defaultTimeout).toBe(555);
        // Should have merged default values for missing fields
        expect(claudePreference?.defaultModel).toBe('claude-sonnet-4-20250514');
        expect(claudePreference?.autoApprove).toBe(false);
        expect(claudePreference?.personality).toBe('methodical-analyst');
      });

      it('should preserve custom CLI preferences on load', () => {
        const dataWithCustom = {
          preferences: {
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
            customcli: {
              command: 'customcli',
              defaultTimeout: 1200,
              autoApprove: true,
              defaultModel: 'custom-model',
            },
          },
          selectedAgentId: 'build',
          customAgents: [],
        };
        localStorage.setItem('agent-store', JSON.stringify(dataWithCustom));

        const newStore = new AgentStore();

        const customPreference = newStore.getPreference('customcli');
        expect(customPreference).toBeDefined();
        expect(customPreference?.command).toBe('customcli');
        expect(customPreference?.defaultTimeout).toBe(1200);
        expect(customPreference?.autoApprove).toBe(true);
        expect(customPreference?.defaultModel).toBe('custom-model');
      });

      it('should handle corrupted localStorage gracefully', () => {
        // Suppress expected console.warn from loadStoredState BEFORE constructing the store
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        localStorage.setItem('agent-store', 'invalid json data');

        // Should not throw and should use defaults
        const newStore = new AgentStore();

        const claudePreference = newStore.getPreference('claude');
        expect(claudePreference?.defaultTimeout).toBe(300);

        consoleWarnSpy.mockRestore();
      });

      it('should handle missing preferences field in localStorage', () => {
        const dataWithoutPreferences = {
          selectedAgentId: 'build',
          customAgents: [],
        };
        localStorage.setItem('agent-store', JSON.stringify(dataWithoutPreferences));

        const newStore = new AgentStore();

        // Should fall back to defaults
        const claudePreference = newStore.getPreference('claude');
        expect(claudePreference?.defaultTimeout).toBe(300);
      });

      it('should persist preferences after reset', () => {
        store.setPreference('claude', { defaultTimeout: 999 });
        store.resetPreference('claude');

        const stored = localStorage.getItem('agent-store');
        expect(stored).toBeTruthy();

        const parsed = JSON.parse(stored!);
        expect(parsed.preferences.claude.defaultTimeout).toBe(300);
      });

      it('should persist preferences after resetAll', () => {
        store.setPreference('claude', { defaultTimeout: 999 });
        store.setPreference('customcli', { defaultTimeout: 500 });
        store.resetAllPreferences();

        const stored = localStorage.getItem('agent-store');
        expect(stored).toBeTruthy();

        const parsed = JSON.parse(stored!);
        expect(parsed.preferences.customcli).toBeUndefined();
        expect(parsed.preferences.claude.defaultTimeout).toBe(300);
      });
    });

    describe('edge cases', () => {
      it('should handle empty string command', () => {
        store.setPreference('', { defaultTimeout: 100 });

        const pref = store.getPreference('');
        expect(pref).toBeDefined();
        expect(pref?.command).toBe('');
      });

      it('should handle command with special characters', () => {
        const specialCommand = 'my-custom-cli@v2.0';
        store.setPreference(specialCommand, { defaultTimeout: 200 });

        const pref = store.getPreference(specialCommand);
        expect(pref?.command).toBe(specialCommand);
      });

      it('should handle very large timeout values', () => {
        store.setPreference('claude', { defaultTimeout: 999999 });

        const pref = store.getPreference('claude');
        expect(pref?.defaultTimeout).toBe(999999);
      });

      it('should handle zero timeout value', () => {
        store.setPreference('claude', { defaultTimeout: 0 });

        const pref = store.getPreference('claude');
        expect(pref?.defaultTimeout).toBe(0);
      });

      it('should handle undefined optional fields', () => {
        store.setPreference('claude', {
          defaultModel: undefined,
          personality: undefined,
        });

        const pref = store.getPreference('claude');
        expect(pref?.defaultModel).toBeUndefined();
        expect(pref?.personality).toBeUndefined();
      });

      it('should maintain reference integrity for getAllPreferences', () => {
        const prefs1 = store.getAllPreferences();
        const prefs2 = store.getAllPreferences();

        // Should return the same reference (readonly signal)
        expect(prefs1).toBe(prefs2);
      });
    });
  });
});
