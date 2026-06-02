import type { SettingsManager } from '../../core/config/settings-manager';
import {
  getMemoryMonitor,
  type MemoryMonitor,
  type OutputStorageManager,
} from '../../memory';
import type { WarmStartManager } from '../warm-start-manager';
import type { IdleMonitor } from './idle-monitor';
import { getLogger } from '../../logging/logger';

const logger = getLogger('InstanceLifecycle');

type MemoryEventName = 'memory:warning' | 'memory:critical' | 'memory:stats';

interface LifecycleMemoryPressureMonitorDeps {
  settings: Pick<SettingsManager, 'getAll'>;
  outputStorage: Pick<OutputStorageManager, 'getTotalStats'>;
  idleMonitor: Pick<IdleMonitor, 'terminateIdleHalf'>;
  warmStartManager?: Pick<WarmStartManager, 'setEnabled'>;
  memoryMonitor?: MemoryMonitor;
  emit: (eventName: MemoryEventName, stats: unknown) => void;
}

export class LifecycleMemoryPressureMonitor {
  private readonly memoryMonitor: MemoryMonitor;
  private started = false;

  constructor(private readonly deps: LifecycleMemoryPressureMonitorDeps) {
    this.memoryMonitor = deps.memoryMonitor ?? getMemoryMonitor();
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    this.memoryMonitor.on('warning', (stats) => {
      logger.warn('Memory warning', stats as Record<string, unknown>);
      this.deps.emit('memory:warning', stats);
    });

    this.memoryMonitor.on('critical', (stats) => {
      logger.error('Memory critical', undefined, stats as Record<string, unknown>);
      this.deps.emit('memory:critical', stats);

      // Disable warm-start under critical memory pressure to free resources.
      if (this.deps.warmStartManager) {
        logger.info('Disabling warm-start due to critical memory pressure');
        this.deps.warmStartManager.setEnabled(false);
      }

      const settingsAll = this.deps.settings.getAll();
      if (settingsAll.autoTerminateOnMemoryPressure) {
        this.deps.idleMonitor.terminateIdleHalf();
      }
    });

    this.memoryMonitor.on('normal', () => {
      // Re-enable warm-start once pressure returns to normal.
      if (this.deps.warmStartManager) {
        logger.info('Re-enabling warm-start after memory pressure resolved');
        this.deps.warmStartManager.setEnabled(true);
      }
    });

    this.memoryMonitor.on('stats', (stats) => {
      this.deps.emit('memory:stats', stats);
    });

    this.memoryMonitor.start();
  }

  getStats() {
    return {
      process: this.memoryMonitor.getStats(),
      storage: this.deps.outputStorage.getTotalStats(),
      pressureLevel: this.memoryMonitor.getPressureLevel(),
    };
  }

  stop(): void {
    this.memoryMonitor.stop();
  }
}
