'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { TREES, approvedPath, setupFileRefusal, isDirectDriver, directSetupContent, sanitizeConfig } = require('./sync-policy');
const { safeDestination, validatePackage, atomicWrite, mergeMemoryIndex, inside } = require('./sync-files');
const { validateAsset } = require('./sync-assets');

function applySyncPackage(pkg, { destinationHome, stateRoots = [] }) {
  validatePackage(pkg);
  const home = fs.realpathSync(destinationHome);
  const originalConfigs = new Map();
  const readLocalConfig = target => { const text = fs.readFileSync(target, 'utf8'); originalConfigs.set(target, text); return text; };
  const operations = new Map(); const deletions = new Set(); const links = []; const omitted = []; const configExclusions = [];
  const planned = new Set([...pkg.files, ...pkg.assets].map(file => path.join(home, file.path)));
  const pathExists = target => planned.has(target) || [...planned].some(file => inside(target, file)) || fs.existsSync(target);
  const canonicalFile = relative => {
    const target = safeDestination(home, relative);
    const missing = [];
    let existing = target;
    while (!fs.existsSync(existing)) { missing.unshift(path.basename(existing)); existing = path.dirname(existing); }
    return path.join(fs.realpathSync(existing), ...missing);
  };
  for (const file of pkg.files) {
    const resolved = canonicalFile(file.path);
    const relative = path.relative(home, resolved).split(path.sep).join('/');
    const sourceTree = TREES.find(tree => file.path.startsWith(tree + '/'));
    const targetTree = TREES.find(tree => relative.startsWith(tree + '/'));
    const sharedSetupTree = sourceTree && targetTree && path.posix.basename(sourceTree) === path.posix.basename(targetTree);
    if (!approvedPath(relative) || setupFileRefusal(relative)
      || (relative !== file.path && !sharedSetupTree)) throw new Error('Setup alias would overwrite a different kind of local state; review the symlink before syncing');
  }
  for (const asset of pkg.assets) {
    if (canonicalFile(asset.path) !== path.join(home, asset.path)) throw new Error('Reviewed asset destination uses an alias; review the symlink before syncing');
  }
  const mergeConfig = (existing, incoming) => {
    const merged = { ...existing };
    for (const [key, value] of Object.entries(incoming)) {
      merged[key] = value && typeof value === 'object' && !Array.isArray(value) && existing[key] && typeof existing[key] === 'object' && !Array.isArray(existing[key])
        ? mergeConfig(existing[key], value) : value;
    }
    return merged;
  };
  const schedule = (relative, text, mode, mtimeMs) => {
    const target = canonicalFile(relative);
    operations.set(target, { target, text, mode, mtimeMs });
  };
  for (const file of pkg.files) {
    const target = safeDestination(home, file.path);
    let text = file.text;
    if (file.memory && fs.existsSync(target)) {
      if (path.basename(target) === 'MEMORY.md') text = mergeMemoryIndex(fs.readFileSync(target, 'utf8'), text);
      else if (fs.statSync(target).mtimeMs >= file.mtimeMs) continue;
    }
    if (file.path === '.claude/settings.json' || file.path === '.codex/config.toml') {
      const result = sanitizeConfig(text, file.path.endsWith('.toml') ? 'codex' : 'claude', { source: true, label: file.path, pathExists });
      text = result.text;
      configExclusions.push(...result.excluded.map(key => `${file.path}#${key}`));
      if (fs.existsSync(target)) {
        const { readConfig, serializeToml } = require('./sync-policy');
        const kind = file.path.endsWith('.toml') ? 'codex' : 'claude';
        const merged = mergeConfig(readConfig(readLocalConfig(target), kind, file.path), readConfig(text, kind, file.path));
        const mergedResult = sanitizeConfig(kind === 'codex' ? serializeToml(merged) : JSON.stringify(merged), kind, { label: file.path });
        text = mergedResult.text;
        configExclusions.push(...mergedResult.excluded.map(key => `${file.path}#${key}`));
      }
      omitted.push(...result.omitted.map(item => `${file.path}: ${item}`));
    }
    schedule(file.path, text, file.mode, file.memory ? file.mtimeMs : undefined);
  }
  for (const asset of pkg.assets) schedule(asset.path, validateAsset(asset), 0o600);
  for (const link of pkg.links) {
    const target = safeDestination(home, link.path); const source = safeDestination(home, link.target);
    if (fs.existsSync(target) && fs.lstatSync(target).isDirectory() && !fs.lstatSync(target).isSymbolicLink()) {
      throw new Error('An existing setup directory conflicts with a required link; review it before syncing');
    }
    links.push({ target, source, directory: link.target === '.agents/personas' });
  }

  // Only local config is rewritten. Auth/login values never leave this process.
  const configs = [{ relative: '.claude.json', kind: 'claude-state' },
    { relative: '.claude/settings.json', kind: 'claude' }, { relative: '.codex/config.toml', kind: 'codex' }];
  const roots = ['.orchestrator', '.ai-orchestrator', 'Library/Application Support/harness', ...stateRoots];
  for (const relative of roots) {
    const root = safeDestination(home, relative);
    for (const [folder, kind, name] of [['claude-cli-profiles', 'claude-state', '.claude.json'], ['codex-cli-profiles', 'codex', 'config.toml']]) {
      const profiles = path.join(root, folder);
      if (!fs.existsSync(profiles)) continue;
      for (const profile of fs.readdirSync(profiles)) {
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(profile)) throw new Error('Unsupported account profile folder; review it before syncing');
        const base = `${relative}/${folder}/${profile}`;
        configs.push({ relative: `${base}/${name}`, kind });
        if (kind === 'claude-state') configs.push({ relative: `${base}/settings.json`, kind: 'claude' });
      }
    }
  }
  for (const config of configs) {
    const target = canonicalFile(config.relative);
    if (!fs.existsSync(target) || operations.has(target)) continue;
    const result = sanitizeConfig(readLocalConfig(target), config.kind, { label: config.relative });
    configExclusions.push(...result.excluded.map(key => `${config.relative}#${key}`));
    if (result.text !== fs.readFileSync(target, 'utf8')) schedule(config.relative, result.text, 0o600);
  }
  // Inspect the current bundled catalog on every sync. Unknown capabilities
  // refuse the sync; no plugins are copied or removed from Codex's catalog.
  const bundled = safeDestination(home, '.codex/.tmp/bundled-marketplaces/openai-bundled/plugins');
  if (fs.existsSync(bundled)) {
    const config = safeDestination(home, '.codex/config.toml');
    let text = operations.get(config)?.text ?? (fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : '');
    const { readConfig, serializeToml, BUNDLED_DRIVERS, SAFE_BUNDLED } = require('./sync-policy');
    const value = readConfig(text, 'codex', '.codex/config.toml');
    value.plugins ??= {};
    for (const plugin of fs.readdirSync(bundled)) {
      if (!/^[\w-]+$/.test(plugin)) throw new Error('Unsupported bundled plugin name; config was left untouched');
      if (isDirectDriver(plugin) || BUNDLED_DRIVERS.includes(plugin)) value.plugins[`${plugin}@openai-bundled`] = { ...value.plugins[`${plugin}@openai-bundled`], enabled: false };
      else if (!SAFE_BUNDLED.has(plugin)) throw new Error('Unclassified bundled plugin found; review its capabilities before syncing');
    }
    text = serializeToml(value);
    schedule('.codex/config.toml', text, 0o600);
  }

  const inspectSetup = (relative, skillRoot, ancestors = new Set()) => {
    const target = safeDestination(home, relative);
    if (!fs.existsSync(target)) return;
    let stat = fs.lstatSync(target);
    const exclude = () => deletions.add(skillRoot ? safeDestination(home, skillRoot) : target);
    if (relative.split('/').some(isDirectDriver)) { exclude(); return; }
    if (stat.isSymbolicLink()) {
      const resolved = fs.realpathSync(target);
      if (!inside(home, resolved)) throw new Error('Setup filter refuses a symlink outside the destination home');
      if (isDirectDriver(resolved)) { exclude(); return; }
      stat = fs.statSync(target);
    }
    if (stat.isDirectory()) {
      const real = fs.realpathSync(target);
      if (ancestors.has(real)) throw new Error('Setup filter refuses a cyclic setup link');
      const next = new Set([...ancestors, real]);
      for (const child of fs.readdirSync(target)) inspectSetup(`${relative}/${child}`, skillRoot, next);
    } else if (stat.isFile() && (skillRoot || /(?:^|\/)(?:hooks|commands)\//.test(relative))) {
      const text = fs.readFileSync(target, 'utf8');
      if (directSetupContent(relative, text, Boolean(skillRoot))) exclude();
    }
  };
  for (const root of [...TREES.filter(root => /\/(?:skills|hooks|commands)$/.test(root)), '.codex/hooks', '.codex/commands']) {
    const absolute = safeDestination(home, root);
    if (!fs.existsSync(absolute)) continue;
    for (const child of fs.readdirSync(absolute)) inspectSetup(`${root}/${child}`, root.endsWith('/skills') ? `${root}/${child}` : undefined);
  }
  // Named homes can contain real setup folders instead of the usual shared links.
  for (const config of configs.filter(config => /\/(?:claude|codex)-cli-profiles\//.test(config.relative))) {
    const base = path.posix.dirname(config.relative);
    for (const folder of ['skills', 'hooks', 'commands']) {
      const relative = `${base}/${folder}`; const absolute = safeDestination(home, relative);
      if (!fs.existsSync(absolute)) continue;
      for (const child of fs.readdirSync(absolute)) inspectSetup(`${relative}/${child}`, folder === 'skills' ? `${relative}/${child}` : undefined);
    }
  }
  // A CLI may refresh account state during preflight; never overwrite that newer config.
  for (const [target, text] of originalConfigs) {
    if (fs.readFileSync(target, 'utf8') !== text) throw new Error('Destination config changed during preflight; retry when its CLI is idle');
  }
  // Every read, path and config has passed preflight before the first mutation.
  let changed = 0;
  for (const target of deletions) { fs.rmSync(target, { recursive: true, force: true }); changed++; }
  for (const operation of operations.values()) {
    if ([...deletions].some(root => inside(root, operation.target))) continue;
    atomicWrite(operation.target, operation.text, operation.mode);
    if (operation.mtimeMs !== undefined) fs.utimesSync(operation.target, new Date(), new Date(operation.mtimeMs));
    changed++;
  }
  for (const link of links) {
    fs.mkdirSync(path.dirname(link.target), { recursive: true, mode: 0o700 });
    if (link.directory) fs.mkdirSync(link.source, { recursive: true, mode: 0o700 });
    try { fs.lstatSync(link.target); fs.unlinkSync(link.target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.symlinkSync(link.source, link.target, link.directory ? 'dir' : 'file'); changed++;
  }
  const excludedPaths = [...new Set([...pkg.exclusions, ...configExclusions, ...[...deletions].map(target => path.relative(home, target).split(path.sep).join('/'))])];
  return { changed, omitted, exclusions: excludedPaths.length, excludedPaths };
}
module.exports = { applySyncPackage };
