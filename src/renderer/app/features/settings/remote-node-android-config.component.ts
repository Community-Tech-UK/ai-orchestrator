import { ChangeDetectionStrategy, Component, effect, signal, input, output } from '@angular/core';
import type { WorkerNodeAndroidAutomationSummary } from '../../../../shared/types/worker-node.types';

export interface AndroidAutomationConfigDraft {
  enabled: boolean;
  sdkPath?: string;
  defaultAvd?: string;
  headlessEmulator: boolean;
  maxEmulators: number;
  allowPhysicalDevices: boolean;
  injectMaestroMcp: boolean;
}

@Component({
  selector: 'app-remote-node-android-config',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="android-config-form">
      <label class="config-row">
        <input
          type="checkbox"
          [checked]="enabled()"
          (change)="enabled.set(!enabled())"
        />
        <span>Enable Android automation on this node</span>
      </label>

      <div class="field-grid">
        <label class="config-field">
          <span class="config-label">Android SDK path</span>
          <input
            type="text"
            class="config-input"
            placeholder="Leave blank to auto-detect ANDROID_HOME / default SDK"
            [value]="sdkPath()"
            (input)="sdkPath.set($any($event.target).value)"
          />
        </label>

        <label class="config-field">
          <span class="config-label">Default emulator AVD</span>
          <input
            type="text"
            class="config-input"
            list="android-avd-list"
            placeholder="Optional; first available AVD if blank"
            [value]="defaultAvd()"
            (input)="defaultAvd.set($any($event.target).value)"
          />
          <datalist id="android-avd-list">
            @for (avd of summary()?.avds ?? []; track avd) {
              <option [value]="avd"></option>
            }
          </datalist>
        </label>

        <label class="config-field compact">
          <span class="config-label">Max emulators</span>
          <input
            type="number"
            class="config-input"
            min="1"
            max="4"
            [value]="maxEmulators()"
            (input)="maxEmulators.set(clampMaxEmulators(+$any($event.target).value))"
          />
        </label>
      </div>

      <div class="switch-grid">
        <label class="config-row">
          <input
            type="checkbox"
            [checked]="headlessEmulator()"
            (change)="headlessEmulator.set(!headlessEmulator())"
          />
          <span>Run managed emulators headless</span>
        </label>

        <label class="config-row">
          <input
            type="checkbox"
            [checked]="allowPhysicalDevices()"
            (change)="allowPhysicalDevices.set(!allowPhysicalDevices())"
          />
          <span>Allow USB/Wi-Fi physical devices</span>
        </label>

        <label class="config-row">
          <input
            type="checkbox"
            [checked]="injectMaestroMcp()"
            (change)="injectMaestroMcp.set(!injectMaestroMcp())"
          />
          <span>Expose Maestro when installed</span>
        </label>
      </div>

      <div class="android-summary">
        <span>SDK: {{ summary()?.sdkPath || 'not detected yet' }}</span>
        <span>ADB: {{ summary()?.adbVersion || 'unavailable' }}</span>
        <span>AVDs: {{ summary()?.avds?.length ?? 0 }}</span>
        <span>Devices: {{ summary()?.connectedDevices?.length ?? 0 }}</span>
        <span>Maestro: {{ summary()?.hasMaestro ? 'yes' : 'no' }}</span>
      </div>

      @if ((summary()?.connectedDevices?.length ?? 0) > 0) {
        <div class="device-list">
          @for (device of summary()?.connectedDevices ?? []; track device.serial) {
            <span class="device-pill">
              {{ device.serial }} · {{ device.kind }} · {{ device.state }}
            </span>
          }
        </div>
      }

      <p class="warning">
        Android automation leases one device per agent and injects mobile-mcp with
        ANDROID_SERIAL locked to that lease. Enable it only on trusted worker
        nodes where the Android SDK and emulator images are operator-managed.
      </p>

      <div class="actions">
        <button
          class="btn btn-primary small"
          type="button"
          [disabled]="busy()"
          (click)="applyRequested.emit(buildPayload())"
        >
          {{ busy() ? 'Applying...' : 'Apply' }}
        </button>
        <button
          class="btn btn-secondary small"
          type="button"
          [disabled]="busy()"
          (click)="cancelRequested.emit()"
        >
          Cancel
        </button>
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
    }

    .android-config-form {
      margin-top: 0.75rem;
      padding: 0.75rem;
      border: 1px solid var(--border-color);
      border-radius: 0.5rem;
      background: var(--bg-secondary, var(--bg-primary));
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
    }

    .field-grid,
    .switch-grid,
    .android-summary,
    .device-list,
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .field-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    }

    .config-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.85rem;
      color: var(--text-primary);
      cursor: pointer;
    }

    .config-field {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .config-field.compact {
      max-width: 8rem;
    }

    .config-label {
      font-size: 0.8rem;
      color: var(--text-secondary, #888);
    }

    .config-input {
      width: 100%;
      padding: 0.4rem 0.55rem;
      border: 1px solid var(--border-color);
      border-radius: 0.4rem;
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: 0.8rem;
      box-sizing: border-box;
    }

    .android-summary,
    .device-pill {
      color: var(--text-muted);
      font-size: 0.75rem;
    }

    .device-pill {
      border: 1px solid var(--border-color);
      border-radius: 999px;
      padding: 0.18rem 0.5rem;
      background: var(--bg-primary);
      color: var(--text-primary);
    }

    .warning {
      margin: 0;
      color: var(--text-muted);
      font-size: 0.75rem;
      line-height: 1.45;
    }
  `],
})
export class RemoteNodeAndroidConfigComponent {
  readonly busy = input(false);
  readonly enabledFallback = input(false);
  readonly summary = input<WorkerNodeAndroidAutomationSummary | undefined>();

  readonly applyRequested = output<AndroidAutomationConfigDraft>();
  readonly cancelRequested = output<void>();

  protected readonly enabled = signal(false);
  protected readonly sdkPath = signal('');
  protected readonly defaultAvd = signal('');
  protected readonly headlessEmulator = signal(true);
  protected readonly maxEmulators = signal(1);
  protected readonly allowPhysicalDevices = signal(true);
  protected readonly injectMaestroMcp = signal(false);

  constructor() {
    effect(() => {
      this.summary();
      this.enabledFallback();
      this.resetDraft();
    });
  }

  protected clampMaxEmulators(value: number): number {
    if (!Number.isFinite(value)) {
      return 1;
    }
    return Math.max(1, Math.min(4, Math.trunc(value)));
  }

  protected buildPayload(): AndroidAutomationConfigDraft {
    const sdkPath = this.sdkPath().trim();
    const defaultAvd = this.defaultAvd().trim();
    return {
      enabled: this.enabled(),
      headlessEmulator: this.headlessEmulator(),
      maxEmulators: this.maxEmulators(),
      allowPhysicalDevices: this.allowPhysicalDevices(),
      injectMaestroMcp: this.injectMaestroMcp(),
      ...(sdkPath ? { sdkPath } : {}),
      ...(defaultAvd ? { defaultAvd } : {}),
    };
  }

  private resetDraft(): void {
    const summary = this.summary();
    this.enabled.set(summary?.enabled ?? this.enabledFallback());
    this.sdkPath.set(summary?.sdkPath ?? '');
    this.defaultAvd.set(summary?.defaultAvd ?? summary?.avds[0] ?? '');
    this.headlessEmulator.set(summary?.headlessEmulator ?? true);
    this.maxEmulators.set(summary?.maxEmulators ?? 1);
    this.allowPhysicalDevices.set(summary?.allowPhysicalDevices ?? true);
    this.injectMaestroMcp.set(summary?.injectMaestroMcp ?? false);
  }
}
