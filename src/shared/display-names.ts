/**
 * One name for each thing (Oct-2 Phase E, step 4 / backlog U3).
 *
 * Before this module the same provider was spelled four ways ("Codex",
 * "OpenAI Codex", "Codex CLI", "OpenAI Codex CLI") across about 17 local maps,
 * MiMo had five names, the quota strip used two-letter codes in which CU meant
 * Cursor while every session header used CU for Computer Use, and other
 * computers were "nodes", "workers" and "browser computers" depending on the
 * screen. This file holds ONLY the name maps; the word list those names follow
 * is Phase F's glossary.
 *
 * Three questions, three functions:
 * - `providerName(id)`: what to call the provider a session runs on. Short for
 *   chips, rows, menus and sentences; `long` adds the vendor.
 * - `providerToolName(id)`: the literal name of the command-line tool or its
 *   config ("the Cursor CLI is not installed", the CLI health page, a settings
 *   list of tools). Every tool name in the app comes from here.
 * - `accountFamilyName(raw)`: what the account, plan and usage belong to.
 *
 * OpenCode is the one provider whose answers differ. It fronts several
 * backends (MiMo Token Plan, its free Zen models, OpenRouter), so on its own
 * it reads "OpenCode". It reads "MiMo" only where something proves it: the
 * session's model is a MiMo Token Plan model (`providerName(id, { model })`),
 * or the thing named is an account or a quota (`accountFamilyName`), because
 * OpenCode accounts and its usage numbers are always the MiMo plan's.
 *
 * Other rules:
 * - Unknown ids are shown in plain words, never as a raw id.
 * - The words "node" and "worker" never appear here: they belong under Details.
 *
 * Tests: `display-names.spec.ts`. Guard: `display-names.guard.spec.ts` fails on
 * a new local map of provider names, or a tool name written out by hand.
 */

/** The app's own name on screen. Identifiers, paths and stored data keep their old spellings. */
export const PRODUCT_NAME = 'Harness';

export interface ProviderNameOptions {
  /** Fuller product name, for places that have room (Settings, Details, health pages). */
  readonly long?: boolean;
  /**
   * The model the session runs. Only OpenCode looks at it: a MiMo Token Plan
   * model makes it read "MiMo" (long form "MiMo via OpenCode"); any other model,
   * or none, leaves "OpenCode".
   */
  readonly model?: string | null;
}

interface ProviderNames {
  readonly short: string;
  readonly long: string;
  /** The literal CLI/tool name; see `providerToolName`. */
  readonly tool: string;
}

const PROVIDER_NAMES: Readonly<Record<string, ProviderNames>> = {
  claude: { short: 'Claude', long: 'Claude Code', tool: 'Claude Code' },
  codex: { short: 'Codex', long: 'OpenAI Codex', tool: 'OpenAI Codex' },
  gemini: { short: 'Gemini', long: 'Google Gemini', tool: 'Google Gemini' },
  antigravity: { short: 'Antigravity', long: 'Google Antigravity', tool: 'Antigravity' },
  copilot: { short: 'Copilot', long: 'GitHub Copilot', tool: 'GitHub Copilot' },
  cursor: { short: 'Cursor', long: 'Cursor', tool: 'Cursor' },
  grok: { short: 'Grok', long: 'Grok Build', tool: 'Grok Build' },
  opencode: { short: 'OpenCode', long: 'OpenCode', tool: 'OpenCode' },
  ollama: { short: 'Ollama', long: 'Ollama', tool: 'Ollama' },
  'local-model': { short: 'Local models', long: 'Local models', tool: 'Local models' },
  auto: { short: 'Auto', long: 'Auto', tool: 'Auto' },
};

/** What OpenCode reads when its model proves it is the MiMo Token Plan. */
const MIMO_NAMES = { short: 'MiMo', long: 'MiMo via OpenCode' } as const;

/** Other spellings of the same provider that reach display code (CLI and doctor keys). */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  'claude-cli': 'claude',
  'codex-cli': 'codex',
  'gemini-cli': 'gemini',
  local_model: 'local-model',
};

const UNKNOWN_PROVIDER_NAME = 'AI provider';

/**
 * Models that identify MiMo: the logical `xiaomi-token-plan[-region]/…`
 * ids, and the `aio-mimo-<profile>/…` ids Harness injects for extra accounts.
 * MiMo model names on Zen or OpenRouter also identify the model maker;
 * generic Zen/OpenRouter models do not. This is display-only, never account routing.
 */
const MIMO_MODEL = /^(?:xiaomi-token-plan(?:-(?:ams|sgp|cn))?|aio-mimo-[a-z0-9][a-z0-9-]*)\/\S+$/;

export function isMiMoModel(model: string | null | undefined): boolean {
  const id = model?.trim() ?? '';
  return MIMO_MODEL.test(id) || /(?:^|\/)mimo(?:[-._]|$)/i.test(id);
}

/** "my-plugin_v2" -> "My plugin v2": a last-resort name that is still plain words. */
function humaniseId(id: string): string {
  const words = id.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : UNKNOWN_PROVIDER_NAME;
}

