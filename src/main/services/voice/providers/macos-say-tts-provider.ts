import type { VoiceProviderStatus, VoiceTtsResult } from '@contracts/schemas/voice';
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  VoiceServiceError,
  type VoiceTtsInput,
  type VoiceTtsProvider,
} from './types';

interface MacosSayTtsProviderDeps {
  platform?: NodeJS.Platform;
  sayPath?: string;
  afconvertPath?: string;
  exists?: (path: string) => boolean;
  spawnProcess?: typeof spawn;
  makeTempDir?: typeof mkdtemp;
  readFile?: typeof readFile;
  removePath?: typeof rm;
  tempRoot?: () => string;
}

const OPENAI_VOICES = new Set([
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
]);

export class MacosSayTtsProvider implements VoiceTtsProvider {
  readonly id = 'local-macos-say' as const;
  private readonly platform: NodeJS.Platform;
  private readonly sayPath: string;
  private readonly afconvertPath: string;
  private readonly exists: (path: string) => boolean;
  private readonly spawnProcess: typeof spawn;
  private readonly makeTempDir: typeof mkdtemp;
  private readonly readOutputFile: typeof readFile;
  private readonly removePath: typeof rm;
  private readonly tempRoot: () => string;
  private readonly activeChildren = new Map<string, ChildProcess>();

  constructor(deps: MacosSayTtsProviderDeps = {}) {
    this.platform = deps.platform ?? process.platform;
    this.sayPath = deps.sayPath ?? '/usr/bin/say';
    this.afconvertPath = deps.afconvertPath ?? '/usr/bin/afconvert';
    this.exists = deps.exists ?? existsSync;
    this.spawnProcess = deps.spawnProcess ?? spawn;
    this.makeTempDir = deps.makeTempDir ?? mkdtemp;
    this.readOutputFile = deps.readFile ?? readFile;
    this.removePath = deps.removePath ?? rm;
    this.tempRoot = deps.tempRoot ?? tmpdir;
  }

  getStatus(): VoiceProviderStatus {
    const unsupported = this.platform !== 'darwin';
    const missingSay = !this.exists(this.sayPath);
    const missingAfconvert = !this.exists(this.afconvertPath);
    const available = !unsupported && !missingSay && !missingAfconvert;

    return {
      id: this.id,
      label: 'macOS Local Voice',
      source: 'local',
      capabilities: ['tts'],
      available,
      configured: available,
      active: false,
      privacy: 'local',
      ...(available
        ? {}
        : {
            reason: this.unavailableReason(unsupported, missingSay, missingAfconvert),
            requiresSetup: 'Use macOS local voice support or configure another TTS provider.',
          }),
    };
  }

  async synthesize(input: VoiceTtsInput): Promise<VoiceTtsResult> {
    const status = this.getStatus();
    if (!status.available) {
      throw new VoiceServiceError(
        'local-voice-unavailable',
        status.reason ?? 'Local macOS voice is unavailable.'
      );
    }

    const dir = await this.makeTempDir(join(this.tempRoot(), 'ai-orchestrator-voice-'));
    const aiffPath = join(dir, `${input.requestId}.aiff`);
    const wavPath = join(dir, `${input.requestId}.wav`);
    try {
      await this.runProcess(this.sayPath, this.sayArgs(input, aiffPath), input.requestId);
      await this.runProcess(
        this.afconvertPath,
        [aiffPath, wavPath, '-f', 'WAVE', '-d', 'LEI16@24000'],
        input.requestId
      );
      const audio = await this.readOutputFile(wavPath);
      return {
        requestId: input.requestId,
        audioBase64: Buffer.from(audio).toString('base64'),
        mimeType: 'audio/wav',
        format: 'wav',
        providerId: this.id,
        local: true,
      };
    } finally {
      this.activeChildren.delete(input.requestId);
      await this.removePath(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  cancel(requestId: string): boolean {
    const child = this.activeChildren.get(requestId);
    if (!child) return false;
    child.kill('SIGTERM');
    this.activeChildren.delete(requestId);
    return true;
  }

  destroy(): void {
    for (const child of this.activeChildren.values()) {
      child.kill('SIGTERM');
    }
    this.activeChildren.clear();
  }

  private sayArgs(input: VoiceTtsInput, outputPath: string): string[] {
    const args = ['-o', outputPath];
    const systemVoice = this.systemVoice(input.voice);
    if (systemVoice) {
      args.push('-v', systemVoice);
    }
    args.push(input.input);
    return args;
  }

  private systemVoice(voice: string): string | undefined {
    const trimmed = voice.trim();
    if (!trimmed || OPENAI_VOICES.has(trimmed.toLowerCase())) return undefined;
    return trimmed;
  }

  private runProcess(command: string, args: string[], requestId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(command, args, { stdio: 'ignore' });
      this.activeChildren.set(requestId, child);

      child.once('error', (error) => {
        if (this.activeChildren.get(requestId) === child) {
          this.activeChildren.delete(requestId);
        }
        reject(error);
      });

      child.once('exit', (code, signal) => {
        if (this.activeChildren.get(requestId) === child) {
          this.activeChildren.delete(requestId);
        }
        if (code === 0) {
          resolve();
          return;
        }
        if (signal) {
          reject(new VoiceServiceError('VOICE_TTS_CANCELLED', 'Speech request was cancelled.'));
          return;
        }
        reject(new VoiceServiceError(
          'local-voice-unavailable',
          `Local voice command failed (${command}, exit ${code ?? 'unknown'}).`
        ));
      });
    });
  }

  private unavailableReason(
    unsupported: boolean,
    missingSay: boolean,
    missingAfconvert: boolean
  ): string {
    if (unsupported) {
      return 'macOS local voice requires macOS.';
    }
    if (missingSay && missingAfconvert) {
      return 'macOS local voice tools /usr/bin/say and /usr/bin/afconvert are missing.';
    }
    if (missingSay) {
      return 'macOS local voice tool /usr/bin/say is missing.';
    }
    return 'macOS audio conversion tool /usr/bin/afconvert is missing.';
  }
}
