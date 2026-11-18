/**
 * The phone's answer route refuses a question only James can answer (a Linear ticket that changed): the phone has no screen
 * that shows what the ticket now says, so for now the answer is given on the Plan Queue page. An ordinary question is still
 * answered from the phone.
 */
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'http';
import { describe, expect, it, vi } from 'vitest';
import { MobileGatewayPlanQueueHandlers, type GatewayPlanQueueSource } from './mobile-gateway-plan-queue-handlers';
import type { MobilePlanQueueItemDto, MobilePlanQueueRunDto } from '../../shared/types/mobile-gateway.types';

function post(body: unknown, run: (req: IncomingMessage) => Promise<boolean>): Promise<boolean> {
  const req = new EventEmitter() as IncomingMessage;
  const pending = run(req);
  req.emit('data', Buffer.from(JSON.stringify(body)));
  req.emit('end');
  return pending;
}

const response = (): ServerResponse => ({ writeHead: () => undefined, end: () => undefined, setHeader: () => undefined }) as unknown as ServerResponse;

const item = (id: string, question: MobilePlanQueueItemDto['question']): MobilePlanQueueItemDto => ({
  id, runId: 'run-1', title: id, sourceRef: `linear:${id}`, state: 'queued', round: 0, question, answer: null, parkReason: null,
  detail: null, verdict: null, workerInstanceId: null, updatedAt: 1,
});
const run: MobilePlanQueueRunDto = {
  id: 'run-1', kind: 'tickets', status: 'running', workspaceCwd: '/repo', startedAt: 0, endedAt: null, workerProvider: null, workerModel: null,
  items: [
    item('ticket', { question: 'ORC-12 changed in Linear. Answer on the Plan Queue page.', jamesOnly: true, options: [{ id: 'use-now', label: 'Use the ticket as it is now' }, { id: 'stop', label: 'Stop work on this ticket' }] }),
    item('ordinary', { question: 'Which one?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }),
  ],
};

function handlers() {
  const source: GatewayPlanQueueSource = {
    list: () => [run], answer: vi.fn(async () => undefined), control: vi.fn(async () => undefined),
    chooseDirectChange: vi.fn(async () => undefined), diffstat: vi.fn(async () => ''), subscribe: () => () => undefined,
  };
  return { source, handlers: new MobileGatewayPlanQueueHandlers({ getSource: () => source, broadcast: () => undefined, sendWaitingPush: () => undefined }) };
}
const answerRoute = (itemId: string) => ['api', 'plan-queue', itemId, 'answer'];

describe('the phone and a question only James can answer', () => {
  it.each(['use-now', 'keep-approved', 'stop', 'leave-waiting'])('refuses "%s" and sends nothing to the queue', async (optionId) => {
    const { source, handlers: gateway } = handlers();
    await expect(post({ optionId }, (req) => gateway.handle(req, response(), answerRoute('ticket'), 'POST')))
      .rejects.toMatchObject({ message: 'Answer this one on the Plan Queue page.', statusCode: 403 });
    expect(source.answer).not.toHaveBeenCalled();
  });

  it('still answers an ordinary question', async () => {
    const { source, handlers: gateway } = handlers();
    await post({ optionId: 'a' }, (req) => gateway.handle(req, response(), answerRoute('ordinary'), 'POST'));
    expect(source.answer).toHaveBeenCalledWith('ordinary', 'a');
  });
});
