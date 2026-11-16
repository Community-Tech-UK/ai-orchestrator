import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
interface TransferFile { path: string; text: string; mtimeMs: number; mode: number; memory: boolean }
interface Transfer { version: number; files: TransferFile[]; assets: { path: string; base64: string }[]; links: unknown[]; exclusions: string[] }
const { buildSyncPackage, applySyncPackage } = require('./sync-agent-setup.js') as {
  buildSyncPackage(options: { sourceHome: string }): Transfer;
  applySyncPackage(pkg: Transfer, options: { destinationHome: string }): unknown;
};
const { serializeToml, readConfig } = require('./sync-policy.js') as {
  serializeToml(value: Record<string, unknown>): string;
  readConfig(text: string, kind: string, label: string): Record<string, unknown>;
};
const homes: string[] = [];
const home = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-sync-config-')); homes.push(root); return root; };
const write = (root: string, relative: string, text: string) => {
  const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
};
afterEach(() => { for (const root of homes.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('home-base structured config credential validation', () => {
  it.each(['claude', 'codex'])('preserves an empty environment fallback through %s source and incoming validation', kind => {
    const source = home(); const destination = home();
    const command = 'TOKEN="${EXAMPLE_API_KEY:-}"; printf ready';
    const project = path.join(destination, 'secret-gist'); fs.mkdirSync(project);
    const value = kind === 'claude' ? { statusLine: { type: 'command', command }, includeCoAuthoredBy: false } : {
      notify: ['sh', '-c', command], model_auto_compact_token_limit: 200000,
      mcp_servers: { helper: { command: 'node', args: ['--token', '${EXAMPLE_API_KEY:-}', '--port', '4000'] } },
      projects: { [project]: { trust_level: 'trusted' } },
    };
    const file = kind === 'claude' ? '.claude/settings.json' : '.codex/config.toml';
    write(source, file, kind === 'claude' ? JSON.stringify(value) : serializeToml(value));
    const pkg = buildSyncPackage({ sourceHome: source });
    applySyncPackage(pkg, { destinationHome: destination });
    expect(readConfig(fs.readFileSync(path.join(destination, file), 'utf8'), kind, file)).toMatchObject(value);
  });

  it.each([
    { notify: ['sh', '-c', 'TOKEN="${EXAMPLE_API_KEY:-do-not-copy-this-literal}"'] },
    { notify: ['sh', '-c', 'TOKEN="${EXAMPLE_API_KEY:-'] },
    { notify: ['sh', '-c', 'TOKEN="${EXAMPLE_API_KEY:-}"; PASSWORD=do-not-copy-this-literal'] },
    { notify: ['sh', '-c', 'TOKEN="${EXAMPLE_API_KEY:-}do-not-copy-this-literal"'] },
    { notify: ['sh', '-c', 'TOKEN="do-not-copy-this-literal${EXAMPLE_API_KEY}"'] },
    { notify: ['sh', '-c', 'command --token do-not-copy-this-literal'] },
    ...[
      'helper --token "${EXAMPLE_API_KEY}"do-not-copy-this-literal',
      'helper --token "${EXAMPLE_API_KEY}""do-not-copy-this-literal"',
      'helper --token="${EXAMPLE_API_KEY}"do-not-copy-this-literal',
      'TOKEN="${EXAMPLE_API_KEY}""do-not-copy-this-literal"',
      'TOKEN="${EXAMPLE_API_KEY}""do-not-copy-this-literal"*',
      'helper --token "${EXAMPLE_API_KEY}"#do-not-copy-this-literal',
      'helper --token "${EXAMPLE_API_KEY}"' + '\\\n' + 'do-not-copy-this-literal',
      'helper --to' + '\\\n' + 'ken do-not-copy-this-literal',
      "helper $'--to\\x6ben' \"${EXAMPLE_API_KEY}\"#do-not-copy-this-literal",
      'helper --token "$EXAMPLE_API_KEY"\\d\\o-not-copy-this-literal',
      "helper --token $'\\x64o-not-copy-this-literal'",
      "helper $'--to\\x6ben' do-not-copy-this-literal",
      'helper --token \'${EXAMPLE_API_KEY}\'do-not-copy-this-literal',
      'sh -c \'helper --token "${EXAMPLE_API_KEY}""do-not-copy-this-literal"\'',
      'bash --noprofile -c \'helper --token "${EXAMPLE_API_KEY}""do-not-copy-this-literal"\'',
      'sh -eu -c \'helper --token "${EXAMPLE_API_KEY}""do-not-copy-this-literal"\'',
      "bash --noprofile -c 'helper $\"--token\" \"${EXAMPLE_API_KEY}\"\"do-not-copy-this-literal\"'",
      'TOKEN=$(printf do-not-copy-this-literal)',
      'TOKEN="$(printf do-not-copy-this-literal)"',
      'TOKEN=`printf do-not-copy-this-literal`',
      'TOKEN="$(security find-generic-password -w -s example-service 2>/dev/null || true)"do-not-copy-this-literal',
      'TOKEN=$(security find-generic-password -w -s example-service; printf do-not-copy-this-literal)',
      "TOKEN='$(security find-generic-password -w -s example-service 2>/dev/null || true)'",
      'TOKEN="${EXAMPLE_API_KEY}"\'\'\\ do-not-copy-this-literal',
    ].map(command => ({ notify: ['sh', '-c', command] })),
    { mcp_servers: { helper: { command: 'node', token: 'do-not-copy-this-literal' } } },
    { mcp_servers: { helper: { command: 'node', token: 123456 } } },
    { mcp_servers: { helper: { command: 'node', token: false } } },
    { mcp_servers: { helper: { command: 'node', APIKey: 'do-not-copy-this-literal' } } },
    { mcp_servers: { helper: { command: 'node', authorizationHeader: 'Bearer do-not-copy-this-literal' } } },
    { mcp_servers: { helper: { command: 'node', args: ['--token', 'do-not-copy-this-literal'] } } },
    { mcp_servers: { helper: { command: 'node', args: ['--token', '123456'] } } },
    { mcp_servers: { helper: { command: 'node', headers: { Authorization: 'Bearer do-not-copy-this-literal' } } } },
  ])('refuses literal or incomplete config credentials before source transfer and destination writes: %#', value => {
    const source = home(); const destination = home();
    const file = '.codex/config.toml';
    write(source, '.agents/AGENTS.md', '# Existing rules');
    const pkg = buildSyncPackage({ sourceHome: source });
    const text = serializeToml(value);
    write(source, file, text);
    expect(() => buildSyncPackage({ sourceHome: source })).toThrow(/credential/);
    pkg.files.push({ path: file, text, mtimeMs: 0, mode: 0o600, memory: false });
    expect(() => applySyncPackage(pkg, { destinationHome: destination })).toThrow(/credential/);
    expect(fs.existsSync(path.join(destination, '.agents/AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(destination, file))).toBe(false);
  });

  it.each([
    'helper --token "${EXAMPLE_API_KEY}" --port 4000',
    'helper --token "$EXAMPLE_API_KEY" --port 4000',
    'helper --token="${EXAMPLE_API_KEY:-}" --port 4000',
    'helper -H "Authorization: Bearer ${EXAMPLE_API_KEY}"',
    'sh -c \'helper --token "${EXAMPLE_API_KEY}" --port 4000\'',
    'TOKEN="$(security find-generic-password -w -s example-service 2>/dev/null || true)"; helper --token "$TOKEN"',
    'sh -c \'TOKEN="${EXAMPLE_API_KEY}"; helper --token "$TOKEN"\'',
  ])('retains complete shell environment references without consuming the next option: %s', command => {
    const source = home(); const destination = home();
    const value = { statusLine: { type: 'command', command } };
    write(source, '.claude/settings.json', JSON.stringify(value));
    applySyncPackage(buildSyncPackage({ sourceHome: source }), { destinationHome: destination });
    expect(JSON.parse(fs.readFileSync(path.join(destination, '.claude/settings.json'), 'utf8'))).toEqual(value);
  });

  it.each(['\\r\\n', '\r\n'])('retains a reviewed credential-file lookup without reading its contents: %#', characters => {
    const source = home(); const destination = home();
    const credentialPath = path.join(destination, 'separately-provisioned-file');
    fs.writeFileSync(credentialPath, '');
    const command = `TOKEN="$(tr -d '${characters}' < '${credentialPath}')"; helper --token "$TOKEN"`;
    const value = { notify: ['sh', '-c', command] };
    write(source, '.codex/config.toml', serializeToml(value));
    applySyncPackage(buildSyncPackage({ sourceHome: source }), { destinationHome: destination });
    expect(readConfig(fs.readFileSync(path.join(destination, '.codex/config.toml'), 'utf8'), 'codex', 'config')).toMatchObject(value);
    expect(fs.readFileSync(credentialPath, 'utf8')).toBe('');
  });
});
