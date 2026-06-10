#!/usr/bin/env node
import puppeteer from 'puppeteer-core';
import { AxePuppeteer } from '@axe-core/puppeteer';

const DEFAULT_TIMEOUT_MS = 60_000;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = 'true';
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function usage() {
  return [
    'Usage: axe-audit --browser-url <cdp-url> --page-url <url> [--tags wcag2a,wcag2aa] [--viewport 1440x900]',
    '',
    'Examples:',
    '  axe-audit --browser-url http://127.0.0.1:9222 --page-url https://example.com',
    '  axe-audit --browser-url http://127.0.0.1:9222 --page-url http://localhost:4200 --viewport 390x844 --tags wcag2a,wcag2aa',
  ].join('\n');
}

function parseViewport(value) {
  if (!value) {
    return undefined;
  }
  const match = String(value).match(/^(\d{2,5})x(\d{2,5})$/i);
  if (!match) {
    throw new Error(`Invalid --viewport value "${value}". Expected WIDTHxHEIGHT.`);
  }
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid --viewport value "${value}".`);
  }
  return { width, height };
}

function parseTags(value) {
  if (!value) {
    return undefined;
  }
  const tags = String(value)
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const browserURL = args['browser-url'];
  const pageUrl = args['page-url'];
  if (!browserURL || !pageUrl || args.help === 'true') {
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  const viewport = parseViewport(args.viewport);
  const tags = parseTags(args.tags);
  const timeoutMs = args.timeout
    ? Number.parseInt(args.timeout, 10)
    : DEFAULT_TIMEOUT_MS;

  let browser;
  let page;
  try {
    browser = await puppeteer.connect({
      browserURL,
      defaultViewport: viewport ?? null,
    });
    page = await browser.newPage();
    if (viewport) {
      await page.setViewport(viewport);
    }
    await page.goto(pageUrl, {
      waitUntil: 'networkidle2',
      timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    });

    let axe = new AxePuppeteer(page);
    if (tags) {
      axe = axe.withTags(tags);
    }
    const results = await axe.analyze();
    const payload = {
      url: results.url,
      requestedUrl: pageUrl,
      viewport: viewport ?? null,
      tags: tags ?? null,
      violations: results.violations,
      passesCount: results.passes.length,
      incompleteCount: results.incomplete.length,
      inapplicableCount: results.inapplicable.length,
      timestamp: new Date().toISOString(),
    };
    console.log(JSON.stringify(payload, null, 2));
  } finally {
    if (page) {
      await page.close().catch(() => undefined);
    }
    if (browser) {
      await browser.disconnect();
    }
  }
}

run().catch((error) => {
  console.error(JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
