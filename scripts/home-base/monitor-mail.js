#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { registerHooks } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { fileURLToPath, pathToFileURL } = require('node:url');

const TOKEN_TIMEOUT_MS = 5_000;
const SMTP_DEADLINE_MS = 11_000;
const SENT_LOOKUP_MS = 15_000;
const COMMAND_DEADLINE_MS = 18_000; // monitor.js stops the child after 20 seconds.
const MAX_INPUT_BYTES = 1024 * 1024;
const MAIL_DOMAIN = 'communitytech.co.uk';
const LEDGER_NAME = 'monitor-mail-ledger.sqlite';

function assertPrivate(stat) {
  // Windows ACLs are set by install-monitor.ps1 and inherited in this folder.
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('The mail configuration, certificate and ledger must be owner-only');
  }
}

function privateFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Expected a regular private mail file');
  assertPrivate(stat);
  return stat;
}

function readConfig(file) {
  if (!path.isAbsolute(file)) throw new Error('Expected the full path to the private mail configuration');
  const directory = fs.realpathSync(path.dirname(file));
  assertPrivate(fs.statSync(directory));
  for (let parent = directory; ; parent = path.dirname(parent)) {
    if (fs.existsSync(path.join(parent, '.git'))) throw new Error('Keep the mail configuration outside checkouts');
    if (parent === path.dirname(parent)) break;
  }
  const configFile = path.join(directory, path.basename(file));
  if (privateFile(configFile).size > 8192) throw new Error('The mail configuration is too large');
  const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (typeof raw?.address !== 'string'
    || !/^[a-z0-9]+(?:[._+-][a-z0-9]+)*@communitytech\.co\.uk$/i.test(raw.address)
    || typeof raw.tenantId !== 'string' || typeof raw.clientId !== 'string' || typeof raw.certThumbprint !== 'string'
    || typeof raw.privateKeyFile !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}\.(?:pem|key)$/i.test(raw.privateKeyFile)) {
    throw new Error('Expected a single Community Tech inbox and a local Microsoft 365 certificate configuration');
  }
  return {
    directory,
    bundle: path.join(directory, 'imap-mcp-server'),
    address: raw.address.toLowerCase(),
    auth: { type: 'm365-app-cert', tenantId: raw.tenantId, clientId: raw.clientId, certThumbprint: raw.certThumbprint,
      privateKeyFile: path.join(directory, raw.privateKeyFile) },
  };
}

async function readAlert(input) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of input) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) throw new Error('The mail alert is too large');
    chunks.push(chunk);
  }
  const alert = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!alert || typeof alert !== 'object' || Object.keys(alert).length !== 3
    || typeof alert.id !== 'string' || !alert.id.trim() || alert.id.length > 200
    || typeof alert.subject !== 'string' || !alert.subject.trim() || /[\r\n\0]/.test(alert.subject)
    || typeof alert.text !== 'string' || !alert.text.trim()) {
    throw new Error('Expected one mail alert with an id, subject and text');
  }
  return alert;
}

