import { describe, expect, it } from 'vitest';
import { RemoteNodeAndroidConfigComponent } from './remote-node-android-config.component';
import type { WorkerNodeAndroidAutomationSummary } from '../../../../shared/types/worker-node.types';

describe('RemoteNodeAndroidConfigComponent', () => {
  it('round-trips applied Android automation config from the node summary', () => {
    const component = new RemoteNodeAndroidConfigComponent();
    component.summary = {
      enabled: true,
      sdkPath: 'C:\\Android\\Sdk',
      adbVersion: 'Android Debug Bridge version 1.0.41',
      avds: ['Pixel_7', 'Pixel_8'],
      connectedDevices: [],
      emulatorRunning: false,
      hasMaestro: true,
      defaultAvd: 'Pixel_8',
      headlessEmulator: false,
      maxEmulators: 3,
      allowPhysicalDevices: false,
      injectMaestroMcp: false,
    } as WorkerNodeAndroidAutomationSummary;

    expect((component as unknown as { buildPayload(): unknown }).buildPayload()).toMatchObject({
      enabled: true,
      sdkPath: 'C:\\Android\\Sdk',
      defaultAvd: 'Pixel_8',
      headlessEmulator: false,
      maxEmulators: 3,
      allowPhysicalDevices: false,
      injectMaestroMcp: false,
    });
  });
});
