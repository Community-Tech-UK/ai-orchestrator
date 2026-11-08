import { describe, expect, it } from 'vitest';
import { ClaudeTurnStartTracker } from './claude-cli-turn-start-tracker';

describe('ClaudeTurnStartTracker', () => {
  it('hands out a different uuid for each write', () => {
    const tracker = new ClaudeTurnStartTracker();
    expect(tracker.claimWrite()).not.toBe(tracker.claimWrite());
  });

  it('calls an init Harness\'s only when the started line before it names a uuid Harness wrote', () => {
    const tracker = new ClaudeTurnStartTracker();
    const uuid = tracker.claimWrite();
    tracker.commandLifecycle(uuid, 'queued');
    tracker.commandLifecycle(uuid, 'started');
    expect(tracker.turnStarted()).toEqual({ source: 'harness-send' });
    expect(tracker.turnStarted()).toEqual({ source: 'provider' });
  });

  it('calls an init with no lifecycle lines before it the provider\'s, even with a write outstanding', () => {
    const tracker = new ClaudeTurnStartTracker();
    tracker.claimWrite();
    expect(tracker.turnStarted()).toEqual({ source: 'provider' });
  });

  it('ignores a started line for a uuid it did not write, and for a malformed one', () => {
    const tracker = new ClaudeTurnStartTracker();
    tracker.commandLifecycle('someone-else', 'started');
    tracker.commandLifecycle(undefined, 'started');
    expect(tracker.turnStarted()).toEqual({ source: 'provider' });
  });

  it('forgets a uuid once it has started, so a repeated started line is not Harness\'s', () => {
    const tracker = new ClaudeTurnStartTracker();
    const uuid = tracker.claimWrite();
    tracker.commandLifecycle(uuid, 'started');
    tracker.turnStarted();
    tracker.commandLifecycle(uuid, 'started');
    expect(tracker.turnStarted()).toEqual({ source: 'provider' });
  });

  it('forgets a failed write, a result, a completed line and a process exit', () => {
    const failed = new ClaudeTurnStartTracker();
    const lost = failed.claimWrite();
    failed.releaseWrite(lost);
    failed.commandLifecycle(lost, 'started');
    expect(failed.turnStarted()).toEqual({ source: 'provider' });

    const ended = new ClaudeTurnStartTracker();
    ended.commandLifecycle(ended.claimWrite(), 'started'); // started with no init of its own
    ended.turnEnded();
    expect(ended.turnStarted()).toEqual({ source: 'provider' });

    const completed = new ClaudeTurnStartTracker();
    const done = completed.claimWrite();
    completed.commandLifecycle(done, 'started');
    completed.commandLifecycle(done, 'completed');
    expect(completed.turnStarted()).toEqual({ source: 'provider' });

    const exited = new ClaudeTurnStartTracker();
    const before = exited.claimWrite();
    exited.reset();
    exited.commandLifecycle(before, 'started');
    expect(exited.turnStarted()).toEqual({ source: 'provider' });
  });
});
