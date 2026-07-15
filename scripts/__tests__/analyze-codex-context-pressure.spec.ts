import {
  mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analyzeCodexContextPressure,
  type CodexContextAnalysisDependencies,
  type CodexContextAnalysisSummary,
} from '../analyze-codex-context-pressure';

const cleanupDirectories: string[] = [];

afterEach(() => {
  for (const directory of cleanupDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('analyze-codex-context-pressure', () => {
  it('extracts metadata from all sources without leaking content or identifiers', async () => {
    const root = temporaryDirectory();
    const inputs = join(root, 'inputs');
    const outDir = join(root, 'output');
    mkdirSync(inputs);
    const logPath = join(inputs, 'app.log');
    const rolloutPath = join(inputs, 'rollout.jsonl');
    const dbPath = join(inputs, 'conversation-ledger.db');
    const privateFragments = [
      'PROMPT_PRIVATE_ALPHA',
      'COMMAND_PRIVATE_BETA',
      '/Users/private/project/secret.txt',
      'https://private.example/query?q=secret',
      'sk-abcdefghijklmnopqrst',
      'instance-private-42',
      'thread-private-42',
      'tool-private-name',
      'abcdef012345',
      'call-private',
      'message-private',
      'session-private',
      'PRIVATE_RAW_BODY',
    ];

    writeFileSync(logPath, lines([
      {
        timestamp: 1,
        subsystem: 'CodexContextDiagnostics',
        message: 'context-pressure-observation',
        data: {
          kind: 'turn-start', schemaVersion: 1, at: 100, turnSequence: 1,
          baselineUsedTokens: 10, ignoredPrompt: privateFragments[0],
        },
      },
      {
        timestamp: 2,
        subsystem: 'CodexContextDiagnostics',
        message: 'context-pressure-observation',
        data: {
          kind: 'transport-usage', schemaVersion: 1, at: 101, transportSequence: 1,
          threadCorrelation: 'abcdef012345', contextWindow: 200,
          last: { totalTokens: 20, inputTokens: 18, cachedInputTokens: 7, outputTokens: 2, reasoningOutputTokens: 1 },
          cumulative: { totalTokens: 30, inputTokens: 27, cachedInputTokens: 9, outputTokens: 3, reasoningOutputTokens: 1 },
          ignoredCommand: privateFragments[1],
        },
      },
      {
        timestamp: 3,
        subsystem: 'CodexContextDiagnostics',
        message: 'context-pressure-observation',
        data: {
          kind: 'item-completed', schemaVersion: 1, at: 102, turnSequence: 1,
          itemSequence: 1, itemClass: 'command', rootThread: true,
          observedPayloadBytes: 17, serializedItemBytes: 91,
          ignoredPath: privateFragments[2],
        },
      },
      {
        timestamp: 4,
        subsystem: 'CodexContextDiagnostics',
        message: 'context-pressure-observation',
        data: {
          kind: 'compaction-observed', schemaVersion: 1, at: 103,
          turnSequence: 1, requestSequence: 1, lastKnownUsedTokens: 20,
        },
      },
      {
        timestamp: 5,
        subsystem: 'CodexContextDiagnostics',
        message: 'context-pressure-observation',
        data: {
          kind: 'turn-complete', schemaVersion: 1, at: 104, turnSequence: 1,
          requestSequence: 1, rootItems: 1, subagentItems: 0,
          observedPayloadBytes: 17, peakUsedTokens: 20, peakPercentage: 10,
          compactionsObserved: 1, completionStatus: 'completed',
        },
      },
    ]));

    writeFileSync(rolloutPath, lines([
      {
        timestamp: '2026-07-13T10:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { total_tokens: 60, input_tokens: 50, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 3 },
            last_token_usage: { total_tokens: 25, input_tokens: 22, cached_input_tokens: 8, output_tokens: 3, reasoning_output_tokens: 1 },
          },
          message: privateFragments[0],
          command: privateFragments[1],
          url: privateFragments[3],
        },
      },
      {
        timestamp: '2026-07-13T10:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          name: privateFragments[6],
          call_id: 'call-private',
          output: `${privateFragments[4]}:${privateFragments[2]}`,
        },
      },
      {
        timestamp: '2026-07-13T10:00:02.000Z',
        type: 'event_msg',
        payload: { type: 'context_compacted', text: privateFragments[0] },
      },
      {
        timestamp: '2026-07-13T10:00:03.000Z',
        type: 'event_msg',
        payload: { type: 'mcp_tool_call_end', name: privateFragments[6], result: privateFragments[4] },
      },
      {
        timestamp: '2026-07-13T10:00:04.000Z',
        type: 'event_msg',
        payload: { type: 'patch_apply_end', path: privateFragments[2], output: privateFragments[1] },
      },
    ]));
    writeFileSync(dbPath, 'READ_ONLY_DATABASE_SENTINEL');
    const database = captureDatabase(makeCaptureRows(privateFragments));

    const inputEntriesBefore = readdirSync(inputs).sort();
    const result = await analyzeCodexContextPressure({
      logPath, dbPath, instanceId: privateFragments[5], rolloutPath, outDir,
    }, database.dependencies);
    const repeated = await analyzeCodexContextPressure({
      logPath, dbPath, instanceId: privateFragments[5], rolloutPath,
      outDir: join(root, 'output-repeat'),
    }, database.dependencies);
    const inputEntriesAfter = readdirSync(inputs).sort();
    const allOutput = [
      readFileSync(result.summaryPath, 'utf8'),
      readFileSync(result.timelinePath, 'utf8'),
      readFileSync(result.reportPath, 'utf8'),
    ].join('\n');
    const summary = JSON.parse(readFileSync(result.summaryPath, 'utf8')) as CodexContextAnalysisSummary;
    const timeline = readJsonLines<Record<string, unknown>>(readFileSync(result.timelinePath, 'utf8'));
    const report = readFileSync(result.reportPath, 'utf8');

    expect(inputEntriesAfter).toEqual(inputEntriesBefore);
    expect(readFileSync(repeated.summaryPath, 'utf8')).toBe(readFileSync(result.summaryPath, 'utf8'));
    expect(readFileSync(repeated.timelinePath, 'utf8')).toBe(readFileSync(result.timelinePath, 'utf8'));
    expect(readFileSync(repeated.reportPath, 'utf8')).toBe(readFileSync(result.reportPath, 'utf8'));
    expect(readFileSync(dbPath, 'utf8')).toBe('READ_ONLY_DATABASE_SENTINEL');
    expect(database.openDatabase).toHaveBeenCalledWith(dbPath, {
      readonly: true,
      fileMustExist: true,
    });
    expect(database.sql.some((sql) => /CASE\s+WHEN\s+length\(raw_source\)/i.test(sql))).toBe(true);
    expect(database.sql.some((sql) => /SELECT[\s\S]*raw_source\s*,\s*raw_json/i.test(sql))).toBe(false);
    expect(database.iterateRows).toHaveBeenCalledTimes(2);
    expect(summary.sources).toEqual({
      diagnosticLog: { provided: true, available: true, acceptedRecords: 5, malformedRecords: 0 },
      providerCaptures: { provided: true, available: true, acceptedRecords: 4, malformedRecords: 0 },
      rollout: { provided: true, available: true, acceptedRecords: 5, malformedRecords: 0 },
    });
    expect(summary.coverage).toEqual({
      rawDiagnosticUsageNotifications: true,
      normalizedContextEvents: true,
      rolloutTokenCountEvents: true,
      itemSizeObservations: true,
      compactionMarkers: true,
      turnBoundaries: true,
    });
    expect(timeline).toContainEqual(expect.objectContaining({
      source: 'provider-capture', kind: 'context', usedTokens: 30, contextWindow: 200,
      inputShareRatio: 0.68, rawProvenancePresent: true,
    }));
    expect(timeline).toContainEqual(expect.objectContaining({
      source: 'provider-capture', kind: 'output', contentBytes: 20,
    }));
    expect(timeline).toContainEqual(expect.objectContaining({
      source: 'rollout', entryType: 'event-message', subtype: 'token-count',
      tokenUsage: expect.objectContaining({ cumulative: expect.objectContaining({ totalTokens: 60 }) }),
    }));
    expect(timeline).toContainEqual(expect.objectContaining({
      source: 'rollout', entryType: 'response-item', subtype: 'tool-result',
      itemClass: 'dynamic', contentBytes: expect.any(Number),
    }));
    expect(timeline).toContainEqual(expect.objectContaining({
      source: 'rollout', subtype: 'tool-result', itemClass: 'mcp',
    }));
    expect(timeline).toContainEqual(expect.objectContaining({
      source: 'rollout', subtype: 'file-change', itemClass: 'file-change',
    }));
    expect(report).toContain('## Usage evidence');
    expect(report).toContain('## Item-size evidence');
    expect(report).toContain('## Compaction and turn observations');
    expect(report).toMatch(/\| diagnostic transport usage \| 101 \| 20 \| — \| 30 \| — \| 200 \| 10 \|/);
    expect(report).toMatch(/\| command \| [1-9][0-9]* \| [1-9][0-9]* \|/);
    expect(report).toMatch(/\| compaction observed \| [1-9][0-9]* \|/);
    expect(allOutput).not.toMatch(/"(?:prompt|command|toolName|tool_name|path|url|query|filename|threadId|instanceId)"\s*:/i);
    for (const fragment of privateFragments) expect(allOutput).not.toContain(fragment);
  });

  it('does not claim item-size coverage for a token-count-only rollout', async () => {
    const root = temporaryDirectory();
    const inputs = join(root, 'inputs');
    mkdirSync(inputs);
    const rolloutPath = join(inputs, 'rollout.jsonl');
    writeFileSync(rolloutPath, lines([tokenCountEntry(100, 25, 60, 200)]));

    const result = await analyzeCodexContextPressure({
      rolloutPath,
      outDir: join(root, 'output'),
    });
    const summary = JSON.parse(
      readFileSync(result.summaryPath, 'utf8'),
    ) as CodexContextAnalysisSummary;

    expect(summary.coverage.rolloutTokenCountEvents).toBe(true);
    expect(summary.coverage.itemSizeObservations).toBe(false);
    expect(summary.limitations).toContain('item-size-observations-unavailable');
    expect(readFileSync(result.reportPath, 'utf8')).toContain('| Item-size observations | no |');
  });

  it('measures real tool-result fields and correlates bounded generic tool classes', async () => {
    const root = temporaryDirectory();
    const inputs = join(root, 'inputs');
    mkdirSync(inputs);
    const rolloutPath = join(inputs, 'rollout.jsonl');
    const outDir = join(root, 'output');
    const privateFragments = [
      'COMMAND_BODY_MUST_NOT_COUNT', '/private/cwd/must-not-count',
      'call-command-private', 'call-mcp-private', 'call-collab-private',
      'mcp__private_server__private_tool', 'spawn_agent',
    ];
    writeFileSync(rolloutPath, lines([
      {
        timestamp: 1, type: 'event_msg', payload: {
          type: 'exec_command_end', command: privateFragments[0], cwd: privateFragments[1],
          aggregated_output: 'abc', stdout: 'duplicate-stdout', stderr: 'duplicate-stderr',
        },
      },
      {
        timestamp: 2, type: 'event_msg', payload: {
          type: 'exec_command_end', command: privateFragments[0], cwd: privateFragments[1],
          stdout: 'ab', stderr: 'cde',
        },
      },
      {
        timestamp: 3, type: 'event_msg', payload: {
          type: 'exec_command_end', command: privateFragments[0], cwd: privateFragments[1],
          formatted_output: 'wxyz', stdout: 'duplicate-stdout',
        },
      },
      { timestamp: 4, type: 'response_item', payload: {
        type: 'function_call', name: 'functions.exec_command', call_id: privateFragments[2],
        arguments: privateFragments[0],
      } },
      { timestamp: 5, type: 'response_item', payload: {
        type: 'function_call_output', call_id: privateFragments[2], output: 'command-result',
      } },
      { timestamp: 6, type: 'response_item', payload: {
        type: 'function_call', name: privateFragments[5], call_id: privateFragments[3],
        arguments: privateFragments[0],
      } },
      { timestamp: 7, type: 'response_item', payload: {
        type: 'function_call_output', call_id: privateFragments[3], output: 'mcp-result',
      } },
      { timestamp: 8, type: 'response_item', payload: {
        type: 'custom_tool_call', name: privateFragments[6], call_id: privateFragments[4],
        arguments: privateFragments[0],
      } },
      { timestamp: 9, type: 'response_item', payload: {
        type: 'custom_tool_call_output', call_id: privateFragments[4], output: 'collab-result',
      } },
      { timestamp: 10, type: 'response_item', payload: {
        type: 'custom_tool_call_output', call_id: privateFragments[4], output: 'uncorrelated-result',
      } },
    ]));

    const result = await analyzeCodexContextPressure({ rolloutPath, outDir });
    const timelineText = readFileSync(result.timelinePath, 'utf8');
    const artifactText = [
      readFileSync(result.summaryPath, 'utf8'),
      timelineText,
      readFileSync(result.reportPath, 'utf8'),
    ].join('\n');
    const timeline = readJsonLines<Record<string, unknown>>(timelineText);

    expect(timeline[0]).toMatchObject({ subtype: 'tool-result', itemClass: 'command', contentBytes: 3 });
    expect(timeline[1]).toMatchObject({ subtype: 'tool-result', itemClass: 'command', contentBytes: 5 });
    expect(timeline[2]).toMatchObject({ subtype: 'tool-result', itemClass: 'command', contentBytes: 4 });
    expect(timeline.slice(3).map((event) => event['itemClass'])).toEqual([
      'command', 'command', 'mcp', 'mcp', 'collaboration', 'collaboration', 'dynamic',
    ]);
    for (const fragment of privateFragments) expect(artifactText).not.toContain(fragment);
  });

  it('bounds generic call correlations and evicts the oldest unresolved call', async () => {
    const root = temporaryDirectory();
    const inputs = join(root, 'inputs');
    mkdirSync(inputs);
    const rolloutPath = join(inputs, 'rollout.jsonl');
    const calls = Array.from({ length: 1_001 }, (_, index) => ({
      timestamp: index,
      type: 'response_item',
      payload: {
        type: 'function_call', name: 'exec_command', call_id: `private-call-${index}`,
        arguments: 'PRIVATE_ARGUMENT_BODY',
      },
    }));
    writeFileSync(rolloutPath, lines([
      ...calls,
      { timestamp: 2_000, type: 'response_item', payload: {
        type: 'function_call_output', call_id: 'private-call-0', output: 'oldest-result',
      } },
      { timestamp: 2_001, type: 'response_item', payload: {
        type: 'function_call_output', call_id: 'private-call-1000', output: 'newest-result',
      } },
    ]));

    const result = await analyzeCodexContextPressure({ rolloutPath, outDir: join(root, 'output') });
    const timelineText = readFileSync(result.timelinePath, 'utf8');
    const timeline = readJsonLines<Record<string, unknown>>(timelineText);

    expect(timeline.at(-2)).toMatchObject({ itemClass: 'dynamic' });
    expect(timeline.at(-1)).toMatchObject({ itemClass: 'command' });
    expect(timelineText).not.toContain('private-call-');
    expect(timelineText).not.toContain('PRIVATE_ARGUMENT_BODY');
  });

  it('keeps first and final usage observations with an explicit bounded omission row', async () => {
    const root = temporaryDirectory();
    const inputs = join(root, 'inputs');
    mkdirSync(inputs);
    const rolloutPath = join(inputs, 'rollout.jsonl');
    const observations = Array.from({ length: 103 }, (_, index) => {
      const current = index === 0 ? 22_380 : index === 102 ? 242_865 : 22_380 + index * 2_000;
      return {
        timestamp: index + 1,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 258_400,
            last_token_usage: { total_tokens: current },
            total_token_usage: { total_tokens: 50_000 + index * 2_500 },
          },
        },
      };
    });
    writeFileSync(rolloutPath, lines(observations));

    const result = await analyzeCodexContextPressure({ rolloutPath, outDir: join(root, 'output') });
    const report = readFileSync(result.reportPath, 'utf8');

    expect(report).toContain('| rollout token count | 1 | 22380 | — | 50000 | — | 258400 | 8.66 |');
    expect(report).toContain('| omitted observations | 3 | — | — | — | — | — | — |');
    expect(report).toContain('| rollout token count | 103 | 242865 | 18485 | 305000 | 2500 | 258400 | 93.99 |');
  });

  it('derives current and cumulative deltas independently per evidence stream', async () => {
    const root = temporaryDirectory();
    const inputs = join(root, 'inputs');
    mkdirSync(inputs);
    const dbPath = join(inputs, 'ledger.db');
    const rolloutPath = join(inputs, 'rollout.jsonl');
    writeFileSync(dbPath, 'READ_ONLY_SENTINEL');
    writeFileSync(rolloutPath, lines([
      tokenCountEntry(3, 10, 100, 50),
      tokenCountEntry(4, 15, 130, 50),
      tokenCountEntry(5, 13, 150, 50),
    ]));
    const database = captureDatabase([
      captureRow(1, 1, { kind: 'context', used: 20, total: 100, percentage: 20 }),
      captureRow(2, 2, { kind: 'context', used: 28, total: 100, percentage: 28 }),
    ]);

    const result = await analyzeCodexContextPressure({
      dbPath, instanceId: 'private-instance', rolloutPath, outDir: join(root, 'output'),
    }, database.dependencies);
    const report = readFileSync(result.reportPath, 'utf8');

    expect(report).toContain('| normalized context | 1 | 20 | — | — | — | 100 | 20 |');
    expect(report).toContain('| normalized context | 2 | 28 | 8 | — | — | 100 | 28 |');
    expect(report).toContain('| rollout token count | 3 | 10 | — | 100 | — | 50 | 20 |');
    expect(report).toContain('| rollout token count | 4 | 15 | 5 | 130 | 30 | 50 | 30 |');
    expect(report).toContain('| rollout token count | 5 | 13 | -2 | 150 | 20 | 50 | 26 |');
  });

  it('excludes structural rollout rows from item counts while retaining item-bearing other', async () => {
    const root = temporaryDirectory();
    const inputs = join(root, 'inputs');
    mkdirSync(inputs);
    const rolloutPath = join(inputs, 'rollout.jsonl');
    writeFileSync(rolloutPath, lines([
      { timestamp: 1, type: 'session_meta', payload: { cwd: '/private/structural/path' } },
      {
        timestamp: 2, type: 'event_msg', payload: {
          type: 'token_count', message: 'STRUCTURAL_BODY_MUST_NOT_COUNT',
          info: { last_token_usage: { total_tokens: 10 }, total_token_usage: { total_tokens: 20 } },
        },
      },
      { timestamp: 3, type: 'event_msg', payload: { type: 'task_started', message: 'STRUCTURAL_START' } },
      { timestamp: 4, type: 'event_msg', payload: { type: 'context_compacted', text: 'STRUCTURAL_COMPACTION' } },
      { timestamp: 5, type: 'response_item', payload: { type: 'unknown_future_item', content: 'abc' } },
      { timestamp: 6, type: 'event_msg', payload: { type: 'agent_message', message: 'wxyz' } },
    ]));

    const result = await analyzeCodexContextPressure({ rolloutPath, outDir: join(root, 'output') });
    const report = readFileSync(result.reportPath, 'utf8');

    expect(report).toMatch(/\| other \| 1 \| 3 \| [1-9][0-9]* \|/);
    expect(report).toMatch(/\| agent-message \| 1 \| 4 \| [1-9][0-9]* \|/);
    expect(report).not.toMatch(/\| other \| [2-9][0-9]* \|/);
  });

  it('counts malformed diagnostic and rollout records while ignoring unrelated logs', async () => {
    const root = temporaryDirectory();
    const inputs = join(root, 'inputs');
    mkdirSync(inputs);
    const logPath = join(inputs, 'app.log');
    const rolloutPath = join(inputs, 'rollout.jsonl');
    const outDir = join(root, 'output');
    writeFileSync(logPath, [
      '{bad-json',
      JSON.stringify({ subsystem: 'Other', message: 'context-pressure-observation', data: { schemaVersion: 1 } }),
      JSON.stringify({ subsystem: 'CodexContextDiagnostics', message: 'context-pressure-observation', data: { schemaVersion: 2, kind: 'turn-start' } }),
      JSON.stringify({ subsystem: 'CodexContextDiagnostics', message: 'context-pressure-observation', data: { schemaVersion: 1, kind: 'made-up-private-kind' } }),
      JSON.stringify({ subsystem: 'CodexContextDiagnostics', message: 'context-pressure-observation', data: { schemaVersion: 1, kind: 'turn-start', at: 1 } }),
    ].join('\n') + '\n');
    writeFileSync(rolloutPath, '{bad-rollout\n\n');

    const result = await analyzeCodexContextPressure({ logPath, rolloutPath, outDir });
    const summary = JSON.parse(readFileSync(result.summaryPath, 'utf8')) as CodexContextAnalysisSummary;

    expect(summary.sources.diagnosticLog).toEqual({
      provided: true, available: true, acceptedRecords: 0, malformedRecords: 4,
    });
    expect(summary.sources.rollout).toEqual({
      provided: true, available: true, acceptedRecords: 0, malformedRecords: 1,
    });
    expect(readFileSync(result.reportPath, 'utf8')).toContain('Malformed diagnostic records: 4');
  });

  it('marks a pre-capture ledger unavailable without mutating or crashing', async () => {
    const root = temporaryDirectory();
    const inputs = join(root, 'inputs');
    mkdirSync(inputs);
    const dbPath = join(inputs, 'legacy.db');
    const outDir = join(root, 'output');
    writeFileSync(dbPath, 'LEGACY_DATABASE_SENTINEL');
    const entriesBefore = readdirSync(inputs).sort();
    const database = captureDatabase([], false);

    const result = await analyzeCodexContextPressure({
      dbPath,
      instanceId: 'instance-must-not-appear',
      outDir,
    }, database.dependencies);
    const summary = JSON.parse(readFileSync(result.summaryPath, 'utf8')) as CodexContextAnalysisSummary;

    expect(summary.sources.providerCaptures).toEqual({
      provided: true, available: false, acceptedRecords: 0, malformedRecords: 0,
    });
    expect(summary.limitations).toContain('provider-capture-table-unavailable');
    expect(readFileSync(dbPath, 'utf8')).toBe('LEGACY_DATABASE_SENTINEL');
    expect(database.openDatabase).toHaveBeenCalledWith(dbPath, {
      readonly: true,
      fileMustExist: true,
    });
    expect(readdirSync(inputs).sort()).toEqual(entriesBefore);
    expect(readFileSync(result.reportPath, 'utf8')).toContain('capture table was unavailable');
    expect(readFileSync(result.summaryPath, 'utf8')).not.toContain('instance-must-not-appear');
  });

  it('requires an evidence source and keeps outputs away from input directories', async () => {
    const root = temporaryDirectory();
    const inputs = join(root, 'inputs');
    mkdirSync(inputs);
    const logPath = join(inputs, 'app.log');
    writeFileSync(logPath, '');

    await expect(analyzeCodexContextPressure({ outDir: join(root, 'out') })).rejects.toThrow(
      'At least one evidence source is required',
    );
    await expect(analyzeCodexContextPressure({ logPath, outDir: inputs })).rejects.toThrow(
      'Output directory must not be equal to or nested within an input directory',
    );
    await expect(analyzeCodexContextPressure({ logPath, outDir: join(inputs, 'nested') })).rejects.toThrow(
      'Output directory must not be equal to or nested within an input directory',
    );
    const inputAlias = join(root, 'input-alias');
    symlinkSync(inputs, inputAlias);
    await expect(analyzeCodexContextPressure({
      logPath,
      outDir: join(inputAlias, 'nested-through-symlink'),
    })).rejects.toThrow('Output directory must not be equal to or nested within an input directory');
    const aliases = join(root, 'aliases');
    mkdirSync(aliases);
    const fileAlias = join(aliases, 'app-alias.log');
    symlinkSync(logPath, fileAlias);
    await expect(analyzeCodexContextPressure({
      logPath: fileAlias,
      outDir: join(inputs, 'nested-through-file-symlink'),
    })).rejects.toThrow('Output directory must not be equal to or nested within an input directory');
    await expect(analyzeCodexContextPressure({
      dbPath: join(inputs, 'missing.db'),
      outDir: join(root, 'output'),
    })).rejects.toThrow('--instance is required with --db');
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'codex-context-analyzer-'));
  cleanupDirectories.push(directory);
  return directory;
}