function openLedger(directory) {
  const file = path.join(directory, LEDGER_NAME);
  try { privateFile(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const database = new DatabaseSync(file);
  try {
    // A transaction must reach disk before SMTP begins or acceptance is reported.
    database.exec(`
      PRAGMA busy_timeout = 750;
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = EXTRA;
      CREATE TABLE IF NOT EXISTS delivery (
        message_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('pending', 'accepted'))
      );
    `);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function checkCodePath(file, directory) {
  const stat = fs.lstatSync(file);
  if ((directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
    || path.relative(file, fs.realpathSync.native(file)) !== '') {
    throw new Error('Expected mail code directly inside the private installed bundle');
  }
}

function insideBundle(bundle, url) {
  if (!url?.startsWith('file:')) return false;
  const relative = path.relative(bundle, fileURLToPath(url));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function guardBundleImports(bundle) {
  checkCodePath(bundle, true);
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      // A missing installed dependency must never be satisfied from an ancestor or NODE_PATH.
      if (insideBundle(bundle, context.parentURL) && !resolved.url.startsWith('node:')) {
        if (!insideBundle(bundle, resolved.url)) throw new Error('A mail dependency resolved outside the private installed bundle');
        checkCodePath(fileURLToPath(resolved.url), false);
      }
      return resolved;
    },
  });
}

function pinnedBundleFile(bundle, ...parts) {
  let file = bundle;
  for (const [index, part] of parts.entries()) {
    file = path.join(file, part);
    checkCodePath(file, index < parts.length - 1);
  }
  return file;
}

function pinnedMailModule(config, name) {
  return import(pathToFileURL(pinnedBundleFile(config.bundle, 'dist', name)).href);
}

async function loadTokenProvider(config) {
  privateFile(config.auth.privateKeyFile);
  const { M365CertificateTokenProvider } = await pinnedMailModule(config, 'm365-token.js');
  return new M365CertificateTokenProvider(config.auth, { timeoutMs: TOKEN_TIMEOUT_MS });
}

async function reconcile(config, messageId) {
  const { ImapClient } = await pinnedMailModule(config, 'imap-client.js');
  const client = new ImapClient({
    host: 'outlook.office365.com', port: 993, tls: true, user: config.address, auth: config.auth,
  }, await loadTokenProvider(config));
  // One bounded, read-only poll. An absent copy never proves that SMTP refused the message.
  const result = await client.findSentByMessageId(messageId, {
    timeoutMs: SENT_LOOKUP_MS, intervalMs: SENT_LOOKUP_MS + 1, minPollMs: SENT_LOOKUP_MS,
  });
  return result.found === true;
}

async function prepareSend(config, messageId, alert) {
  const composerFile = pinnedBundleFile(config.bundle, 'node_modules', 'nodemailer', 'lib', 'nodemailer.js');
  const { runM365SmtpSession } = await pinnedMailModule(config, 'm365-smtp.js');
  const nodemailer = require(composerFile);
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
  const { message } = await composer.sendMail({
    from: config.address, to: config.address, messageId, subject: alert.subject, text: alert.text,
  });
  const token = await (await loadTokenProvider(config)).token();
  return () => runM365SmtpSession({
    host: 'smtp.office365.com', port: 587, requireTLS: true, user: config.address, accessToken: token.value,
    connectionTimeout: 7_000, greetingTimeout: 7_000, socketTimeout: SMTP_DEADLINE_MS, deadlineMs: SMTP_DEADLINE_MS,
  }, { kind: 'send', envelope: { from: config.address, to: [config.address] }, raw: message });
}

function definitelyRefused(error) {
  // A dropped socket can carry a partial reply and a response code. EMESSAGE
  // with a negative code comes from Nodemailer's complete SMTP DATA response.
  return error?.endOfDataSent === false
    || (error?.code === 'EMESSAGE' && Number.isInteger(error.responseCode)
      && error.responseCode >= 400 && error.responseCode < 600);
}

async function deliver(config, alert) {
  const digest = createHash('sha256').update(alert.id).digest('hex');
  const messageId = `<home-base-monitor.${digest}@${MAIL_DOMAIN}>`;
  const database = openLedger(config.directory);
  try {
    const state = database.prepare('SELECT state FROM delivery WHERE message_id = ?');
    const accepted = database.prepare("UPDATE delivery SET state = 'accepted' WHERE message_id = ?");
    const previous = state.get(messageId)?.state;
    if (previous === 'accepted') return true;
    guardBundleImports(config.bundle);
    if (previous === 'pending') {
      if (!await reconcile(config, messageId)) return false;
      return accepted.run(messageId).changes === 1;
    }

    // Finish preparing the message and getting a token before claiming the send.
    const send = await prepareSend(config, messageId, alert);
    const claim = database.prepare("INSERT INTO delivery VALUES (?, 'pending') ON CONFLICT DO NOTHING");
    if (claim.run(messageId).changes !== 1) return state.get(messageId)?.state === 'accepted';

    let result;
    try { result = await send(); }
    catch (error) {
      if (definitelyRefused(error)) {
        database.prepare("DELETE FROM delivery WHERE message_id = ? AND state = 'pending'").run(messageId);
      }
      return false;
    }
    if (result?.accepted?.length !== 1 || result.accepted[0]?.toLowerCase() !== config.address
      || result.rejected?.length !== 0) return false;
    return accepted.run(messageId).changes === 1;
  } finally {
    database.close();
  }
}

async function main() {
  const [flag, file, ...extra] = process.argv.slice(2);
  if (flag !== '--config' || !file || extra.length) throw new Error('Expected --config <private monitor-mail.json>');
  if (process.platform !== 'win32') process.umask(0o077);
  const config = readConfig(file);
  return deliver(config, await readAlert(process.stdin));
}

function exitWithFailure() {
  // The monitor also suppresses child output. Never print credentials or provider errors here.
  fs.writeSync(2, 'The mail command could not confirm acceptance. The monitor alert remains queued.\n');
  process.exit(1);
}

setTimeout(exitWithFailure, COMMAND_DEADLINE_MS);
void main().then(accepted => {
  if (!accepted) exitWithFailure();
  // Any leftover mail connection can be closed now that the ledger is durable.
  process.exit(0);
}, exitWithFailure);
