import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { installFatalTrapSignalGuard } from './fatal-trap-signal-guard';

function createTarget() {
  const target = new EventEmitter();
  const deferred: (() => void)[] = [];
  const flush = () => {
    for (const callback of deferred.splice(0)) callback();
  };
  return { target, flush, defer: (callback: () => void) => deferred.push(callback) };
}

describe('installFatalTrapSignalGuard', () => {
  it('removes SIGTRAP listeners registered before it was installed', () => {
    const { target, defer } = createTarget();
    target.on('SIGTRAP', () => undefined);
    target.once('SIGTRAP', () => undefined);

    installFatalTrapSignalGuard({ target, defer });

    expect(target.listenerCount('SIGTRAP')).toBe(0);
  });

  it('removes SIGTRAP listeners registered later, including once() wrappers', () => {
    const { target, defer, flush } = createTarget();
    installFatalTrapSignalGuard({ target, defer });

    // The shape when-exit uses at import time.
    target.once('SIGTRAP', () => undefined);
    target.on('SIGTRAP', () => undefined);
    expect(target.listenerCount('SIGTRAP')).toBe(2);

    flush();

    expect(target.listenerCount('SIGTRAP')).toBe(0);
  });

  it('leaves every other signal listener alone', () => {
    const { target, defer, flush } = createTarget();
    const onTerm = () => undefined;
    target.on('SIGTERM', onTerm);

    installFatalTrapSignalGuard({ target, defer });
    target.once('SIGABRT', () => undefined);
    target.on('SIGTRAP', () => undefined);
    flush();

    expect(target.listeners('SIGTERM')).toEqual([onTerm]);
    expect(target.listenerCount('SIGABRT')).toBe(1);
    expect(target.listenerCount('SIGTRAP')).toBe(0);
  });

  it('installs one newListener hook per target however often it is called', () => {
    const { target, defer } = createTarget();

    installFatalTrapSignalGuard({ target, defer });
    installFatalTrapSignalGuard({ target, defer });

    expect(target.listenerCount('newListener')).toBe(1);
  });

  it('defers removal to process.nextTick by default, after the registering call returns', async () => {
    const target = new EventEmitter();
    installFatalTrapSignalGuard({ target });

    target.on('SIGTRAP', () => undefined);
    expect(target.listenerCount('SIGTRAP')).toBe(1);

    await new Promise<void>((resolve) => process.nextTick(resolve));
    expect(target.listenerCount('SIGTRAP')).toBe(0);
  });
});
