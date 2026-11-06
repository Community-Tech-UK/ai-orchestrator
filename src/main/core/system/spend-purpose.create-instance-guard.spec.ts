import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { resolveSpendPurpose } from './spend-purpose';

/**
 * Step 6 (A0-S) guard. Every production `createInstance(` call in `src/main`
 * is listed here with the purpose its turns file under, computed by running
 * the real `resolveSpendPurpose` over the `metadata` and `parentId` that the
 * call site writes. A Harness-started path must resolve to something other
 * than `chat`; a person's own action is `chat` on purpose. A call site that is
 * added, removed, or loses its tag changes a row and fails the test, which is
 * the net that keeps a new Harness-started path from slipping back to "chat"
 * on the Costs page.
 *
 * A call whose argument is not an object literal is `forwarded`: the config
 * was built elsewhere, and that builder has its own row (or is a person
 * action). `createInstance({ ... })` plus any `.createInstance(` property call
 * counts; the unrelated specialist registry call is listed in `NOT_A_SESSION`.
 *
 * To add a site: classify it, then add its row. Do not add a `chat` row for a
 * path Harness starts by itself; tag it instead (see `spend-purpose.ts`).
 */
type SiteKind = 'chat' | 'child' | 'plan-queue' | 'repo-job' | 'remote-node' | 'review'
  | 'automation' | 'channel' | 'forwarded';

/** Not a session spawn: the specialist registry builds a specialist record. */
const NOT_A_SESSION = new Set(['ipc/specialist-ipc-handler.ts']);

/** Harness-started: every built config must resolve to the listed non-chat purpose. */
const MACHINE_SITES: Record<string, SiteKind[]> = {
  'plan-queue/plan-queue-item-flow.ts': ['plan-queue'],
  'plan-queue/plan-queue-checker-spawn.ts': ['plan-queue'],
  'plan-queue/plan-queue-triage.ts': ['plan-queue'],
  // Both the resume attempt and its fresh-session retry forward the tagged queue config.
  'plan-queue/plan-queue-spawn.ts': ['forwarded', 'forwarded'],
  'repo-jobs/repo-job-service.ts': ['repo-job'],
  'app/orchestrator-tools-step.ts': ['remote-node'],
  'orchestration/reviewer-session-spawner.ts': ['review'],
  // First attempts and retries share the tagged dispatchRunOnce creation site.
  'automations/automation-runner.ts': ['automation'],
  'channels/channel-message-router.ts': ['channel', 'channel'],
  // spawn_child helpers: the purpose comes from `parentId`. The four forwarders
  // hand a config on to the lifecycle manager or a dependency port.
  'instance/instance-manager.ts': ['forwarded', 'forwarded', 'forwarded', 'forwarded', 'child', 'child'],
};

/** James's own actions: a chat he opens, phone, thin client, restore, fork, crash revival. */
const PERSON_SITES: Record<string, SiteKind[]> = {
  'chats/chat-service.ts': ['chat'],
  'event-bus/thin-client-instance-commands.ts': ['forwarded'],
  'history/archive-recoverable-sessions.ts': ['chat'],
  'history/history-restore-coordinator.ts': ['chat', 'chat'],
  'history/ingest-missing-last-stop-history.ts': ['chat'],
  'instance/instance-persistence.ts': ['forwarded', 'chat'],
  'instance/lifecycle/continuity-recovery-coordinator.ts': ['forwarded'],
  'instance/lifecycle/continuity-revival.ts': ['chat'],
  // Step 15b: James clicks "Build in a new session" on an approved plan.
  'instance/plan-handoff/plan-build-handoff.ts': ['chat'],
  'ipc/handlers/instance-create-with-message.ts': ['chat'],
  // James clicks Start on the Set aside page; the session has no spend tag, so its turns file under Chat.
  'plan-queue/plan-queue-set-aside.ts': ['chat'],
  // The renderer's create call; `child` when it passes `parentInstanceId`, otherwise a root chat.
  'ipc/handlers/instance-handlers.ts': ['child'],
  'ipc/handlers/plan-handoff-handlers.ts': ['forwarded'],
  'mobile-gateway/mobile-gateway-instance-routes.ts': ['forwarded'],
};

const SOURCE_ROOT = join(process.cwd(), 'src/main');

function productionFiles(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') out.push(...productionFiles(join(dir, entry.name), rel));
    } else if (entry.name.endsWith('.ts')
      && !/\.(spec|d)\.ts$/.test(entry.name)
      && !entry.name.endsWith('.test-helpers.ts')) {
      out.push(rel);
    }
  }
  return out;
}

