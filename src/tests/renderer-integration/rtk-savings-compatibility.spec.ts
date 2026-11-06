import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { IpcRenderer } from 'electron';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels';
import type { IpcResponse } from '../../shared/types/ipc.types';
import { initSqliteWasm, createSqliteWasmDatabase } from '../../main/db/sqlite-wasm-driver';
import { RtkTrackingReader } from '../../main/cli/rtk/rtk-tracking-reader';
import { registerRtkHandlers } from '../../main/ipc/handlers/rtk-handlers';
import { createRtkDomain } from '../../preload/domains/rtk.preload';
import { RtkSavingsTabComponent } from '../../renderer/app/features/settings/rtk-savings-tab.component';
import { ElectronIpcService } from '../../renderer/app/core/services/ipc/electron-ipc.service';
import { SettingsStore } from '../../renderer/app/core/state/settings.store';

const state = vi.hoisted(() => ({ reader: null as RtkTrackingReader | null,
  handlers: new Map<string, (event: unknown, payload: unknown) => Promise<IpcResponse>>() }));
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: never) => state.handlers.set(channel, handler) } }));
// The handlers dispatch through the worker-backed tracking client; replace
// only that thread seam (this fixture supplies no electron.app). The stub
// worker answers exactly what rtk-tracking-worker.ts computes, so the real
// client, the real reader and the fixture SQLite DB stay on the boundary.
vi.mock('../../main/cli/rtk/rtk-tracking-client', async importOriginal => {
  const actual = await importOriginal<typeof import('../../main/cli/rtk/rtk-tracking-client')>();
  return {
    ...actual,
    getRtkTrackingClient: () => new actual.RtkTrackingClient(() => {
      const handlers = new Map<string, (payload: unknown) => void>();
      return {
        on(event: string, handler: (payload: unknown) => void) { handlers.set(event, handler); return this; },
        postMessage(message: { id: number; method: 'summary' | 'history'; options: never }) {
          try {
            const reader = state.reader;
            if (!reader) throw new Error('fixture tracking reader missing');
            const result = message.method === 'summary'
              ? (() => {
                  const summary = reader.getSummary(message.options);
                  return summary ? { ...summary, projectBursts: reader.getProjectBursts() } : null;
                })()
              : reader.getRecentHistory(message.options);
            handlers.get('message')?.({ id: message.id, result });
          } catch (error) {
            handlers.get('message')?.({ id: message.id, error: error instanceof Error ? error.message : String(error) });
          }
        },
        ref: vi.fn(), unref: vi.fn(), terminate: () => Promise.resolve(0),
      } as unknown as import('node:worker_threads').Worker;
    }),
  };
});
vi.mock('../../main/cli/rtk/rtk-runtime', () => ({ getRtkRuntime: () => ({
  isAvailable: () => false, binarySource: () => 'none', version: () => null,
}) }));
vi.mock('../../main/core/config/settings-manager', () => ({ getSettingsManager: () => ({ get: () => false }) }));
vi.mock('../../main/ipc/rtk-trial-info', () => ({ readRtkTrialInfo: async () => null }));
vi.mock('../../main/core/system/cost-attribution', () => ({ getCostAttributionFilePath: () => null }));
vi.mock('../../main/logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

await initSqliteWasm();
await resolveComponentResources(url => url.endsWith('.scss') ? Promise.resolve('') : Promise.reject(new Error(url)));

describe('RTK tracking DB through IPC, preload, service and Savings template', () => {
  it('retains raw compatibility data while rendering only capped shortened-output savings', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rtk-savings-render-'));
    const dbPath = join(root, 'tracking.db'); writeFileSync(dbPath, 'fixture');
    const db = createSqliteWasmDatabase(':memory:');
    try {
      db.exec(`CREATE TABLE commands (timestamp TEXT, original_cmd TEXT, rtk_cmd TEXT,
        input_tokens INTEGER, output_tokens INTEGER, saved_tokens INTEGER, savings_pct REAL)`);
      const insert = db.prepare('INSERT INTO commands VALUES (?,?,?,?,?,?,?)');
      for (const [command, input, output] of [
        ['rtk git log', 50000, 10], ['rtk proxy cargo test', 40000, 10],
        ['rtk fallback npm test', 40000, 10], ['rtk git status', 10, 20],
      ] as const) insert.run(new Date().toISOString(), command, command, input, output, input - output, 100 * (input - output) / input);
      const factory = vi.fn(() => db);
      state.reader = new RtkTrackingReader({ dbPathOverride: dbPath, driverFactory: factory });
      registerRtkHandlers();
      const api = createRtkDomain({ invoke: (channel: string, payload: unknown) => state.handlers.get(channel)!({}, payload) } as unknown as IpcRenderer, IPC_CHANNELS);
      const raw = await api.rtkGetSummary({});
      expect(raw.success).toBe(true);
      expect(raw.data).toMatchObject({ savedTokensCapped: 7500, commandsRanInFull: 2,
        byCommand: expect.arrayContaining([expect.objectContaining({ saved: 49990 }), expect.objectContaining({ saved: 39990 })]) });
      TestBed.configureTestingModule({ providers: [
        { provide: ElectronIpcService, useValue: { getApi: () => api } },
        { provide: SettingsStore, useValue: { rtkSettings: () => [], get: () => false, set: vi.fn() } },
      ] });
      const fixture = TestBed.createComponent(RtkSavingsTabComponent);
      fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(fixture.nativeElement.textContent).toContain('7,500');
      });
      const text = fixture.nativeElement.textContent as string;
      expect(fixture.nativeElement.querySelector('.error-banner')?.textContent ?? '').toBe('');
      expect(text.match(/7,500/g)).toHaveLength(2); // Card and program both use the capped population.
      expect(text).not.toContain('49,990');
      expect(text).not.toContain('39,990');
      expect(text).not.toContain('rtk proxy cargo test');
      expect(factory).toHaveBeenCalledWith(dbPath, { readonly: true });
      fixture.destroy();
    } finally {
      TestBed.resetTestingModule(); state.reader?.close(); db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
