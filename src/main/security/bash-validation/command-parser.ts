// src/main/security/bash-validation/command-parser.ts
import type { ParsedCommand, CommandSegment } from './types';

const WRAPPERS = new Set(['env', 'time', 'nice', 'ionice', 'nohup', 'setsid', 'stdbuf', 'rlwrap']);
const WRAPPERS_WITH_ARG = new Set(['timeout', 'watch']);

export class CommandParser {
  parse(command: string): ParsedCommand {
    const trimmed = command.trim();
    if (!trimmed) {
      return { raw: command, segments: [] };
    }
    const rawSegments = this.splitCompound(trimmed);
    return {
      raw: command,
      segments: rawSegments.map(seg => this.parseSegment(seg.text, seg.backgrounded)),
    };
  }

  private splitCompound(command: string): { text: string; backgrounded: boolean }[] {
    const segments: { text: string; backgrounded: boolean }[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let i = 0;

    while (i < command.length) {
      const ch = command[i];

      if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; i++; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; i++; continue; }
      if (inSingle || inDouble) { current += ch; i++; continue; }

      if (ch === ';') {
        if (current.trim()) segments.push({ text: current.trim(), backgrounded: false });
        current = '';
        i++;
        continue;
      }
      if (ch === '&' && command[i + 1] === '&') {
        if (current.trim()) segments.push({ text: current.trim(), backgrounded: false });
        current = '';
        i += 2;
        continue;
      }
      if (ch === '|' && command[i + 1] === '|') {
        if (current.trim()) segments.push({ text: current.trim(), backgrounded: false });
        current = '';
        i += 2;
        continue;
      }
      if (ch === '&') {
        if (current.trim()) segments.push({ text: current.trim(), backgrounded: true });
        current = '';
        i++;
        continue;
      }

      current += ch;
      i++;
    }

    if (current.trim()) segments.push({ text: current.trim(), backgrounded: false });
    return segments;
  }

  private parseSegment(text: string, backgrounded: boolean): CommandSegment {
    const pipeSegments = this.splitPipes(text);
    const firstPipe = pipeSegments[0];
    const pipes = pipeSegments.slice(1);

    const { cleaned, redirects } = this.extractRedirects(firstPipe);
    const tokens = this.tokenize(cleaned);
    const stripped = this.stripPrivilegeEscalation(tokens);
    const unwrapped = this.stripWrappers(stripped);

    let mainCommand = unwrapped[0] || '';
    const args = unwrapped.slice(1);

    if (mainCommand.includes('/')) {
      mainCommand = mainCommand.split('/').pop() || mainCommand;
    }

    return { mainCommand, rawSegment: text, arguments: args, pipes, redirects, backgrounded };
  }

  private splitPipes(command: string): string[] {
    const segments: string[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let i = 0;

    while (i < command.length) {
      const ch = command[i];
      if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; i++; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; i++; continue; }
      if (inSingle || inDouble) { current += ch; i++; continue; }

      if (ch === '|' && command[i + 1] !== '|') {
        segments.push(current.trim());
        current = '';
        i++;
        continue;
      }

      current += ch;
      i++;
    }

    if (current.trim()) segments.push(current.trim());
    return segments;
  }

  private extractRedirects(command: string): { cleaned: string; redirects: string[] } {
    const redirects: string[] = [];
    const pattern = /(?:2>>?|>>?|<|>&|&>)\s*\S+/g;
    const matches = command.match(pattern);
    if (matches) redirects.push(...matches.map(m => m.trim()));
    const cleaned = command.replace(pattern, '').trim();
    return { cleaned, redirects };
  }

  private tokenize(command: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;

    for (const ch of command) {
      if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
      if (!inSingle && !inDouble && (ch === ' ' || ch === '\t')) {
        if (current) { tokens.push(current); current = ''; }
        continue;
      }
      current += ch;
    }
    if (current) tokens.push(current);
    return tokens;
  }

  private stripPrivilegeEscalation(tokens: string[]): string[] {
    if (tokens.length === 0) return tokens;
    const first = tokens[0];

    if (first === 'sudo' || first === 'doas' || first === 'pkexec') {
      let i = 1;
      while (i < tokens.length && tokens[i].startsWith('-')) {
        if (tokens[i] === '-u' && i + 1 < tokens.length) { i += 2; }
        else { i++; }
      }
      return tokens.slice(i).length > 0 ? tokens.slice(i) : tokens;
    }

    if (first === 'su' && tokens.includes('-c')) {
      const cIdx = tokens.indexOf('-c');
      return tokens.slice(cIdx + 1);
    }

    return tokens;
  }

  private stripWrappers(tokens: string[]): string[] {
    if (tokens.length <= 1) return tokens;
    const first = tokens[0];

    if (first === 'env') {
      let i = 1;
      while (i < tokens.length && tokens[i].includes('=')) i++;
      return i < tokens.length ? tokens.slice(i) : tokens;
    }

    if (WRAPPERS.has(first)) {
      return tokens.slice(1);
    }

    if (WRAPPERS_WITH_ARG.has(first) && tokens.length > 2) {
      return tokens.slice(2);
    }

    if (first === 'script' && tokens.includes('-c')) {
      const cIdx = tokens.indexOf('-c');
      return tokens.slice(cIdx + 1);
    }

    return tokens;
  }
}
