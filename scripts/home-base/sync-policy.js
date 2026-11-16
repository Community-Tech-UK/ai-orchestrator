'use strict';

const { parseTOML, getStaticTOMLValue } = require('toml-eslint-parser');
const { parse: parseShell } = require('shell-quote');
const path = require('node:path');

const DIRECT_DRIVER = /(?:chrome[-_]devtools|playwright|puppeteer|selenium|chromedriver|node[-_]repl|computer[-_]use|browser[-_]use|unified[-_]computer|remote[-_]debugging)/i;
const DIRECT_CONTROL = /\b(?:computer\.[a-z_]+|computer\s+use|Chrome\s+DevTools|osascript|AppleScript|System\s+Events|xdotool|pyautogui|pywinauto|cliclick|AutoHotkey|robotjs|nut[-_]js|AXUIElementPerformAction|CGEventPost|UIAutomationClient|SendKeys|GUI\s+(?:scripting|automation)|Claude in Chrome)\b|\bcomputer\.\*|\bopen(?:\s+|:)(?:-(?:a|b)\b|https?:|<url>)|\b(?:chrome|chromium|firefox|msedge)\.exe\b/i;
const APP_LAUNCH = /(?:^|[\s;&|([{])(?:\/[^\s;&|()]+\/)?open(?=$|[\s:),])/i;
const BROWSER_EXECUTABLE = /(?:^|[\s;&|([{])(?:\/[^\s;&|()]+\/)?(?:google-chrome(?:-stable|-beta|-unstable)?|chrome|chromium(?:-browser)?|firefox(?:-esr)?|msedge|microsoft-edge(?:-stable|-beta|-dev)?|brave(?:-browser)?|opera|vivaldi|safari|xdg-open|sensible-browser|x-www-browser|gnome-open|kde-open5?)(?=$|[\s:),])/i;
const DESKTOP_URL_LAUNCH = /(?:^|[\s;&|([{])(?:start(?:-process)?|explorer(?:\.exe)?|rundll32(?:\.exe)?)(?=$|[\s:),])/i;
const TEXT_EXTENSIONS = new Set(['.md', '.mdc', '.txt', '.json', '.yaml', '.yml', '.toml', '.sh', '.bash', '.zsh', '.py', '.js', '.mjs', '.cjs', '.ts', '.html', '.css', '.svg', '.xsd', '.xml', '.csv']);
const FILES = new Set(['.agents/AGENTS.md', '.claude/settings.json', '.codex/config.toml', '.codex/RTK.md',
  '.copilot/copilot-instructions.md', '.grok/AGENTS.md', '.cursor/rules/windows-pc-browser-routing.mdc',
  'work/creds/SERVER-ACCESS.md', 'work/server-inventory.md']);
const TREES = ['.agents/skills', '.agents/personas', '.claude/skills', '.claude/commands', '.claude/docs', '.claude/hooks', '.codex/skills'];
const LINKS = [{ path: '.claude/CLAUDE.md', target: '.agents/AGENTS.md' }, { path: '.codex/AGENTS.md', target: '.agents/AGENTS.md' },
  { path: 'AGENTS.md', target: '.agents/AGENTS.md' }, { path: '.claude/agents', target: '.agents/personas' }];
const SAFE_ENV = new Map([
  ['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', /^(?:0|1|true|false)$/], ['ENABLE_LSP_TOOL', /^(?:0|1|true|false)$/],
  ['ENABLE_TOOL_SEARCH', /^(?:0|1|true|false|auto(?::\d+)?)$/], ['CLAUDE_CODE_EFFORT_LEVEL', /^(?:low|medium|high|max)$/],
  ['XCODEBUILDMCP_EXPERIMENTAL_WORKFLOW_DISCOVERY', /^(?:0|1|true|false)$/], ['TOOLSETS', /^[\w, -]{1,500}$/],
]);
const CLAUDE_KEYS = new Set(['env', 'includeCoAuthoredBy', 'permissions', 'hooks', 'statusLine', 'enabledPlugins',
  'extraKnownMarketplaces', 'alwaysThinkingEnabled', 'effortLevel', 'tui', 'skipDangerousModePermissionPrompt',
  'inputNeededNotifEnabled', 'agentPushNotifEnabled', 'model', 'language', 'outputStyle', 'cleanupPeriodDays',
  'respectGitignore', 'sandbox', 'feedbackSurveyRate']);
const CODEX_KEYS = new Set(['approval_policy', 'model', 'model_reasoning_effort', 'personality', 'sandbox_mode', 'notify',
  'service_tier', 'features', 'marketplaces', 'mcp_servers', 'plugins', 'projects', 'shell_environment_policy', 'tui', 'hooks',
  'desktop', 'model_context_window', 'model_auto_compact_token_limit', 'web_search', 'hide_agent_reasoning',
  'model_reasoning_summary', 'model_verbosity', 'check_for_update_on_startup', 'history']);
const BUNDLED_DRIVERS = ['chrome', 'computer-use', 'browser', 'unified-computer-use', 'computer-history', 'record-and-replay', 'codex-app-tools', 'messages'];
// The installed bundled manifests identify Messages as native macOS app access,
// computer-history/record-and-replay as desktop capture, and codex-app-tools as
// a native pipe exposing provider-app management (including opening app panels).
const SAFE_BUNDLED = new Set(['visualize', 'latex', 'documents', 'presentations', 'spreadsheets', 'pdf']);

function safeKey(value) { return /^[\w.@/-]{1,100}$/.test(value) ? value : '[unsupported key]'; }
function fail(label, reason) { throw new Error(`Refused ${label}: ${reason}`); }
function approvedPath(relative) {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.split('/').some(part => part === '..' || !part)) return false;
  return FILES.has(relative) || TREES.some(root => relative.startsWith(root + '/')) || /^\.claude\/projects\/[^/]+\/memory\/[^].+$/.test(relative);
}
function isDirectDriver(value) { return DIRECT_DRIVER.test(value); }
function setupFileRefusal(relative) {
  const leaf = path.basename(relative);
  if (leaf.startsWith('.') || /^(?:auth|accounts|credentials|cookies)(?:\.|$)/i.test(leaf)) return 'credential or hidden file';
  if (!TEXT_EXTENSIONS.has(path.extname(leaf)) && !/^(?:LICENSE|COPYRIGHT)$/i.test(leaf)) return 'non-text asset requires separate review';
  return null;
}
function directCommand(value) {
  const parts = input => {
    if (input === undefined || input === null || typeof input === 'boolean') return [];
    if (typeof input === 'string') return [input];
    if (Array.isArray(input)) {
      if (!input.every(item => typeof item === 'string')) throw new Error('Unsupported executable argument layout; review the config before syncing');
      return input;
    }
    if (typeof input !== 'object') throw new Error('Unsupported executable command layout; review the config before syncing');
    return ['command', 'executable', 'program', 'cmd', 'script', 'shell', 'args', 'arguments', 'argv', 'code'].flatMap(key => parts(input[key]));
  };
  const text = parts(value).join(' ');
  // Plain output is harmless; substitutions and command chaining are still inspected.
  if (/^\s*(?:echo|printf|print)\b/.test(text) && !/[;&|$`]/.test(text)) return false;
  const normalized = text.replace(/['"`]/g, ' ').replace(/\s+/g, ' ');
  return isDirectDriver(normalized) || DIRECT_CONTROL.test(normalized) || APP_LAUNCH.test(normalized)
    || /\.app\/Contents\/MacOS\/|\b(?:webbrowser|startfile|FileProtocolHandler)\b/i.test(normalized)
    || BROWSER_EXECUTABLE.test(normalized)
    || (/https?:\/\//i.test(normalized) && DESKTOP_URL_LAUNCH.test(normalized));
}
function directScript(text) {
  return text.split('\n').filter(line => !/^\s*#/.test(line)).some(line =>
    !(/^\s*(?:reason|message|description)=/.test(line) && !/[$`]/.test(line)) && directCommand(line));
}
function directSkillContent(text) {
  // Skill prose (including headings and references) is executable guidance too.
  // Ambiguous instructions to control a browser/desktop are excluded; gateway
  // tool names such as browser.find_or_open do not match these direct routes.
  return isDirectDriver(text) || directScript(text) || DIRECT_CONTROL.test(text)
    || /\b(?:headed|local)\s+(?:browser|Chrome)|\b(?:browser|desktop)\s+(?:automation|control)\b/i.test(text)
    || /\b(?:use|launch|start|open|drive|automate|navigate|inspect)\s+(?:(?:a|the)\s+)?(?:Chrome|Chromium|Firefox|Safari|desktop|browser(?!\.[a-z_]|\s+Gateway))\b/i.test(text);
}
function directSetupContent(relative, text, skill = /(?:^|\/)skills\//.test(relative)) {
  if (skill || (/(?:^|\/)commands\//.test(relative) && relative.endsWith('.md'))) return directSkillContent(text);
  return /(?:^|\/)(?:hooks|commands)\//.test(relative) && directScript(text);
}
function assertSecretFree(text, label) {
  const safeValue = value => /^(?:\$|\{|<|\[|\(|your[-_]|example[-_]|placeholder|changeme|process\.|os\.|None|null|undefined|true|false)/i.test(value);
  for (const match of text.matchAll(/(?:\bauthorization\s*[:=]\s*[\'"]?\s*(?:Bearer|Basic)\s+|--(?:token|password|api-key|client-secret)(?:=|\s+)[\'"]?)([^\s\'";,}]+)/gi)) {
    if (!safeValue(match[1])) fail(label, 'literal credential in a header or command requires separate provisioning');
  }
  if (text.includes('\0') || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)
    || /\b(?:gh[pousr]_[a-zA-Z0-9]{20,}|sk-(?:proj-|ant-)?[a-zA-Z0-9_-]{24,}|xox[baprs]-[a-zA-Z0-9-]{15,})\b/.test(text)) {
    fail(label, 'credential-shaped or non-text content requires separate provisioning');
  }
  const assignments = text.matchAll(/\b(?:[A-Z_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|CLIENT_SECRET|SECRET_KEY)|password|token|secret|api[_-]?key|access[_-]?token|client[_-]?secret)[\'"]?\s*[:=]\s*['"]?([^\s'";,}]+)/gi);
  for (const match of assignments) {
    const value = match[1];
    if (!safeValue(value)) {
      fail(label, 'possible embedded credential requires separate provisioning');
    }
  }
  // URL user-info and query credentials must never enter the transfer package.
  if (/https?:\/\/[^/\s]+:[^/@\s]+@|[?&](?:access_token|api_key|token|password)=[^&\s<${]+/i.test(text)) {
    fail(label, 'credential-bearing URL requires separate provisioning');
  }
}
function validateEnv(env, label) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) fail(label, 'environment must be an object');
  for (const [key, value] of Object.entries(env)) {
    if (isDirectDriver(key)) { delete env[key]; continue; }
    if (typeof value !== 'string') fail(label, `unsupported env key ${safeKey(key)}`);
    const rule = SAFE_ENV.get(key);
    if (rule?.test(value)) continue;
    if (['CONFLUENCE_URL', 'JIRA_URL'].includes(key)) {
      let url; try { url = new URL(value); } catch { fail(label, `unsupported env key ${safeKey(key)}`); }
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) continue;
    }
    if (['CONFLUENCE_USERNAME', 'JIRA_USERNAME', 'MYSHELL_MCP_USER_ID'].includes(key) && /^[\w.@+ -]{1,200}$/.test(value)) continue;
    if (key === 'CCLSP_CONFIG_PATH' && path.isAbsolute(value)) continue;
    fail(label, `unsupported env key ${safeKey(key)}; provision it separately`);
  }
}
function filterToolMaps(value, excluded, prefix = '') {
  if (!value || typeof value !== 'object') return;
  const location = key => prefix ? `${prefix}.${safeKey(key)}` : safeKey(key);
  for (const key of ['mcp_servers', 'mcpServers']) {
    const servers = value[key];
    if (!servers || typeof servers !== 'object') continue;
    for (const [name, server] of Object.entries(servers)) {
      if (isDirectDriver(name) || directCommand(server) || isDirectDriver(server?.url || server?.httpUrl || '')) {
        delete servers[name]; excluded.push(`${location(key)}.${safeKey(name)}`);
      }
    }
  }
  const plugins = value.plugins;
  if (plugins && typeof plugins === 'object') {
    for (const name of [...Object.keys(plugins), ...BUNDLED_DRIVERS.map(name => `${name}@openai-bundled`)]) {
      const bundledName = name.endsWith('@openai-bundled') ? name.slice(0, -'@openai-bundled'.length) : null;
      if (isDirectDriver(name) || (bundledName && BUNDLED_DRIVERS.includes(bundledName))) plugins[name] = { ...plugins[name], enabled: false };
      else if (bundledName && !SAFE_BUNDLED.has(bundledName)) throw new Error(`Refused unclassified bundled plugin ${safeKey(name)}; review its capabilities before syncing`);
    }
  }
  if (value.enabledPlugins && typeof value.enabledPlugins === 'object') {
    for (const name of Object.keys(value.enabledPlugins)) if (isDirectDriver(name)) value.enabledPlugins[name] = false;
  }
  if (value.features?.js_repl !== undefined) value.features.js_repl = false;
  filterExecutionSinksAndPermissions(value, excluded, prefix);
  for (const [key, child] of Object.entries(value)) {
    if (!['env', 'headers', 'oauthAccount', 'credentials', 'auth', 'authentication'].includes(key)
      && child && typeof child === 'object') filterToolMaps(child, excluded, location(key));
  }
}
function filterExecutionSinksAndPermissions(value, excluded, prefix) {
  const location = key => prefix ? `${prefix}.${safeKey(key)}` : safeKey(key);
  for (const key of ['statusLine', 'notify']) {
    if (value[key] !== undefined && directCommand(value[key])) { delete value[key]; excluded.push(location(key)); }
  }
  const filterHooks = (node, key) => {
    if (typeof node === 'string' || (Array.isArray(node) && node.every(item => typeof item === 'string'))) {
      if (directCommand(node)) { excluded.push(key); return undefined; }
      return node;
    }
    if (Array.isArray(node)) return node.map((child, index) => filterHooks(child, `${key}.${index}`)).filter(child => child !== undefined);
    if (!node || typeof node !== 'object') return node;
    if (directCommand(node) || isDirectDriver(node.matcher || '')
      || (['prompt', 'agent'].includes(node.type) && typeof node.prompt === 'string' && directSkillContent(node.prompt))) {
      excluded.push(key); return undefined;
    }
    for (const [childKey, child] of Object.entries(node)) {
      if (['env', 'headers'].includes(childKey) || !child || typeof child !== 'object') continue;
      const filtered = filterHooks(child, `${key}.${safeKey(childKey)}`);
      if (filtered === undefined) delete node[childKey]; else node[childKey] = filtered;
    }
    return Array.isArray(node.hooks) && node.hooks.length === 0 ? undefined : node;
  };
  if (value.hooks !== undefined) {
    const filtered = filterHooks(value.hooks, location('hooks'));
    if (filtered === undefined) delete value.hooks; else value.hooks = filtered;
  }
  for (const list of ['allow', 'ask']) {
    if (Array.isArray(value.permissions?.[list])) value.permissions[list] = value.permissions[list].filter((rule, index) => {
      if (!directCommand(String(rule))) return true;
      excluded.push(`${location('permissions')}.${list}.${index}`); return false;
    });
  }
}
function validateSourceConfig(value, kind, label) {
  for (const key of Object.keys(value)) if (!(kind === 'codex' ? CODEX_KEYS : CLAUDE_KEYS).has(key)) fail(label, `unsupported setting ${safeKey(key)}`);
  const literalText = text => {
    const literal = text.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*(?::-)?\}/g, '').replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, '');
    if (/\$\{[^{}\r\n]*(?::[-=+?]|[-=+?])/.test(literal)) fail(label, 'credential fallback or incomplete expansion requires separate provisioning');
    return literal;
  };
  const credentialKey = key => {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) return false;
    const name = key.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_');
    return /password|secret|private_?key|api_?key|authorization|oauth|credentials?/i.test(name)
      || /(?:^|_)tokens?(?:_env_var)?$/i.test(name)
      || /(?:access|auth|refresh|bearer|id|session|csrf|xsrf)_?tokens?(?:_|$)/i.test(name);
  };
  const credentialFlag = /^--(?:token|password|api-key|client-secret)(=([\s\S]*))?$/i;
  const credentialContext = /--(?:token|password|api-key|client-secret)\b|\b(?:token|password|api[_-]?key|secret|authorization)\s*[:=]/i;
  const reviewedRetrieval = body => {
    let words;
    try { words = parseShell(body, () => { throw new Error('Dynamic retrieval command'); }); } catch { return false; }
    const operator = (word, op) => word && typeof word === 'object' && word.op === op;
    // These read already-provisioned credentials; they cannot print a supplied value.
    return (words.length === 10 && words[0] === 'security' && words[1] === 'find-generic-password'
      && words[2] === '-w' && words[3] === '-s' && typeof words[4] === 'string' && /^[\w.@ -]{1,200}$/.test(words[4])
      && words[5] === '2' && operator(words[6], '>') && words[7] === '/dev/null' && operator(words[8], '||') && words[9] === 'true')
      || (words.length === 5 && words[0] === 'tr' && words[1] === '-d' && ['\\r\\n', '\r\n'].includes(words[2])
        && operator(words[3], '<') && typeof words[4] === 'string' && /^\/[\w./ -]+$/.test(words[4]));
  };
  const inspectString = (text, depth = 0) => {
    // shell-quote does not implement shell line-continuation semantics. Refuse
    // those strings rather than interpreting part of a credential as a new word.
    if (/\\\r?\n/.test(text)) fail(label, 'continued command strings require separate credential provisioning');
    if (text.includes('$"')) fail(label, 'localised command quoting requires separate credential provisioning');
    assertSecretFree(literalText(text), label);
    const checked = text.replace(/\$\(([^()]*)\)/g, (original, body) => reviewedRetrieval(body) ? '${AIO_SETUP_ENV_REFERENCE}' : original);
    // Preserve expansion provenance while the parser joins adjacent quote contexts.
    // Original NULs are forbidden above; ANSI-C NUL escapes terminate their word.
    let words;
    try {
      words = parseShell(checked, name => {
        if (!name) return '$';
        if (/^(?:[A-Za-z_][A-Za-z0-9_]*(?::-)?|[0-9]+|[*@#?$!-])$/.test(name)) return '\0';
        throw new Error('Unsupported expansion');
      });
    } catch { fail(label, 'credential expansion could not be checked; provision the command separately'); }
    const hasCredentialContext = credentialContext.test(text) || words.some(word => credentialContext.test(typeof word === 'string' ? word : word.pattern || ''));
    if (hasCredentialContext && /\$\(|`/.test(checked)) fail(label, 'unreviewed credential substitution requires separate provisioning');
    const dynamicOnly = word => typeof word === 'string' && /^\0+$/.test(word);
    for (let index = 0; index < words.length; index++) {
      const token = words[index];
      const entry = typeof token === 'string' ? token : token.op === 'glob' ? token.pattern : null;
      if (entry === null) {
        // The parser treats an unquoted # anywhere in a word as a comment.
        // Do not let that hide a suffix or a later credential-bearing line.
        if ('comment' in token && hasCredentialContext) fail(label, 'credential command comments require separate provisioning');
        continue;
      }
      const flag = entry.match(credentialFlag);
      if (flag && !dynamicOnly(flag[1] ? flag[2] : words[index + 1])) fail(label, 'literal credential argument requires separate provisioning');
      const header = entry.match(/^authorization\s*[:=]\s*(?:Bearer|Basic)\s+([\s\S]*)$/i);
      if (header && !dynamicOnly(header[1])) fail(label, 'literal credential header requires separate provisioning');
      const nestedShell = typeof words[index - 2] === 'string' && /^(?:.*\/)?(?:sh|bash|zsh|dash|ksh)$/.test(words[index - 2])
        && typeof words[index - 1] === 'string' && /^-[a-z]*c[a-z]*$/.test(words[index - 1]);
      const assignment = entry.match(/^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/);
      if (!nestedShell && assignment && credentialKey(assignment[1]) && assignment[2] !== '' && !dynamicOnly(assignment[2])) fail(label, 'literal credential assignment requires separate provisioning');
      // Quoted arguments can themselves carry a script, even behind options or
      // another command. Inspect them without depending on a shell-option list.
      if (nestedShell || (entry !== text && /\s/.test(entry) && !assignment && !header
        && (credentialContext.test(entry) || /\\(?:x[0-9a-f]|u[0-9a-f]|[0-7])|\$['"]/i.test(entry)))) {
        if (depth >= 4) fail(label, 'nested credential command requires separate provisioning');
        inspectString(entry.replace(/\0/g, '${AIO_SETUP_ENV_REFERENCE}'), depth + 1);
      } else {
        // Quotes decoded inside a word cannot mask literal assignments/headers.
        assertSecretFree(entry.replace(/\0/g, '').replace(/['"]/g, ''), label);
      }
    }
  };
  const visit = object => {
    if (typeof object === 'string') {
      inspectString(object); return;
    }
    if (Array.isArray(object)) {
      for (let index = 0; index < object.length; index++) {
        if (typeof object[index] === 'string' && /^--(?:token|password|api-key|client-secret)$/i.test(object[index])) {
          const argument = object[index + 1];
          if (typeof argument !== 'string' || literalText(argument) !== '') fail(label, 'literal credential argument requires separate provisioning');
        }
      }
      // Standalone argv flags were checked with their following value above.
      object.filter(item => typeof item !== 'string' || !/^--(?:token|password|api-key|client-secret)$/i.test(item)).forEach(visit); return;
    }
    if (!object || typeof object !== 'object') return;
    for (const [key, child] of Object.entries(object)) {
      if (key === 'env' || (key === 'set' && object === value.shell_environment_policy)) validateEnv(child, label);
      else {
        // Env-name references contain no credential values and are retained.
        if (credentialKey(key) && !(key.endsWith('_env_var') && typeof child === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(child))) {
          fail(label, `credential setting ${safeKey(key)} requires separate provisioning`);
        }
        visit(child);
      }
    }
  };
  visit(value);
}
function quoteToml(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return String(value);
  if (Array.isArray(value)) return `[${value.map(quoteToml).join(', ')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) return `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${quoteToml(item)}`).join(', ')} }`;
  throw new Error('Unsupported TOML value; config was left untouched');
}
function serializeToml(value) {
  const lines = [];
  const emit = (object, prefix) => {
    for (const [key, item] of Object.entries(object)) {
      if (item && !Array.isArray(item) && typeof item === 'object') continue;
      lines.push(`${JSON.stringify(key)} = ${quoteToml(item)}`);
    }
    for (const [key, item] of Object.entries(object)) {
      if (!item || Array.isArray(item) || typeof item !== 'object') continue;
      const names = [...prefix, key];
      lines.push('', `[${names.map(name => JSON.stringify(name)).join('.')}]`);
      emit(item, names);
    }
  };
  emit(value, []);
  return lines.join('\n') + '\n';
}
function readConfig(text, kind, label) {
  try {
    const value = kind === 'codex' ? getStaticTOMLValue(parseTOML(text)) : JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label, 'expected an object');
    const inspect = object => {
      if (!object || typeof object !== 'object') return;
      if (!(Array.isArray(object) || [null, Object.prototype].includes(Object.getPrototypeOf(object)))) fail(label, 'unsupported value type');
      for (const [key, child] of Object.entries(object)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) fail(label, 'unsafe configuration key');
        inspect(child);
      }
    };
    inspect(value);
    return value;
  } catch { fail(label, 'configuration could not be parsed; original left untouched'); }
}
function sanitizeConfig(text, kind, { source = false, label = 'config', pathExists } = {}) {
  const value = readConfig(text, kind, label);
  if (kind === 'codex') value.plugins ??= {};
  const excluded = [];
  filterToolMaps(value, excluded);
  if (source) validateSourceConfig(value, kind, label);
  const omitted = [];
  if (pathExists) {
    const missing = object => {
      if (typeof object === 'string') return (path.isAbsolute(object) && !pathExists(object)) || [...object.matchAll(/(?:^|[\s"'=])(\/[^\s"'\],;]+)/g)].some(match => !pathExists(match[1]));
      return object && typeof object === 'object' && Object.values(object).some(missing);
    };
    for (const key of ['mcp_servers', 'projects', 'marketplaces']) {
      for (const [name, entry] of Object.entries(value[key] || {})) {
        if ((key === 'projects' && path.isAbsolute(name) && !pathExists(name)) || missing(entry)) {
          delete value[key][name]; omitted.push(`${key}.${safeKey(name)}`);
        }
      }
    }
    for (const key of ['notify', 'statusLine']) if (value[key] && missing(value[key])) { delete value[key]; omitted.push(key); }
    const checkPathEnv = object => {
      if (!object || typeof object !== 'object') return;
      for (const [key, child] of Object.entries(object)) {
        if ((key === 'env' || key === 'set') && child && typeof child === 'object') {
          for (const [envName, envValue] of Object.entries(child)) {
            if (envName === 'CCLSP_CONFIG_PATH' && typeof envValue === 'string' && !pathExists(envValue)) fail(label, `path for env key ${safeKey(envName)} is absent; provision it before syncing`);
          }
        }
        checkPathEnv(child);
      }
    };
    checkPathEnv(value);
  }
  return { text: kind === 'codex' ? serializeToml(value) : JSON.stringify(value, null, 2) + '\n', omitted, excluded };
}

module.exports = { FILES, TREES, LINKS, approvedPath, setupFileRefusal, isDirectDriver, directCommand, directSetupContent, assertSecretFree, validateSourceConfig, sanitizeConfig,
  filterCodexConfig: text => sanitizeConfig(text, 'codex').text, readConfig, serializeToml, BUNDLED_DRIVERS, SAFE_BUNDLED };
