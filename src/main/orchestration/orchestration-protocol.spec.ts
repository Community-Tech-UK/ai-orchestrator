import { describe, expect, it, vi } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

import {
  ORCHESTRATION_MARKER_END,
  ORCHESTRATION_MARKER_START,
  formatCommandResponse,
  generateChildPrompt,
  generateOrchestrationPrompt,
  parseOrchestratorCommands,
  stripOrchestrationMarkers,
  type OrchestratorCommand,
} from './orchestration-protocol';

function commandBlock(command: Record<string, unknown>): string {
  return [
    ORCHESTRATION_MARKER_START,
    JSON.stringify(command),
    ORCHESTRATION_MARKER_END,
  ].join('\n');
}

function parseFirst(input: string): OrchestratorCommand | undefined {
  return parseOrchestratorCommands(input)[0];
}

describe('orchestration-protocol module', () => {
  it('exports the documented marker constants', () => {
    expect(ORCHESTRATION_MARKER_START).toBe(':::ORCHESTRATOR_COMMAND:::');
    expect(ORCHESTRATION_MARKER_END).toBe(':::END_COMMAND:::');
  });
});

describe('generateOrchestrationPrompt', () => {
  const instanceId = 'inst_test_42';
  const prompt = generateOrchestrationPrompt(instanceId, 'claude-sonnet-4');

  it('interpolates the instance id into the prompt body', () => {
    expect(prompt).toContain(`**Instance ID:** ${instanceId}`);
  });

  it('interpolates the current model into the identity preamble when supplied', () => {
    expect(prompt).toContain('You are currently running as **claude-sonnet-4**');
  });

  it('omits the identity preamble when no model is supplied', () => {
    const bare = generateOrchestrationPrompt(instanceId);
    expect(bare).not.toContain('You are currently running as');
    expect(bare).toContain(`**Instance ID:** ${instanceId}`);
  });

  describe('delegation rules', () => {
    it('tells the parent to spawn children only for parallel or specialized work', () => {
      expect(prompt).toMatch(/Spawn children ONLY when:[\s\S]*2\+ independent tasks/);
      expect(prompt).toMatch(/specialized focus/);
    });

    it('tells the parent not to spawn children for sequential, single-file, or simple-read tasks', () => {
      expect(prompt).toMatch(/Do NOT spawn children for:[\s\S]*Sequential analysis/);
      expect(prompt).toMatch(/Single-file or few-file tasks/);
      expect(prompt).toMatch(/Simple file reading/);
    });

    it('tells the parent to retry once and then do the work directly on failure', () => {
      expect(prompt).toMatch(/On failure:[\s\S]*retry once[\s\S]*do the work directly/);
    });

    it('tells the parent to terminate children when done', () => {
      expect(prompt).toMatch(/[Aa]lways terminate children when done/);
    });
  });

  describe('retrieval-first preference', () => {
    it('prefers structured retrieval over raw output', () => {
      expect(prompt).toMatch(/prefer structured retrieval over raw output/i);
    });

    it('lists every structured-retrieval command', () => {
      expect(prompt).toContain('get_child_summary');
      expect(prompt).toContain('get_child_artifacts');
      expect(prompt).toContain('get_child_section');
    });

    it('warns that get_child_output is a last-resort raw read', () => {
      expect(prompt).toMatch(/get_child_output[\s\S]*Raw output[\s\S]*last resort/);
    });
  });

  describe('model and provider routing guidance', () => {
    it('tells the parent to set both provider and model when the user names both', () => {
      expect(prompt).toContain('set both `provider` and `model`');
    });

    it('lists supported providers', () => {
      expect(prompt).toMatch(/Providers:[\s\S]*claude[\s\S]*codex[\s\S]*gemini[\s\S]*copilot/);
    });

    it('lists model tiers', () => {
      expect(prompt).toMatch(/Model tiers:[\s\S]*fast[\s\S]*balanced[\s\S]*powerful/);
    });
  });

  describe('native cross-LLM coordination', () => {
    it('tells the parent to use spawn_child.provider for cross-LLM work', () => {
      expect(prompt).toContain('always use `spawn_child` with the `provider` field');
    });

    it('explicitly forbids the MCP wrappers for provider coordination', () => {
      expect(prompt).toContain('mcp__copilot__copilot_chat');
      expect(prompt).toContain('mcp__gemini-cli__gemini');
      expect(prompt).toContain('mcp__codex-cli__*');
      expect(prompt).toMatch(/Do NOT use:/);
    });
  });

  describe('user interaction', () => {
    it('documents request_user_action and the core prompt-table request types', () => {
      expect(prompt).toContain('request_user_action');
      for (const requestType of ['switch_mode', 'approve_action', 'ask_questions']) {
        expect(prompt).toContain(requestType);
      }
    });
  });

  describe('consensus guidance', () => {
    it('documents consensus_query as a high-confidence-validation tool', () => {
      expect(prompt).toMatch(/consensus_query[\s\S]*high-confidence/);
    });

    it('warns against consensus for simple lookups', () => {
      expect(prompt).toMatch(/Do NOT use[\s\S]*simple lookups/);
    });
  });
});

