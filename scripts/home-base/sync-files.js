'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { FILES, TREES, LINKS, approvedPath, setupFileRefusal, isDirectDriver, directSetupContent, assertSecretFree, sanitizeConfig } = require('./sync-policy');
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
  const files = []; const exclusions = []; const refused = [];
  const safeRoots = TREES.map(relative => path.join(root, relative));
  let bytes = 0;
  const collect = (relative, ancestors = new Set()) => {
    const absolute = path.join(root, relative);
    let stat; try { stat = fs.lstatSync(absolute); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    let real; try { real = fs.realpathSync(absolute); } catch { refused.push(`${relative}: broken or cyclic setup link`); return; }
    if (!inside(root, real)) { refused.push(`${relative}: source link outside the home`); return; }
    if (['.DS_Store', 'Thumbs.db'].includes(path.basename(relative)) || /(?:\.(?:bak|backup|orig|swp)(?:[.-]|\d|$)|~$|\.py[co]$)/i.test(path.basename(relative))) return;
    if (relative.split('/').some(part => ['__pycache__', 'node_modules', '.git', '.tmp', '.system', '.cache', '.backup', '_backup', 'backups'].includes(part))) return;
    if (relative.split('/').some(isDirectDriver)) { exclusions.push(relative); return; }
    if (stat.isSymbolicLink()) {
      const real = fs.realpathSync(absolute);
      if (!safeRoots.some(safeRoot => inside(safeRoot, real))) { refused.push(`${relative}: link outside approved setup`); return; }
      if (ancestors.has(real)) { refused.push(`${relative}: link cycle`); return; }
      stat = fs.statSync(absolute);
    }
    if (stat.isDirectory()) {
      const real = fs.realpathSync(absolute);
      if (ancestors.has(real)) { refused.push(`${relative}: link cycle`); return; }
      const next = new Set([...ancestors, real]);
      for (const entry of fs.readdirSync(absolute)) collect(`${relative}/${entry}`, next);
      return;
    }
    if (!stat.isFile() || !approvedPath(relative)) { refused.push(`${relative}: unsupported setup file`); return; }
    const refusal = setupFileRefusal(relative);
    if (refusal) { refused.push(`${relative}: ${refusal}`); return; }
    if (stat.size > MAX_FILE_BYTES || bytes + stat.size > MAX_PACKAGE_BYTES) { refused.push(`${relative}: setup size limit exceeded`); return; }
    let text = fs.readFileSync(absolute, 'utf8');
    const skillMatch = relative.match(/^(\.(?:agents|claude|codex)\/skills\/[^/]+)\//);
    if (!skillMatch && directSetupContent(relative, text)) { exclusions.push(relative); return; }
    try {
      if (relative === '.claude/settings.json' || relative === '.codex/config.toml') {
        const result = sanitizeConfig(text, relative.endsWith('.toml') ? 'codex' : 'claude', { source: true, label: relative });
        text = result.text;
        exclusions.push(...result.excluded.map(key => `${relative}#${key}`));
      }
      assertSecretFree(text, relative);
    } catch (error) { refused.push(error.message); return; }
    if (skillMatch && directSetupContent(relative, text)) {
      exclusions.push(skillMatch[1]); return;
    }
    bytes += Buffer.byteLength(text);
    files.push({ path: relative, text, mtimeMs: stat.mtimeMs, mode: stat.mode & 0o111 ? 0o700 : 0o600, memory: relative.includes('/memory/') });
  };
  for (const relative of FILES) collect(relative);
  for (const relative of TREES) collect(relative);
  const projects = path.join(root, '.claude', 'projects');
  if (fs.existsSync(projects)) for (const entry of fs.readdirSync(projects, { withFileTypes: true })) {
    if (entry.isDirectory()) collect(`.claude/projects/${entry.name}/memory`);
    else if (entry.isSymbolicLink()) refused.push(`.claude/projects/${entry.name}: project link requires separate review`);
  }
  if (refused.length) {
    const error = new Error(`Setup sync refused ${refused.length} files; provision or review them separately:\n${refused.slice(0, 6).join('\n')}`);
    error.refusals = refused;
    throw error;
  }
  return { version: 1, files: files.filter(file => !exclusions.some(excluded => file.path === excluded || file.path.startsWith(excluded + '/'))), links: LINKS.filter(link => fs.existsSync(path.join(root, link.target))), exclusions };
}
function validatePackage(pkg) {
  if (pkg?.version !== 1 || !Array.isArray(pkg.files) || !Array.isArray(pkg.links) || !Array.isArray(pkg.exclusions)
    || pkg.exclusions.some(item => typeof item !== 'string') || pkg.files.length > 20_000 || pkg.links.length > LINKS.length) throw new Error('Invalid setup transfer package');
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
    assertSecretFree(file.text, file.path);
    paths.add(file.path);
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
