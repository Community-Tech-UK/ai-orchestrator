import type {
  VoiceLocalSttChunkPayload,
  VoiceLocalSttEvent,
  VoiceProviderStatus,
  VoiceTranscriptionSession,
} from '@contracts/schemas/voice';
import { execFile } from 'node:child_process';
import { randomUUID } from 'crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type VoiceSttRoutingMode,
} from '../../../../shared/types/settings.types';
import type {
  WorkerLocalSttCapability,
  WorkerNodeInfo,
} from '../../../../shared/types/worker-node.types';
import {
  type CreateVoiceTranscriptionSessionInput,
  VoiceServiceError,
  type VoiceTranscriptionProvider,
} from './types';

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;
type CommandExistsImpl = (command: string) => boolean;
type ExecFileImpl = (
  file: string,
  args: string[],
  opts?: { timeoutMs?: number }
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
type LocalSttLocation = NonNullable<VoiceProviderStatus['location']>;

const HEALTH_CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 2_000;
const LOCAL_STT_SAMPLE_RATE = 16_000;
const LOCAL_STT_TRANSCRIPTION_TIMEOUT_MS = 30_000;
const DEFAULT_LOCAL_STT_MODEL = 'distil-large-v3';
const AUDIO_TRANSCRIBE_METHOD = 'audio.transcribe';
const DEFAULT_THIS_DEVICE_ENDPOINTS = [
  'http://127.0.0.1:8080',
  'http://127.0.0.1:8000',
];

interface LocalWhisperTranscriptionProviderDeps {
  fetchImpl?: FetchImpl;
  commandExists?: CommandExistsImpl;
  execFile?: ExecFileImpl;
  now?: () => number;
}

interface ThisDeviceHealth {
  healthy: boolean;
  configured: boolean;
  baseUrl?: string;
  models: string[];
  reason?: string;
}

interface HealthCacheEntry {
  checkedAt: number;
  result: ThisDeviceHealth;
}

interface ResolvedLocalBackend {
  available: boolean;
  configured: boolean;
  location?: LocalSttLocation;
  model?: string;
  provider?: WorkerLocalSttCapability['provider'];
  baseUrl?: string;
  workerNodeId?: string;
  reason?: string;
  requiresSetup?: string;
}

function defaultConnectedWorkerNodes(): WorkerNodeInfo[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getWorkerNodeRegistry } = require('../../../remote-node/worker-node-registry') as typeof import('../../../remote-node/worker-node-registry');
    return getWorkerNodeRegistry().getAllNodes().filter((node) => node.status === 'connected');
  } catch {
    return [];
  }
}

async function defaultSendServiceRpc<T>(
  nodeId: string,
  method: string,
  params: unknown,
  timeoutMs: number
): Promise<T> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { sendServiceRpc } = require('../../../remote-node/service-rpc-client') as typeof import('../../../remote-node/service-rpc-client');
    return sendServiceRpc<T>(nodeId, method, params, timeoutMs);
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error('Worker-node STT RPC client is unavailable.');
  }
}

let getConnectedWorkerNodesLazy = defaultConnectedWorkerNodes;
let sendServiceRpcLazy = defaultSendServiceRpc;

export function __setLocalWhisperRemoteHooksForTesting(hooks: {
  connectedWorkerNodes?: () => WorkerNodeInfo[];
  sendServiceRpc?: <T>(
    nodeId: string,
    method: string,
    params: unknown,
    timeoutMs: number
  ) => Promise<T>;
}): void {
  if (hooks.connectedWorkerNodes) {
    getConnectedWorkerNodesLazy = hooks.connectedWorkerNodes;
  }
  if (hooks.sendServiceRpc) {
    sendServiceRpcLazy = hooks.sendServiceRpc;
  }
}

export function __resetLocalWhisperRemoteHooksForTesting(): void {
  getConnectedWorkerNodesLazy = defaultConnectedWorkerNodes;
  sendServiceRpcLazy = defaultSendServiceRpc;
}

