import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as tls from 'node:tls';
import * as readline from 'node:readline/promises';
import { DEFAULT_CONFIG_PATH } from '../worker-config';
import {
  buildCoordinatorUrl,
  parsePairingConfigInput,
  sanitizePairingErrorMessage,
  writePairedWorkerConfig,
  type ParsedPairingConfig,
} from './pairing-config';

export interface PairCommandResult {
  exitCode: number;
  startWorker: boolean;
  configPath: string;
}

export interface PairCommandDeps {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  probeCoordinator?: (coordinatorUrl: string) => Promise<void>;
  stdin?: NodeJS.ReadableStream;
  isInteractive?: boolean;
  prompt?: (question: string) => Promise<string>;
}

interface ParsedPairArgs {
  input?: string;
  configPath: string;
  name?: string;
  workingDirectories: string[];
  probe: boolean;
  startWorker: boolean;
}

export async function runPairCommand(
  argv: string[],
  deps: PairCommandDeps = {},
): Promise<PairCommandResult> {
  const options = parsePairCommandArgs(argv);
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const input = options.input ?? await promptForPairingInput(deps);
  const parsed = await parseInputWithCredentialPrompt(input, deps);
  const prompted = await promptForPairingDetails(parsed, options, deps);
  const merged: ParsedPairingConfig = {
    ...prompted,
    ...(options.name ? { name: options.name } : {}),
    workingDirectories: options.workingDirectories.length > 0
      ? options.workingDirectories
      : prompted.workingDirectories,
  };

  if (options.probe) {
    await (deps.probeCoordinator ?? probeCoordinatorReachability)(merged.coordinatorUrl);
  }

  const config = writePairedWorkerConfig(options.configPath, merged);
  const coordinator = safeCoordinatorDisplay(config.coordinatorUrl);
  stdout(`Paired ${config.name} with ${coordinator}.\n`);
  if (options.startWorker) {
    stdout('Worker starting under supervision.\n');
  } else {
    stderr('Worker config written. Start it with aio-worker --supervise.\n');
  }

  return {
    exitCode: 0,
    startWorker: options.startWorker,
    configPath: options.configPath,
  };
}

