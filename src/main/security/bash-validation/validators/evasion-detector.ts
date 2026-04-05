// src/main/security/bash-validation/validators/evasion-detector.ts
import type {
  BashValidatorSubmodule, SubmoduleResult, EvasionFlags,
} from '../types';

export class EvasionDetector implements BashValidatorSubmodule {
  readonly name = 'EvasionDetector';

  validate(raw: string): SubmoduleResult {
    const evasionFlags = this.detectFlags(raw);
    const flagCount = this.countFlags(evasionFlags);

    // 3+ flags = automatic block
    if (flagCount >= 3) {
      return { action: 'block', reason: `${flagCount} evasion techniques detected (threshold: 3)`, submodule: this.name };
    }

    // Individual block-level patterns
    if (evasionFlags.hasHexOctalEscape) {
      return { action: 'block', reason: 'Hex/octal/unicode escape in command', submodule: this.name };
    }
    if (evasionFlags.hasBase64Decode) {
      return { action: 'block', reason: 'Encoded data piped to shell execution', submodule: this.name };
    }
    if (evasionFlags.hasTrapDebug) {
      return { action: 'block', reason: 'trap DEBUG/EXIT persistence detected', submodule: this.name };
    }

    // Env injection: BASH_ENV, shellshock → block; LD_PRELOAD, PATH, others → warn
    // NOTE: LD_PRELOAD is warn (not block) for backward compat with harness-invariants
    if (evasionFlags.hasEnvInjection) {
      if (/\bBASH_ENV=/.test(raw) || /\(\)\s*\{/.test(raw)) {
        return { action: 'block', reason: 'Dangerous environment injection', submodule: this.name };
      }
    }

    // awk system() execution
    if (/\bawk\b.*\bsystem\s*\(/.test(raw)) {
      return { action: 'block', reason: 'awk system() execution detected', submodule: this.name };
    }

    // History manipulation (covering tracks)
    if (/\bhistory\s+-(c|d|w)\b/.test(raw) || /\bunset\s+HISTFILE\b/.test(raw)) {
      return { action: 'warn', message: 'History manipulation detected', submodule: this.name };
    }

    // Any warn-level flags
    if (flagCount > 0) {
      const names = this.getFlagNames(evasionFlags);
      return { action: 'warn', message: `Evasion signals: ${names.join(', ')}`, submodule: this.name };
    }

    return { action: 'allow' };
  }

  detectFlags(raw: string): EvasionFlags {
    return {
      hasVariableExpansion: this.checkVariableExpansion(raw),
      hasCommandSubstitution: this.checkCommandSubstitution(raw),
      hasHexOctalEscape: this.checkHexOctalEscape(raw),
      hasBase64Decode: this.checkBase64Decode(raw),
      hasPipeToShell: this.checkPipeToShell(raw),
      hasEvalExec: this.checkEvalExec(raw),
      hasWrapperCommand: false, // handled by CommandParser stripping
      hasStringSplitting: false, // merged into quoteInsertion
      hasBraceExpansion: this.checkBraceExpansion(raw),
      hasGlobAsCommand: false, // reserved
      hasIfsManipulation: this.checkIfsManipulation(raw),
      hasQuoteInsertion: this.checkQuoteInsertion(raw),
      hasEmptySubstitution: this.checkEmptySubstitution(raw),
      hasArithmeticExpansion: this.checkArithmeticExpansion(raw),
      hasTrapDebug: this.checkTrapDebug(raw),
      hasEnvInjection: this.checkEnvInjection(raw),
    };
  }

  private checkVariableExpansion(raw: string): boolean {
    // Variable embedded inside a word: c${u}at, who${x}ami
    if (/[a-zA-Z]\$\{?\w*\}?[a-zA-Z]/.test(raw)) return true;
    // Indirect reference: ${!var}
    if (/\$\{!\w+\}/.test(raw)) return true;
    // Default value expansion: ${@:-r}m
    if (/\$\{[^}]*:-[^}]*\}/.test(raw)) return true;
    return false;
  }

