import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { MobileGatewayLoopHandlers, type GatewayLoopControl, type GatewayLoopRunRecord } from './mobile-gateway-loop-handlers';
import { MobileGatewayPlanQueueHandlers, type GatewayPlanQueueSource } from './mobile-gateway-plan-queue-handlers';
import { parseDocReviewDecision, MobileGatewayDocReviewHandlers } from './mobile-gateway-doc-review-handlers';
import { parseDocReviewItems } from './mobile-gateway-doc-review-items';
import {
  MobileGatewayBrowserApprovalHandlers,
  projectBrowserPrompt,
} from './mobile-gateway-browser-approval-handlers';
import { MobileGatewayHistoryContinueHandlers } from './mobile-gateway-history-continue';
import { tokenFromWsUpgrade } from './mobile-gateway-ws-handlers';
import { allowedCorsOrigin, redactUrlToken } from './mobile-gateway-http-utils';
import type { MobilePromptDto } from '../../shared/types/mobile-gateway.types';

function jsonRequest(_body: unknown): IncomingMessage {
  return new EventEmitter() as IncomingMessage;
}

async function withJson<T>(body: unknown, run: (req: IncomingMessage) => Promise<T>): Promise<T> {
  const req = jsonRequest(body);
  const pending = run(req);
  req.emit('data', Buffer.from(JSON.stringify(body)));
  req.emit('end');
  return pending;
}

function response(): { res: ServerResponse; status: number; body: unknown } {
  const state = { status: 0, body: undefined as unknown };
  const res = {
    writeHead(status: number) { state.status = status; },
    end(payload: string) { state.body = JSON.parse(payload); },
  } as unknown as ServerResponse;
  return { res, get status() { return state.status; }, get body() { return state.body; } };
}

const run: GatewayLoopRunRecord = {
  id: 'loop-1', chatId: 'chat-1', status: 'running', currentStage: 'IMPLEMENT',
  iteration: 2, maxIterations: 10, startedAt: 1, endedAt: null, totalTokens: 4,
  totalCostCents: 1, workspaceCwd: '/repo', endReason: null, pausedForInput: false,
};

