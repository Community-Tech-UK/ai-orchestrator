import type { AgentRunResult, ArmId, ArmSpec, LocalArmEndpoint, LocalModelKey, TaskDefinition, TokenUsage } from './types';
import { emptyUsage } from './types';

export const CLAUDE_OPS_MODEL = 'claude-opus-5-5';
export const CLAUDE_SONNET_MODEL = 'claude-sonnet-5-5';

export const ARMS: Record<ArmId, ArmSpec> = {
  A: {
    id: 'A',
    label: 'Claude Opus 5.5, no planner',
    planner: 'none',
    coderKind: 'claude',
    coderModel: CLAUDE_OPS_MODEL,
    usesFrozenPlan: false,
    phase: 'pilot',
    rationale: "Today's way of working. The baseline.",
  },
  B: {
    id: 'B',
    label: 'Qwen3.6-35B-A3B on the 5090, no planner',
    planner: 'none',
    coderKind: 'local-claude-code',
    coderModel: 'qwen/qwen3.6-35b-a3b',
    localModelKey: 'qwen3.6-35b-a3b',
    usesFrozenPlan: false,
    phase: 'pilot',
    rationale: "The article's setup, as written.",
  },
  C1: {
    id: 'C1',
    label: 'Opus plan + Qwen3.8-27B coder (all on the 5090)',
    planner: 'claude-opus-5-5',
    coderKind: 'local-claude-code',
    coderModel: 'qwen3.8-27b',
    localModelKey: 'qwen3.8-27b',
    usesFrozenPlan: true,
    phase: 'pilot',
    rationale: "James's idea with the best model that fits the graphics card.",
  },
  C2: {
    id: 'C2',
    label: 'Opus plan + Qwen3.8-Flash-Next coder (5090 + system RAM)',
    planner: 'claude-opus-5-5',
    coderKind: 'local-claude-code',
    coderModel: 'qwen3.8-flash-next',
    localModelKey: 'qwen3.8-flash-next',
    usesFrozenPlan: true,
    phase: 'pilot',
    rationale: "James's idea with the biggest practical model. Does the RAM earn its keep?",
  },
  D: {
    id: 'D',
    label: 'Opus plan + Claude Sonnet 5.5 coder',
    planner: 'claude-opus-5-5',
    coderKind: 'claude',
    coderModel: CLAUDE_SONNET_MODEL,
    usesFrozenPlan: true,
    phase: 'pilot',
    rationale: 'Can the saving be had without leaving Claude?',
  },
  E: {
    id: 'E',
    label: 'Opus plan + hosted GLM-5.3 coder',
    planner: 'claude-opus-5-5',
    coderKind: 'claude',
    coderModel: 'glm-5.3',
    usesFrozenPlan: true,
    phase: 'pilot',
    rationale: 'Big open model, cheap plan. Tests the hosted middle ground.',
  },
  G: {
    id: 'G',
    label: 'Codex (current default model), no planner',
    planner: 'none',
    coderKind: 'codex',
    coderModel: '',
    usesFrozenPlan: false,
    phase: 'pilot',
    rationale: 'Is Codex worth keeping, on the same tasks?',
  },
  F: {
    id: 'F',
    label: 'Opus plan + best of C1/C2, Opus takeover on stall',
    planner: 'claude-opus-5-5',
    coderKind: 'local-claude-code',
    coderModel: '',
    usesFrozenPlan: true,
    phase: 'full',
    rationale: "The article's actual rule. Measures how often a takeover is needed and what it saves.",
  },
};

export const PILOT_ARMS: ArmId[] = ['A', 'B', 'C1', 'C2', 'D'];
export const OPTIONAL_PILOT_ARMS: ArmId[] = ['E', 'G'];
export const FULL_ONLY_ARMS: ArmId[] = ['F'];

/**
 * Whether this arm's coder tokens are billed to Anthropic (arms A and D).
 * Arm E's hosted GLM bills at the provider's plan/rates, local coders serve
 * their own tokens, and Codex runs on ChatGPT plan limits — so their coder
 * tokens are neither Claude tokens nor local-model tokens.
 */
export function coderIsClaudeBilled(armId: ArmId): boolean {
  const arm = ARMS[armId];
  return arm.coderKind === 'claude' && arm.coderModel.startsWith('claude');
}

/** Whether this arm's coder tokens are processed by the local (PC) model. */
export function coderIsLocalModel(armId: ArmId): boolean {
  return ARMS[armId].coderKind === 'local-claude-code';
}

/**
 * Runs per task for one arm (plan: "Pilot: 1 run per task per arm. Full: 3 runs
 * per task for cloud arms, 2 for local arms (time budget)"). Arm F's coder is
 * local, so it takes the local count. `override` (--runs) replaces every count.
 */
export function runsPerArmFor(phase: 'pilot' | 'full', armId: ArmId, override?: number): number {
  if (override !== undefined) return override;
  if (phase === 'pilot') return 1;
  return ARMS[armId].coderKind === 'local-claude-code' ? 2 : 3;
}

