const fs = require('fs');
const path = require('path');

const CHANNEL_ENTRY_PATTERN = /^\s+([A-Z0-9_]+):\s*['"]([^'"]+)['"]/;

function extractChannelsFromLines(lines) {
  const channels = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(CHANNEL_ENTRY_PATTERN);
    if (match) {
      channels.push({
        name: match[1],
        value: match[2],
        line: index + 1
      });
    }
  }

  return channels;
}

function extractIpcObjectLines(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const bodyLines = [];
  let capturing = false;
  let braceDepth = 0;

  for (const line of lines) {
    if (!capturing && line.includes('IPC_CHANNELS') && line.includes('{')) {
      capturing = true;
      braceDepth = 1;
      continue;
    }

    if (!capturing) {
      continue;
    }

    for (const ch of line) {
      if (ch === '{') braceDepth += 1;
      if (ch === '}') braceDepth -= 1;
    }

    if (braceDepth <= 0) {
      break;
    }

    bodyLines.push(line);
  }

  if (bodyLines.length === 0) {
    throw new Error(`Failed to extract IPC_CHANNELS body from ${filePath}`);
  }

  return bodyLines;
}

function extractIpcObjectChannels(filePath) {
  return extractChannelsFromLines(extractIpcObjectLines(filePath));
}

function getContractsChannelFiles(indexPath) {
  const content = fs.readFileSync(indexPath, 'utf-8');
  const lines = content.split('\n');
  const files = [];
  const importPattern =
    /^import\s+\{\s*[A-Z0-9_]+\s*\}\s+from\s+['"](\.\/[^'"]+\.channels)['"];?$/;

  for (const line of lines) {
    const match = line.match(importPattern);
    if (!match) {
      continue;
    }

    files.push(path.resolve(path.dirname(indexPath), `${match[1]}.ts`));
  }

  if (files.length === 0) {
    throw new Error(
      `Failed to discover channel definition files from ${indexPath}`
    );
  }

  return files;
}

function extractContractsChannelBody(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const bodyLines = [];
  let capturing = false;
  let braceDepth = 0;

  for (const line of lines) {
    if (!capturing && line.includes('export const') && line.includes('= {')) {
      capturing = true;
      braceDepth = 1;
      continue;
    }

    if (!capturing) {
      continue;
    }

    for (const ch of line) {
      if (ch === '{') braceDepth += 1;
      if (ch === '}') braceDepth -= 1;
    }

    if (braceDepth <= 0) {
      break;
    }

    bodyLines.push(line);
  }

  if (bodyLines.length === 0) {
    throw new Error(`Failed to extract channel block from ${filePath}`);
  }

  return bodyLines;
}

function extractContractsChannelBodyLines(indexPath) {
  const files = getContractsChannelFiles(indexPath);
  const combined = [];

  files.forEach((filePath, index) => {
    const body = extractContractsChannelBody(filePath);

    // Ensure the last key-value line ends with a comma so concatenated
    // blocks form a valid object literal (each file's last entry won't
    // have a trailing comma in its own source).
    for (let i = body.length - 1; i >= 0; i--) {
      if (CHANNEL_ENTRY_PATTERN.test(body[i])) {
        if (!body[i].trimEnd().endsWith(',')) {
          body[i] = body[i].replace(/(['"])\s*$/, '$1,');
        }
        break;
      }
    }

    combined.push(...body);
    if (index < files.length - 1) {
      combined.push('');
    }
  });

  return combined;
}

function extractContractsChannelEntries(indexPath) {
  return extractChannelsFromLines(extractContractsChannelBodyLines(indexPath));
}

module.exports = {
  extractContractsChannelBodyLines,
  extractContractsChannelEntries,
  extractIpcObjectChannels
};
