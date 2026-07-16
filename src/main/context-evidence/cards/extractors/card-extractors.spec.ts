import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EvidenceLedgerRecord } from '../../../conversation-ledger/context-evidence-ledger.types';
import { BrowserCardExtractor } from './browser-card-extractor';
import { CommandCardExtractor } from './command-card-extractor';
import { DatabaseCardExtractor } from './database-card-extractor';
import { FileCardExtractor } from './file-card-extractor';
import {
  GenericCardExtractor,
  type CardExtractionContext,
  type EvidenceCardExtractor,
} from './generic-card-extractor';
import { McpCardExtractor } from './mcp-card-extractor';
import { WebCardExtractor } from './web-card-extractor';

const encoder = new TextEncoder();

function record(
  sourceKind: EvidenceLedgerRecord['sourceKind'],
  content: Uint8Array,
  overrides: Partial<EvidenceLedgerRecord> = {},
): EvidenceLedgerRecord {
  return {
    id: 'evidence-1',
    conversationId: 'conversation-1',
    provider: 'codex',
    providerThreadRef: null,
    providerSessionRef: null,
    turnRef: null,
    toolCallRef: null,
    toolName: 'tool',
    sourceKind,
    sourceLocatorRedacted: null,
    status: 'complete',
    blobRef: 'opaque/ref.aioev1',
    keyedContentId: 'a'.repeat(64),
    byteCount: content.byteLength,
    tokenEstimate: null,
    mimeType: 'application/json',
    sensitivity: 'normal',
    provenanceTrust: 'runtime-authenticated',
    captureMode: 'pre-retention',
    captureCompleteness: 'complete',
    truncationReason: null,
    keyVersion: 1,
    captureKey: 'capture-1',
    createdAt: 100,
    completedAt: 200,
    updatedAt: 200,
    ...overrides,
  };
}

function context(
  sourceKind: EvidenceLedgerRecord['sourceKind'],
  text: string,
  overrides: Partial<EvidenceLedgerRecord> = {},
): CardExtractionContext {
  const content = encoder.encode(text);
  return {
    record: record(sourceKind, content, overrides),
    content,
    createCitation: async (startByte, endByte) => ({
      evidenceId: 'evidence-1',
      startByte,
      endByte,
      contentDigest: createHash('sha256')
        .update(content.subarray(startByte, endByte))
        .digest('hex'),
    }),
  };
}

const FIXTURES: {
  name: string;
  extractor: EvidenceCardExtractor;
  sourceKind: EvidenceLedgerRecord['sourceKind'];
  body: string;
  expectedStatements: string[];
}[] = [
  {
    name: 'command',
    extractor: new CommandCardExtractor(),
    sourceKind: 'command',
    body: JSON.stringify({
      commandClass: 'test',
      exitStatus: 0,
      durationMs: 125,
      changedPaths: ['src/example.ts'],
      testCount: 12,
      warningCount: 1,
      error: 'obvious-placeholder-error',
    }),
    expectedStatements: [
      'Command class: test.',
      'Exit status: 0.',
      'Changed paths: 1.',
      'Tests reported: 12.',
      'Warnings reported: 1.',
      'Command error was reported.',
    ],
  },
  {
    name: 'file',
    extractor: new FileCardExtractor(),
    sourceKind: 'file',
    body: JSON.stringify({
      canonicalPath: '/workspace/example.ts',
      contentIdentity: 'revision-placeholder',
      lineCount: 42,
      lineRange: '10-20',
      parseStatus: 'valid',
    }),
    expectedStatements: [
      'File path: /workspace/example.ts.',
      'File line count: 42.',
      'File parse status: valid.',
    ],
  },
  {
    name: 'database',
    extractor: new DatabaseCardExtractor(),
    sourceKind: 'database',
    body: JSON.stringify({
      queryIdentity: 'query-placeholder',
      columns: ['id', 'status'],
      rowCount: 3,
      selectedRows: 2,
      truncated: true,
    }),
    expectedStatements: [
      'Database columns reported: 2.',
      'Database row count: 3.',
      'Selected rows included: 2.',
      'Database result was truncated.',
    ],
  },
  {
    name: 'web',
    extractor: new WebCardExtractor(),
    sourceKind: 'web',
    body: JSON.stringify({
      canonicalUrl: 'https://example.invalid/article',
      title: 'Example title',
      statusCode: 200,
      retrievedAt: 1_000,
      publishedAt: 500,
    }),
    expectedStatements: [
      'Web URL: https://example.invalid/article.',
      'Web title: Example title.',
      'HTTP status: 200.',
      'Web retrieval time: 1000.',
      'Web publication time: 500.',
    ],
  },
  {
    name: 'browser',
    extractor: new BrowserCardExtractor(),
    sourceKind: 'browser',
    body: JSON.stringify({
      url: 'https://example.invalid/page',
      pageIdentity: 'page-placeholder',
      visibleState: 'dialog-open',
      action: 'click',
      outcome: 'completed',
    }),
    expectedStatements: [
      'Browser URL: https://example.invalid/page.',
      'Browser action: click.',
      'Browser interaction outcome: completed.',
    ],
  },
  {
    name: 'MCP',
    extractor: new McpCardExtractor(),
    sourceKind: 'mcp',
    body: JSON.stringify({
      server: 'example-server',
      tool: 'example-tool',
      status: 'ok',
      resultCount: 4,
    }),
    expectedStatements: [
      'MCP server: example-server.',
      'MCP tool: example-tool.',
      'MCP status: ok.',
      'MCP results reported: 4.',
    ],
  },
];

