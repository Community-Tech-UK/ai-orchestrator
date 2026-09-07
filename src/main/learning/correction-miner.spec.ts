import { describe, expect, it } from 'vitest';
import {
  classifyError,
  extractBaseCommand,
  extractToolInvocations,
  findCorrectionPairs,
  isExplorationCommand,
  mineCorrections,
  scoreConfidence,
  stringSimilarity,
  type MinableMessage,
  type ToolInvocation,
} from './correction-miner';

let seq = 0;
function toolUse(command: string, id = `t${seq++}`): MinableMessage {
  return {
    type: 'tool_use',
    content: `Using tool: Bash`,
    timestamp: Date.now(),
    metadata: { id, name: 'Bash', input: { command } },
  };
}
function toolResult(id: string, content: string, isError: boolean | undefined): MinableMessage {
  return {
    type: 'tool_result',
    content,
    timestamp: Date.now(),
    metadata: isError === undefined ? { tool_use_id: id } : { tool_use_id: id, is_error: isError },
  };
}
function pair(command: string, resultContent: string, isError: boolean | undefined): MinableMessage[] {
  const id = `t${seq++}`;
  return [toolUse(command, id), toolResult(id, resultContent, isError)];
}

/** LT-196: the transcript-invisible record Claude writes (and ACP falls back to). */
function toolOutcome(id: string, content: string, isError: boolean): MinableMessage {
  return {
    type: 'tool_outcome',
    content,
    timestamp: Date.now(),
    metadata: { tool_use_id: id, is_error: isError, name: 'Bash' },
  };
}

describe('LT-196: tool_outcome records feed the miner', () => {
  it('closes an open tool_use exactly like a tool_result does', () => {
    const id = `lt196-${seq++}`;
    const invocations = extractToolInvocations([
      toolUse('grep --bogus-flag foo', id),
      toolOutcome(id, 'grep: unrecognized option --bogus-flag', true),
    ]);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      command: 'grep --bogus-flag foo',
      resultText: 'grep: unrecognized option --bogus-flag',
      isError: true,
      toolName: 'Bash',
    });
  });

  it('records a successful outcome as isError false', () => {
    const id = `lt196-${seq++}`;
    const invocations = extractToolInvocations([
      toolUse('grep foo bar.txt', id),
      toolOutcome(id, '', false),
    ]);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.isError).toBe(false);
  });

  it('mines a real failure-then-correction pair from tool_outcome records alone', () => {
    // The exact shape a *Claude* session now archives: no `tool_result` message
    // anywhere, only tool_use + the invisible record. ACP providers use a
    // different shape and are covered separately below.
    const failId = `lt196-${seq++}`;
    const fixId = `lt196-${seq++}`;
    const messages: MinableMessage[] = [
      toolUse('grep --bogus-flag needle haystack.txt', failId),
      toolOutcome(failId, 'grep: unrecognized option --bogus-flag', true),
      toolUse('grep -F needle haystack.txt', fixId),
      toolOutcome(fixId, '', false),
    ];
    expect(messages.some((m) => m.type === 'tool_result')).toBe(false);

    const pairs = findCorrectionPairs(extractToolInvocations(messages));
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    expect(pairs[0]).toMatchObject({
      baseCommand: 'grep',
      failCommand: 'grep --bogus-flag needle haystack.txt',
      fixCommand: 'grep -F needle haystack.txt',
      fixIsError: false,
    });
  });

  it('mines a real ACP-shaped session (Copilot/Cursor/Grok)', () => {
    // The real shapes AcpCliAdapter emits: `tool_use` metadata is
    // { toolCallId, kind, name, title, status, transport, input }, and
    // `tool_result` metadata is { sessionUpdate, toolCallId, title, status,
    // transport, is_error }. Correlation is by `toolCallId`, not `tool_use_id`,
    // and the command lives under `input.command`.
    const acpUse = (id: string, command: string): MinableMessage => ({
      type: 'tool_use',
      content: `\`${command}\``,
      timestamp: Date.now(),
      metadata: {
        toolCallId: id,
        kind: 'execute',
        name: 'execute',
        title: `\`${command}\``,
        status: 'pending',
        transport: 'acp',
        input: { command },
      },
    });
    const acpResult = (id: string, content: string, isError: boolean): MinableMessage => ({
      type: 'tool_result',
      content,
      timestamp: Date.now(),
      metadata: {
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        title: 'x',
        status: isError ? 'failed' : 'completed',
        transport: 'acp',
        is_error: isError,
      },
    });

    const messages: MinableMessage[] = [
      acpUse('acp-1', 'grep --bogus-flag needle haystack.txt'),
      acpResult('acp-1', 'grep: unrecognized option --bogus-flag', true),
      acpUse('acp-2', 'grep -F needle haystack.txt'),
      acpResult('acp-2', 'needle', false),
    ];

    const invocations = extractToolInvocations(messages);
    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toMatchObject({
      command: 'grep --bogus-flag needle haystack.txt',
      isError: true,
    });

    const pairs = findCorrectionPairs(invocations);
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    expect(pairs[0]).toMatchObject({
      baseCommand: 'grep',
      failCommand: 'grep --bogus-flag needle haystack.txt',
      fixCommand: 'grep -F needle haystack.txt',
      fixIsError: false,
    });
  });

  it('drops an ACP tool_use with no command, as before (nothing to mine)', () => {
    // A read/think call carries no command; it must not open an invocation.
    const messages: MinableMessage[] = [{
      type: 'tool_use',
      content: 'Read File',
      timestamp: Date.now(),
      metadata: { toolCallId: 'acp-r', kind: 'read', name: 'read', transport: 'acp' },
    }];
    expect(extractToolInvocations(messages)).toHaveLength(0);
  });

  it('leaves the Codex tool_result path working unchanged', () => {
    const messages = pair('npm test --flag-x', 'unrecognized option --flag-x', true);
    expect(extractToolInvocations(messages)).toHaveLength(1);
  });
});

