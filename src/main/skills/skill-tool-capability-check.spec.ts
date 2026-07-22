import { describe, expect, it } from 'vitest';
import type { SkillBundle } from '../../shared/types/skill.types';
import {
  checkSkillToolCapabilities,
  describeSkillToolMismatch,
} from './skill-tool-capability-check';

function bundle(id: string): SkillBundle {
  return {
    id,
    path: `/skills/${id}`,
    corePath: `/skills/${id}/SKILL.md`,
    metadata: { name: id, description: '' } as SkillBundle['metadata'],
    referencePaths: [],
    examplePaths: [],
    scriptPaths: [],
    assetPaths: [],
  };
}

const BROWSER_TOOLS = ['browser.find_or_open', 'browser.click', 'computer.click'];

describe('checkSkillToolCapabilities', () => {
  it('flags a skill that mandates node_repl when no such tool is exposed', () => {
    const mismatches = checkSkillToolCapabilities({
      exposedToolNames: BROWSER_TOOLS,
      skills: [{
        bundle: bundle('chrome:control-chrome'),
        coreContent: [
          '# Control Chrome',
          'You MUST use node_repl to run the client.',
        ].join('\n'),
      }],
    });

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      skillId: 'chrome:control-chrome',
      requirement: { tool: 'node_repl' },
      evidence: 'You MUST use node_repl to run the client.',
    });
    const described = describeSkillToolMismatch(mismatches[0]!);
    expect(described).toContain('does not expose');
    // The remediation names the surface that DOES exist, so the operator is not
    // left guessing what to use instead.
    expect(described).toContain('`browser.*` and `computer.*` MCP tools');
  });

  it('flags mandated client scripts for both browser and computer use', () => {
    const mismatches = checkSkillToolCapabilities({
      exposedToolNames: BROWSER_TOOLS,
      skills: [
        {
          bundle: bundle('chrome'),
          coreContent: 'Always run scripts/browser-client.mjs for every page action.',
        },
        {
          bundle: bundle('computer-use'),
          coreContent: 'You must use scripts/computer-use-client.mjs to click.',
        },
      ],
    });

    expect(mismatches.map((entry) => entry.requirement.tool)).toEqual([
      'scripts/browser-client.mjs',
      'scripts/computer-use-client.mjs',
    ]);
  });

  it('stays quiet when the mandated tool IS exposed', () => {
    expect(checkSkillToolCapabilities({
      exposedToolNames: [...BROWSER_TOOLS, 'node_repl'],
      skills: [{
        bundle: bundle('chrome'),
        coreContent: 'You must use node_repl for this.',
      }],
    })).toEqual([]);
  });

  it('does not flag a passing mention that is not a mandate', () => {
    // Prose about a tool is not an instruction to use it; flagging that would
    // train operators to ignore the check.
    expect(checkSkillToolCapabilities({
      exposedToolNames: BROWSER_TOOLS,
      skills: [{
        bundle: bundle('notes'),
        coreContent: 'Older Harness builds shipped a node_repl tool; this one does not.',
      }],
    })).toEqual([]);
  });

  it('reports nothing for a skill that already uses the managed tools', () => {
    expect(checkSkillToolCapabilities({
      exposedToolNames: BROWSER_TOOLS,
      skills: [{
        bundle: bundle('chrome'),
        coreContent: 'Use browser.find_or_open, then browser.click by uid.',
      }],
    })).toEqual([]);
  });
});
