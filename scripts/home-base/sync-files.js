'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { FILES, TREES, LINKS, approvedPath, setupFileRefusal, isDirectDriver, directSetupContent, assertSecretFree, validateSourceConfig, readConfig, sanitizeConfig } = require('./sync-policy');
const { isReviewedAsset, validateAsset } = require('./sync-assets');
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;

function inside(root, target) { const relative = path.relative(root, target); return !relative.startsWith('..') && !path.isAbsolute(relative); }
function safeDestination(home, relative) {
  const root = fs.realpathSync(home);
  const target = path.resolve(root, relative);
  if (!inside(root, target)) throw new Error('Sync path is outside the destination home');
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    let stat; try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink() && !inside(root, fs.realpathSync(current))) throw new Error('Sync refuses a destination symlink outside the home');
  }
  return target;
}
function buildSyncPackage({ sourceHome }) {
  const root = fs.realpathSync(sourceHome);
  const files = []; const assets = []; const exclusions = []; const refused = [];
  const refuse = (relative, message) => refused.push({ relative, message });
  const safeRoots = TREES.map(relative => path.join(root, relative));
  let bytes = 0;
  const collect = (relative, ancestors = new Set()) => {
    const absolute = path.join(root, relative);
    let stat; try { stat = fs.lstatSync(absolute); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    let real; try { real = fs.realpathSync(absolute); } catch { refuse(relative, `${relative}: broken or cyclic setup link`); return; }
    if (!inside(root, real)) { refuse(relative, `${relative}: source link outside the home`); return; }
    if (/^\.claude\/projects\/[^/]+\/memory\/\.MEMORY\.md\.before-compaction-\d{8}T\d{6}Z$/.test(relative)) {
      exclusions.push(relative); return;
    }
    if (['.DS_Store', 'Thumbs.db'].includes(path.basename(relative)) || /(?:\.(?:bak|backup|orig|swp)(?:[.-]|\d|$)|~$|\.py[co]$)/i.test(path.basename(relative))) return;
    if (relative.split('/').some(part => ['__pycache__', 'node_modules', '.git', '.tmp', '.system', '.cache', '.backup', '_backup', 'backups'].includes(part))) return;
    if (relative.split('/').some(isDirectDriver)) { exclusions.push(relative); return; }
    if (stat.isSymbolicLink()) {
      const real = fs.realpathSync(absolute);
      if (!safeRoots.some(safeRoot => inside(safeRoot, real))) { refuse(relative, `${relative}: link outside approved setup`); return; }
      if (ancestors.has(real)) { refuse(relative, `${relative}: link cycle`); return; }
      stat = fs.statSync(absolute);
    }
    if (stat.isDirectory()) {
      const real = fs.realpathSync(absolute);
      if (ancestors.has(real)) { refuse(relative, `${relative}: link cycle`); return; }
      const next = new Set([...ancestors, real]);
      for (const entry of fs.readdirSync(absolute)) collect(`${relative}/${entry}`, next);
      return;
    }
    if (!stat.isFile() || !approvedPath(relative)) { refuse(relative, `${relative}: unsupported setup file`); return; }
    if (isReviewedAsset(relative)) {
      try {
        if (stat.size > MAX_FILE_BYTES || bytes + stat.size > MAX_PACKAGE_BYTES) throw new Error(`${relative}: setup size limit exceeded`);
        const asset = { path: relative, base64: fs.readFileSync(absolute).toString('base64') };
        bytes += validateAsset(asset).length;
        assets.push(asset);
      } catch (error) { refuse(relative, `${relative}: ${error.message}`); }
      return;
    }
    const refusal = setupFileRefusal(relative);
    if (refusal) { refuse(relative, `${relative}: ${refusal}`); return; }
    if (stat.size > MAX_FILE_BYTES || bytes + stat.size > MAX_PACKAGE_BYTES) { refuse(relative, `${relative}: setup size limit exceeded`); return; }
    let text = fs.readFileSync(absolute, 'utf8');
    const skillMatch = relative.match(/^(\.(?:agents|claude|codex)\/skills\/[^/]+)\//);
    if (!skillMatch && directSetupContent(relative, text)) { exclusions.push(relative); return; }
    if (skillMatch && directSetupContent(relative, text)) {
      exclusions.push(skillMatch[1]); return;
    }
    try {
      if (relative === '.claude/settings.json' || relative === '.codex/config.toml') {
        const result = sanitizeConfig(text, relative.endsWith('.toml') ? 'codex' : 'claude', { source: true, label: relative });
        text = result.text;
        exclusions.push(...result.excluded.map(key => `${relative}#${key}`));
      } else assertSecretFree(text, relative);
    } catch (error) { refuse(relative, error.message); return; }
    bytes += Buffer.byteLength(text);
    files.push({ path: relative, text, mtimeMs: stat.mtimeMs, mode: stat.mode & 0o111 ? 0o700 : 0o600, memory: relative.includes('/memory/') });
  };
  for (const relative of FILES) collect(relative);
  for (const relative of TREES) collect(relative);
  const projects = path.join(root, '.claude', 'projects');
  if (fs.existsSync(projects)) for (const entry of fs.readdirSync(projects, { withFileTypes: true })) {
    if (entry.isDirectory()) collect(`.claude/projects/${entry.name}/memory`);
    else if (entry.isSymbolicLink()) refuse(`.claude/projects/${entry.name}`, `.claude/projects/${entry.name}: project link requires separate review`);
  }
  // A later reference can exclude its whole skill. None of that skill's files
  // are transmitted, including resources whose validation failed earlier.
  const excluded = relative => exclusions.some(item => relative === item || relative.startsWith(item + '/'));
  const retainedRefusals = refused.filter(item => !excluded(item.relative)).map(item => item.message);
  if (retainedRefusals.length) {
    const error = new Error(`Setup sync refused ${retainedRefusals.length} files; provision or review them separately:\n${retainedRefusals.slice(0, 6).join('\n')}`);
    error.refusals = retainedRefusals;
    throw error;
  }
  return { version: 2, files: files.filter(file => !excluded(file.path)), assets: assets.filter(asset => !excluded(asset.path)), links: LINKS.filter(link => fs.existsSync(path.join(root, link.target))), exclusions: [...new Set(exclusions)] };
}
function validatePackage(pkg) {
  if (pkg?.version !== 2 || !Array.isArray(pkg.files) || !Array.isArray(pkg.assets) || !Array.isArray(pkg.links) || !Array.isArray(pkg.exclusions)
    || pkg.exclusions.some(item => typeof item !== 'string') || pkg.files.length + pkg.assets.length > 20_000 || pkg.links.length > LINKS.length) throw new Error('Invalid setup transfer package');
  let bytes = 0; const paths = new Set();
  for (const file of pkg.files) {
    if (!approvedPath(file.path) || paths.has(file.path) || typeof file.text !== 'string'
      || !Number.isFinite(file.mtimeMs) || ![0o600, 0o700].includes(file.mode)
      || typeof file.memory !== 'boolean' || file.memory !== file.path.includes('/memory/')) throw new Error('Invalid setup file in transfer package');
    if (file.path.split('/').some(isDirectDriver)) throw new Error('Transfer contains a direct browser driver');
    const refusal = setupFileRefusal(file.path);
    if (refusal) throw new Error(`Transfer contains a ${refusal}`);
    if (directSetupContent(file.path, file.text)) throw new Error('Transfer contains a direct browser or desktop skill, hook or command');
    bytes += Buffer.byteLength(file.text);
    if (Buffer.byteLength(file.text) > MAX_FILE_BYTES || bytes > MAX_PACKAGE_BYTES) throw new Error('Setup transfer exceeds size limit');
    if (file.path === '.claude/settings.json' || file.path === '.codex/config.toml') {
      const kind = file.path.endsWith('.toml') ? 'codex' : 'claude';
      validateSourceConfig(readConfig(file.text, kind, file.path), kind, file.path);
    } else assertSecretFree(file.text, file.path);
    paths.add(file.path);
  }
  for (const asset of pkg.assets) {
    const data = validateAsset(asset);
    if (paths.has(asset.path)) throw new Error('Duplicate reviewed asset path');
    bytes += data.length;
    if (bytes > MAX_PACKAGE_BYTES) throw new Error('Setup transfer exceeds size limit');
    paths.add(asset.path);
  }
  for (const link of pkg.links) if (!LINKS.some(allowed => allowed.path === link.path && allowed.target === link.target)) throw new Error('Unsupported setup link');
}
function atomicWrite(filePath, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.aio-sync-${process.pid}`;
  try {
    fs.writeFileSync(temp, text, { encoding: 'utf8', mode, flag: 'wx' });
    fs.renameSync(temp, filePath);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function mergeMemoryIndex(existing, incoming) {
  const lines = existing.replace(/\n$/, '').split('\n'); const seen = new Set(lines);
  for (const line of incoming.replace(/\n$/, '').split('\n')) if (!seen.has(line)) { lines.push(line); seen.add(line); }
  return lines.join('\n') + '\n';
}
module.exports = { inside, safeDestination, buildSyncPackage, validatePackage, atomicWrite, mergeMemoryIndex };