describe('generateChildPrompt', () => {
  it('includes the child id and parent id', () => {
    const out = generateChildPrompt('child_1', 'parent_1', 'do something useful');
    expect(out).toContain('Instance: child_1');
    expect(out).toContain('Parent: parent_1');
  });

  it('embeds the task verbatim', () => {
    const task = 'audit the auth module for missing CSRF guards';
    const out = generateChildPrompt('c', 'p', task);
    expect(out).toContain(`**Your Task:** ${task}`);
  });

  it('includes the task id when provided', () => {
    const out = generateChildPrompt('c', 'p', 'task body', 'task_99');
    expect(out).toContain('(Task: task_99)');
  });

  it('omits the task id label when no task id is provided', () => {
    const out = generateChildPrompt('c', 'p', 'task body');
    expect(out).not.toContain('(Task:');
  });

  it('forbids the child from spawning further children', () => {
    const out = generateChildPrompt('c', 'p', 'task body');
    expect(out).toMatch(/cannot spawn children/i);
  });

  it('instructs the child to report results via the orchestrator command marker', () => {
    const out = generateChildPrompt('c', 'p', 'task body');
    expect(out).toContain(ORCHESTRATION_MARKER_START);
    expect(out).toContain(ORCHESTRATION_MARKER_END);
    expect(out).toContain('"action": "report_result"');
  });

  it('renders the parent context section only when context is provided', () => {
    const without = generateChildPrompt('c', 'p', 'task body');
    expect(without).not.toContain('Parent Context');

    const withContext = generateChildPrompt('c', 'p', 'task body', undefined, 'recent decisions: none');
    expect(withContext).toContain('## Parent Context');
    expect(withContext).toContain('recent decisions: none');
  });

  it('lists each artifact type currently advertised in the prompt', () => {
    const out = generateChildPrompt('c', 'p', 'task body');
    for (const artifactType of [
      'finding',
      'recommendation',
      'code_snippet',
      'file_reference',
      'decision',
      'data',
      'command',
      'error',
      'warning',
      'success',
      'metric',
    ]) {
      expect(out).toContain(artifactType);
    }
  });

  it('lists every supported severity level', () => {
    const out = generateChildPrompt('c', 'p', 'task body');
    for (const severity of ['critical', 'high', 'medium', 'low', 'info']) {
      expect(out).toContain(severity);
    }
  });
});

