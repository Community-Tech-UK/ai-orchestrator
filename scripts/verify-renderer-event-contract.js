#!/usr/bin/env node
/**
 * Inventory main-to-renderer event sends against the central Zod registry.
 *
 * The check is strict: any statically-sent channel missing from the registry,
 * or any dynamic channel expression the scanner cannot resolve, fails the run.
 * Files listed in VALIDATED_DYNAMIC_SITE_FILES perform their own payload
 * validation (the central event-bus transport) and are exempt from the
 * dynamic-site failure.
 */

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const MAIN_ROOT = path.join(ROOT, 'src/main');
const CHANNELS_ROOT = path.join(ROOT, 'packages/contracts/src/channels');
const REGISTRY_FILE = path.join(MAIN_ROOT, 'event-bus/renderer-event-validation.ts');

/**
 * Files whose dynamic sends are safe by construction: they call
 * validateRendererEventPayload themselves before forwarding.
 */
const VALIDATED_DYNAMIC_SITE_FILES = new Set([
  'src/main/event-bus/electron-window-transport.ts',
]);

function findRendererEventSendsInSource(file, source) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sends = [];
  const localRendererSenders = findLocalRendererSenderNames(sourceFile);
  const localConstStrings = findLocalConstStrings(sourceFile);

  function visit(node) {
    if (ts.isCallExpression(node) && isRendererSendCall(node, localRendererSenders)) {
      if (!isWrapperDeclarationBodySend(node, localRendererSenders)) {
        const channels = channelKeys(node.arguments[0], sourceFile, localConstStrings);
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        if (channels.length === 0) {
          sends.push({ file, line: position.line + 1, channel: null });
        } else {
          for (const channel of channels) {
            sends.push({ file, line: position.line + 1, channel });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return sends;
}

function findRegisteredChannelsInSource(source) {
  const sourceFile = ts.createSourceFile('renderer-event-validation.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const channels = new Set();

  function visit(node) {
    if (
      ts.isVariableDeclaration(node)
      && node.name.getText(sourceFile) === 'RENDERER_EVENT_SCHEMAS'
      && node.initializer
      && ts.isNewExpression(node.initializer)
    ) {
      const entries = node.initializer.arguments?.[0];
      if (entries && ts.isArrayLiteralExpression(entries)) {
        for (const entry of entries.elements) {
          if (!ts.isArrayLiteralExpression(entry)) continue;
          const keys = channelKeys(entry.elements[0], sourceFile, new Map());
          for (const key of keys) channels.add(key);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return channels;
}

function findLocalRendererSenderNames(sourceFile) {
  const names = new Set(['sendToRenderer']);
  for (const statement of sourceFile.statements) {
    collectRendererSenderDeclarations(statement, sourceFile, names);
  }
  return names;
}

function collectRendererSenderDeclarations(node, sourceFile, names) {
  if (
    ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.initializer
    && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    const parameterNames = new Set(
      node.initializer.parameters
        .map((parameter) => parameter.name)
        .filter(ts.isIdentifier)
        .map((parameter) => parameter.text),
    );
    let forwardsChannelParameter = false;
    const inspect = (child) => {
      if (
        ts.isCallExpression(child)
        && ts.isPropertyAccessExpression(child.expression)
        && child.expression.name.text === 'sendToRenderer'
        && ts.isIdentifier(child.arguments[0])
        && parameterNames.has(child.arguments[0].text)
      ) {
        forwardsChannelParameter = true;
      }
      ts.forEachChild(child, inspect);
    };
    inspect(node.initializer.body);
    if (forwardsChannelParameter) {
      names.add(node.name.text);
    }
  }
  ts.forEachChild(node, (child) => collectRendererSenderDeclarations(child, sourceFile, names));
}

/**
 * Collect `const NAME = 'literal'` bindings so identifier channel arguments
 * (e.g. COST_BUDGET_WARNING_CHANNEL) resolve to their static value.
 */
function findLocalConstStrings(sourceFile) {
  const consts = new Map();

  function visit(node) {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && ts.isStringLiteralLike(node.initializer)
    ) {
      consts.set(node.name.text, node.initializer.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return consts;
}

/**
 * A channel-forwarding wrapper's own body contains a send whose channel is
 * just the wrapper's parameter. Its CALL sites are inventoried instead, so
 * the declaration body itself is not a real send site.
 */
function isWrapperDeclarationBodySend(node, localRendererSenders) {
  const channelArg = node.arguments[0];
  if (!channelArg || !ts.isIdentifier(channelArg)) return false;
  for (let current = node.parent; current; current = current.parent) {
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current))
      && current.parameters.some(
        (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === channelArg.text,
      )
    ) {
      const declaration = current.parent;
      return ts.isVariableDeclaration(declaration)
        && ts.isIdentifier(declaration.name)
        && localRendererSenders.has(declaration.name.text);
    }
  }
  return false;
}

function isRendererSendCall(node, localRendererSenders) {
  if (ts.isIdentifier(node.expression)) {
    return localRendererSenders.has(node.expression.text);
  }
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  const method = node.expression.name.text;
  if (method === 'sendToRenderer') return true;
  if (method !== 'send') return false;
  const owner = node.expression.expression.getText();
  return owner === 'event.sender'
    || owner === 'webContents'
    || owner.endsWith('.webContents');
}

/**
 * Resolve a channel argument to its static channel key(s). An empty result
 * means the expression is dynamic. A ternary whose branches both resolve
 * contributes every branch.
 */
function channelKeys(node, sourceFile, localConstStrings) {
  if (!node) return [];
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (
    ts.isPropertyAccessExpression(node)
    && node.expression.getText(sourceFile) === 'IPC_CHANNELS'
  ) {
    return [`IPC_CHANNELS.${node.name.text}`];
  }
  if (ts.isIdentifier(node) && localConstStrings.has(node.text)) {
    return [localConstStrings.get(node.text)];
  }
  if (ts.isParenthesizedExpression(node)) {
    return channelKeys(node.expression, sourceFile, localConstStrings);
  }
  if (ts.isConditionalExpression(node)) {
    const whenTrue = channelKeys(node.whenTrue, sourceFile, localConstStrings);
    const whenFalse = channelKeys(node.whenFalse, sourceFile, localConstStrings);
    if (whenTrue.length > 0 && whenFalse.length > 0) {
      return [...whenTrue, ...whenFalse];
    }
    return [];
  }
  return [];
}

function loadIpcChannelValues(root) {
  const values = new Map();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.channels.ts')) continue;
    const source = fs.readFileSync(path.join(root, entry.name), 'utf8');
    const pattern = /^\s*([A-Z0-9_]+):\s*'([^']+)'/gm;
    for (const match of source.matchAll(pattern)) {
      values.set(`IPC_CHANNELS.${match[1]}`, match[2]);
    }
  }
  return values;
}

function normalizeChannelKey(channel, values) {
  return channel ? values.get(channel) ?? channel : null;
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
  const channelValues = loadIpcChannelValues(CHANNELS_ROOT);
  const registered = new Set(
    [...findRegisteredChannelsInSource(fs.readFileSync(REGISTRY_FILE, 'utf8'))]
      .map((channel) => normalizeChannelKey(channel, channelValues)),
  );
  const sends = listProductionTypeScriptFiles(MAIN_ROOT).flatMap((file) =>
    findRendererEventSendsInSource(path.relative(ROOT, file), fs.readFileSync(file, 'utf8')))
    .map((send) => ({ ...send, channel: normalizeChannelKey(send.channel, channelValues) }));
  const staticSends = sends.filter((send) => send.channel);
  const uncovered = staticSends.filter((send) => !registered.has(send.channel));
  const uniqueUncovered = [...new Set(uncovered.map((send) => send.channel))].sort();
  const dynamic = sends.filter((send) => !send.channel);
  const unexpectedDynamic = dynamic.filter((send) => !VALIDATED_DYNAMIC_SITE_FILES.has(send.file));

  console.log(
    `Renderer event contracts: ${registered.size} registered; `
    + `${new Set(staticSends.map((send) => send.channel)).size} statically-sent channels; `
    + `${uniqueUncovered.length} uncovered.`,
  );
  for (const channel of uniqueUncovered) {
    const first = uncovered.find((send) => send.channel === channel);
    console.log(`  ${channel} (${first.file}:${first.line})`);
  }
  if (unexpectedDynamic.length > 0) {
    console.log(`Unresolved dynamic renderer channel sites: ${unexpectedDynamic.length}`);
    for (const send of unexpectedDynamic) {
      console.log(`  ${send.file}:${send.line}`);
    }
  }

  if (uniqueUncovered.length > 0 || unexpectedDynamic.length > 0) {
    process.exit(1);
  }
}

module.exports = {
  findRegisteredChannelsInSource,
  findRendererEventSendsInSource,
  normalizeChannelKey,
};

if (require.main === module) {
  main();
}