export class LocalWhisperTranscriptionProvider implements VoiceTranscriptionProvider {
  readonly id = 'local-whisper' as const;
  private readonly fetchImpl: FetchImpl;
  private readonly commandExists: CommandExistsImpl;
  private readonly execFileImpl: ExecFileImpl;
  private readonly now: () => number;
  private settings: AppSettings = DEFAULT_SETTINGS;
  private thisDeviceCache: HealthCacheEntry | null = null;
  private thisDeviceProbeInFlight: Promise<void> | null = null;
  private probeGeneration = 0;
  private activeSession: {
    sessionId: string;
    backend: ResolvedLocalBackend;
    model: string;
    language: string;
    task: 'transcribe' | 'translate';
  } | null = null;

  constructor(deps: LocalWhisperTranscriptionProviderDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.commandExists = deps.commandExists ?? commandExistsInPath;
    this.execFileImpl = deps.execFile ?? execFileCapture;
    this.now = deps.now ?? (() => Date.now());
  }

  configure(settings: AppSettings): void {
    if (this.didLocalSttSettingsChange(this.settings, settings)) {
      this.thisDeviceCache = null;
      this.thisDeviceProbeInFlight = null;
      this.probeGeneration += 1;
    }
    this.settings = settings;
  }

  async refreshHealth(): Promise<void> {
    if (!this.shouldProbeThisDevice()) return;
    await this.refreshThisDeviceHealth();
  }

  getStatus(): VoiceProviderStatus {
    const backend = this.resolveBackendForMode(this.settings.voiceSttRoutingMode);
    this.kickThisDeviceProbeIfKnownOrExplicit();

    return {
      id: this.id,
      label: 'Local Whisper STT',
      source: 'local',
      capabilities: ['stt'],
      available: backend.available,
      configured: backend.configured,
      active: false,
      privacy: 'local',
      latencyClass: 'near-realtime',
      ...(backend.location ? { location: backend.location } : {}),
      ...(backend.available ? {} : {
        reason: backend.reason ?? 'No local STT backend is available.',
        requiresSetup: backend.requiresSetup ?? 'Start a local STT engine on this device or a connected worker node.',
      }),
    };
  }

  async createSession(
    input: CreateVoiceTranscriptionSessionInput
  ): Promise<VoiceTranscriptionSession> {
    if (this.activeSession) {
      throw new VoiceServiceError(
        'session-unavailable',
        'Another local transcription session is already active.'
      );
    }

    const backend = this.resolveBackendForMode(this.settings.voiceSttRoutingMode);
    if (!backend.available || !backend.model) {
      throw new VoiceServiceError(
        'local-voice-unavailable',
        backend.reason ?? 'No local STT backend is available.'
      );
    }

    const sessionId = randomUUID();
    const language = (input.language ?? this.settings.voiceLocalSttLanguage) || 'en';
    this.activeSession = {
      sessionId,
      backend,
      model: backend.model,
      language,
      task: 'transcribe',
    };
    return {
      transport: 'local-segmented',
      sessionId,
      model: backend.model,
      providerId: this.id,
      sampleRate: LOCAL_STT_SAMPLE_RATE,
      maxSegmentMs: this.settings.voiceLocalSttMaxSegmentMs,
      language,
      task: 'transcribe',
    };
  }

  closeSession(sessionId: string): boolean {
    if (this.activeSession?.sessionId !== sessionId) return false;
    this.activeSession = null;
    return true;
  }

  async pushSegment(
    input: Pick<VoiceLocalSttChunkPayload, 'sessionId' | 'seq' | 'wavBase64' | 'last'>
  ): Promise<VoiceLocalSttEvent> {
    const session = this.activeSession;
    if (!session || session.sessionId !== input.sessionId) {
      throw new VoiceServiceError(
        'local-stt-session-not-found',
        'Local STT segment does not match an active session.'
      );
    }

    if (session.backend.location === 'worker-node') {
      return this.transcribeWorkerSegment(session, input);
    }
    if (session.backend.location === 'this-device' &&
      session.backend.provider === 'openai-compatible') {
      return this.transcribeThisDeviceHttpSegment(session, input);
    }
    if (session.backend.location === 'this-device' &&
      session.backend.provider === 'whisper-cli') {
      return this.transcribeThisDeviceCliSegment(session, input);
    }

    throw new VoiceServiceError(
      'local-stt-backend-unavailable',
      'This local STT session is not backed by a supported local endpoint.'
    );
  }

