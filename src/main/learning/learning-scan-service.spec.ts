import { describe, expect, it, vi } from 'vitest';
import type { ConversationHistoryEntry, ConversationData } from '../../shared/types/history.types';
import type { OutputMessage } from '../../shared/types/instance.types';
import type { GovernedProposal } from '../memory/governed-proposal-store';
import type {
  LearningScanCheckpoint,
  UpsertLearningScanCheckpointParams,
} from '../persistence/rlm/rlm-learning-scan-checkpoints';
import { LearningScanService, aggregateCandidates } from './learning-scan-service';
import type { CorrectionCandidate } from './correction-miner';

function makeEntry(id: string, endedAt: number, overrides: Partial<ConversationHistoryEntry> = {}): ConversationHistoryEntry {
  return {
    id,
    displayName: id,
    createdAt: endedAt - 1000,
    endedAt,
    workingDirectory: '/repo',
    messageCount: 4,
    firstUserMessage: 'do the thing',
    lastUserMessage: 'do the thing',
    status: 'completed',
    originalInstanceId: id,
    parentId: null,
    sessionId: id,
    ...overrides,
  };
}

let seq = 0;
function toolUse(command: string, id = `t${seq++}`): OutputMessage {
  return {
    id: `m${seq}`,
    timestamp: Date.now(),
    type: 'tool_use',
    content: 'Using tool: Bash',
    metadata: { id, name: 'Bash', input: { command } },
  };
}
function toolResult(id: string, content: string, isError: boolean): OutputMessage {
  return {
    id: `m${seq++}`,
    timestamp: Date.now(),
    type: 'tool_result',
    content,
    metadata: { tool_use_id: id, is_error: isError },
  };
}
function correctionMessages(fail: string, failResult: string, fix: string): OutputMessage[] {
  const id = `t${seq++}`;
  return [toolUse(fail, id), toolResult(id, failResult, true), ...(() => {
    const fixId = `t${seq++}`;
    return [toolUse(fix, fixId), toolResult(fixId, 'ok', false)];
  })()];
}

function makeHistoryFake(entries: ConversationHistoryEntry[], conversations: Map<string, ConversationData>) {
  return {
    getEntries: vi.fn((opts?: { workingDirectory?: string }) =>
      opts?.workingDirectory
        ? entries.filter((e) => e.workingDirectory === opts.workingDirectory)
        : entries,
    ),
    loadConversation: vi.fn(async (id: string) => conversations.get(id) ?? null),
  };
}

function makeProposalsFake() {
  const calls: unknown[] = [];
  const seen = new Set<string>();
  return {
    calls,
    captureRuleProposal: vi.fn((params: { baseCommand: string; errorClass: string; pattern: string; correction: string; sourceSessionId?: string | null }) => {
      calls.push(params);
      const key = `${params.baseCommand}::${params.errorClass}`;
      const reinforced = seen.has(key);
      seen.add(key);
      const proposal: GovernedProposal = {
        id: key,
        kind: 'rule',
        status: 'pending',
        provenance: 'agent-derived',
        title: `${params.pattern} → ${params.correction}`,
        description: '',
        payloadJson: '{}',
        sourceSessionId: params.sourceSessionId ?? null,
        sourceMessageId: null,
        createdAt: 0,
        decidedAt: null,
        decidedBy: null,
        decisionRationale: null,
        reinforcements: reinforced ? 2 : 1,
        relatedIdsJson: '[]',
        tagsJson: '[]',
      };
      return { reinforced, proposal };
    }),
  };
}

function makeCheckpointsFake() {
  const store = new Map<string, LearningScanCheckpoint>();
  return {
    get: vi.fn((scopeKey: string) => store.get(scopeKey) ?? null),
    recordRun: vi.fn((params: UpsertLearningScanCheckpointParams) => {
      const previousTotal = store.get(params.scopeKey)?.sessionsScannedTotal ?? 0;
      store.set(params.scopeKey, {
        scopeKey: params.scopeKey,
        lastScannedEndedAt: params.lastScannedEndedAt,
        lastScannedEntryId: params.lastScannedEntryId,
        lastScanStartedAt: params.lastScanStartedAt,
        lastScanCompletedAt: params.lastScanCompletedAt,
        sessionsScannedLastRun: params.sessionsScannedLastRun,
        sessionsScannedTotal: previousTotal + params.sessionsScannedLastRun,
        proposalsCreatedLastRun: params.proposalsCreatedLastRun,
        proposalsReinforcedLastRun: params.proposalsReinforcedLastRun,
        lastError: params.lastError,
        updatedAt: Date.now(),
      });
    }),
    _store: store,
  };
}

