import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const OUTPUT_PATH = join(
  ROOT,
  'src/main/cli/adapters/codex/generated/app-server-protocol.gen.ts',
);

const SOURCE_FILES = [
  'ClientRequest.ts',
  'ServerNotification.ts',
  'v2/ThreadStartParams.ts',
  'v2/ThreadStartResponse.ts',
  'v2/ThreadResumeParams.ts',
  'v2/ThreadResumeResponse.ts',
  'v2/ThreadCompactStartResponse.ts',
  'v2/TurnStartParams.ts',
  'v2/TurnStartResponse.ts',
  'v2/TurnInterruptResponse.ts',
] as const;

type ResponseContractKind = 'object' | 'empty-object';

interface ResponseContract {
  kind: ResponseContractKind;
  requiredKeys: string[];
}

interface RequestContract {
  requiredKeys: string[];
  supportedKeys: string[];
}

function readGenerated(outputDir: string, path: string): string {
  return readFileSync(join(outputDir, path), 'utf8');
}

function extractMethods(source: string): string[] {
  const methods: string[] = [];
  const seen = new Set<string>();
  for (const match of source.matchAll(/"method":\s*"([^"]+)"/g)) {
    const method = match[1];
    if (!method || seen.has(method)) continue;
    seen.add(method);
    methods.push(method);
  }
  return methods;
}

function extractRequestContract(source: string, typeName: string): RequestContract {
  const marker = `export type ${typeName} = {`;
  const start = source.indexOf(marker);
  const end = source.lastIndexOf('};');
  if (start < 0 || end <= start) throw new Error(`Unable to extract generated ${typeName}`);
  const body = source.slice(start + marker.length, end);
  const supportedKeys: string[] = [];
  const requiredKeys: string[] = [];
  for (const match of body.matchAll(/(?:^|,|\n)\s*([A-Za-z_][A-Za-z0-9_]*)(\?)?:/g)) {
    const key = match[1];
    if (!key || supportedKeys.includes(key)) continue;
    supportedKeys.push(key);
    if (!match[2]) requiredKeys.push(key);
  }
  return { requiredKeys, supportedKeys };
}

function assertContains(source: string, pattern: RegExp, description: string): void {
  if (!pattern.test(source)) {
    throw new Error(`Generated Codex protocol no longer contains ${description}`);
  }
}

function assertExcludes(source: string, pattern: RegExp, description: string): void {
  if (pattern.test(source)) {
    throw new Error(`Generated Codex protocol unexpectedly contains ${description}`);
  }
}