  private resolveBackendForMode(mode: VoiceSttRoutingMode): ResolvedLocalBackend {
    if (!this.settings.voiceLocalSttEnabled) {
      return {
        available: false,
        configured: false,
        reason: 'Local STT is disabled in settings.',
      };
    }

    if (mode === 'cloud') {
      return {
        available: false,
        configured: false,
        reason: 'Cloud STT routing is selected.',
      };
    }

    if (mode === 'worker-node') return this.resolveWorkerBackend();
    if (mode === 'this-device' || mode === 'this-device-or-cloud') {
      return this.resolveThisDeviceBackend();
    }

    const thisDevice = this.resolveThisDeviceBackend();
    if (thisDevice.available) return thisDevice;
    const worker = this.resolveWorkerBackend();
    if (worker.available) return worker;

    return {
      available: false,
      configured: thisDevice.configured || worker.configured,
      location: thisDevice.configured
        ? thisDevice.location
        : worker.configured
          ? worker.location
          : undefined,
      reason: thisDevice.configured
        ? thisDevice.reason
        : worker.configured
          ? worker.reason
          : 'No healthy local STT backend is available.',
      requiresSetup: 'Start speaches or whisper.cpp locally, or connect a worker node advertising STT.',
    };
  }

  private resolveThisDeviceBackend(): ResolvedLocalBackend {
    const cached = this.thisDeviceCache?.result;
    const configured = Boolean(this.settings.voiceThisDeviceSttEndpointUrl.trim()) ||
      Boolean(cached?.configured);

    if (cached?.healthy) {
      return {
        available: true,
        configured: true,
        location: 'this-device',
        model: this.selectModel(cached.models),
        provider: 'openai-compatible',
        baseUrl: cached.baseUrl,
      };
    }

    const cliBackend = this.resolveThisDeviceCliBackend();
    if (cliBackend) return cliBackend;

    return {
      available: false,
      configured,
      location: 'this-device',
      reason: cached?.reason ?? 'No this-device STT endpoint is healthy yet.',
      requiresSetup: 'Start a local whisper.cpp or speaches OpenAI-compatible STT endpoint.',
    };
  }

  private resolveThisDeviceCliBackend(): ResolvedLocalBackend | null {
    if (!this.commandExists('whisper-cli')) return null;
    return {
      available: true,
      configured: true,
      location: 'this-device',
      model: this.selectModel([]),
      provider: 'whisper-cli',
    };
  }

  private resolveWorkerBackend(): ResolvedLocalBackend {
    const pin = this.settings.voiceLocalSttWorkerNodeId.trim();
    let sawWorkerSttConfig = false;

    for (const node of getConnectedWorkerNodesLazy()) {
      if (pin && node.id !== pin) continue;
      for (const cap of node.capabilities.localSttEndpoints ?? []) {
        sawWorkerSttConfig = true;
        if (!this.isUsableWorkerSttCapability(cap)) continue;
        return {
          available: true,
          configured: true,
          location: 'worker-node',
          model: this.selectModel(cap.models),
          provider: cap.provider,
          baseUrl: cap.baseUrl,
          workerNodeId: node.id,
        };
      }
    }

    if (pin) {
      return {
        available: false,
        configured: true,
        location: 'worker-node',
        reason: `Pinned worker ${pin} is not connected or is not advertising healthy STT.`,
        requiresSetup: 'Start the pinned worker node and its local STT endpoint.',
      };
    }

    return {
      available: false,
      configured: sawWorkerSttConfig,
      location: 'worker-node',
      reason: 'No connected worker node is advertising healthy STT.',
      requiresSetup: 'Start speaches on a worker node and wait for the next heartbeat.',
    };
  }

  private isUsableWorkerSttCapability(cap: WorkerLocalSttCapability): boolean {
    return cap.provider === 'openai-compatible' && cap.healthy;
  }