describe('deterministic card extractors', () => {
  it.each(FIXTURES)('$name emits only exact-cited deterministic facts', async (fixture) => {
    const extractionContext = context(fixture.sourceKind, fixture.body);
    const first = await fixture.extractor.extract(extractionContext);
    const second = await fixture.extractor.extract(extractionContext);

    expect(first).toEqual(second);
    expect(first.findings.map((finding) => finding.statement)).toEqual(
      expect.arrayContaining(fixture.expectedStatements),
    );
    for (const finding of first.findings) {
      expect(finding.citations).toHaveLength(1);
      const cited = finding.citations[0];
      expect(cited).toBeDefined();
      const bytes = extractionContext.content.subarray(cited!.startByte, cited!.endByte);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(cited!.contentDigest);
      expect(bytes.byteLength).toBeGreaterThan(0);
    }
  });

  it('adds a non-completeness disclosure without implying full coverage', async () => {
    const extractionContext = context('command', JSON.stringify({ exitStatus: 0 }), {
      captureCompleteness: 'bounded',
      truncationReason: 'provider retained only a bounded result',
    });
    const draft = await new CommandCardExtractor().extract(extractionContext);
    expect(draft.summary).toContain('does not represent the complete source');
    expect(draft.summary).toContain('provider retained only a bounded result');
  });

  it('omits claims from ambiguous duplicate JSON properties', async () => {
    const extractionContext = context('command', '{"exitStatus":1,"exitStatus":0}');
    const draft = await new CommandCardExtractor().extract(extractionContext);
    expect(draft.findings).toEqual([]);
  });

  it.each([
    new FileCardExtractor(),
    new DatabaseCardExtractor(),
    new WebCardExtractor(),
    new BrowserCardExtractor(),
    new McpCardExtractor(),
  ])('marks empty $sourceKind structured input partial', async (extractor) => {
    const draft = await extractor.extract(context(extractor.sourceKind, '{}'));
    expect(draft.status).toBe('partial');
    expect(draft.findings).toEqual([]);
  });

  it('builds binary and unknown-MIME fallback cards from head/tail citations only', async () => {
    const bytes = Uint8Array.from({ length: 700 }, (_value, index) => index % 251);
    const extractionContext: CardExtractionContext = {
      record: record('other', bytes, { mimeType: 'application/octet-stream' }),
      content: bytes,
      createCitation: async (startByte, endByte) => ({
        evidenceId: 'evidence-1',
        startByte,
        endByte,
        contentDigest: createHash('sha256')
          .update(bytes.subarray(startByte, endByte))
          .digest('hex'),
      }),
    };
    const draft = await new GenericCardExtractor().extract(extractionContext);
    expect(draft.status).toBe('partial');
    expect(draft.findings.map((finding) => finding.statement)).toEqual([
      'Authenticated raw head range is available.',
      'Authenticated raw tail range is available.',
    ]);
    expect(draft.summary).toBe(
      'No deterministic summary was derived. Retrieve authenticated raw evidence by reference evidence-1.',
    );
  });
});