describe('mobile away-from-desk handlers', () => {
  it('pauses and stops through the control API and pushes only on a new terminal status', async () => {
    const control: GatewayLoopControl = {
      list: () => [run],
      get: () => ({ ...run, iterations: [], outstanding: [] }),
      pause: vi.fn(() => ({ ok: true, run: { ...run, status: 'paused' } })),
      resume: vi.fn(async () => ({ ok: true, run })),
      stop: vi.fn(async () => ({ ok: true, run: { ...run, status: 'cancelled', endedAt: 2 } })),
      subscribe: (listener) => {
        listener('loop-1', { ...run, status: 'completed', endedAt: 3 });
        listener('loop-1', { ...run, status: 'completed', endedAt: 3 });
        return () => undefined;
      },
    };
    const pushes: string[] = [];
    const handlers = new MobileGatewayLoopHandlers({
      getControl: () => control,
      broadcast: () => undefined,
      sendPush: (_run, kind) => pushes.push(kind),
    });
    handlers.attach();
    const listed = response();
    await handlers.handle({} as never, listed.res, ['api', 'loops'], 'GET');
    expect(Array.isArray(listed.body) ? listed.body[0] : listed.body).toMatchObject({ id: 'loop-1', status: 'running' });
    const paused = response();
    await handlers.handle({} as never, paused.res, ['api', 'loops', 'loop-1', 'pause'], 'POST');
    expect(control.pause).toHaveBeenCalledWith('loop-1');
    expect(paused.body).toMatchObject({ ok: true, run: { status: 'paused' } });
    const stopped = response();
    await handlers.handle({} as never, stopped.res, ['api', 'loops', 'loop-1', 'stop'], 'POST');
    expect(control.stop).toHaveBeenCalledWith('loop-1');
    expect(pushes).toEqual(['completed']);
    handlers.detach();
  });

  it('answers a plan-queue question and rejects item-level landing controls', async () => {
    const source: GatewayPlanQueueSource = {
      list: () => [],
      answer: vi.fn(async () => undefined),
      control: vi.fn(async () => undefined),
      diffstat: vi.fn(async () => '1 file changed'),
      subscribe: () => () => undefined,
    };
    const handlers = new MobileGatewayPlanQueueHandlers({
      getSource: () => source,
      broadcast: () => undefined,
      sendNeedsAnswerPush: () => undefined,
    });
    const answered = response();
    await withJson({ optionId: 'keep' }, (req) => handlers.handle(req, answered.res, ['api', 'plan-queue', 'item-1', 'answer'], 'POST'));
    expect(source.answer).toHaveBeenCalledWith('item-1', 'keep');
    const diff = response();
    await handlers.handle({} as never, diff.res, ['api', 'plan-queue', 'item-1', 'diffstat'], 'GET');
    expect(diff.body).toEqual({ diffstat: '1 file changed' });
    await expect(withJson({ action: 'land-anyway' }, (req) => handlers.handle(
      req, response().res, ['api', 'plan-queue', 'run-1', 'control'], 'POST',
    ))).rejects.toThrow(/pause, resume, or cancel/);
    expect(source.control).not.toHaveBeenCalled();
  });

  it('parses review items and submits the canonical decision payload', async () => {
    const html = `
      <section data-review-item="strategy" data-review-title="Strategy" data-decision-id="1">
        <ul data-review-options data-multi="false">
          <li data-option="a" data-option-default="true">Loop only</li>
          <li data-option="b">Loop and chat</li>
        </ul>
      </section>`;
    expect(parseDocReviewItems(html)).toEqual([{
      id: 'strategy', title: 'Strategy', decisionId: '1',
      options: [
        { id: 'a', label: 'Loop only', multi: false, isDefault: true },
        { id: 'b', label: 'Loop and chat', multi: false, isDefault: false },
      ],
    }]);
    const submitted: unknown[] = [];
    const handlers = new MobileGatewayDocReviewHandlers({
      getSource: () => ({
        listPending: () => [],
        get: async () => null,
        submit: async (_id, body) => {
          submitted.push(body);
          return { ok: true as const, status: 'approved' as const };
        },
        subscribe: () => () => undefined,
      }),
      sendPendingPush: () => undefined,
    });
    const decision = parseDocReviewDecision({
      overall: 'approved',
      decisions: [{ itemId: 'strategy', decisionId: '1', decision: 'approve', choice: 'b', choices: [] }],
    });
    const result = response();
    await withJson(decision, (req) => handlers.handle(
      req, result.res, ['api', 'doc-reviews', 'review-1', 'decision'], 'POST',
    ));
    expect(submitted).toEqual([decision]);
    expect(result.body).toEqual({ ok: true, status: 'approved' });
  });

  it('refuses phone approval of credential browser steps and approves a submit', async () => {
    const prompts = new Map<string, MobilePromptDto>();
    const sink = {
      syncBrowser(next: MobilePromptDto[]) { prompts.clear(); for (const prompt of next) prompts.set(prompt.id, prompt); },
      get: (id: string) => prompts.get(id),
      clear: (id: string) => prompts.delete(id),
    };
    const approve = vi.fn(async () => undefined);
    const handlers = new MobileGatewayBrowserApprovalHandlers({
      getSource: () => ({
        listPending: async () => [
          { id: '1', requestId: 'login', instanceId: 'inst', toolName: 'fill', action: 'sign in', actionClass: 'credential', createdAt: 1, status: 'pending' },
          { id: '2', requestId: 'save', instanceId: 'inst', toolName: 'click', action: 'submit form', actionClass: 'submit', origin: 'https://example.test', createdAt: 2, status: 'pending' },
        ],
        approve, deny: vi.fn(async () => undefined),
      }),
      prompts: sink,
    });
    await handlers.refresh();
    expect(projectBrowserPrompt({ id: '1', requestId: 'login', instanceId: 'inst', toolName: 'fill', action: 'sign in', actionClass: 'credential', createdAt: 1, status: 'pending' })?.actionClass).toBe('credential');
    await expect(withJson({ decisionAction: 'allow' }, (req) => handlers.handle(
      req, response().res, ['api', 'browser-approvals', 'login', 'respond'], 'POST',
    ))).rejects.toThrow(/Open this step on your Mac/);
    const allowed = response();
    await withJson({ decisionAction: 'allow' }, (req) => handlers.handle(
      req, allowed.res, ['api', 'browser-approvals', 'save', 'respond'], 'POST',
    ));
    expect(approve).toHaveBeenCalledWith('save');
    expect(allowed.body).toEqual({ ok: true });
  });

  it('continues history through restore and wakes a hibernated instance', async () => {
    const restore = vi.fn(async () => ({
      instanceId: 'new-1', sessionId: 'session-1', historyThreadId: 'thread-1', restoreMode: 'native-resume' as const,
    }));
    const wake = vi.fn(async () => undefined);
    const handlers = new MobileGatewayHistoryContinueHandlers({ getSource: () => ({ restore, wake }) });
    const continued = response();
    await handlers.handle({} as never, continued.res, ['api', 'history', 'inst:old-1', 'continue'], 'POST');
    expect(restore).toHaveBeenCalledWith('old-1');
    expect(continued.body).toMatchObject({ instanceId: 'new-1', restoreMode: 'native-resume' });
    await expect(handlers.handle(
      {} as never, response().res, ['api', 'history', 'chat:chat-1', 'continue'], 'POST',
    )).rejects.toThrow(/cannot be continued from the phone/);
    const woken = response();
    await handlers.handle({} as never, woken.res, ['api', 'instances', 'hibernated-1', 'wake'], 'POST');
    expect(wake).toHaveBeenCalledWith('hibernated-1');
    expect(woken.body).toEqual({ ok: true });
  });

  it('reads the websocket token from the protocol and keeps the query form', () => {
    const url = new URL('http://localhost/ws?token=query-token');
    expect(tokenFromWsUpgrade({ headers: { 'sec-websocket-protocol': 'aio.v1, bearer.protocol-token' } } as never, url)).toBe('protocol-token');
    expect(tokenFromWsUpgrade({ headers: {} } as never, url)).toBe('query-token');
    expect(redactUrlToken('/ws?token=query-token&x=1')).toBe('/ws?token=redacted&x=1');
    expect(allowedCorsOrigin('capacitor://localhost')).toBe('capacitor://localhost');
    expect(allowedCorsOrigin('http://localhost:4200', false)).toBeNull();
    expect(allowedCorsOrigin('http://127.0.0.1:4310', true)).toBe('http://127.0.0.1:4310');
    expect(allowedCorsOrigin('https://evil.test', true)).toBeNull();
  });
});
