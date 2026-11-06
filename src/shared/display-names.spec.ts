import { describe, expect, it } from 'vitest';
import {
  OTHER_COMPUTERS_PHRASE,
  OTHER_COMPUTERS_TITLE,
  PRODUCT_NAME,
  accountFamilyName,
  computerName,
  isMiMoModel,
  providerName,
  providerToolName,
} from './display-names';

const KNOWN_IDS = [
  'claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok', 'opencode', 'ollama', 'local-model', 'auto',
] as const;

const MIMO_MODELS = [
  'xiaomi-token-plan-ams/mimo-v2.6-pro',
  'xiaomi-token-plan-sgp/mimo-v2.6-flash',
  'xiaomi-token-plan-cn/mimo-v2-tts',
  'xiaomi-token-plan/mimo-v2.6-pro',
  'aio-mimo-max-b-1a2b/mimo-v2.6-pro',
  'opencode/mimo-v2.5-free',
  'openrouter/xiaomi/mimo-v2.6-pro',
  'mimo-v2.6-pro',
];
const OTHER_OPENCODE_MODELS = ['opencode/big-pickle', 'openrouter/anthropic/claude-x', 'auto', '', '   '];

describe('PRODUCT_NAME', () => {
  it('is Harness', () => {
    expect(PRODUCT_NAME).toBe('Harness');
  });
});

describe('providerName', () => {
  it('gives one short name per provider', () => {
    expect(Object.fromEntries(KNOWN_IDS.map((id) => [id, providerName(id)]))).toEqual({
      claude: 'Claude',
      codex: 'Codex',
      gemini: 'Gemini',
      antigravity: 'Antigravity',
      copilot: 'Copilot',
      cursor: 'Cursor',
      grok: 'Grok',
      opencode: 'OpenCode',
      ollama: 'Ollama',
      'local-model': 'Local models',
      auto: 'Auto',
    });
  });

  it('gives the fuller product name when asked', () => {
    expect(Object.fromEntries(KNOWN_IDS.map((id) => [id, providerName(id, { long: true })]))).toEqual({
      claude: 'Claude Code',
      codex: 'OpenAI Codex',
      gemini: 'Google Gemini',
      antigravity: 'Google Antigravity',
      copilot: 'GitHub Copilot',
      cursor: 'Cursor',
      grok: 'Grok Build',
      opencode: 'OpenCode',
      ollama: 'Ollama',
      'local-model': 'Local models',
      auto: 'Auto',
    });
  });

  it('spells Codex two ways at most, never "Codex CLI" or "OpenAI Codex CLI"', () => {
    const spellings = new Set(['codex', 'codex-cli', 'CODEX'].flatMap((id) => [
      providerName(id),
      providerName(id, { long: true }),
    ]));
    expect([...spellings].sort()).toEqual(['Codex', 'OpenAI Codex']);
    for (const spelling of spellings) expect(spelling).not.toMatch(/\bCLI\b/);
  });

  describe('OpenCode and MiMo', () => {
    it('reads OpenCode when only the provider is known, because Zen and OpenRouter sessions are not MiMo', () => {
      expect(providerName('opencode')).toBe('OpenCode');
      expect(providerName('opencode', { long: true })).toBe('OpenCode');
      expect(providerName('opencode', { model: null })).toBe('OpenCode');
      expect(providerName('opencode', { model: undefined })).toBe('OpenCode');
    });

    it.each(MIMO_MODELS)('reads MiMo when the model is the MiMo Token Plan: %s', (model) => {
      expect(providerName('opencode', { model })).toBe('MiMo');
      expect(providerName('opencode', { model, long: true })).toBe('MiMo via OpenCode');
    });

    it.each(OTHER_OPENCODE_MODELS)('still reads OpenCode for the model "%s"', (model) => {
      expect(providerName('opencode', { model })).toBe('OpenCode');
      expect(providerName('opencode', { model, long: true })).toBe('OpenCode');
    });

    it('only OpenCode looks at the model', () => {
      expect(providerName('claude', { model: MIMO_MODELS[0] })).toBe('Claude');
      expect(providerName('codex', { model: MIMO_MODELS[0], long: true })).toBe('OpenAI Codex');
    });

    it('recognises a MiMo model id, and only that', () => {
      for (const model of MIMO_MODELS) expect(isMiMoModel(model)).toBe(true);
      for (const model of [...OTHER_OPENCODE_MODELS, null, undefined, 'xiaomi-token-plan-ams', 'xiaomi-token-plan-xx/other-model']) {
        expect(isMiMoModel(model)).toBe(false);
      }
    });
  });

  it('never returns a two-letter strip code', () => {
    for (const id of KNOWN_IDS) {
      expect(providerName(id).length).toBeGreaterThan(2);
      expect(providerName(id, { long: true }).length).toBeGreaterThan(2);
    }
  });

  it('accepts the CLI spellings, ignoring case and spaces', () => {
    expect(providerName('claude-cli')).toBe('Claude');
    expect(providerName('gemini-cli', { long: true })).toBe('Google Gemini');
    expect(providerName('  CODEX ')).toBe('Codex');
  });

  it('shows an unknown id in plain words, never as the raw id', () => {
    expect(providerName('my-plugin_v2')).toBe('My plugin v2');
    expect(providerName('aio-mimo-abc')).toBe('Aio mimo abc');
  });

  it('has a plain fallback for a missing id', () => {
    expect(providerName(undefined)).toBe('AI provider');
    expect(providerName(null)).toBe('AI provider');
    expect(providerName('   ')).toBe('AI provider');
  });

  it('never uses the words node, worker or AIO', () => {
    for (const id of KNOWN_IDS) {
      for (const long of [false, true]) {
        expect(providerName(id, { long })).not.toMatch(/\b(node|worker|AIO)\b/i);
      }
    }
  });
});

