/**
 * Bash Command Validator - Validate and analyze bash commands for safety
 *
 * Features:
 * - Detect dangerous commands (rm -rf, dd, mkfs, etc.)
 * - Validate command structure
 * - Check for command injection patterns
 * - Configurable allow/block patterns
 */

export interface BashValidationResult {
  valid: boolean;
  risk: 'safe' | 'warning' | 'dangerous' | 'blocked';
  message?: string;
  command: string;
  details?: {
    mainCommand: string;
    arguments: string[];
    pipes: string[];
    redirects: string[];
    warnings: string[];
    blockedPatterns: string[];
  };
}

export interface BashValidatorConfig {
  // Commands that are always blocked
  blockedCommands: string[];
  // Patterns that trigger warnings
  warningPatterns: (string | RegExp)[];
  // Patterns that are always blocked
  blockedPatterns: (string | RegExp)[];
  // Allow these commands even if they match warning patterns
  allowedCommands: string[];
  // Max command length
  maxCommandLength: number;
}

const DEFAULT_CONFIG: BashValidatorConfig = {
  blockedCommands: [
    // Disk/partition destructive commands
    'mkfs',
    'mkfs.ext4',
    'mkfs.ext3',
    'mkfs.xfs',
    'mkfs.btrfs',
    'fdisk',
    'parted',
    'dd',
    // System modification
    'init',
    'shutdown',
    'reboot',
    'halt',
    'poweroff',
    // Root modifications
    'chroot',
    'passwd',
    'usermod',
    'useradd',
    'userdel',
    'groupmod',
    'groupadd',
    'groupdel',
    // Network exploitation
    'nmap',
    'netcat',
    'nc',
    'socat',
    // Crypto mining
    'xmrig',
    'cpuminer',
    'minerd',
  ],
  warningPatterns: [
    // rm with recursive and force flags
    /rm\s+(-[rf]+\s+)*\//,
    /rm\s+-[rf]*\s+\.\./,
    // chmod/chown on system directories
    /chmod\s+-R\s+.*\//,
    /chown\s+-R\s+.*\//,
    // Writing to system files
    />\s*\/etc\//,
    />\s*\/usr\//,
    />\s*\/bin\//,
    />\s*\/sbin\//,
    // Curl/wget piped to shell
    /curl\s+.*\|\s*(?:ba)?sh/,
    /wget\s+.*\|\s*(?:ba)?sh/,
    /curl\s+.*\|\s*sudo/,
    /wget\s+.*\|\s*sudo/,
    // sudo without specific command
    /sudo\s+-i/,
    /sudo\s+su/,
    // Environment variable manipulation
    /export\s+PATH=/,
    /export\s+LD_PRELOAD/,
    /export\s+LD_LIBRARY_PATH/,
    // History manipulation
    /history\s+-c/,
    /history\s+-d/,
    // Fork bomb pattern
    /:\(\)\{\s*:\|:&\s*\};:/,
    /\(\)\{\s*:\|:&\s*\}/,
  ],
  blockedPatterns: [
    // rm -rf / variations
    /rm\s+(-[rf]+\s+)+\/($|\s)/,
    /rm\s+(-[rf]+\s+)+\/\*($|\s)/,
    /rm\s+(-[rf]+\s+)+--no-preserve-root/,
    // dd targeting disk devices
    /dd\s+.*of=\/dev\/[hs]d/,
    /dd\s+.*of=\/dev\/nvme/,
    // Overwriting boot
    />\s*\/boot\//,
    /dd\s+.*of=\/dev\/sda$/,
    // Fork bombs
    /:\(\)\{.*:\|:.*\}/,
    /\.\(\)\{.*\.\|\..*\}/,
    // Explicit rm of root
    /rm\s+\/$/,
  ],
  allowedCommands: [
    'ls',
    'cat',
    'head',
    'tail',
    'grep',
    'find',
    'echo',
    'pwd',
    'cd',
    'mkdir',
    'touch',
    'cp',
    'mv',
    'which',
    'type',
    'file',
    'stat',
    'wc',
    'sort',
    'uniq',
    'diff',
    'less',
    'more',
    'man',
    'help',
    'date',
    'cal',
    'whoami',
    'hostname',
    'uname',
    'env',
    'printenv',
  ],
  maxCommandLength: 10000,
};

export class BashValidator {
  private config: BashValidatorConfig;

