import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RtkSavingsTabComponent } from '../../renderer/app/features/settings/rtk-savings-tab.component';
import { RtkIpcService, type RtkSavingsSummary, type RtkStatusData } from '../../renderer/app/core/services/ipc/rtk-ipc.service';
import { ElectronIpcService, type IpcResponse } from '../../renderer/app/core/services/ipc/electron-ipc.service';
import { SettingsStore } from '../../renderer/app/core/state/settings.store';
import { RtkTrackingReader } from '../../main/cli/rtk/rtk-tracking-reader';
import { createSqliteWasmDatabase } from '../../main/db/sqlite-wasm-driver';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

await resolveComponentResources((url) => url.endsWith('.scss')
  ? Promise.resolve('') : Promise.reject(new Error(`Unexpected resource: ${url}`)));

beforeEach(() => {
  TestBed.configureTestingModule({ providers: [
    { provide: SettingsStore, useValue: { rtkSettings: () => [], get: () => true, set: () => undefined } },
  ] });
});
afterEach(() => TestBed.resetTestingModule());

async function render() {
  const fixture = TestBed.createComponent(RtkSavingsTabComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}

describe('RTK shortened-only actual-reader consumer boundary', () => {
  it('renders actual shortened-only SQL through the real renderer IPC service and a fake Electron API', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'rtk-shortened-renderer-'));
    let db: ReturnType<typeof createSqliteWasmDatabase> | undefined;
    let reader: RtkTrackingReader | undefined;
    try {
      const actualDb = createSqliteWasmDatabase(':memory:');
      db = actualDb;
      const dbPath = join(rootDir, 'owned-empty-path');
      writeFileSync(dbPath, '');
      actualDb.exec(`CREATE TABLE commands (timestamp TEXT, original_cmd TEXT, rtk_cmd TEXT,
        input_tokens INTEGER, output_tokens INTEGER, saved_tokens INTEGER, savings_pct REAL, project_path TEXT)`);
      const rows: [string, number, number][] = [
        ['rtk git log', 1000, 100], ['rtk git status', 1000, 1000], ['rtk git diff', 10, 20],
        ['rtk proxy cargo test', 1000, 100], ['rtk fallback cargo build', 1000, 100],
      ];
      for (const [command, input, output] of rows) actualDb.prepare('INSERT INTO commands VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(new Date().toISOString(), command, command, input, output, input - output, 100 * (input - output) / input, '/owned');
      const actualReader = new RtkTrackingReader({ dbPathOverride: dbPath, driverFactory: () => actualDb });
      reader = actualReader;
      expect(actualReader.getSummary()).toMatchObject({ commands: 5, totalSaved: 2690,
        commandsFiltered: 1, commandsRanInFull: 2, weightedReductionPct: 90 });
      const api = {
        rtkGetStatus: async (): Promise<IpcResponse<RtkStatusData>> => ({ success: true, data: {
          enabled: true, available: true, binarySource: 'bundled', version: '0.51.0',
          trackingDbPath: dbPath, trackingDbAvailable: true, coverage: [],
        } }),
        rtkGetSummary: async (opts?: Parameters<RtkTrackingReader['getSummary']>[0]): Promise<IpcResponse<RtkSavingsSummary | null>> =>
          ({ success: true, data: actualReader.getSummary(opts) }),
      };
      TestBed.configureTestingModule({ providers: [{ provide: ElectronIpcService, useValue: { getApi: () => api } }] });
      TestBed.overrideProvider(RtkIpcService, { useFactory: () => new RtkIpcService() });
      const fixture = await render();
      try {
        // Await the real service's async refresh rather than assuming TestBed
        // stability tracks the additional Promise boundaries of the IPC service.
        await fixture.componentInstance.refresh();
        fixture.detectChanges();
        const element: HTMLElement = fixture.nativeElement;
        const cards = Array.from(element.querySelectorAll('.summary-card')).map(card => ({
          label: card.querySelector('.summary-label')?.textContent?.trim(),
          value: card.querySelector('.summary-value')?.textContent?.trim(),
        }));
        expect(cards).toEqual([
          { label: 'Commands made shorter', value: '1' },
          { label: 'Ran in full (not shortened)', value: '2' },
          { label: 'Output tokens saved (estimate)', value: '900' },
          { label: 'Typical reduction on shortened commands', value: '90%' },
        ]);
        const programRows = Array.from(element.querySelectorAll('.rtk-table tbody tr')).map(row =>
          Array.from(row.querySelectorAll('td')).map(cell => cell.textContent?.trim()));
        expect(programRows).toContainEqual(['git', '1', '900']);
        expect(programRows.some(row => row[0] === 'cargo')).toBe(false);
      } finally { fixture.destroy(); }
    } finally {
      reader?.close();
      db?.close();
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

});
