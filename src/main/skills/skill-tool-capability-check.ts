import type { SkillBundle } from '../../shared/types/skill.types';

/**
 * Skill instruction / tool-surface parity.
 *
 * A skill whose instructions say "you MUST drive the browser through
 * `node_repl` + scripts/browser-client.mjs" is unusable when the runtime only
 * exposes managed `browser.*` MCP tools — and the failure is silent and
 * confusing: the agent reads mandatory instructions pointing at a runtime that
 * does not exist, and either gives up or improvises. This detects that mismatch
 * up front and says exactly what to do instead.
 *
 * Deliberately conservative. It only reports a mismatch when a skill *mandates*
 * a tool that is genuinely absent from the exposed surface; merely mentioning a
 * tool name in prose is not enough.
 */

export interface SkillToolRequirement {
  /** Tool the instructions mandate, e.g. `node_repl`. */
  tool: string;
  /** Managed tools that cover the same job, when the surface exposes them. */
  replacedBy: string[];
  /** What the operator or skill author should do. */
  remediation: string;
}

export interface SkillToolMismatch {
  skillId: string;
  skillPath: string;
  requirement: SkillToolRequirement;
  /** The quoted line that mandates the missing tool. */
  evidence: string;
}

/**
 * Known "mandatory tool" patterns. `pattern` must match a MANDATE, not a
 * mention: each requires an imperative/necessity cue on the same line.
 */
const REQUIREMENT_PATTERNS: Array<{
  requirement: SkillToolRequirement;
  pattern: RegExp;
}> = [
  {
    requirement: {
      tool: 'node_repl',
      replacedBy: ['browser.*', 'computer.*'],
      remediation:
        'This Harness build exposes managed `browser.*` and `computer.*` MCP tools and does '
        + 'NOT provide a persistent `node_repl` JavaScript tool. Update the skill to call the '
        + 'managed tools directly, or remove the skill.',
    },
    pattern: /(?:must|always|required?|use)\b[^\n]*\bnode_repl\b/i,
  },
  {
    requirement: {
      tool: 'scripts/browser-client.mjs',
      replacedBy: ['browser.*'],
      remediation:
        'Drive the browser through the managed `browser.*` MCP tools (start with '
        + '`browser.preflight_target` / `browser.find_or_open`) instead of a bundled client script.',
    },
    pattern: /(?:must|always|required?|use|run)\b[^\n]*browser-client\.mjs/i,
  },
  {
    requirement: {
      tool: 'scripts/computer-use-client.mjs',
      replacedBy: ['computer.*'],
      remediation:
        'Drive desktop apps through the managed `computer.*` MCP tools (start with '
        + '`computer.health` / `computer.list_apps`) instead of a bundled client script.',
    },
    pattern: /(?:must|always|required?|use|run)\b[^\n]*computer-use-client\.mjs/i,
  },
];

export interface SkillToolCapabilityInput {
  skills: Array<{ bundle: SkillBundle; coreContent: string }>;
  /** Tool names actually exposed to agent sessions, e.g. `browser.click`. */
  exposedToolNames: readonly string[];
}

export function checkSkillToolCapabilities(
  input: SkillToolCapabilityInput,
): SkillToolMismatch[] {
  const exposed = new Set(input.exposedToolNames);
  const mismatches: SkillToolMismatch[] = [];
  for (const { bundle, coreContent } of input.skills) {
    for (const { requirement, pattern } of REQUIREMENT_PATTERNS) {
      if (exposed.has(requirement.tool)) {
        continue;
      }
      const evidence = findMandateLine(coreContent, pattern);
      if (!evidence) {
        continue;
      }
      mismatches.push({
        skillId: bundle.id,
        skillPath: bundle.corePath,
        requirement,
        evidence,
      });
    }
  }
  return mismatches;
}

/** One operator-readable line per mismatch; never includes secrets. */
export function describeSkillToolMismatch(mismatch: SkillToolMismatch): string {
  return `Skill "${mismatch.skillId}" requires the tool \`${mismatch.requirement.tool}\`, which `
    + `this build does not expose (${mismatch.skillPath}). ${mismatch.requirement.remediation} `
    + `Instruction: "${mismatch.evidence}"`;
}

function findMandateLine(content: string, pattern: RegExp): string | null {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.length > 400) {
      continue;
    }
    if (pattern.test(line)) {
      return line;
    }
  }
  return null;
}
