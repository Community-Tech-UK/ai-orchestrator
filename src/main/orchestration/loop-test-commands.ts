function quoteForShell(value: string): string {
  if (process.platform === 'win32') {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function nodeEvalCommand(script: string): string {
  return `${quoteForShell(process.execPath)} -e ${quoteForShell(script)}`;
}

function jsString(value: string): string {
  return `'${value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}'`;
}

export function passingVerifyCommand(): string {
  return nodeEvalCommand('process.exit(0);');
}

export function failingVerifyCommand(): string {
  return nodeEvalCommand('process.exit(1);');
}

export function flakyOnceVerifyCommand(flagFile = 'verify-first-failed'): string {
  return nodeEvalCommand(
    `const fs=require('node:fs');const flagFile=${jsString(flagFile)};` +
      "if(fs.existsSync(flagFile))process.exit(0);fs.writeFileSync(flagFile,'1');process.exit(1);",
  );
}

export function bugFreeVerifyCommand(file = 'app.js', marker = 'BUG'): string {
  return nodeEvalCommand(
    `const fs=require('node:fs');const text=fs.readFileSync(${jsString(file)},'utf8');` +
      `process.exit(text.includes(${jsString(marker)})?1:0);`,
  );
}
