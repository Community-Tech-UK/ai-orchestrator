import { beforeEach, describe, expect, it } from 'vitest';
import { InstanceContinuityInputQueue } from './instance-continuity-input-queue';

describe('InstanceContinuityInputQueue', () => {
  let queue: InstanceContinuityInputQueue;

  beforeEach(() => {
    queue = new InstanceContinuityInputQueue();
  });

  it('ignores blank continuity preambles', () => {
    queue.queueContinuity('instance-1', '   ');

    expect(queue.consume('instance-1', null)).toBeNull();
  });

  it('consumes continuity then warning before the caller context block', () => {
    queue.queueContinuity('instance-1', 'Recovered conversation context');
    queue.queueContextWarning('instance-1', 'Context pressure guidance');

    expect(queue.consume('instance-1', 'Caller-provided context')).toBe(
      'Recovered conversation context\n\nContext pressure guidance\n\nCaller-provided context',
    );
    queue.markAnswered('instance-1');
    expect(queue.consume('instance-1', 'Next context')).toBe('Next context');
  });

  it('sends continuity again with the next input when the model never replied to it', () => {
    queue.queueContinuity('instance-1', 'Recovered conversation context');
    queue.queueContextWarning('instance-1', 'Context pressure guidance');
    queue.consume('instance-1', null);

    // The turn was stopped before any reply: history again, the warning was one-shot.
    expect(queue.consume('instance-1', 'try again')).toBe('Recovered conversation context\n\ntry again');

    queue.markAnswered('instance-1');
    expect(queue.consume('instance-1', 'next')).toBe('next');
  });

  it('holds history delivered outside the queue until the model replies', () => {
    queue.holdUntilAnswered('instance-1', 'Condensed history sent as its own turn');
    queue.queueRetrievedContext('instance-1', 'Late code search results');

    expect(queue.consume('instance-1', 'try again')).toBe(
      'Condensed history sent as its own turn\n\nLate code search results\n\ntry again',
    );
    // Still unanswered: the history goes again, the search results were one-shot.
    expect(queue.consume('instance-1', 'again')).toBe('Condensed history sent as its own turn\n\nagain');

    queue.markAnswered('instance-1');
    expect(queue.consume('instance-1', null)).toBeNull();
  });

  it('never lets retrieved context displace queued or held history', () => {
    queue.queueContinuity('instance-1', 'Restored history');
    queue.queueRetrievedContext('instance-1', 'Search results 1');
    queue.queueRetrievedContext('instance-1', 'Search results 2');

    expect(queue.consume('instance-1', 'first')).toBe('Restored history\n\nSearch results 2\n\nfirst');
    queue.queueRetrievedContext('instance-1', 'Search results 3');
    expect(queue.consume('instance-1', 'second')).toBe('Restored history\n\nSearch results 3\n\nsecond');
    expect(queue.consume('instance-1', 'third')).toBe('Restored history\n\nthird');
  });

  it('resends the images held with history, ahead of the caller attachments, until the model replies', () => {
    const image = { name: 'chart.png', type: 'image/png', size: 3, data: 'abc' };
    const userFile = { name: 'notes.txt', type: 'text/plain', size: 2, data: 'hi' };
    queue.holdUntilAnswered('instance-1', 'History with one image', [image]);

    const first = queue.prepare('instance-1', null, [userFile]);
    first.commit();
    expect(first.attachments).toEqual([image, userFile]);

    // A retry that already carries the history must not attach the image twice.
    expect(queue.prepare('instance-1', first.contextBlock, first.attachments).attachments).toEqual([image, userFile]);

    queue.markAnswered('instance-1');
    expect(queue.prepare('instance-1', null, [userFile]).attachments).toEqual([userFile]);
  });

  it('replaces held text with newer continuity so repeated stopped turns do not pile up copies', () => {
    queue.holdUntilAnswered('instance-1', 'History 1');
    queue.queueContinuity('instance-1', 'History 2');
    expect(queue.consume('instance-1', 'retry')).toBe('History 1\n\nHistory 2\n\nretry');

    queue.queueContinuity('instance-1', 'History 3');
    expect(queue.consume('instance-1', 'retry')).toBe('History 2\n\nHistory 3\n\nretry');
    expect(queue.consume('instance-1', 'retry')).toBe('History 3\n\nretry');
  });

  it('does not hold the text again when the model replied while the input was being prepared', () => {
    queue.holdUntilAnswered('instance-1', 'Condensed history');
    const prepared = queue.prepare('instance-1', 'next');

    queue.markAnswered('instance-1');
    prepared.commit();

    expect(prepared.contextBlock).toBe('Condensed history\n\nnext');
    expect(queue.consume('instance-1', 'after')).toBe('after');
  });

  it('does not repeat held history in a retried turn that already carries it', () => {
    queue.holdUntilAnswered('instance-1', 'Condensed history');
    const firstSend = queue.consume('instance-1', 'context');

    expect(queue.consume('instance-1', firstSend)).toBe(firstSend);
    queue.queueContextWarning('instance-1', 'Warning');
    expect(queue.consume('instance-1', firstSend)).toBe(`Warning\n\n${firstSend}`);
  });

  it('ignores blank held history', () => {
    queue.holdUntilAnswered('instance-1', '  ');

    expect(queue.consume('instance-1', null)).toBeNull();
  });

  it('isolates and cleans up pending input by instance', () => {
    queue.queueContinuity('instance-1', 'One');
    queue.queueContinuity('instance-2', 'Two');
    queue.queueContextWarning('instance-1', 'Warning');
    queue.holdUntilAnswered('instance-1', 'Held');

    queue.cleanup('instance-1');

    expect(queue.consume('instance-1', undefined)).toBeUndefined();
    expect(queue.consume('instance-2', undefined)).toBe('Two');
  });
});
