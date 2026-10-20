// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// This is a consumer resource contract, not a parser microbenchmark. Keeping
// every unrelated path in the resolver must fail while a small control passes
// under the SAME heap ceiling. No Map replacement or private-state inspection.
const HEAP_MIB = 64;
const LARGE_STATUS_COUNT = 200_000;
const directories: string[] = [];
let harness: string;

const emitterSource = String.raw`
const { once } = require('node:events');
(async () => {
  const count = Number(process.argv[2]);
  const exitCode = Number(process.argv[3]);
  const write = async (bytes) => {
    if (!process.stdout.write(bytes)) await once(process.stdout, 'drain');
  };
  // A match arrives first: even then, the consumer must inspect the entire
  // stream and wait for its exit before resetting any operator document.
  await write(' M register.md\0');
  for (let start = 0; start < count; start += 128) {
    let block = '';
    for (let i = start; i < Math.min(start + 128, count); i++) {
      block += '?? unrelated/' + String(i).padStart(9, '0') + '/' + 'x'.repeat(240) + '\0';
    }
    await write(block);
  }
  process.exitCode = exitCode;
})().catch((error) => { console.error(error); process.exitCode = 1; });
`;

const workerSource = String.raw`
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const [directory, bundle, emitter, count, failThird] = process.argv.slice(2);
const repo = path.join(directory, 'repo');
fs.mkdirSync(repo);
const git = (args) => cp.execFileSync('git', args, {
  cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const base = 'first\n\nsecond\n\nthird\n';
const ours = 'ours\n\nsecond\n\nthird\n';
const candidate = 'first\n\nsecond\n\nitem\n';
git(['init', '-q', '-b', 'main']);
git(['config', 'user.name', 'Document streaming test']);
git(['config', 'user.email', 'test@example.invalid']);
git(['config', 'commit.gpgsign', 'false']);
git(['config', 'core.hooksPath', path.join(directory, 'no-hooks')]);
fs.writeFileSync(path.join(repo, 'register.md'), base);
git(['add', 'register.md']);
git(['commit', '-qm', 'base']);
const before = git(['rev-parse', 'HEAD']);
fs.writeFileSync(path.join(repo, 'register.md'), candidate);
git(['add', 'register.md']);
git(['commit', '-qm', 'candidate']);
const tip = git(['rev-parse', 'HEAD']);
git(['branch', 'integration/item', tip]);
git(['update-ref', 'refs/aio/managed-integrations/integration/item', tip]);
git(['reset', '--hard', before]);
fs.writeFileSync(path.join(repo, 'register.md'), ours);
const indexBefore = fs.readFileSync(path.join(repo, '.git', 'index')).toString('base64');
const trace = path.join(directory, 'promotion.trace');
process.env.GIT_TRACE = trace;
// Keep execFile (all ordinary Git work) native. Only status spawn is retargeted,
// before loading the actual bundled production parser/promoter/resolver.
const nativeSpawn = cp.spawn;
const closes = [];
const pending = [];
let inspections = 0;
cp.spawn = function (command, args, options) {
  if (command !== 'git' || args[0] !== 'status') return nativeSpawn(command, args, options);
  if (JSON.stringify(args) !== JSON.stringify(['status', '--porcelain=v1', '-z', '--untracked-files=all'])) {
    throw new Error('Unexpected status invocation');
  }
  const inspection = ++inspections;
  const code = failThird === 'true' && inspection === 3 ? 42 : 0;
  const child = nativeSpawn(process.execPath, [emitter, count, String(code)], options);
  pending.push(new Promise((resolve) => child.once('close', (code, signal) => {
    closes.push({ inspection, code, signal }); resolve();
  })));
  return child;
};
(async () => {
  const { promoteIntegrationBranch, createDocumentOverlapResolver } = require(bundle);
  const result = await promoteIntegrationBranch(repo, 'main', 'integration/item', tip, {
    dirtyRootPolicy: 'block-overlap',
    resolveDirtyOverlap: createDocumentOverlapResolver({ itemId: 'streaming-item' }),
  });
  await Promise.all(pending);
  const report = {
    result, before, tip, head: git(['rev-parse', 'HEAD']),
    document: fs.readFileSync(path.join(repo, 'register.md'), 'utf8'),
    committedDocument: cp.execFileSync('git', ['show', 'HEAD:register.md'], { cwd: repo, encoding: 'utf8' }),
    staged: git(['diff', '--cached', '--name-only']),
    indexUnchanged: fs.readFileSync(path.join(repo, '.git', 'index')).toString('base64') === indexBefore,
    trace: fs.readFileSync(trace, 'utf8'), closes,
  };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report));
})().catch((error) => { console.error(error); process.exitCode = 1; });
`;