  constructor(config: Partial<BashValidatorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Validate a bash command
   */
  validate(command: string): BashValidationResult {
    const trimmedCommand = command.trim();

    // Basic checks
    if (!trimmedCommand) {
      return {
        valid: false,
        risk: 'blocked',
        message: 'Empty command',
        command: trimmedCommand,
      };
    }

    if (trimmedCommand.length > this.config.maxCommandLength) {
      return {
        valid: false,
        risk: 'blocked',
        message: `Command exceeds maximum length of ${this.config.maxCommandLength}`,
        command: trimmedCommand,
      };
    }

    // Parse the command
    const parsed = this.parseCommand(trimmedCommand);

    // Check for blocked commands
    const blockedCommand = this.checkBlockedCommands(parsed.mainCommand);
    if (blockedCommand) {
      return {
        valid: false,
        risk: 'blocked',
        message: `Command '${blockedCommand}' is blocked for safety`,
        command: trimmedCommand,
        details: parsed,
      };
    }

    // Check for blocked patterns
    const blockedPatterns = this.checkBlockedPatterns(trimmedCommand);
    if (blockedPatterns.length > 0) {
      return {
        valid: false,
        risk: 'blocked',
        message: 'Command matches blocked safety patterns',
        command: trimmedCommand,
        details: {
          ...parsed,
          blockedPatterns,
        },
      };
    }

    // Check for warning patterns
    const warnings = this.checkWarningPatterns(trimmedCommand);

    // If it's an allowed command with no other issues, it's safe
    if (this.config.allowedCommands.includes(parsed.mainCommand) && warnings.length === 0) {
      return {
        valid: true,
        risk: 'safe',
        command: trimmedCommand,
        details: parsed,
      };
    }

    // Return with warnings if any
    if (warnings.length > 0) {
      return {
        valid: true,
        risk: 'warning',
        message: 'Command may have destructive effects',
        command: trimmedCommand,
        details: {
          ...parsed,
          warnings,
        },
      };
    }

    // Default: valid but potentially dangerous
    return {
      valid: true,
      risk: this.assessRisk(parsed),
      command: trimmedCommand,
      details: parsed,
    };
  }

  /**
   * Parse a bash command into components
   */
  private parseCommand(command: string): {
    mainCommand: string;
    arguments: string[];
    pipes: string[];
    redirects: string[];
    warnings: string[];
    blockedPatterns: string[];
  } {
    const pipes: string[] = [];
    const redirects: string[] = [];
    const warnings: string[] = [];
    let mainCommand = '';
    let args: string[] = [];

    // Split by pipes
    const pipeSegments = command.split(/\s*\|\s*/);
    if (pipeSegments.length > 1) {
      pipes.push(...pipeSegments.slice(1));
    }

    // Get the first segment for main command
    const firstSegment = pipeSegments[0];

    // Extract redirects
    const redirectMatches = firstSegment.match(/[<>]+\s*\S+/g);
    if (redirectMatches) {
      redirects.push(...redirectMatches);
    }

    // Clean command of redirects
    const cleanedSegment = firstSegment.replace(/[<>]+\s*\S+/g, '').trim();

    // Split into command and arguments
    const parts = this.tokenize(cleanedSegment);
    if (parts.length > 0) {
      mainCommand = parts[0];
      args = parts.slice(1);
    }

    // Strip path from command if present
    if (mainCommand.includes('/')) {
      mainCommand = mainCommand.split('/').pop() || mainCommand;
    }

    return {
      mainCommand,
      arguments: args,
      pipes,
      redirects,
      warnings,
      blockedPatterns: [],
    };
  }

  /**
   * Simple tokenizer for bash commands
   */
  private tokenize(command: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';

    for (const char of command) {
      if (inQuote) {
        if (char === quoteChar) {
          inQuote = false;
          tokens.push(current);
          current = '';
        } else {
          current += char;
        }
      } else {
        if (char === '"' || char === "'") {
          inQuote = true;
          quoteChar = char;
        } else if (char === ' ' || char === '\t') {
          if (current) {
            tokens.push(current);
            current = '';
          }
        } else {
          current += char;
        }
      }
    }

    if (current) {
      tokens.push(current);
    }

    return tokens;
  }

  /**
   * Check if the main command is blocked
   */
  private checkBlockedCommands(command: string): string | null {
    const lowerCommand = command.toLowerCase();
    for (const blocked of this.config.blockedCommands) {
      if (lowerCommand === blocked.toLowerCase()) {
        return blocked;
      }
    }
    return null;
  }

  /**
   * Check if the command matches any blocked patterns
   */
  private checkBlockedPatterns(command: string): string[] {
    const matches: string[] = [];
    for (const pattern of this.config.blockedPatterns) {
      const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
      if (regex.test(command)) {
        matches.push(pattern.toString());
      }
    }
    return matches;
  }

  /**
   * Check if the command matches any warning patterns
   */
  private checkWarningPatterns(command: string): string[] {
    const warnings: string[] = [];
    for (const pattern of this.config.warningPatterns) {
      const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
      if (regex.test(command)) {
        warnings.push(`Matches pattern: ${pattern.toString()}`);
      }
    }
    return warnings;
  }

  /**
   * Assess the risk level of a parsed command
   */
  private assessRisk(
    parsed: ReturnType<BashValidator['parseCommand']>
  ): 'safe' | 'warning' | 'dangerous' {
    const dangerousCommands = ['rm', 'rmdir', 'chmod', 'chown', 'kill', 'pkill', 'killall'];
    const warningCommands = ['mv', 'cp', 'ln', 'git', 'npm', 'yarn', 'pip'];

    if (dangerousCommands.includes(parsed.mainCommand)) {
      return 'dangerous';
    }

    if (warningCommands.includes(parsed.mainCommand)) {
      return 'warning';
    }

    // Pipes to shell are dangerous
    if (parsed.pipes.some((p) => p.includes('sh') || p.includes('bash'))) {
      return 'dangerous';
    }

    // Redirects to system directories are dangerous
    if (parsed.redirects.some((r) => r.match(/>\s*\/(?:etc|usr|bin|sbin)\//))) {
      return 'dangerous';
    }

    return 'safe';
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<BashValidatorConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Add a blocked command
   */
  addBlockedCommand(command: string): void {
    if (!this.config.blockedCommands.includes(command)) {
      this.config.blockedCommands.push(command);
    }
  }

  /**
   * Add a blocked pattern
   */
  addBlockedPattern(pattern: string | RegExp): void {
    this.config.blockedPatterns.push(pattern);
  }

  /**
   * Add an allowed command
   */
  addAllowedCommand(command: string): void {
    if (!this.config.allowedCommands.includes(command)) {
      this.config.allowedCommands.push(command);
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): BashValidatorConfig {
    return { ...this.config };
  }
}

// Singleton instance
let bashValidator: BashValidator | null = null;

export function getBashValidator(): BashValidator {
  if (!bashValidator) {
    bashValidator = new BashValidator();
  }
  return bashValidator;
}