function lookup(id: string | null | undefined): { canonical: string; names: ProviderNames } | null {
  const key = id?.trim().toLowerCase();
  if (!key) return null;
  const canonical = PROVIDER_ALIASES[key] ?? key;
  const names = PROVIDER_NAMES[canonical];
  return names ? { canonical, names } : null;
}

/**
 * The name to show for the provider a session runs on. Case-insensitive;
 * accepts the CLI and doctor spellings (`claude-cli`). A missing id reads
 * "AI provider". Pass `model` wherever the session's model is at hand so a
 * MiMo session reads "MiMo" (see the header).
 *
 * @hoverTextReadable every name it can return is a literal in this file, so the UI hints check reads them.
 */
export function providerName(id: string | null | undefined, options: ProviderNameOptions = {}): string {
  const trimmed = id?.trim();
  if (!trimmed) return UNKNOWN_PROVIDER_NAME;
  const found = lookup(trimmed);
  if (!found) return humaniseId(trimmed);
  if (found.canonical === 'opencode' && isMiMoModel(options.model)) {
    return options.long ? MIMO_NAMES.long : MIMO_NAMES.short;
  }
  return options.long ? found.names.long : found.names.short;
}

/**
 * The literal name of a provider's command-line tool or config: "the Cursor
 * CLI is not installed", the CLI health page, a list of tools in Settings, the
 * tool's entry in a registry. One spelling each, so Codex is never "Codex CLI"
 * in one place and "OpenAI Codex CLI" in another.
 */
export function providerToolName(id: string | null | undefined): string {
  const trimmed = id?.trim();
  if (!trimmed) return UNKNOWN_PROVIDER_NAME;
  return lookup(trimmed)?.names.tool ?? humaniseId(trimmed);
}

/**
 * True for a provider the app still lists but no longer recommends: Gemini,
 * replaced by Antigravity. Lists that show it put "(legacy)" after its name.
 */
export function isLegacyProvider(id: string | null | undefined): boolean {
  return lookup(id)?.canonical === 'gemini';
}

/**
 * The family an account belongs to ("Your work Claude account", "Signed out of
 * MiMo"), from any name the app or its CLIs use for it: a provider id, an
 * OpenCode backend such as `xiaomi-token-plan-ams`, or the per-account
 * `aio-mimo-<profile>` name Harness injects at spawn. OpenCode accounts and
 * usage are always the MiMo Token Plan's, so `opencode` reads "MiMo" here even
 * though a session on it does not. This is what stops a raw backend id
 * reaching the screen.
 *
 * @hoverTextReadable every name it can return is a literal in this file, so the UI hints check reads them.
 */
export function accountFamilyName(raw: string | null | undefined): string {
  const key = raw?.trim().toLowerCase();
  if (!key) return UNKNOWN_PROVIDER_NAME;
  if (key === 'opencode' || key.startsWith('aio-mimo-') || key.startsWith('xiaomi-token-plan') || key.startsWith('mimo')) {
    return MIMO_NAMES.short;
  }
  if (key === 'anthropic') return providerName('claude');
  if (key === 'openai' || key === 'chatgpt') return providerName('codex');
  return providerName(raw);
}

/** A computer Harness runs sessions on: the Mac or PC it is installed on, or another one it can reach. */
export interface ComputerLike {
  /** The name the user gave the computer, or its host name. */
  readonly name?: string | null;
  /** `process.platform` style: `darwin`, `win32`, `linux`. */
  readonly platform?: string | null;
  /** True for the computer this app is running on. */
  readonly isLocal?: boolean;
}

function thisComputerName(platform: string | null | undefined): string {
  if (platform === 'darwin') return 'this Mac';
  if (platform === 'win32') return 'this PC';
  return 'this computer';
}

function otherComputerName(platform: string | null | undefined): string {
  if (platform === 'darwin') return 'your other Mac';
  if (platform === 'win32') return 'your Windows PC';
  if (platform === 'linux') return 'your Linux computer';
  return 'another computer';
}

/**
 * How to name a computer in a sentence. A remote computer keeps the name its
 * owner gave it; one with no name falls back to a description of what it is.
 * `local` (or a missing computer) is the machine the app is running on.
 *
 * @param localPlatform `process.platform` of this machine, to say "this Mac" or "this PC".
 */
export function computerName(
  computer: ComputerLike | 'local' | null | undefined,
  localPlatform?: string | null,
): string {
  if (computer == null || computer === 'local' || computer.isLocal) {
    return thisComputerName(computer && computer !== 'local' ? computer.platform ?? localPlatform : localPlatform);
  }
  const name = computer.name?.trim();
  return name || otherComputerName(computer.platform);
}

/** The screen, menu entry and group that list the computers Harness can run sessions on. */
export const OTHER_COMPUTERS_TITLE = 'Other computers';

/** Mid-sentence form of `OTHER_COMPUTERS_TITLE` ("Pair one of your other computers first"). */
export const OTHER_COMPUTERS_PHRASE = 'your other computers';
