import { describe, it, expect } from 'vitest';
import { CLAUDE_DESCRIPTOR } from '../claude-cli-provider';
import { CODEX_DESCRIPTOR } from '../codex-cli-provider';
import { GEMINI_DESCRIPTOR } from '../gemini-cli-provider';
import { COPILOT_DESCRIPTOR } from '../copilot-sdk-provider';

describe('adapter descriptors', () => {
  const descriptors = [
    ['claude', CLAUDE_DESCRIPTOR, { subAgents: true }],
    ['codex', CODEX_DESCRIPTOR, { subAgents: false }],
    ['gemini', GEMINI_DESCRIPTOR, { sessionResume: false, subAgents: false }],
    ['copilot', COPILOT_DESCRIPTOR, { permissionPrompts: false, subAgents: false }],
  ] as const;
  for (const [name, d, expected] of descriptors) {
    it(`${name} descriptor has provider, displayName, capabilities, defaultConfig`, () => {
      expect(d.provider).toBe(name);
      expect(typeof d.displayName).toBe('string');
      expect(d.capabilities).toMatchObject(expected);
      expect(d.defaultConfig.type).toBeDefined();
    });
  }
});