describe('providerToolName', () => {
  it('gives one literal tool name per provider', () => {
    expect(Object.fromEntries(KNOWN_IDS.map((id) => [id, providerToolName(id)]))).toEqual({
      claude: 'Claude Code',
      codex: 'OpenAI Codex',
      gemini: 'Google Gemini',
      antigravity: 'Antigravity',
      copilot: 'GitHub Copilot',
      cursor: 'Cursor',
      grok: 'Grok Build',
      opencode: 'OpenCode',
      ollama: 'Ollama',
      'local-model': 'Local models',
      auto: 'Auto',
    });
  });

  it('does not end in CLI, so a sentence can add "CLI" without saying it twice', () => {
    for (const id of KNOWN_IDS) expect(providerToolName(id)).not.toMatch(/\bCLI$/);
    expect(`the ${providerToolName('cursor')} CLI is not installed`).toBe('the Cursor CLI is not installed');
  });

  it('names OpenCode as OpenCode, whatever model a session runs', () => {
    expect(providerToolName('opencode')).toBe('OpenCode');
  });

  it('accepts the CLI spellings and never prints a raw id', () => {
    expect(providerToolName('claude-cli')).toBe('Claude Code');
    expect(providerToolName(' GROK ')).toBe('Grok Build');
    expect(providerToolName('some-new-tool')).toBe('Some new tool');
    expect(providerToolName(undefined)).toBe('AI provider');
  });
});

describe('accountFamilyName', () => {
  it('maps every MiMo backend name, and OpenCode accounts, to MiMo', () => {
    for (const raw of ['opencode', 'xiaomi-token-plan', 'xiaomi-token-plan-ams', 'aio-mimo-max-b', 'MiMo Token Plan', 'mimo']) {
      expect(accountFamilyName(raw)).toBe('MiMo');
    }
  });

  it('maps vendor names to the product the account is used for', () => {
    expect(accountFamilyName('anthropic')).toBe('Claude');
    expect(accountFamilyName('openai')).toBe('Codex');
    expect(accountFamilyName('chatgpt')).toBe('Codex');
  });

  it('falls back to the provider name', () => {
    expect(accountFamilyName('claude')).toBe('Claude');
    expect(accountFamilyName('copilot')).toBe('Copilot');
    expect(accountFamilyName('something-new')).toBe('Something new');
    expect(accountFamilyName(undefined)).toBe('AI provider');
  });

  it('is the one place OpenCode reads MiMo without a model', () => {
    expect(accountFamilyName('opencode')).toBe('MiMo');
    expect(providerName('opencode')).toBe('OpenCode');
  });
});

describe('computerName', () => {
  it('calls the machine the app runs on "this Mac" or "this PC"', () => {
    expect(computerName(null, 'darwin')).toBe('this Mac');
    expect(computerName('local', 'win32')).toBe('this PC');
    expect(computerName(undefined, 'linux')).toBe('this computer');
    expect(computerName(undefined)).toBe('this computer');
    expect(computerName({ isLocal: true, name: 'ignored' }, 'darwin')).toBe('this Mac');
    expect(computerName({ isLocal: true, platform: 'win32' }, 'darwin')).toBe('this PC');
  });

  it('keeps the name the owner gave another computer', () => {
    expect(computerName({ name: 'windows-pc', platform: 'win32' })).toBe('windows-pc');
    expect(computerName({ name: '  Studio Mac  ' })).toBe('Studio Mac');
  });

  it('describes an unnamed computer by what it is, without the words node or worker', () => {
    expect(computerName({ name: '', platform: 'win32' })).toBe('your Windows PC');
    expect(computerName({ name: null, platform: 'darwin' })).toBe('your other Mac');
    expect(computerName({ platform: 'linux' })).toBe('your Linux computer');
    expect(computerName({})).toBe('another computer');
    for (const platform of ['win32', 'darwin', 'linux', undefined]) {
      expect(computerName({ platform })).not.toMatch(/\b(node|worker)\b/i);
    }
  });

  it('has one name for the screen that lists them, and no jargon in it', () => {
    expect(OTHER_COMPUTERS_TITLE).toBe('Other computers');
    expect(OTHER_COMPUTERS_PHRASE).toBe('your other computers');
    expect(`${OTHER_COMPUTERS_TITLE} ${OTHER_COMPUTERS_PHRASE}`).not.toMatch(/\b(node|worker|remote)\b/i);
  });
});
