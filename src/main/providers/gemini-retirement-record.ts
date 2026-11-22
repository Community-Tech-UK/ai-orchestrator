/**
 * Whether Google has told this computer that its Gemini sign-in is retired, so Harness stops choosing Gemini itself.
 *
 * Gemini still looks installed and signed in after Google switched off its personal sign-in, so nothing else stops
 * a parent agent asking for a Gemini helper, or an automatic pick choosing Gemini, when the run is bound to fail.
 * The record starts the first time a Gemini run here shows Google's message, and ends as soon as a Gemini run here
 * replies, which is what happens once Gemini is set up another way (an API key or Vertex AI). The Gemini adapter
 * reports both (`reportGeminiSignInOutcome`); only this computer's main process listens, so a worker computer's own
 * Gemini set-up never changes the record.
 */

import ElectronStore from 'electron-store';
import { setGeminiSignInObserver } from '../cli/adapters/gemini-client-retired';
import { getLogger } from '../logging/logger';
import type { SpawnChildCommand } from '../orchestration/orchestration-protocol.types';

const logger = getLogger('GeminiRetirementRecord');

interface RecordShape {
  /** When a Gemini run here first showed Google's message. Absent while Gemini is not known to be retired. */
  retiredAt?: number;
}

/** The part of electron-store this record uses, so tests can hand it a plain object. */
export interface RetirementStore {
  get(key: 'retiredAt'): number | undefined;
  set(key: 'retiredAt', value: number): void;
  delete(key: 'retiredAt'): void;
}

function memoryStore(): RetirementStore {
  let retiredAt: number | undefined;
  return {
    get: () => retiredAt,
    set: (_key, value) => { retiredAt = value; },
    delete: () => { retiredAt = undefined; },
  };
}

export class GeminiRetirementRecord {
  private static instance: GeminiRetirementRecord | null = null;
  private retiredAt: number | undefined;

  static getInstance(): GeminiRetirementRecord {
    this.instance ??= new GeminiRetirementRecord(process.versions.electron
      ? new ElectronStore<RecordShape>({ name: 'gemini-retirement' }) as unknown as RetirementStore
      // Outside Electron (tests and scripts) there is no app data folder, so the record lives only in memory.
      : memoryStore());
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  constructor(private readonly store: RetirementStore) {
    const saved = store.get('retiredAt');
    this.retiredAt = typeof saved === 'number' && Number.isFinite(saved) ? saved : undefined;
  }

  isRetired(): boolean {
    return this.retiredAt !== undefined;
  }

  recordRetired(at = Date.now()): void {
    if (this.retiredAt !== undefined) return;
    this.retiredAt = at;
    this.store.set('retiredAt', at);
    logger.info('Gemini sign-in reported retired; Harness will stop choosing Gemini on this computer');
  }

  recordReplied(): void {
    if (this.retiredAt === undefined) return;
    this.retiredAt = undefined;
    this.store.delete('retiredAt');
    logger.info('A Gemini run replied; Harness may choose Gemini again on this computer');
  }
}

export function getGeminiRetirementRecord(): GeminiRetirementRecord {
  return GeminiRetirementRecord.getInstance();
}

/**
 * Keep the record from what Gemini runs on this computer report. Called once at startup. A record that cannot be
 * saved is logged and skipped: it must never stop the run's own error or reply reaching the person.
 */
export function observeGeminiSignIn(): void {
  setGeminiSignInObserver((outcome) => {
    try {
      const record = getGeminiRetirementRecord();
      if (outcome === 'retired') record.recordRetired();
      else record.recordReplied();
    } catch (error) {
      logger.warn('Could not update the Gemini sign-in record', {
        outcome, error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

/**
 * Whether a provider Harness is about to choose by itself can be chosen: anything but Gemini once Google has
 * retired the sign-in here. The record is read only for Gemini, so other choices never touch its saved file.
 */
export function canChooseProviderHere(provider: string): boolean {
  return provider !== 'gemini' || !getGeminiRetirementRecord().isRetired();
}

/**
 * Why a helper asked for on Gemini is refused, in words the parent agent can act on, or `undefined` to let it start.
 * A helper on a worker computer (named, or inherited from a parent running there) is never refused: that computer has
 * its own Gemini set-up. The record is read only for a Gemini request, so other helpers never touch its saved file.
 */
export function geminiHelperRefusal(
  command: Pick<SpawnChildCommand, 'provider' | 'node'>,
  parent: { executionLocation?: { type: string } },
): string | undefined {
  if (command.node || parent.executionLocation?.type === 'remote') return undefined;
  if (command.provider === undefined || canChooseProviderHere(command.provider)) return undefined;
  return 'Google has retired Gemini for personal Google accounts, so Gemini helpers fail on this computer. '
    + 'Use provider "antigravity" for a Google model, or another provider.';
}
