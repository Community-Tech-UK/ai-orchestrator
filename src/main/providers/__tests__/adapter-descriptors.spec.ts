import { describe, it, expect } from 'vitest';
import { CLAUDE_DESCRIPTOR } from '../claude-cli-provider';
import { CODEX_DESCRIPTOR } from '../codex-cli-provider';
import { GEMINI_DESCRIPTOR } from '../gemini-cli-provider';
import { COPILOT_DESCRIPTOR } from '../copilot-cli-provider';
import { CURSOR_DESCRIPTOR } from '../cursor-cli-provider';

describe('adapter descriptors', () => {
  const descriptors = [
    [
      'claude',
      CLAUDE_DESCRIPTOR,
      'Claude Code',
      {
        interruption: true,
        permissionPrompts: true,
        sessionResume: true,
        streamingOutput: true,
        usageReporting: true,
        subAgents: true,
      },
    ],
    [
      'codex',
      CODEX_DESCRIPTOR,
      'OpenAI Codex',
      {
        interruption: true,
        permissionPrompts: true,
        sessionResume: true,
        streamingOutput: true,
        usageReporting: true,
        subAgents: false,
      },
    ],
    [
      'gemini',
      GEMINI_DESCRIPTOR,
      'Google Gemini',
      {
        interruption: true,
        permissionPrompts: true,
        sessionResume: false,
        streamingOutput: true,
        usageReporting: true,
        subAgents: false,
      },
    ],
    [
      'copilot',
      COPILOT_DESCRIPTOR,
      'GitHub Copilot',
      {
        interruption: true,
        permissionPrompts: false,
        sessionResume: true,
        streamingOutput: true,
        usageReporting: true,
        subAgents: false,
      },
    ],
    [
      'cursor',
      CURSOR_DESCRIPTOR,
      'Cursor',
      {
        interruption: true,
        permissionPrompts: false,
        sessionResume: true,
        streamingOutput: true,
        usageReporting: true,
        subAgents: false,
      },
    ],
  ] as const;
  for (const [name, d, displayName, capabilities] of descriptors) {
    it(`${name} descriptor is complete`, () => {
      expect(d.provider).toBe(name);
      expect(d.displayName).toBe(displayName);
      expect(d.capabilities).toEqual(capabilities);
      expect(d.defaultConfig.type).toBeDefined();
    });
  }
});