export interface ClaudeInvocationOptions {
  prompt: string;
  cwd: string;
  model: string;
  maxTurns: number;
  env?: NodeJS.ProcessEnv;
  /** Read-only planner runs disallow editing and shell tools. */
  readOnly?: boolean;
  claudeCommand?: string;
}

export interface CodexInvocationOptions {
  prompt: string;
  cwd: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
  codexCommand?: string;
}

export interface Invocation {
  command: string[];
  env: NodeJS.ProcessEnv;
  prompt: string;
}

export function buildClaudeInvocation(options: ClaudeInvocationOptions): Invocation {
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', options.model,
    '--max-turns', String(options.maxTurns),
  ];
  if (options.readOnly) {
    args.push('--disallowedTools', 'Edit,Write,NotebookEdit,Bash');
    args.push('--permission-mode', 'plan');
  } else {
    args.push('--dangerously-skip-permissions');
  }
  return {
    command: [options.claudeCommand ?? 'claude', ...args],
    env: options.env ?? process.env,
    prompt: options.prompt,
  };
}

export function buildCodexInvocation(options: CodexInvocationOptions): Invocation {
  // `codex exec` has no turn-cap flag (unlike `claude --max-turns`); the
  // shared cap is enforced on the event stream in agent-cli.ts (TurnCapRule).
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '-C', options.cwd,
  ];
  if (options.model) args.push('--model', options.model);
  return {
    command: [options.codexCommand ?? 'codex', ...args],
    env: options.env ?? process.env,
    prompt: options.prompt,
  };
}

export function localEndpointEnv(endpoint: LocalArmEndpoint): NodeJS.ProcessEnv {
  // Return a complete environment, not an overlay: merging the parent back in
  // would reintroduce its OAuth bearer token/custom headers or cloud routing.
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('ANTHROPIC_') || name === 'CLAUDE_CODE_OAUTH_TOKEN' || name.startsWith('CLAUDE_CODE_USE_')) {
      delete env[name];
    }
  }
  return {
    ...env,
    ANTHROPIC_BASE_URL: endpoint.baseUrl,
    ANTHROPIC_API_KEY: process.env[endpoint.apiKeyEnv] ?? 'local-benchmark-key',
    CLAUDE_CONFIG_DIR: endpoint.configDir,
    CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
  };
}

export function plannerPrompt(task: TaskDefinition): string {
  return [
    'You are the planning half of a plan/execute coding pipeline. Read the repository and produce a plan an implementer will follow. Do not edit anything.',
    '',
    'Return a plan with exactly these sections:',
    '1. Steps — ordered implementation steps.',
    '2. Files to touch — the files you expect to change or add.',
    '3. How to test — the commands that prove the work.',
    '4. Done-when — observable acceptance conditions.',
    '',
    'Task:',
    task.prompt,
  ].join('\n');
}

export function coderPrompt(task: TaskDefinition, frozenPlan: string | null, _armLabel: string): string {
  const parts = [
    'Implement the following task in this repository. Make the smallest complete change, run the tests you can, and leave the working tree with your final patch applied.',
    '',
    'Task:',
    task.prompt,
  ];
  if (frozenPlan) {
    parts.push('', 'A planner produced this plan. Follow it unless it is wrong; if you must deviate, say so in your final message.', '', frozenPlan);
  }
  // No arm label here on purpose: coders must see identical prompts across arms
  // (only the frozen plan differs), or the comparison picks up demand effects.
  parts.push('', 'Work only inside this workspace directory.');
  return parts.join('\n');
}

export function takeoverPrompt(task: TaskDefinition, coderText: string, reason: string): string {
  return [
    'The previous coder stalled on this task. Take over and finish the work in this repository.',
    '',
    'Task:',
    task.prompt,
    '',
    'Why the takeover fired:',
    reason,
    '',
    'The previous coder last said:',
    coderText.slice(-4_000),
  ].join('\n');
}

export function resolveLocalModelKey(armId: ArmId): LocalModelKey {
  const arm = ARMS[armId];
  if (!arm.localModelKey) {
    throw new Error(`Arm ${armId} has no local model`);
  }
  return arm.localModelKey;
}

export function summarizeAgentResult(partial: Partial<AgentRunResult>): AgentRunResult {
  return {
    finalText: partial.finalText ?? '',
    usage: partial.usage ?? emptyUsage(),
    turns: partial.turns ?? 0,
    toolErrors: partial.toolErrors ?? [],
    hitTurnCap: partial.hitTurnCap ?? false,
    durationMs: partial.durationMs ?? 0,
    exitCode: partial.exitCode ?? null,
    timedOut: partial.timedOut ?? false,
    error: partial.error,
    rawLogPath: partial.rawLogPath ?? '',
  };
}

export function usageFromParts(parts: Partial<TokenUsage>): TokenUsage {
  return { ...emptyUsage(), ...parts };
}