/** A property written as `name: value` or as the shorthand `name`. */
function propertyNamed(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralElementLike | undefined {
  return object.properties.find((entry) => (
    (ts.isPropertyAssignment(entry) || ts.isShorthandPropertyAssignment(entry))
    && entry.name.getText() === name
  ));
}

/** `parentId: null` and `parentId: undefined` are explicit root sessions. */
function hasParent(config: ts.ObjectLiteralExpression): boolean {
  const entry = propertyNamed(config, 'parentId');
  if (!entry) return false;
  if (ts.isShorthandPropertyAssignment(entry)) return true;
  if (!ts.isPropertyAssignment(entry)) return false;
  const value = entry.initializer;
  return value.kind !== ts.SyntaxKind.NullKeyword
    && !(ts.isIdentifier(value) && value.text === 'undefined');
}

/** Read the literal keys a call site writes into `metadata`; spreads are ignored. */
function metadataOf(config: ts.ObjectLiteralExpression): Record<string, unknown> {
  const entry = propertyNamed(config, 'metadata');
  const metadata = entry && ts.isPropertyAssignment(entry) ? entry.initializer : undefined;
  if (!metadata || !ts.isObjectLiteralExpression(metadata)) return {};
  const out: Record<string, unknown> = {};
  for (const entry of metadata.properties) {
    if (!ts.isPropertyAssignment(entry)) continue;
    const value = entry.initializer;
    out[entry.name.getText()] = ts.isStringLiteralLike(value) ? value.text
      : value.kind === ts.SyntaxKind.TrueKeyword ? true
        : value.kind === ts.SyntaxKind.FalseKeyword ? false
          : 'dynamic';
  }
  return out;
}

function kindOf(config: ts.ObjectLiteralExpression): SiteKind {
  return resolveSpendPurpose({
    ...(hasParent(config) ? { parentId: 'parent' } : {}),
    metadata: metadataOf(config),
  }).purpose as SiteKind;
}

function callSitesIn(rel: string): SiteKind[] {
  const source = ts.createSourceFile(rel, readFileSync(join(SOURCE_ROOT, rel), 'utf8'), ts.ScriptTarget.Latest, true);
  const sites: SiteKind[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const property = ts.isPropertyAccessExpression(callee) && callee.name.text === 'createInstance';
      const bare = ts.isIdentifier(callee) && callee.text === 'createInstance';
      const config = node.arguments[0];
      const literal = config !== undefined && ts.isObjectLiteralExpression(config);
      if (property || (bare && literal)) sites.push(literal ? kindOf(config) : 'forwarded');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

function actualSites(): Record<string, SiteKind[]> {
  const found: Record<string, SiteKind[]> = {};
  for (const rel of productionFiles(SOURCE_ROOT).sort()) {
    if (NOT_A_SESSION.has(rel)) continue;
    const sites = callSitesIn(rel);
    if (sites.length > 0) found[rel] = sites;
  }
  return found;
}

describe('createInstance call sites carry a spend purpose (A0-S guard)', () => {
  const actual = actualSites();

  it('every production call site is classified, with the purpose its turns file under', () => {
    // A new, removed or untagged call site changes this object and fails here.
    expect(actual).toEqual({ ...MACHINE_SITES, ...PERSON_SITES });
  });

  it('no Harness-started path resolves to chat', () => {
    for (const [file, kinds] of Object.entries(MACHINE_SITES)) {
      expect(kinds, file).not.toContain('chat');
    }
  });

  it('a machine session without a tag would resolve to chat (the guard detects a removed tag)', () => {
    // Proves the guard's own reading: the same literal without its metadata is `chat`.
    const stripped = ts.createSourceFile(
      'probe.ts',
      "im.createInstance({ displayName: 'x', yoloMode: true, metadata: { hideFromProjectRail: true } });",
      ts.ScriptTarget.Latest,
      true,
    );
    const call = (stripped.statements[0] as ts.ExpressionStatement).expression as ts.CallExpression;
    expect(kindOf(call.arguments[0] as ts.ObjectLiteralExpression)).toBe('chat');
  });

  it('the listed files still exist (rename upkeep)', () => {
    const files = new Set(productionFiles(SOURCE_ROOT));
    for (const file of [...Object.keys(MACHINE_SITES), ...Object.keys(PERSON_SITES), ...NOT_A_SESSION]) {
      expect(files.has(file), file).toBe(true);
    }
  });
});