  private async transcribeWorkerSegment(
    session: NonNullable<LocalWhisperTranscriptionProvider['activeSession']>,
    input: Pick<VoiceLocalSttChunkPayload, 'sessionId' | 'seq' | 'wavBase64' | 'last'>
  ): Promise<VoiceLocalSttEvent> {
    const backend = session.backend;
    if (!backend.workerNodeId || !backend.provider || !backend.baseUrl) {
      throw new VoiceServiceError(
        'local-stt-backend-unavailable',
        'Worker-node STT backend is missing endpoint details.'
      );
    }

    const result = await sendServiceRpcLazy<{ text?: unknown }>(
      backend.workerNodeId,
      AUDIO_TRANSCRIBE_METHOD,
      {
        provider: backend.provider,
        baseUrl: backend.baseUrl,
        model: session.model,
        language: session.language,
        task: session.task,
        audioBase64: input.wavBase64,
        sampleRate: LOCAL_STT_SAMPLE_RATE,
        timeoutMs: LOCAL_STT_TRANSCRIPTION_TIMEOUT_MS,
      },
      LOCAL_STT_TRANSCRIPTION_TIMEOUT_MS + 1_000
    );
    if (typeof result.text !== 'string') {
      throw new VoiceServiceError(
        'local-stt-transcription-failed',
        'Worker-node STT returned an invalid transcript response.'
      );
    }

    return {
      sessionId: input.sessionId,
      kind: 'final',
      text: result.text,
      segmentId: input.seq,
    };
  }

  private async transcribeThisDeviceHttpSegment(
    session: NonNullable<LocalWhisperTranscriptionProvider['activeSession']>,
    input: Pick<VoiceLocalSttChunkPayload, 'sessionId' | 'seq' | 'wavBase64' | 'last'>
  ): Promise<VoiceLocalSttEvent> {
    const baseUrl = session.backend.baseUrl;
    if (!baseUrl) {
      throw new VoiceServiceError(
        'local-stt-backend-unavailable',
        'This-device STT backend is missing endpoint details.'
      );
    }

    const text = await this.postOpenAiCompatibleTranscription(
      baseUrl,
      session,
      input.wavBase64
    );
    return this.finalSegmentEvent(input.sessionId, input.seq, text);
  }

