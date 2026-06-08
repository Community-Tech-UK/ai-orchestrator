import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getLogger } from '../logging/logger';

const logger = getLogger('CodexAuthMode');

/**
 * How the codex CLI is authenticated for the current user.
 *
 * - `chatgpt`   — signed in with a ChatGPT account (the common case). Only the
 *                 account's allotted models are usable; many catalog ids
 *                 (notably `*-codex` variants and several `gpt-5.x` ids) return
 *                 HTTP 400 "model is not supported when using Codex with a
 *                 ChatGPT account".
 * - `api-key`   — an OpenAI API key is configured; the full model range is
 *                 available.
 * - `unknown`   — no readable auth (logged out, missing file, or unparseable).
 */
export type CodexAuthMode = 'chatgpt' | 'api-key' | 'unknown';

/** Cache TTL — auth mode changes rarely (only on explicit login/logout). */
const CACHE_TTL_MS = 60_000;

let cache: { mode: CodexAuthMode; readAt: number } | null = null;

function codexHomeDir(): string {
  const explicit = process.env['CODEX_HOME'];
  if (explicit && explicit.trim()) {
    return explicit;
  }
  const home = process.env['HOME'] || process.env['USERPROFILE'] || homedir();
  return join(home, '.codex');
}

function detectCodexAuthMode(): CodexAuthMode {
  try {
    const raw = readFileSync(join(codexHomeDir(), 'auth.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { auth_mode?: unknown; OPENAI_API_KEY?: unknown };

    const rawMode = typeof parsed.auth_mode === 'string' ? parsed.auth_mode.toLowerCase() : '';
    if (rawMode.includes('chatgpt')) return 'chatgpt';
    if (rawMode.includes('api')) return 'api-key';

    // Fall back to key presence when auth_mode is absent/opaque.
    if (typeof parsed.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY.trim()) {
      return 'api-key';
    }
    return 'unknown';
  } catch (error) {
    logger.debug('Could not read codex auth.json; treating auth mode as unknown', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 'unknown';
  }
}

/**
 * Synchronously read the codex CLI auth mode from `~/.codex/auth.json`
 * (respecting `CODEX_HOME`). Cached for {@link CACHE_TTL_MS} so it is cheap to
 * call on hot paths such as per-iteration loop model routing.
 *
 * Unlike `checkCodexCliAuthentication`, this does NOT shell out to
 * `codex login status` — it is a plain file read intended for fast, frequent
 * checks.
 */
export function readCodexAuthMode(now: number = Date.now()): CodexAuthMode {
  if (cache && now - cache.readAt < CACHE_TTL_MS) {
    return cache.mode;
  }
  const mode = detectCodexAuthMode();
  cache = { mode, readAt: now };
  return mode;
}

/** Test hook: clear the cached auth-mode reading. */
export function _resetCodexAuthModeCacheForTesting(): void {
  cache = null;
}
