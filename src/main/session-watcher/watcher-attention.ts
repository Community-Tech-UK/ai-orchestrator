import type { SessionWatcher, WatcherFlag } from './session-watcher';

type FlagsListener = (flags: WatcherFlag[]) => void;

/**
 * The sessions the watcher has handed back to the user, one flag per session, kept for the renderer. Fed by the
 * watcher's `flag` and `clear` events; every change sends the whole list, so the renderer never has to merge.
 */
export class WatcherAttention {
  private static instance: WatcherAttention | null = null;
  private readonly flags = new Map<string, WatcherFlag>();
  private listener: FlagsListener | null = null;
  private detachWatcher: (() => void) | null = null;

  static getInstance(): WatcherAttention {
    WatcherAttention.instance ??= new WatcherAttention();
    return WatcherAttention.instance;
  }

  static _resetForTesting(): void {
    WatcherAttention.instance?.detach();
    WatcherAttention.instance = null;
  }

  /** Follows this watcher and calls `onChange` with the full list after every change. A second attach replaces the first. */
  attach(watcher: SessionWatcher, onChange: FlagsListener): void {
    this.detach();
    this.listener = onChange;
    const onFlag = (flag: WatcherFlag): void => { this.flags.set(flag.instanceId, flag); this.changed(); };
    const onClear = (instanceId: string): void => this.clear(instanceId);
    watcher.on('flag', onFlag);
    watcher.on('clear', onClear);
    this.detachWatcher = () => { watcher.off('flag', onFlag); watcher.off('clear', onClear); };
  }

  detach(): void {
    this.detachWatcher?.();
    this.detachWatcher = null;
    this.listener = null;
    this.flags.clear();
  }

  list(): WatcherFlag[] {
    return [...this.flags.values()].sort((a, b) => a.since - b.since || a.instanceId.localeCompare(b.instanceId));
  }

  get(instanceId: string): WatcherFlag | undefined {
    return this.flags.get(instanceId);
  }

  /** Drops this session's flag, if it has one. */
  clear(instanceId: string): void {
    if (this.flags.delete(instanceId)) this.changed();
  }

  private changed(): void {
    this.listener?.(this.list());
  }
}

export function getWatcherAttention(): WatcherAttention {
  return WatcherAttention.getInstance();
}
