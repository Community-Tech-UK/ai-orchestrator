import { app } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { getLogger } from '../logging/logger';
import { getSessionRecallService } from '../session/session-recall-service';
import { resolveLifecycleTraceFilePath } from '../observability/lifecycle-trace';
import type {
  OperatorArtifactBundleManifest,
  OperatorArtifactExportRequest,
  OperatorArtifactExportResult,
} from '../../shared/types/diagnostics.types';
import { getDoctorService } from './doctor-service';
import { redactValue } from './redaction';
import { createStoredZip, type ZipEntryInput } from './zip-writer';

const logger = getLogger('OperatorArtifactExporter');
const LIFECYCLE_TAIL_LINE_LIMIT = 500;

interface BundleEntry {
  name: string;
  content: string;
  source: string;
  redacted: boolean;
  redactSessionBodies?: boolean;
}

interface SessionDiagnosticsProvider {
  getSessionDiagnostics?: (sessionId: string) => Promise<unknown>;
}

export class OperatorArtifactExporter {
  private static instance: OperatorArtifactExporter | null = null;

  static getInstance(): OperatorArtifactExporter {
    if (!this.instance) {
      this.instance = new OperatorArtifactExporter();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  async export(req: OperatorArtifactExportRequest = {}): Promise<OperatorArtifactExportResult> {
    const doctorReport = await getDoctorService().getReport({
      workingDirectory: req.workingDirectory,
      force: req.force,
    });
    const entries: BundleEntry[] = [
      {
        name: 'startup-report.json',
        content: stringify(doctorReport.startupCapabilities),
        source: 'CapabilityProbe report',
        redacted: true,
      },
      {
        name: 'provider-diagnoses.json',
        content: stringify(doctorReport.providerDiagnoses),
        source: 'ProviderDoctor diagnoses',
        redacted: true,
      },
      {
        name: 'cli-health.json',
        content: stringify(doctorReport.cliHealth),
        source: 'CliDetectionService and CliUpdateService',
        redacted: true,
      },
      {
        name: 'browser-automation.json',
        content: stringify(doctorReport.browserAutomation),
        source: 'BrowserAutomationHealthService',
        redacted: true,
      },
      {
        name: 'skill-diagnostics.json',
        content: stringify(doctorReport.skillDiagnostics),
        source: 'SkillDiagnosticsService output',
        redacted: true,
      },
      {
        name: 'instruction-diagnostics.json',
        content: stringify(doctorReport.instructionDiagnostics),
        source: 'InstructionDiagnosticsService output',
        redacted: true,
      },
      {
        name: 'doctor-report.json',
        content: stringify(doctorReport),
        source: 'DoctorService composed report',
        redacted: true,
      },
    ];

    if (doctorReport.commandDiagnostics.available) {
      entries.push({
        name: 'command-diagnostics.json',
        content: stringify(doctorReport.commandDiagnostics),
        source: 'CommandManager registry snapshot diagnostics',
        redacted: true,
      });
    }

    entries.push({
      name: 'lifecycle-tail.ndjson',
      content: await this.readLifecycleTail(),
      source: 'lifecycle trace tail',
      redacted: true,
    });

    if (req.sessionId) {
      entries.push({
        name: 'selected-session-diagnostics.json',
        content: stringify(await this.collectSessionDiagnostics(req.sessionId)),
        source: 'SessionRecallService selected-session diagnostics',
        redacted: true,
        redactSessionBodies: true,
      });
    }

    const redactedEntries = entries.map((entry) => ({
      ...entry,
      content: entry.name.endsWith('.json')
        ? stringify(redactValue(JSON.parse(entry.content) as unknown, {
            redactSessionBodies: entry.redactSessionBodies,
          }))
        : redactValue(entry.content, {}),
    }));

    const manifest = this.buildManifest(redactedEntries, req);
    const manifestContent = stringify(manifest);
    const zipEntries: ZipEntryInput[] = [
      ...redactedEntries.map((entry) => ({
        name: entry.name,
        content: entry.content,
      })),
      {
        name: 'manifest.json',
        content: manifestContent,
      },
    ];

    const zip = createStoredZip(zipEntries);
    const bundlePath = await this.writeBundle(zip);

    return {
      bundlePath,
      bundleBytes: zip.byteLength,
      manifest,
    };
  }

  private buildManifest(
    entries: BundleEntry[],
    req: OperatorArtifactExportRequest,
  ): OperatorArtifactBundleManifest {
    const files = entries.map((entry) => {
      const buffer = Buffer.from(entry.content, 'utf-8');
      return {
        name: entry.name,
        bytes: buffer.byteLength,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        source: entry.source,
        redacted: entry.redacted,
      };
    });

    files.push({
      name: 'manifest.json',
      bytes: 0,
      sha256: 'self-described',
      source: 'OperatorArtifactExporter manifest',
      redacted: false,
    });

    return {
      schemaVersion: 1,
      generatedAt: Date.now(),
      appVersion: this.getAppVersion(),
      platform: process.platform,
      selectedSessionId: req.sessionId,
      workingDirectory: req.workingDirectory ? homeRelative(req.workingDirectory) : undefined,
      files,
      redactionPolicy: {
        homePaths: 'home-relative',
        secrets: 'redacted',
        environmentVariables: 'presence-only',
        sessionMessageBodies: 'omitted',
      },
    };
  }

  private async readLifecycleTail(): Promise<string> {
    try {
      const content = await fs.readFile(resolveLifecycleTraceFilePath(), 'utf-8');
      return content
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-LIFECYCLE_TAIL_LINE_LIMIT)
        .map((line) => redactValue(line, {}))
        .join('\n');
    } catch {
      return '';
    }
  }

  private async collectSessionDiagnostics(sessionId: string): Promise<unknown> {
    try {
      const recall = getSessionRecallService() as SessionDiagnosticsProvider;
      if (typeof recall.getSessionDiagnostics === 'function') {
        return await recall.getSessionDiagnostics(sessionId);
      }
      return {
        sessionId,
        generatedAt: Date.now(),
        error: 'Session diagnostics provider is unavailable.',
      };
    } catch (error) {
      logger.warn('Session diagnostics export failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        sessionId,
        generatedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async writeBundle(zip: Buffer): Promise<string> {
    const dir = path.join(app.getPath('userData'), 'diagnostics-bundles');
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.zip`);
    await fs.writeFile(filePath, zip);
    return filePath;
  }

  private getAppVersion(): string | undefined {
    try {
      return app.getVersion();
    } catch {
      return undefined;
    }
  }
}

function stringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function homeRelative(value: string): string {
  const home = os.homedir();
  return home && value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

export function getOperatorArtifactExporter(): OperatorArtifactExporter {
  return OperatorArtifactExporter.getInstance();
}

export function _resetOperatorArtifactExporterForTesting(): void {
  OperatorArtifactExporter._resetForTesting();
}