export function parsePairCommandArgs(argv: string[]): ParsedPairArgs {
  const result: ParsedPairArgs = {
    configPath: DEFAULT_CONFIG_PATH,
    workingDirectories: [],
    probe: true,
    startWorker: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config') {
      result.configPath = requireValue(argv, ++i, arg);
    } else if (arg === '--name') {
      result.name = requireValue(argv, ++i, arg);
    } else if (arg === '--workdir' || arg === '--working-directory') {
      result.workingDirectories.push(requireValue(argv, ++i, arg));
    } else if (arg === '--no-probe') {
      result.probe = false;
    } else if (arg === '--no-start') {
      result.startWorker = false;
    } else if (arg === '--start') {
      result.startWorker = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown pair option: ${arg}`);
    } else if (!result.input) {
      result.input = arg;
    } else {
      throw new Error('Only one pairing link or config argument is supported');
    }
  }

  return result;
}

export function probeCoordinatorReachability(coordinatorUrl: string, timeoutMs = 5_000): Promise<void> {
  const url = new URL(coordinatorUrl);
  const port = Number.parseInt(url.port || (url.protocol === 'wss:' ? '443' : '80'), 10);
  const host = url.hostname;
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      socket.destroy();
      reject(new Error(`Coordinator is not reachable at ${host}:${port}: ${error.message}`));
    };
    const socket = url.protocol === 'wss:'
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
      : net.connect({ host, port });
    socket.setTimeout(timeoutMs, () => onError(new Error(`timeout after ${timeoutMs}ms`)));
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.end();
      resolve();
    });
    socket.once('secureConnect', () => {
      socket.end();
      resolve();
    });
  });
}

async function parseInputWithCredentialPrompt(
  input: string,
  deps: PairCommandDeps,
): Promise<ParsedPairingConfig> {
  const trimmed = input.trim();
  if (!looksLikeCredentialOnly(trimmed)) {
    try {
      return parsePairingConfigInput(trimmed);
    } catch (error) {
      throw new Error(sanitizePairingErrorMessage(error));
    }
  }

  if (!isInteractive(deps)) {
    throw new Error(
      'A one-time credential alone is not enough to locate the coordinator. Paste the full pairing link or Connection Config.',
    );
  }

  const host = (await askQuestion(deps, 'Coordinator host: ')).trim();
  const port = Number.parseInt((await askQuestion(deps, 'Coordinator port [4878]: ')).trim() || '4878', 10);
  const tlsAnswer = (await askQuestion(deps, 'Use TLS? [y/N]: ')).trim().toLowerCase();
  return parsePairingConfigInput(JSON.stringify({
    token: trimmed,
    host,
    port,
    requireTls: tlsAnswer === 'y' || tlsAnswer === 'yes',
  }));
}

async function promptForPairingInput(deps: PairCommandDeps): Promise<string> {
  if (!isInteractive(deps)) {
    throw new Error('Usage: aio-worker pair <pairing-link-or-connection-config>');
  }
  if (deps.prompt) {
    const first = await deps.prompt('Pairing link, Connection Config, or one-time credential: ');
    return collectMultilineJsonInput(first, deps.prompt);
  }
  const rl = readline.createInterface({
    input: deps.stdin ?? process.stdin,
    output: process.stdout,
  });
  try {
    const first = await rl.question('Pairing link, Connection Config, or one-time credential: ');
    return collectMultilineJsonInput(first, (question) => rl.question(question));
  } finally {
    rl.close();
  }
}

async function promptForPairingDetails(
  parsed: ParsedPairingConfig,
  options: ParsedPairArgs,
  deps: PairCommandDeps,
): Promise<ParsedPairingConfig> {
  if (!isInteractive(deps)) {
    return parsed;
  }

  const defaultName = parsed.name?.trim() || os.hostname();
  const name = options.name
    ? options.name
    : (await askQuestion(deps, `Worker display name [${defaultName}]: `)).trim() || defaultName;

  const defaultDirs = parsed.workingDirectories.length > 0
    ? parsed.workingDirectories
    : defaultWorkingDirectoryList();
  const workingDirectories = options.workingDirectories.length > 0
    ? options.workingDirectories
    : await promptForWorkingDirectories(defaultDirs, deps);

  return {
    ...parsed,
    ...(name ? { name } : {}),
    workingDirectories,
  };
}

async function promptForWorkingDirectories(
  defaultDirs: string[],
  deps: PairCommandDeps,
): Promise<string[]> {
  const suffix = defaultDirs.length > 0 ? ` [${defaultDirs.join(', ')}]` : '';
  const answer = (await askQuestion(deps, `Allowed working directories${suffix}: `)).trim();
  return answer ? parseWorkingDirectoryAnswer(answer) : defaultDirs;
}

async function askQuestion(deps: PairCommandDeps, question: string): Promise<string> {
  if (deps.prompt) {
    return deps.prompt(question);
  }
  const rl = readline.createInterface({
    input: deps.stdin ?? process.stdin,
    output: process.stdout,
  });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function isInteractive(deps: PairCommandDeps): boolean {
  return deps.isInteractive ?? Boolean(process.stdin.isTTY);
}

function looksLikeCredentialOnly(value: string): boolean {
  return !value.startsWith('{')
    && !value.startsWith('ai-orchestrator://')
    && !value.includes('://')
    && !/\s/.test(value)
    && value.length >= 16;
}

async function collectMultilineJsonInput(
  firstLine: string,
  ask: (question: string) => Promise<string>,
): Promise<string> {
  let input = firstLine;
  for (let i = 0; needsMoreJsonLines(input) && i < 200; i++) {
    input += `\n${await ask('... ')}`;
  }
  return input;
}

function needsMoreJsonLines(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('{') && !hasBalancedJsonDelimiters(trimmed);
}

function hasBalancedJsonDelimiters(value: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === '{' || char === '[') {
      depth++;
    } else if (char === '}' || char === ']') {
      depth--;
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0 && !inString;
}

function safeCoordinatorDisplay(coordinatorUrl: string | undefined): string {
  if (!coordinatorUrl) {
    return 'unknown coordinator';
  }
  try {
    return new URL(coordinatorUrl).host;
  } catch {
    return coordinatorUrl;
  }
}

export function defaultWorkingDirectoryCandidate(): string | undefined {
  const userProfile = process.env['USERPROFILE'];
  if (process.platform !== 'win32' || !userProfile) {
    return undefined;
  }
  const documentsWork = `${userProfile}\\Documents\\work`;
  return fs.existsSync(documentsWork)
    ? documentsWork
    : undefined;
}

function defaultWorkingDirectoryList(): string[] {
  const candidate = defaultWorkingDirectoryCandidate();
  return candidate ? [candidate] : [];
}

function parseWorkingDirectoryAnswer(answer: string): string[] {
  return answer
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