describe('parseOrchestratorCommands', () => {
  it('returns an empty list when the text contains no markers', () => {
    expect(parseOrchestratorCommands('plain assistant text with no commands')).toEqual([]);
  });

  it('extracts a spawn_child command embedded in surrounding markdown', () => {
    const command = {
      action: 'spawn_child',
      task: 'audit auth module',
      provider: 'copilot',
      model: 'gemini-3.1-pro-preview',
      name: 'audit-1',
    };
    const text = `Lead-in prose.\n${commandBlock(command)}\nTrailing prose.`;
    expect(parseFirst(text)).toEqual(command);
  });

  it('extracts multiple commands in a single text', () => {
    const first = { action: 'get_children' };
    const second = { action: 'terminate_child', childId: 'c1' };
    const text = `${commandBlock(first)}\n--\n${commandBlock(second)}`;
    expect(parseOrchestratorCommands(text)).toEqual([first, second]);
  });

  it('round-trips every documented action type', () => {
    const samples: Record<string, unknown>[] = [
      { action: 'spawn_child', task: 't' },
      { action: 'message_child', childId: 'c', message: 'hi' },
      { action: 'get_children' },
      { action: 'terminate_child', childId: 'c' },
      { action: 'get_child_output', childId: 'c' },
      { action: 'call_tool', toolId: 'fs.read' },
      { action: 'report_task_complete', success: true, summary: 's' },
      { action: 'report_progress', percentage: 25, currentStep: 'reading' },
      { action: 'report_error', code: 'E_X', message: 'm' },
      { action: 'get_task_status' },
      { action: 'request_user_action', requestType: 'confirm', title: 't', message: 'm' },
      { action: 'report_result', summary: 's' },
      { action: 'get_child_summary', childId: 'c' },
      { action: 'get_child_artifacts', childId: 'c' },
      { action: 'get_child_section', childId: 'c', section: 'conclusions' },
      { action: 'consensus_query', question: 'is this safe?' },
    ];

    for (const sample of samples) {
      expect(
        parseFirst(commandBlock(sample)),
        `expected to round-trip action "${sample.action}"`,
      ).toEqual(sample);
    }
  });

  it('drops non-JSON marker payloads silently', () => {
    const text = `${ORCHESTRATION_MARKER_START}\nthis is not json\n${ORCHESTRATION_MARKER_END}`;
    expect(parseOrchestratorCommands(text)).toEqual([]);
  });

  it('drops commands whose action is unknown', () => {
    const text = commandBlock({ action: 'totally_made_up', task: 't' });
    expect(parseOrchestratorCommands(text)).toEqual([]);
  });
});

describe('isValidCommand (via parser drop behavior)', () => {
  function rejects(name: string, payload: Record<string, unknown>): void {
    it(`rejects ${name}`, () => {
      expect(parseOrchestratorCommands(commandBlock(payload))).toEqual([]);
    });
  }

  rejects('spawn_child without a task', { action: 'spawn_child' });
  rejects('spawn_child with non-string task', { action: 'spawn_child', task: 7 });
  rejects('message_child without childId', { action: 'message_child', message: 'hi' });
  rejects('message_child without message', { action: 'message_child', childId: 'c' });
  rejects('terminate_child without childId', { action: 'terminate_child' });
  rejects('get_child_output without childId', { action: 'get_child_output' });
  rejects('call_tool without toolId', { action: 'call_tool' });
  rejects('report_task_complete without summary', {
    action: 'report_task_complete',
    success: true,
  });
  rejects('report_task_complete with non-boolean success', {
    action: 'report_task_complete',
    summary: 's',
    success: 'yes',
  });
  rejects('report_progress without percentage', {
    action: 'report_progress',
    currentStep: 'reading',
  });
  rejects('report_progress without currentStep', {
    action: 'report_progress',
    percentage: 50,
  });
  rejects('report_error without code', { action: 'report_error', message: 'm' });
  rejects('report_error without message', { action: 'report_error', code: 'E' });

  describe('request_user_action', () => {
    rejects('with unknown requestType', {
      action: 'request_user_action',
      requestType: 'banana',
      title: 't',
      message: 'm',
    });
    rejects('switch_mode without targetMode', {
      action: 'request_user_action',
      requestType: 'switch_mode',
      title: 't',
      message: 'm',
    });
    rejects('switch_mode with invalid targetMode', {
      action: 'request_user_action',
      requestType: 'switch_mode',
      title: 't',
      message: 'm',
      targetMode: 'banana',
    });
    rejects('select_option with empty options', {
      action: 'request_user_action',
      requestType: 'select_option',
      title: 't',
      message: 'm',
      options: [],
    });
    rejects('select_option with bad option shape', {
      action: 'request_user_action',
      requestType: 'select_option',
      title: 't',
      message: 'm',
      options: [{ id: '', label: '' }],
    });
    rejects('ask_questions without questions', {
      action: 'request_user_action',
      requestType: 'ask_questions',
      title: 't',
      message: 'm',
    });
    rejects('ask_questions with empty-string question', {
      action: 'request_user_action',
      requestType: 'ask_questions',
      title: 't',
      message: 'm',
      questions: ['  '],
    });
  });

  describe('structured-result commands', () => {
    rejects('report_result without summary', { action: 'report_result' });
    rejects('get_child_summary without childId', { action: 'get_child_summary' });
    rejects('get_child_artifacts without childId', { action: 'get_child_artifacts' });
    rejects('get_child_section without childId', {
      action: 'get_child_section',
      section: 'conclusions',
    });
    rejects('get_child_section with bad section', {
      action: 'get_child_section',
      childId: 'c',
      section: 'banana',
    });
  });

  rejects('consensus_query without a question', { action: 'consensus_query' });
});

