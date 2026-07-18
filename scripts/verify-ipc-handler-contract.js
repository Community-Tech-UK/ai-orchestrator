#!/usr/bin/env node
/**
 * Prevent raw direct ipcMain.handle callbacks from re-entering the main process.
 *
 * Direct registrations must either use validatedHandler(...) or declare an
 * IpcResponse return type. Subsystem registrars may still centralize direct
 * calls behind their own typed helper.
 */

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const MAIN_ROOT = path.join(ROOT, 'src/main');

function findUnsafeHandlersInSource(file, source) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const findings = [];

  function visit(node) {
    if (ts.isCallExpression(node) && isDirectIpcMainHandle(node)) {
      const listener = node.arguments[1];
      if (!listener || !hasStructuredContract(listener, sourceFile)) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        findings.push({
          file,
          line: position.line + 1,
          channel: node.arguments[0]?.getText(sourceFile) ?? '<missing>',
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

function isDirectIpcMainHandle(node) {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  return node.expression.expression.getText() === 'ipcMain'
    && node.expression.name.text === 'handle';
}

function hasStructuredContract(listener, sourceFile) {
  if (ts.isCallExpression(listener)) {
    return listener.expression.getText(sourceFile) === 'validatedHandler';
  }
  if (!ts.isArrowFunction(listener) && !ts.isFunctionExpression(listener)) {
    return false;
  }
  const returnType = listener.type?.getText(sourceFile) ?? '';
  return /\bIpcResponse(?:\s*<|\b)/.test(returnType);
}

function listProductionTypeScriptFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') stack.push(full);
      } else if (
        entry.isFile()
        && entry.name.endsWith('.ts')
        && !entry.name.endsWith('.spec.ts')
        && !entry.name.endsWith('.test.ts')
      ) {
        files.push(full);
      }
    }
  }
  return files;
}

function main() {
  const findings = listProductionTypeScriptFiles(MAIN_ROOT).flatMap((file) =>
    findUnsafeHandlersInSource(
      path.relative(ROOT, file),
      fs.readFileSync(file, 'utf8'),
    ));

  if (findings.length > 0) {
    console.error('Unsafe direct ipcMain.handle registrations:');
    for (const finding of findings) {
      console.error(`  ${finding.file}:${finding.line} ${finding.channel}`);
    }
    console.error('Use validatedHandler(...) or declare an IpcResponse return type.');
    process.exit(1);
  }

  console.log('IPC handler contract check passed.');
}

module.exports = { findUnsafeHandlersInSource };

if (require.main === module) {
  main();
}