describe('aggregateCandidates', () => {
  it('groups by baseCommand::errorClass, keeps the highest-confidence candidate, caps evidence at 3', () => {
    const low: CorrectionCandidate = { baseCommand: 'npm', errorClass: 'UnknownFlag', failCommand: 'npm test --x', fixCommand: 'npm test --y', fixIsError: null, confidence: 0.4 };
    const high: CorrectionCandidate = { baseCommand: 'npm', errorClass: 'UnknownFlag', failCommand: 'npm test --a', fixCommand: 'npm test --b', fixIsError: false, confidence: 0.9 };
    const perSession = [
      { sessionId: 's1', candidates: [low] },
      { sessionId: 's2', candidates: [high] },
      { sessionId: 's3', candidates: [low] },
      { sessionId: 's4', candidates: [low] },
    ];
    const aggregated = aggregateCandidates(perSession);
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0].occurrences).toBe(4);
    expect(aggregated[0].confidence).toBe(0.9);
    expect(aggregated[0].bestCandidate).toBe(high);
    expect(aggregated[0].evidence).toHaveLength(3);
  });

  it('keeps distinct patterns separate', () => {
    const a: CorrectionCandidate = { baseCommand: 'npm', errorClass: 'UnknownFlag', failCommand: 'x', fixCommand: 'y', fixIsError: false, confidence: 0.5 };
    const b: CorrectionCandidate = { baseCommand: 'git', errorClass: 'PermissionDenied', failCommand: 'x', fixCommand: 'y', fixIsError: false, confidence: 0.5 };
    expect(aggregateCandidates([{ sessionId: 's1', candidates: [a, b] }])).toHaveLength(2);
  });
});