describe('extractToolInvocations', () => {
  it('correlates tool_use/tool_result pairs into invocations with command + isError', () => {
    const messages = pair('npm test --flag-x', 'unrecognized option --flag-x', true);
    const invocations = extractToolInvocations(messages);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      command: 'npm test --flag-x',
      resultText: 'unrecognized option --flag-x',
      isError: true,
      toolName: 'Bash',
    });
  });

  it('drops tool_use messages with no extractable command', () => {
    const messages: MinableMessage[] = [
      { type: 'tool_use', content: 'Using tool: Read', metadata: { id: 'r1', name: 'Read', input: { path: '/x' } } },
      toolResult('r1', 'file contents', false),
    ];
    expect(extractToolInvocations(messages)).toHaveLength(0);
  });

  it('drops an uncorrelated tool_result (no matching open tool_use id)', () => {
    const messages: MinableMessage[] = [toolResult('missing-id', 'some output', true)];
    expect(extractToolInvocations(messages)).toHaveLength(0);
  });

  it('reads command from metadata.arguments.command (codex-exec shape)', () => {
    const messages: MinableMessage[] = [
      {
        type: 'tool_use',
        content: 'Running command: git status',
        metadata: { name: 'command_execution', arguments: { command: 'git status' }, callId: 'c1' },
      },
      { type: 'tool_result', content: 'clean', metadata: { callId: 'c1', is_error: false } },
    ];
    const invocations = extractToolInvocations(messages);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({ command: 'git status', isError: false });
  });
});

describe('extractBaseCommand', () => {
  it.each([
    ['git commit -m "x"', 'git'],
    ['npm test --flag-x', 'npm'],
    ['/usr/bin/git push', 'git'],
    ['C:\\tools\\node.exe --version', 'node.exe'],
    ['   ', ''],
    ['', ''],
  ])('extractBaseCommand(%j) -> %j', (input, expected) => {
    expect(extractBaseCommand(input)).toBe(expected);
  });
});

describe('isExplorationCommand', () => {
  it.each(['cd /tmp', 'ls -la', 'pwd', 'find . -name x', 'tree', 'dir'])('%s is exploration', (cmd) => {
    expect(isExplorationCommand(cmd)).toBe(true);
  });
  it.each(['git status', 'npm test', 'cat file.txt'])('%s is not exploration', (cmd) => {
    expect(isExplorationCommand(cmd)).toBe(false);
  });
});

describe('classifyError', () => {
  it.each([
    ['bash: foo: command not found', 'CommandNotFound'],
    ["'xyz' is not recognized as an internal or external command", 'CommandNotFound'],
    ['Error: spawn foo ENOENT', 'CommandNotFound'],
    ['permission denied', 'PermissionDenied'],
    ['EACCES: permission denied, open \'/etc/x\'', 'PermissionDenied'],
    ['unrecognized option \'--flag-x\'', 'UnknownFlag'],
    ['unknown flag: --bogus', 'UnknownFlag'],
    ['error: missing required argument \'path\'', 'MissingArg'],
    ['the following arguments are required: file', 'MissingArg'],
    ['SyntaxError: Unexpected token }', 'WrongSyntax'],
    ['usage: git commit [options]', 'WrongSyntax'],
    ['ENOENT: no such file or directory, open \'/x/y\'', 'WrongPath'],
    ['cannot find the path specified', 'WrongPath'],
  ])('%j -> %s', (text, expected) => {
    expect(classifyError(text)).toBe(expected);
  });

  it('returns null for unclassifiable text (conservative, no guessing)', () => {
    expect(classifyError('connection reset by peer')).toBeNull();
    expect(classifyError('')).toBeNull();
  });
});