function sha256(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function buildManifest(outputDir: string, version: string): string {
  const clientRequests = readGenerated(outputDir, 'ClientRequest.ts');
  const serverNotifications = readGenerated(outputDir, 'ServerNotification.ts');
  const turnStartParams = readGenerated(outputDir, 'v2/TurnStartParams.ts');
  const turnStartResponse = readGenerated(outputDir, 'v2/TurnStartResponse.ts');
  const turnInterruptResponse = readGenerated(outputDir, 'v2/TurnInterruptResponse.ts');
  const threadCompactResponse = readGenerated(outputDir, 'v2/ThreadCompactStartResponse.ts');
  const threadStartParams = readGenerated(outputDir, 'v2/ThreadStartParams.ts');
  const threadResumeParams = readGenerated(outputDir, 'v2/ThreadResumeParams.ts');
  const threadStartResponse = readGenerated(outputDir, 'v2/ThreadStartResponse.ts');
  const threadResumeResponse = readGenerated(outputDir, 'v2/ThreadResumeResponse.ts');

  assertContains(turnStartParams, /threadId:\s*string/, 'turn/start.threadId');
  assertContains(turnStartParams, /input:\s*Array<UserInput>/, 'turn/start.input');
  assertContains(turnStartParams, /effort\?:\s*ReasoningEffort/, 'turn/start.effort');
  assertContains(turnStartParams, /serviceTier\?:/, 'turn/start.serviceTier');
  assertContains(turnStartParams, /outputSchema\?:/, 'turn/start.outputSchema');
  assertExcludes(turnStartParams, /reasoningEffort\?:/, 'turn/start.reasoningEffort');
  assertExcludes(threadStartParams, /reasoningEffort\?:|effort\?:/, 'thread/start reasoning effort');
  assertContains(turnStartResponse, /\{\s*turn:\s*Turn/, 'turn/start response turn');
  assertContains(threadStartResponse, /\{\s*thread:\s*Thread/, 'thread/start response thread');
  assertContains(threadResumeResponse, /\{\s*thread:\s*Thread/, 'thread/resume response thread');
  assertContains(turnInterruptResponse, /Record<string, never>/, 'empty turn/interrupt response');
  assertContains(threadCompactResponse, /Record<string, never>/, 'empty thread/compact response');

  const responseContracts: Record<string, ResponseContract> = {
    initialize: { kind: 'object', requiredKeys: [] },
    'thread/start': { kind: 'object', requiredKeys: ['thread'] },
    'thread/resume': { kind: 'object', requiredKeys: ['thread'] },
    'thread/name/set': { kind: 'empty-object', requiredKeys: [] },
    'thread/list': { kind: 'object', requiredKeys: ['data'] },
    'thread/read': { kind: 'object', requiredKeys: ['thread'] },
    'thread/turns/list': { kind: 'object', requiredKeys: ['data'] },
    'thread/compact/start': { kind: 'empty-object', requiredKeys: [] },
    'review/start': { kind: 'object', requiredKeys: ['turn'] },
    'model/list': { kind: 'object', requiredKeys: ['data'] },
    'turn/start': { kind: 'object', requiredKeys: ['turn'] },
    'turn/interrupt': { kind: 'empty-object', requiredKeys: [] },
  };

  const sourceHashes = Object.fromEntries(
    SOURCE_FILES.map((path) => [path, sha256(readGenerated(outputDir, path))]),
  );
  const protocol = {
    clientRequestMethods: extractMethods(clientRequests),
    serverNotificationMethods: extractMethods(serverNotifications),
    requestContracts: {
      'thread/start': extractRequestContract(threadStartParams, 'ThreadStartParams'),
      'thread/resume': extractRequestContract(threadResumeParams, 'ThreadResumeParams'),
      'turn/start': extractRequestContract(turnStartParams, 'TurnStartParams'),
    },
    responseContracts,
    sourceHashes,
  };

  return [
    '// GENERATED CODE! DO NOT MODIFY BY HAND.',
    '// Generated by scripts/generate-codex-app-server-protocol.ts from the installed Codex CLI.',
    '',
    `export const CODEX_APP_SERVER_PROTOCOL_VERSION = ${JSON.stringify(version)} as const;`,
    '',
    `export const CODEX_APP_SERVER_PROTOCOL = ${JSON.stringify(protocol, null, 2)} as const;`,
    '',
  ].join('\n');
}

function generate(): string {
  const version = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim();
  if (!/^codex-cli \d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Unexpected Codex version output: ${version}`);
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'aio-codex-protocol-'));
  try {
    execFileSync('codex', [
      'app-server',
      'generate-ts',
      '--out',
      tempDir,
      '--experimental',
    ], { stdio: 'pipe' });
    return buildManifest(tempDir, version);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const generated = generate();
if (process.argv.includes('--check')) {
  const current = readFileSync(OUTPUT_PATH, 'utf8');
  if (current !== generated) {
    throw new Error(
      `Codex protocol manifest is stale. Run: npm run generate:codex-protocol (${relative(ROOT, OUTPUT_PATH)})`,
    );
  }
} else {
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  const tempPath = `${OUTPUT_PATH}.tmp`;
  writeFileSync(tempPath, generated, 'utf8');
  renameSync(tempPath, OUTPUT_PATH);
}