describe('LearningScanService.runScan', () => {
  it('is bounded: scans at most sessionLimit sessions, oldest-first', async () => {
    const entries = [makeEntry('e3', 3000), makeEntry('e1', 1000), makeEntry('e2', 2000)];
    const history = makeHistoryFake(entries, new Map());
    const proposals = makeProposalsFake();
    const checkpoints = makeCheckpointsFake();
    const service = new LearningScanService(history, proposals, checkpoints);

    const result = await service.runScan({ sessionLimit: 2 });

    expect(result.sessionsScanned).toBe(2);
    expect(history.loadConversation).toHaveBeenCalledWith('e1');
    expect(history.loadConversation).toHaveBeenCalledWith('e2');
    expect(history.loadConversation).not.toHaveBeenCalledWith('e3');
  });

  it('mines a real correction and creates exactly one governed rule proposal', async () => {
    const entry = makeEntry('e1', 1000);
    const messages = correctionMessages('npm test --flag-x', "unrecognized option '--flag-x'", 'npm test --flag-y');
    const conversations = new Map<string, ConversationData>([[entry.id, { entry, messages }]]);
    const history = makeHistoryFake([entry], conversations);
    const proposals = makeProposalsFake();
    const checkpoints = makeCheckpointsFake();
    const service = new LearningScanService(history, proposals, checkpoints);

    const result = await service.runScan();

    expect(result.proposalsCreated).toBe(1);
    expect(result.proposalsReinforced).toBe(0);
    expect(result.patternsFound).toBe(1);
    expect(proposals.captureRuleProposal).toHaveBeenCalledWith(
      expect.objectContaining({ baseCommand: 'npm', errorClass: 'UnknownFlag', occurrences: 1 }),
    );
  });

  it('is checkpointed: a second run only scans sessions ended after the persisted checkpoint', async () => {
    const e1 = makeEntry('e1', 1000);
    const e2 = makeEntry('e2', 2000);
    const history = makeHistoryFake([e1, e2], new Map());
    const proposals = makeProposalsFake();
    const checkpoints = makeCheckpointsFake();
    const service = new LearningScanService(history, proposals, checkpoints);

    const first = await service.runScan();
    expect(first.sessionsScanned).toBe(2);
    history.loadConversation.mockClear();

    const second = await service.runScan();
    expect(second.sessionsScanned).toBe(0);
    expect(history.loadConversation).not.toHaveBeenCalled();
  });

  it('dedupe-reinforces on rescan: the same recurring pattern found in a later scan reinforces, not duplicates', async () => {
    const e1 = makeEntry('e1', 1000);
    const e2 = makeEntry('e2', 2000);
    const messages1 = correctionMessages('npm test --flag-x', "unrecognized option '--flag-x'", 'npm test --flag-y');
    const messages2 = correctionMessages('npm test --flag-x', "unrecognized option '--flag-x'", 'npm test --flag-z');
    const conversations = new Map<string, ConversationData>([
      [e1.id, { entry: e1, messages: messages1 }],
      [e2.id, { entry: e2, messages: messages2 }],
    ]);
    const history = makeHistoryFake([e1, e2], conversations);
    const proposals = makeProposalsFake();
    const checkpoints = makeCheckpointsFake();
    const service = new LearningScanService(history, proposals, checkpoints);

    const first = await service.runScan({ sessionLimit: 1 });
    expect(first.proposalsCreated).toBe(1);

    const second = await service.runScan({ sessionLimit: 1 });
    expect(second.proposalsCreated).toBe(0);
    expect(second.proposalsReinforced).toBe(1);
  });

  it('counts a session that fails to load as skipped, without throwing', async () => {
    const entry = makeEntry('e1', 1000);
    const history = makeHistoryFake([entry], new Map()); // loadConversation resolves null for unknown ids
    const proposals = makeProposalsFake();
    const checkpoints = makeCheckpointsFake();
    const service = new LearningScanService(history, proposals, checkpoints);

    const result = await service.runScan();
    expect(result.sessionsScanned).toBe(1);
    expect(result.sessionsSkipped).toBe(1);
    expect(result.error).toBeNull();
  });

  it('scopes to a single workspace when workspaceId is provided', async () => {
    const inScope = makeEntry('e1', 1000, { workingDirectory: '/repo-a' });
    const outOfScope = makeEntry('e2', 1000, { workingDirectory: '/repo-b' });
    const history = makeHistoryFake([inScope, outOfScope], new Map());
    const proposals = makeProposalsFake();
    const checkpoints = makeCheckpointsFake();
    const service = new LearningScanService(history, proposals, checkpoints);

    const result = await service.runScan({ workspaceId: '/repo-a' });
    expect(result.scopeKey).toBe('/repo-a');
    expect(result.sessionsScanned).toBe(1);
    expect(history.loadConversation).toHaveBeenCalledWith('e1');
  });

  it('records a run error via the checkpoint store and returns it, without throwing', async () => {
    const history = {
      getEntries: vi.fn(() => { throw new Error('index corrupt'); }),
      loadConversation: vi.fn(),
    };
    const proposals = makeProposalsFake();
    const checkpoints = makeCheckpointsFake();
    const service = new LearningScanService(history, proposals, checkpoints);

    const result = await service.runScan();
    expect(result.error).toBe('index corrupt');
    expect(checkpoints.recordRun).toHaveBeenCalledWith(expect.objectContaining({ lastError: 'index corrupt' }));
  });

  it('getStatus reads the checkpoint store for the resolved scope', async () => {
    const history = makeHistoryFake([], new Map());
    const proposals = makeProposalsFake();
    const checkpoints = makeCheckpointsFake();
    const service = new LearningScanService(history, proposals, checkpoints);

    service.getStatus('/repo-a');
    expect(checkpoints.get).toHaveBeenCalledWith('/repo-a');
    service.getStatus();
    expect(checkpoints.get).toHaveBeenCalledWith('__global__');
  });
});
