import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';

export class FsWatcherManager extends EventEmitter {
  private watchers: fs.FSWatcher[] = [];
  private timer: NodeJS.Timeout | null = null;

  watch(paths: readonly string[]): void {
    this.close();
    for (const filePath of paths) {
      try {
        this.watchers.push(fs.watch(filePath, () => this.emitDebounced(filePath)));
      } catch {
        // Nonexistent provider config files are common before first write.
      }
    }
  }

  close(): void {
    for (const watcher of this.watchers.splice(0)) {
      watcher.close();
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private emitDebounced(filePath: string): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.emit('change', { filePath });
    }, 150);
  }
}
