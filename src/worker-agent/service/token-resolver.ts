import * as fs from 'node:fs/promises';
import * as readline from 'node:readline';

export enum TokenSource {
  File = 'file',
  Stdin = 'stdin',
  Env = 'env',
  Interactive = 'interactive',
}

export interface ResolveTokenOptions {
  tokenFile?: string;
  tokenEnv?: string;
  fromStdin?: boolean;
  interactive?: boolean;
}

export interface ResolvedToken {
  token: string;
  source: TokenSource;
}

export async function resolveToken(opts: ResolveTokenOptions): Promise<ResolvedToken> {
  if (opts.tokenFile) {
    const raw = await fs.readFile(opts.tokenFile, 'utf8');
    const token = raw.replace(/\r?\n$/, '').trim();
    if (!token) throw new Error(`Token file ${opts.tokenFile} is empty`);
    return { token, source: TokenSource.File };
  }
  if (opts.tokenEnv) {
    const val = process.env[opts.tokenEnv];
    if (!val || !val.trim()) throw new Error(`Env var ${opts.tokenEnv} is unset or empty`);
    return { token: val.trim(), source: TokenSource.Env };
  }
  if (opts.fromStdin) {
    const token = await readAll(process.stdin);
    const trimmed = token.replace(/\r?\n$/, '').trim();
    if (!trimmed) throw new Error('Stdin was empty');
    return { token: trimmed, source: TokenSource.Stdin };
  }
  if (opts.interactive) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      const ans = await new Promise<string>((resolve) =>
        rl.question('Enrollment token: ', resolve),
      );
      const trimmed = ans.trim();
      if (!trimmed) throw new Error('No token entered');
      return { token: trimmed, source: TokenSource.Interactive };
    } finally {
      rl.close();
    }
  }
  throw new Error('No token source specified (--token-file / --token-env / --token-stdin / --token-interactive)');
}

function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => (buf += chunk));
    stream.on('end', () => resolve(buf));
    stream.on('error', reject);
  });
}