  private async postOpenAiCompatibleTranscription(
    baseUrl: string,
    session: NonNullable<LocalWhisperTranscriptionProvider['activeSession']>,
    wavBase64: string
  ): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOCAL_STT_TRANSCRIPTION_TIMEOUT_MS);
    try {
      const body = new FormData();
      body.append('file', new Blob([Buffer.from(wavBase64, 'base64')], {
        type: 'audio/wav',
      }), 'segment.wav');
      body.append('model', session.model);
      body.append('language', session.language);
      body.append('task', session.task);
      body.append('response_format', 'json');

      const headers = this.thisDeviceHeaders();
      const response = await this.fetchImpl(`${baseUrl}/v1/audio/transcriptions`, {
        method: 'POST',
        ...(headers ? { headers } : {}),
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new VoiceServiceError(
          'local-stt-transcription-failed',
          `This-device STT failed with HTTP ${response.status}.`
        );
      }
      const data = await response.json() as { text?: unknown };
      if (typeof data.text !== 'string') {
        throw new VoiceServiceError(
          'local-stt-transcription-failed',
          'This-device STT returned an invalid transcript response.'
        );
      }
      return data.text;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new VoiceServiceError(
          'local-stt-transcription-timeout',
          `This-device STT timed out after ${LOCAL_STT_TRANSCRIPTION_TIMEOUT_MS}ms.`
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async transcribeThisDeviceCliSegment(
    session: NonNullable<LocalWhisperTranscriptionProvider['activeSession']>,
    input: Pick<VoiceLocalSttChunkPayload, 'sessionId' | 'seq' | 'wavBase64' | 'last'>
  ): Promise<VoiceLocalSttEvent> {
    const tempDir = await mkdtemp(join(tmpdir(), 'aio-local-stt-'));
    const wavPath = join(tempDir, `segment-${input.seq}.wav`);
    const outputPrefix = join(tempDir, 'transcript');
    try {
      await writeFile(wavPath, Buffer.from(input.wavBase64, 'base64'));
      const args = this.whisperCliArgs(session, wavPath, outputPrefix);
      try {
        const result = await this.execFileImpl('whisper-cli', args, {
          timeoutMs: LOCAL_STT_TRANSCRIPTION_TIMEOUT_MS,
        });
        const text = await readWhisperCliTranscript(outputPrefix, result.stdout);
        if (!text) {
          throw new VoiceServiceError(
            'local-stt-transcription-failed',
            'whisper-cli returned an empty transcript.'
          );
        }
        return this.finalSegmentEvent(input.sessionId, input.seq, text);
      } catch (error) {
        if (error instanceof VoiceServiceError) throw error;
        throw new VoiceServiceError(
          'local-stt-transcription-failed',
          `whisper-cli failed: ${errorMessage(error)}`
        );
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private whisperCliArgs(
    session: NonNullable<LocalWhisperTranscriptionProvider['activeSession']>,
    wavPath: string,
    outputPrefix: string
  ): string[] {
    const args = [
      '-f',
      wavPath,
      '-m',
      session.model,
      '-l',
      session.language,
      '-oj',
      '-of',
      outputPrefix,
    ];
    if (session.task === 'translate') args.push('--translate');
    return args;
  }

  private finalSegmentEvent(
    sessionId: string,
    seq: number,
    text: string
  ): VoiceLocalSttEvent {
    return {
      sessionId,
      kind: 'final',
      text,
      segmentId: seq,
    };
  }

  private selectModel(models: string[]): string {
    const pinned = this.settings.voiceLocalSttModel.trim();
    if (pinned) return pinned;
    return models[0] ?? DEFAULT_LOCAL_STT_MODEL;
  }

  private shouldProbeThisDevice(): boolean {
    if (!this.settings.voiceLocalSttEnabled) return false;
    return this.settings.voiceSttRoutingMode === 'auto' ||
      this.settings.voiceSttRoutingMode === 'this-device' ||
      this.settings.voiceSttRoutingMode === 'this-device-or-cloud';
  }

  private kickThisDeviceProbeIfKnownOrExplicit(): void {
    if (!this.shouldProbeThisDevice()) return;
    if (this.isThisDeviceCacheFresh()) return;
    if (!this.thisDeviceCache && !this.settings.voiceThisDeviceSttEndpointUrl.trim()) return;
    void this.refreshThisDeviceHealth().catch(() => undefined);
  }

  private async refreshThisDeviceHealth(): Promise<void> {
    if (this.isThisDeviceCacheFresh()) return;
    if (this.thisDeviceProbeInFlight) {
      await this.thisDeviceProbeInFlight;
      return;
    }

    const generation = this.probeGeneration;
    this.thisDeviceProbeInFlight = this.probeThisDeviceHealth()
      .then((result) => {
        if (this.probeGeneration === generation) {
          this.thisDeviceCache = { checkedAt: this.now(), result };
        }
      })
      .finally(() => {
        if (this.probeGeneration === generation) {
          this.thisDeviceProbeInFlight = null;
        }
      });
    await this.thisDeviceProbeInFlight;
  }

  private isThisDeviceCacheFresh(): boolean {
    return Boolean(
      this.thisDeviceCache &&
      this.now() - this.thisDeviceCache.checkedAt < HEALTH_CACHE_TTL_MS
    );
  }

  private async probeThisDeviceHealth(): Promise<ThisDeviceHealth> {
    const invalidExplicitEndpoint = this.invalidExplicitThisDeviceEndpointReason();
    if (invalidExplicitEndpoint) {
      return {
        healthy: false,
        configured: true,
        models: [],
        reason: invalidExplicitEndpoint,
      };
    }

    const candidates = this.thisDeviceCandidateUrls();
    if (candidates.length === 0) {
      return {
        healthy: false,
        configured: false,
        models: [],
        reason: 'No this-device STT endpoint URL is configured.',
      };
    }

    let lastReason = 'No this-device STT endpoint was detected.';
    for (const baseUrl of candidates) {
      const result = await this.probeOpenAiCompatibleThisDevice(baseUrl);
      if (result.healthy) return result;
      lastReason = result.reason ?? lastReason;
    }

    return {
      healthy: false,
      configured: Boolean(this.settings.voiceThisDeviceSttEndpointUrl.trim()),
      models: [],
      reason: lastReason,
    };
  }

  private thisDeviceCandidateUrls(): string[] {
    const rawExplicit = this.settings.voiceThisDeviceSttEndpointUrl.trim();
    const explicit = normalizeBaseUrl(rawExplicit);
    if (explicit) return [explicit];
    if (rawExplicit) return [];
    return DEFAULT_THIS_DEVICE_ENDPOINTS;
  }

  private invalidExplicitThisDeviceEndpointReason(): string | null {
    const rawExplicit = this.settings.voiceThisDeviceSttEndpointUrl.trim();
    if (!rawExplicit || normalizeBaseUrl(rawExplicit)) return null;
    return 'This-device STT endpoint URL must be a loopback URL such as http://127.0.0.1:8080.';
  }

  private async probeOpenAiCompatibleThisDevice(baseUrl: string): Promise<ThisDeviceHealth> {
    const models = await this.listModelIds(baseUrl);
    if (!models) {
      return {
        healthy: false,
        configured: Boolean(this.settings.voiceThisDeviceSttEndpointUrl.trim()),
        baseUrl,
        models: [],
        reason: 'This-device STT endpoint is unreachable.',
      };
    }

    const hasAudioRoute = await this.hasAudioTranscriptionsRoute(baseUrl);
    if (!hasAudioRoute && !models.some(isLikelySttModelId)) {
      return {
        healthy: false,
        configured: true,
        baseUrl,
        models,
        reason: 'This-device endpoint does not expose an STT endpoint.',
      };
    }

    return {
      healthy: true,
      configured: true,
      baseUrl,
      models,
    };
  }

  private async listModelIds(baseUrl: string): Promise<string[] | null> {
    const response = await this.fetchWithTimeout(`${baseUrl}/v1/models`);
    if (!response?.ok) return null;
    const data = await response.json() as { data?: { id: string }[] };
    return (data.data ?? [])
      .map((model) => model.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  }

  private async hasAudioTranscriptionsRoute(baseUrl: string): Promise<boolean> {
    const response = await this.fetchWithTimeout(`${baseUrl}/v1/audio/transcriptions`);
    if (!response) return false;
    return response.status === 400 || response.status === 401 || response.status === 405;
  }

  private async fetchWithTimeout(url: string): Promise<Response | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      return await this.fetchImpl(url, {
        method: 'GET',
        headers: this.thisDeviceHeaders(),
        signal: controller.signal,
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private thisDeviceHeaders(): RequestInit['headers'] | undefined {
    const envName = this.settings.voiceThisDeviceSttApiKeyEnv.trim();
    if (!envName) return undefined;
    const apiKey = process.env[envName]?.trim();
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
  }

  private didLocalSttSettingsChange(previous: AppSettings, next: AppSettings): boolean {
    return previous.voiceSttRoutingMode !== next.voiceSttRoutingMode ||
      previous.voiceLocalSttEnabled !== next.voiceLocalSttEnabled ||
      previous.voiceLocalSttWorkerNodeId !== next.voiceLocalSttWorkerNodeId ||
      previous.voiceLocalSttModel !== next.voiceLocalSttModel ||
      previous.voiceLocalSttLanguage !== next.voiceLocalSttLanguage ||
      previous.voiceThisDeviceSttEndpointUrl !== next.voiceThisDeviceSttEndpointUrl ||
      previous.voiceThisDeviceSttApiKeyEnv !== next.voiceThisDeviceSttApiKeyEnv;
  }
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return '';
    }
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
      return '';
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function isLikelySttModelId(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return normalized.includes('whisper') ||
    normalized.includes('distil-large-v3') ||
    normalized.includes('transcribe');
}

function commandExistsInPath(command: string): boolean {
  const pathValue = process.env['PATH'] ?? '';
  return pathValue
    .split(delimiter)
    .filter(Boolean)
    .some((pathDir) => existsSync(join(pathDir, command)));
}

function execFileCapture(
  file: string,
  args: string[],
  opts: { timeoutMs?: number } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: opts.timeoutMs,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr, exitCode: 0 });
      }
    );
  });
}

async function readWhisperCliTranscript(
  outputPrefix: string,
  stdout: string
): Promise<string> {
  const outputJson = await readFile(`${outputPrefix}.json`, 'utf8').catch(() => '');
  return extractTranscriptText(outputJson) ?? extractTranscriptText(stdout) ?? stdout.trim();
}

function extractTranscriptText(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return extractTranscriptFromJson(JSON.parse(trimmed));
  } catch {
    return trimmed;
  }
}

function extractTranscriptFromJson(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record['text'] === 'string') return record['text'].trim() || null;
  for (const key of ['transcription', 'segments']) {
    const entries = record[key];
    if (Array.isArray(entries)) {
      const text = entries
        .map((entry) => extractTranscriptFromJson(entry))
        .filter((entry): entry is string => Boolean(entry))
        .join(' ')
        .trim();
      if (text) return text;
    }
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