describe('stringSimilarity / scoreConfidence', () => {
  it('identical strings have similarity 1', () => {
    expect(stringSimilarity('git commit -m x', 'git commit -m x')).toBe(1);
  });

  it('similarity decreases with edit distance', () => {
    const close = stringSimilarity('npm test --flag-x', 'npm test --flag-y');
    const far = stringSimilarity('npm test --flag-x', 'npm run build');
    expect(close).toBeGreaterThan(far);
  });

  it('confidence ranks confirmed-success > unobserved > still-failing, for the same edit', () => {
    const confirmed = scoreConfidence('npm test --flag-x', 'npm test --flag-y', false);
    const unobserved = scoreConfidence('npm test --flag-x', 'npm test --flag-y', null);
    const stillFailing = scoreConfidence('npm test --flag-x', 'npm test --flag-y', true);
    expect(confirmed).toBeGreaterThan(stillFailing);
    expect(stillFailing).toBeGreaterThan(unobserved);
  });

  it('confidence is always below 1.0 for a single observation (never trusted outright)', () => {
    expect(scoreConfidence('git commit', 'git commit --amend', false)).toBeLessThan(1);
  });
});

describe('findCorrectionPairs', () => {
  function invocationsFrom(messages: MinableMessage[]): ToolInvocation[] {
    return extractToolInvocations(messages);
  }

  it('pairs a classified failure with the next differing same-base-command success', () => {
    const messages = [
      ...pair('npm test --flag-x', "unrecognized option '--flag-x'", true),
      ...pair('npm test --flag-y', 'PASS 12/12', false),
    ];
    const pairs = findCorrectionPairs(invocationsFrom(messages));
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      baseCommand: 'npm',
      errorClass: 'UnknownFlag',
      failCommand: 'npm test --flag-x',
      fixCommand: 'npm test --flag-y',
      fixIsError: false,
    });
  });

  it('TDD red-green filter: an identical re-run of the same command is never a correction', () => {
    const messages = [
      ...pair('npm test', 'FAIL 1/12', true),
      ...pair('npm test', 'PASS 12/12', false),
    ];
    // The failure result text ("FAIL 1/12") also isn't classifiable, but even
    // with a classifiable message the identical-command guard must fire first.
    expect(findCorrectionPairs(invocationsFrom(messages))).toHaveLength(0);
  });

  it('TDD filter fires even when the failure text IS classifiable', () => {
    const messages = [
      ...pair('pytest tests/test_x.py', 'command not found: pytest', true),
      ...pair('pytest tests/test_x.py', '1 passed', false),
    ];
    expect(findCorrectionPairs(invocationsFrom(messages))).toHaveLength(0);
  });

  it('path-exploration filter: cd failing then succeeding on a different path is not mined', () => {
    const messages = [
      ...pair('cd /old/path', 'no such file or directory', true),
      ...pair('cd /new/path', '', false),
    ];
    expect(findCorrectionPairs(invocationsFrom(messages))).toHaveLength(0);
  });

  it('skips an unclassifiable failure', () => {
    const messages = [
      ...pair('git push', 'connection reset by peer', true),
      ...pair('git push --force', 'done', false),
    ];
    expect(findCorrectionPairs(invocationsFrom(messages))).toHaveLength(0);
  });

  it('skips a still-failing candidate and pairs with the next real fix', () => {
    const messages = [
      ...pair('git commit -m x', 'permission denied', true),
      ...pair('git commit -amend', 'permission denied', true),
      ...pair('git commit -m x --no-verify', 'success', false),
    ];
    const pairs = findCorrectionPairs(invocationsFrom(messages));
    expect(pairs).toHaveLength(1);
    expect(pairs[0].fixCommand).toBe('git commit -m x --no-verify');
  });

  it('does not pair across different base commands', () => {
    const messages = [
      ...pair('npm test --flag-x', "unrecognized option '--flag-x'", true),
      ...pair('git status', 'clean', false),
    ];
    expect(findCorrectionPairs(invocationsFrom(messages))).toHaveLength(0);
  });

  it('respects the lookahead window', () => {
    const messages = [
      ...pair('npm test --flag-x', "unrecognized option '--flag-x'", true),
      ...pair('git status', 'clean', false),
      ...pair('git status', 'clean', false),
      ...pair('npm test --flag-y', 'PASS', false),
    ];
    expect(findCorrectionPairs(invocationsFrom(messages), { lookahead: 1 })).toHaveLength(0);
    expect(findCorrectionPairs(invocationsFrom(messages), { lookahead: 5 })).toHaveLength(1);
  });

  it('pairs with fixIsError null when a tool_result is observed but its outcome flag is not', () => {
    const messages = [
      ...pair('npm test --flag-x', "unrecognized option '--flag-x'", true),
      ...pair('npm test --flag-y', 'some output', undefined), // metadata has no is_error key
    ];
    const pairs = findCorrectionPairs(invocationsFrom(messages));
    expect(pairs).toHaveLength(1);
    expect(pairs[0].fixIsError).toBeNull();
    expect(pairs[0].confidence).toBeLessThan(
      scoreConfidence('npm test --flag-x', 'npm test --flag-y', false),
    );
  });
});

describe('mineCorrections (end-to-end)', () => {
  it('extracts + pairs in one call', () => {
    const messages = [
      ...pair('npm test --flag-x', "unrecognized option '--flag-x'", true),
      ...pair('npm test --flag-y', 'PASS 12/12', false),
    ];
    expect(mineCorrections(messages)).toHaveLength(1);
  });
});
