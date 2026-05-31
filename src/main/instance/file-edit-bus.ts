/**
 * Internal file-edit event bus.
 *
 * `instance-communication` already emits a `file.edited` PLUGIN hook (for external
 * plugins). This bus is the MAIN-PROCESS counterpart: it lets internal
 * coordinators (e.g. the LSP post-edit feedback loop, backlog #13) react to agent
 * file edits without coupling to the plugin manager or to instance-manager. It is
 * a decoupling seam — emitters and subscribers never reference each other.
 */

import { EventEmitter } from 'node:events';

export interface FileEditedEvent {
  instanceId: string;
  filePath: string;
  toolName: string;
  provider: string;
}

class FileEditBus extends EventEmitter {
  emitEdited(event: FileEditedEvent): void {
    this.emit('edited', event);
  }

  /** Subscribe to file-edit events. Returns an unsubscribe fn. */
  onEdited(listener: (event: FileEditedEvent) => void): () => void {
    this.on('edited', listener);
    return () => {
      this.off('edited', listener);
    };
  }
}

let singleton: FileEditBus | null = null;

export function getFileEditBus(): FileEditBus {
  singleton ??= new FileEditBus();
  // Many coordinators may subscribe; avoid the default 10-listener warning.
  singleton.setMaxListeners(50);
  return singleton;
}

export function _resetFileEditBusForTesting(): void {
  singleton = null;
}
