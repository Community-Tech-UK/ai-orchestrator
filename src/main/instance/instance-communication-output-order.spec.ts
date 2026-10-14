import { describe, expect, it } from 'vitest';
import { OutputPublicationOrder } from './instance-communication-output-order';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('OutputPublicationOrder', () => {
  it('lets messages pass without waiting while nothing is held', () => {
    const order = new OutputPublicationOrder();
    const first = order.enter();
    const second = order.enter();

    expect(first.turn).toBeUndefined();
    expect(second.turn).toBeUndefined();
    first.release();
    second.release();
  });

  it('queues messages emitted while an earlier one is held, in emit order', async () => {
    const order = new OutputPublicationOrder();
    const published: string[] = [];
    const first = order.enter();
    first.hold();
    const second = order.enter();
    const third = order.enter();
    void second.turn?.then(() => { published.push('second'); second.release(); });
    void third.turn?.then(() => { published.push('third'); third.release(); });

    await flush();
    expect(published).toEqual([]);

    published.push('first');
    first.release();
    await flush();
    expect(published).toEqual(['first', 'second', 'third']);
  });

  it('stops queueing once every held message has released', async () => {
    const order = new OutputPublicationOrder();
    const first = order.enter();
    first.hold();
    const second = order.enter();
    first.release();
    await second.turn;
    second.release();
    await flush();

    expect(order.enter().turn).toBeUndefined();
  });

  it('does not let a later message pass a held one that releases early', async () => {
    const order = new OutputPublicationOrder();
    const published: string[] = [];
    const first = order.enter();
    first.hold();
    const second = order.enter();
    const third = order.enter();
    // An out-of-turn release of the middle ticket must not open the queue for
    // the third message before the first has published.
    second.release();
    void third.turn?.then(() => published.push('third'));
    await flush();
    expect(published).toEqual([]);

    first.release();
    await flush();
    expect(published).toEqual(['third']);
  });

  it('reports pending publication only while a message is held', async () => {
    const order = new OutputPublicationOrder();
    expect(order.pending()).toBeUndefined();
    const first = order.enter();
    first.hold();
    const pending = order.pending();
    let settled = false;
    void pending?.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);

    first.release();
    await flush();
    expect(settled).toBe(true);
    expect(order.pending()).toBeUndefined();
  });

  it('stops delaying later messages once a hold outlasts its limit', async () => {
    const order = new OutputPublicationOrder(20);
    const first = order.enter();
    first.hold();
    const second = order.enter();
    let secondReady = false;
    void second.turn?.then(() => { secondReady = true; });

    await flush();
    expect(secondReady).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(secondReady).toBe(true);
    second.release();
    first.release();
  });

  it('treats hold and release as idempotent', async () => {
    const order = new OutputPublicationOrder();
    const first = order.enter();
    first.hold();
    first.hold();
    const second = order.enter();
    first.release();
    first.release();

    await expect(second.turn).resolves.toBeUndefined();
  });
});