interface Report {
  result: { status: string; reason?: string; mergedPaths?: string[]; tip?: string };
  before: string;
  tip: string;
  head: string;
  document: string;
  committedDocument: string;
  staged: string;
  indexUnchanged: boolean;
  trace: string;
  closes: { inspection: number; code: number; signal: string | null }[];
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'queue-doc-status-'));
  directories.push(directory);
  return directory;
}

beforeAll(async () => {
  harness = await temporaryDirectory();
  await writeFile(join(harness, 'emitter.cjs'), emitterSource);
  await writeFile(join(harness, 'worker.cjs'), workerSource);
  const root = process.cwd();
  await build({
    stdin: {
      contents: `export { promoteIntegrationBranch } from ${JSON.stringify(resolve(root, 'src/main/workspace/git/worktree-integration.ts'))};
export { createDocumentOverlapResolver } from ${JSON.stringify(resolve(root, 'src/main/plan-queue/plan-queue-doc-merge.ts'))};`,
      resolveDir: root, loader: 'ts',
    },
    outfile: join(harness, 'production.cjs'), bundle: true, platform: 'node',
    format: 'cjs', packages: 'external', logLevel: 'silent',
  });
}, 30_000);

afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function promoteWithStatus(count: number, failThird = false): Promise<Report> {
  const directory = await temporaryDirectory();
  const args = [
    `--max-old-space-size=${HEAP_MIB}`, join(harness, 'worker.cjs'), directory,
    join(harness, 'production.cjs'), join(harness, 'emitter.cjs'), String(count), String(failThird),
  ];
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolveOutcome, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env,
      NODE_PATH: [join(process.cwd(), 'node_modules'), process.env['NODE_PATH']].filter(Boolean).join(delimiter),
    };
    // A caller's Node flags must not silently override this test's heap bound.
    delete env['NODE_OPTIONS'];
    delete env['AI_ORCHESTRATOR_BROWSER_FORWARDER_LOG_DIR'];
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 75_000);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolveOutcome({ code, signal, stderr });
    });
  });
  expect(outcome, `Production promotion under ${HEAP_MIB} MiB with ${count} unrelated paths`).toEqual({
    code: 0, signal: null, stderr: '',
  });
  return JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')) as Report;
}

describe('document promotion with bounded streamed status', () => {
  it.each([0, LARGE_STATUS_COUNT])('merges operator and candidate bytes under the same heap limit with %i unrelated paths', async (count) => {
    const report = await promoteWithStatus(count);
    expect(report.result).toMatchObject({ status: 'promoted', tip: report.tip, mergedPaths: ['register.md'] });
    expect(report.head).toBe(report.tip);
    expect(report.head).not.toBe(report.before);
    expect(report.document).toBe('ours\n\nsecond\n\nitem\n');
    expect(report.committedDocument).toBe('first\n\nsecond\n\nitem\n');
    expect(report.staged).toBe('');
    expect(report.closes).toEqual([
      { inspection: 1, code: 0, signal: null },
      { inspection: 2, code: 0, signal: null },
      { inspection: 3, code: 0, signal: null },
    ]);
  }, 90_000);

  it('preserves HEAD, index and operator bytes when the third inspection fails after a match and a large tail', async () => {
    const report = await promoteWithStatus(LARGE_STATUS_COUNT, true);
    expect(report.result).toMatchObject({ status: 'blocked', reason: expect.stringContaining('status inspection failed') });
    expect(report.head).toBe(report.before);
    expect(report.document).toBe('ours\n\nsecond\n\nthird\n');
    expect(report.committedDocument).toBe('first\n\nsecond\n\nthird\n');
    expect(report.indexUnchanged).toBe(true);
    expect(report.staged).toBe('');
    expect(report.trace).not.toMatch(/built-in: git (?:checkout|reset|merge) /);
    expect(report.closes).toEqual([
      { inspection: 1, code: 0, signal: null },
      { inspection: 2, code: 0, signal: null },
      { inspection: 3, code: 42, signal: null },
    ]);
  }, 90_000);
});