  private checkCommandSubstitution(raw: string): boolean {
    return /\$\(/.test(raw) || /`[^`]+`/.test(raw);
  }

  private checkHexOctalEscape(raw: string): boolean {
    // ANSI-C quoting: $'\x..', $'\1..', $'\u..'
    if (/\$'[^']*\\[xuU0-7][0-9a-fA-F]+/.test(raw)) return true;
    // echo -e with hex/octal
    if (/echo\s+-e\s+.*\\[x0][0-9a-fA-F]/.test(raw)) return true;
    // printf with hex/octal
    if (/printf\s+.*\\[x0][0-9a-fA-F]/.test(raw)) return true;
    return false;
  }

  private checkBase64Decode(raw: string): boolean {
    if (/base64\s+(-d|--decode)/.test(raw) && /\|\s*(sh|bash|zsh|eval)\b/.test(raw)) return true;
    if (/xxd\s+-r/.test(raw) && /\|\s*(sh|bash)\b/.test(raw)) return true;
    if (/\brev\b/.test(raw) && /\|\s*(sh|bash)\b/.test(raw)) return true;
    if (/gzip\s+-d/.test(raw) && /\|\s*(sh|bash)\b/.test(raw)) return true;
    return false;
  }

  private checkPipeToShell(raw: string): boolean {
    return /\|\s*(sh|bash|zsh|dash|ash|ksh|fish)\b/.test(raw) ||
           /\|\s*\$0\b/.test(raw) ||
           /\|\s*\$SHELL\b/.test(raw) ||
           /\|\s*sudo\b/.test(raw);
  }

  private checkEvalExec(raw: string): boolean {
    return /\beval\s/.test(raw) ||
           /\bexec\s/.test(raw) ||
           /\bsource\s/.test(raw) ||
           /(?:^|[;&|]\s*)\.\s+\S/.test(raw);
  }

  private checkQuoteInsertion(raw: string): boolean {
    // Only check the first token of each command segment to avoid
    // false positives on legitimate quoted arguments (e.g. "it's ready")
    const segments = raw.split(/[|;&]+/).map(s => s.trim());
    for (const segment of segments) {
      const firstToken = segment.split(/\s+/)[0];
      // letter-quote-letter: w'h'oami, c"a"t
      if (/[a-zA-Z]['"][a-zA-Z]/.test(firstToken)) return true;
      // letter-backslash-letter: c\at
      if (/[a-zA-Z]\\[a-zA-Z]/.test(firstToken)) return true;
    }
    return false;
  }

  private checkEmptySubstitution(raw: string): boolean {
    // $() empty substitution inside word
    if (/\w\$\(\)\w/.test(raw)) return true;
    // 3+ consecutive slashes (path normalization evasion)
    if (/\/{3,}/.test(raw)) return true;
    return false;
  }

  private checkBraceExpansion(raw: string): boolean {
    // {cmd,arg1,arg2} pattern at start of command or after pipe
    return /(?:^|\|)\s*\{[^}]+,[^}]+\}/.test(raw);
  }

  private checkIfsManipulation(raw: string): boolean {
    return /\bIFS=/.test(raw) || /\$\{IFS\}/.test(raw) || /\$IFS\b/.test(raw);
  }

  private checkArithmeticExpansion(raw: string): boolean {
    // a[$(cmd)] — array index with command substitution
    if (/\w\[\$\(/.test(raw)) return true;
    // $(($(cmd))) — arithmetic with embedded substitution
    if (/\$\(\(\$\(/.test(raw)) return true;
    return false;
  }

  private checkTrapDebug(raw: string): boolean {
    return /\btrap\s+['"].*['"]\s+(DEBUG|EXIT|ERR|RETURN)\b/.test(raw) ||
           /\btrap\s+\S+\s+(DEBUG|EXIT|ERR|RETURN)\b/.test(raw);
  }

  private checkEnvInjection(raw: string): boolean {
    const patterns = [
      /\bBASH_ENV=/, /\bENV=\S+\s+sh\b/, /\bPROMPT_COMMAND=/,
      /\bLD_PRELOAD=/, /\bLD_LIBRARY_PATH=/,
      /\bNODE_OPTIONS=/, /\bPYTHONPATH=/,
      /\bPATH=/, /\bVISUAL=/, /\bEDITOR=/,
      /\(\)\s*\{/, // shellshock
    ];
    return patterns.some(p => p.test(raw));
  }

  private countFlags(f: EvasionFlags): number {
    return Object.values(f).filter(Boolean).length;
  }

  private getFlagNames(f: EvasionFlags): string[] {
    const names: string[] = [];
    if (f.hasVariableExpansion) names.push('variable-expansion');
    if (f.hasCommandSubstitution) names.push('command-substitution');
    if (f.hasHexOctalEscape) names.push('hex-octal-escape');
    if (f.hasBase64Decode) names.push('base64-decode');
    if (f.hasPipeToShell) names.push('pipe-to-shell');
    if (f.hasEvalExec) names.push('eval-exec');
    if (f.hasWrapperCommand) names.push('wrapper-command');
    if (f.hasStringSplitting) names.push('string-splitting');
    if (f.hasBraceExpansion) names.push('brace-expansion');
    if (f.hasGlobAsCommand) names.push('glob-as-command');
    if (f.hasIfsManipulation) names.push('ifs-manipulation');
    if (f.hasQuoteInsertion) names.push('quote-insertion');
    if (f.hasEmptySubstitution) names.push('empty-substitution');
    if (f.hasArithmeticExpansion) names.push('arithmetic-expansion');
    if (f.hasTrapDebug) names.push('trap-debug');
    if (f.hasEnvInjection) names.push('env-injection');
    return names;
  }
}
