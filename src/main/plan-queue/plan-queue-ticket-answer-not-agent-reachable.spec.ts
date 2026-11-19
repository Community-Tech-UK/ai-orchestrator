/**
 * No agent can read or answer the question a changed Linear ticket opens. Agents get at the app through MCP tools, the
 * `aio-mcp` command and the session RPC (all under `src/main/mcp/`), the Plan Queue's own tool operations and the phone's
 * gateway. This guard fails if any of them names the answer module, the two channels or the held text, so a later change that
 * wires one in does so on purpose.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
/**
 * The only files that name the answer module or its channels: the module, the page's handlers, the coordinator, the pump's
 * own clean-up, the contracts, and the Plan Queue page's own three files (the renderer's channel service, the card that reads
 * and answers, and the list that shows the card). The renderer is the page; no agent runs there.
 */
const ALLOWED = [
  join('src', 'main', 'ipc', 'handlers', 'plan-queue-handlers.ts'),
  join('src', 'main', 'plan-queue', 'plan-queue-coordinator.ts'),
  join('src', 'main', 'plan-queue', 'plan-queue-pump.ts'),
  join('src', 'main', 'plan-queue', 'plan-queue-ticket-answer.ts'),
  join('src', 'preload', 'domains', 'plan-queue.preload.ts'),
  join('src', 'preload', 'generated', 'channels.ts'),
  join('packages', 'contracts', 'src', 'channels', 'plan-queue.channels.ts'),
  join('packages', 'contracts', 'src', 'schemas', 'plan-queue.schemas.ts'),
  join('packages', 'contracts', 'src', 'schemas', 'plan-queue-ticket-ask.schemas.ts'),
  join('src', 'renderer', 'app', 'core', 'services', 'ipc', 'plan-queue-ipc.service.ts'),
  join('src', 'renderer', 'app', 'features', 'plan-queue', 'components', 'plan-queue-question-list.component.ts'),
  join('src', 'renderer', 'app', 'features', 'plan-queue', 'components', 'plan-queue-ticket-ask-card.component.ts'),
];
const NAMES = /plan-queue-ticket-answer['"]|PLAN_QUEUE_TICKET_ASK|plan-queue:ticket-ask|answerTicketAsk|readTicketAsk|PlanQueueTicketAsk|plan-queue-ticket-ask\.schemas/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (entry === 'node_modules' || entry === 'dist') return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !/\.(spec|test)\.ts$/.test(path) && !path.endsWith('.test-helpers.ts') ? [path] : [];
  });
}

const namers = ['src/main', 'src/preload', 'src/shared', 'src/renderer', 'packages']
  .flatMap((folder) => sourceFiles(join(ROOT, folder)))
  .map((path) => relative(ROOT, path))
  .filter((path) => NAMES.test(readFileSync(join(ROOT, path), 'utf8')));

describe('the ticket question is not reachable by agents', () => {
  it('is named by nothing outside the page\'s handlers, the coordinator and the contracts', () => {
    expect(namers.filter((path) => !ALLOWED.includes(path))).toEqual([]);
  });

  it('is named by no tool, command, RPC method, tool operation or phone route', () => {
    const routes = namers.filter((path) => path.startsWith(join('src', 'main', 'mcp')) || path.includes('mobile-gateway') || path.endsWith('plan-queue-tool-operations.ts'));
    expect(routes).toEqual([]);
  });

  it('the one place that reads the held text is the answer module (nothing else opens `heldText`)', () => {
    const readers = ['src/main', 'src/preload', 'src/shared', 'packages']
      .flatMap((folder) => sourceFiles(join(ROOT, folder)))
      .map((path) => relative(ROOT, path))
      .filter((path) => /\.heldText\b|heldText:/.test(readFileSync(join(ROOT, path), 'utf8')));
    expect(readers.sort()).toEqual([
      join('src', 'main', 'plan-queue', 'plan-queue-linear-ticket-store.ts'),
      join('src', 'main', 'plan-queue', 'plan-queue-ticket-answer.ts'),
      join('src', 'main', 'plan-queue', 'plan-queue-ticket-guard.ts'),
    ].sort());
  });
});