function makeCaptureRows(privateFragments: string[]): Array<Record<string, unknown>> {
  return [
    captureRow(1, 105, {
      kind: 'context', used: 30, total: 200, percentage: 15, inputTokens: 27,
      outputTokens: 3, source: 'private-source', promptWeight: 0.68,
    }),
    captureRow(2, 106, {
      kind: 'output', content: 'OUTPUT_PRIVATE_VALUE', messageId: 'message-private',
    }),
    captureRow(3, 107, {
      kind: 'tool_result', toolName: privateFragments[6], success: true,
      output: 'TOOL_RESULT_PRIVATE',
    }),
    captureRow(4, 108, { kind: 'status', status: 'busy', details: privateFragments[3] }),
  ];
}

function captureRow(sequence: number, createdAt: number, event: unknown): Record<string, unknown> {
  return {
    sequence,
    created_at: createdAt,
    event_json: JSON.stringify(event),
    raw_provenance_present: 1,
  };
}

function tokenCountEntry(
  timestamp: number,
  current: number,
  cumulative: number,
  contextWindow: number,
): Record<string, unknown> {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        model_context_window: contextWindow,
        last_token_usage: { total_tokens: current },
        total_token_usage: { total_tokens: cumulative },
      },
    },
  };
}

function captureDatabase(rows: unknown[], tableExists = true): {
  dependencies: CodexContextAnalysisDependencies;
  openDatabase: ReturnType<typeof vi.fn>;
  iterateRows: ReturnType<typeof vi.fn>;
  sql: string[];
} {
  const close = vi.fn();
  const sql: string[] = [];
  const iterateRows = vi.fn(function* () {
    yield* rows;
  });
  const openDatabase = vi.fn(() => ({
    prepare: (statement: string) => ({
      get: () => {
        sql.push(statement);
        return statement.includes('sqlite_master') && tableExists ? { present: 1 } : undefined;
      },
      iterate: () => {
        sql.push(statement);
        return statement.includes('provider_event_captures')
          ? iterateRows()
          : [][Symbol.iterator]();
      },
      all: () => { throw new Error('provider capture rows must be streamed'); },
    }),
    close,
  }));
  return {
    dependencies: { openDatabase },
    openDatabase,
    iterateRows,
    sql,
  };
}

function lines(values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join('\n') + '\n';
}

function readJsonLines<T>(text: string): T[] {
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as T);
}
