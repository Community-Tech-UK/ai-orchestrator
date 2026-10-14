import { describe, expect, it } from 'vitest';
import { classifyCoordinatorRequest, WorkerActivity } from './worker-activity';

describe('WorkerActivity', () => {
  it('is busy while live state reports work', () => {
    let count = 0;
    const activity = new WorkerActivity(() => count);
    expect(activity.isBusy()).toBe(false);
    count = 2;
    expect(activity.isBusy()).toBe(true);
  });

  it('counts a coordinator request for its whole duration and stamps when it ended', async () => {
    let now = 100;
    let finish!: () => void;
    const activity = new WorkerActivity(() => 0, () => 0, () => now);

    const work = activity.track('instance.spawn', new Promise<void>((resolve) => {
      finish = resolve;
    }));
    expect(activity.isBusy()).toBe(true);
    expect(activity.lastActivityAt()).toBe(100);

    now = 250;
    finish();
    await work;
    expect(activity.isBusy()).toBe(false);
    expect(activity.lastActivityAt()).toBe(250);
  });

  it('stops counting a request that failed', async () => {
    const activity = new WorkerActivity(() => 0);
    await expect(activity.track('instance.sendInput', Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(activity.isBusy()).toBe(false);
  });

  it('reports the later of tracked and external activity', () => {
    const activity = new WorkerActivity(() => 0, () => 900, () => 100);
    expect(activity.lastActivityAt()).toBe(900);
  });

  it('ignores coordinator housekeeping entirely', async () => {
    const activity = new WorkerActivity(() => 0, () => 0, () => 500);
    let finish!: () => void;
    const ping = activity.track('node.ping', new Promise<void>((resolve) => {
      finish = resolve;
    }));
    expect(activity.isBusy()).toBe(false);
    finish();
    await ping;
    expect(activity.lastActivityAt()).toBe(0);
  });

  it('counts a short one-off request only while it runs', async () => {
    let now = 100;
    const activity = new WorkerActivity(() => 0, () => 0, () => now);
    let finish!: () => void;
    const generate = activity.track('auxiliaryModel.generate', new Promise<void>((resolve) => {
      finish = resolve;
    }));
    expect(activity.isBusy()).toBe(true);
    now = 200;
    finish();
    await generate;
    expect(activity.isBusy()).toBe(false);
    expect(activity.lastActivityAt()).toBe(0);
  });
});

describe('classifyCoordinatorRequest', () => {
  it.each([
    ['node.ping', 'ignore'],
    ['localAi.health.check', 'ignore'],
    ['auxiliaryModel.list', 'ignore'],
    ['service.status', 'ignore'],
    ['fs.readFileChunk', 'in_flight'],
    ['sync.applyDelta', 'in_flight'],
    ['auxiliaryModel.generate', 'in_flight'],
    ['instance.spawn', 'work'],
    ['terminal.create', 'work'],
    ['node.exec', 'work'],
    ['browser.cdp.open', 'work'],
    [undefined, 'work'],
  ])('%s is %s', (method, weight) => {
    expect(classifyCoordinatorRequest(method)).toBe(weight);
  });
});