describe('stripOrchestrationMarkers', () => {
  it('removes a single command block while preserving surrounding text', () => {
    const text = `before\n${commandBlock({ action: 'get_children' })}\nafter`;
    const cleaned = stripOrchestrationMarkers(text);
    expect(cleaned).not.toContain(ORCHESTRATION_MARKER_START);
    expect(cleaned).not.toContain(ORCHESTRATION_MARKER_END);
    expect(cleaned).toContain('before');
    expect(cleaned).toContain('after');
  });

  it('removes multiple command blocks', () => {
    const text = [
      'lead',
      commandBlock({ action: 'get_children' }),
      'middle',
      commandBlock({ action: 'terminate_child', childId: 'c1' }),
      'tail',
    ].join('\n');
    const cleaned = stripOrchestrationMarkers(text);
    expect(cleaned).not.toContain(ORCHESTRATION_MARKER_START);
    expect(cleaned).toContain('lead');
    expect(cleaned).toContain('middle');
    expect(cleaned).toContain('tail');
  });

  it('removes orchestrator response blocks', () => {
    const text = [
      'preamble',
      '[Orchestrator Response]',
      'Action: get_children',
      'Status: SUCCESS',
      '[/Orchestrator Response]',
      'postamble',
    ].join('\n');
    const cleaned = stripOrchestrationMarkers(text);
    expect(cleaned).not.toContain('[Orchestrator Response]');
    expect(cleaned).not.toContain('[/Orchestrator Response]');
    expect(cleaned).toContain('preamble');
    expect(cleaned).toContain('postamble');
  });

  it('collapses runs of three or more blank lines down to two', () => {
    const text = `line1\n\n\n\nline2`;
    expect(stripOrchestrationMarkers(text)).toBe('line1\n\nline2');
  });
});

describe('formatCommandResponse', () => {
  it('produces the canonical response block with action, status, and JSON data', () => {
    const out = formatCommandResponse('get_children', true, { children: [] });
    expect(out).toContain('[Orchestrator Response]');
    expect(out).toContain('Action: get_children');
    expect(out).toContain('Status: SUCCESS');
    expect(out).toContain('"children": []');
    expect(out).toContain('[/Orchestrator Response]');
  });

  it('reports FAILED status when success is false', () => {
    const out = formatCommandResponse('terminate_child', false, { error: 'no such child' });
    expect(out).toContain('Status: FAILED');
    expect(out).toContain('"error": "no such child"');
  });
});
