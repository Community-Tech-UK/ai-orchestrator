import type { BashValidatorSubmodule, ParsedCommand, ValidationContext, SubmoduleResult } from '../types';

const SYSTEM_PATHS = ['/etc/', '/usr/', '/var/', '/boot/', '/sys/', '/proc/', '/dev/', '/sbin/', '/lib/'];

export class SedValidator implements BashValidatorSubmodule {
  readonly name = 'SedValidator';

  validate(raw: string, parsed: ParsedCommand, context: ValidationContext): SubmoduleResult {
    const hasSed = parsed.segments.some(s => s.mainCommand === 'sed');
    if (!hasSed) return { action: 'allow' };

    // sed write flag: s/.../w /path
    if (/sed\b.*['"].*\/w\s+\//.test(raw) || /sed\b.*\/w\s+\//.test(raw)) {
      return { action: 'block', reason: 'sed write flag can write to arbitrary files', submodule: this.name };
    }

    // sed execute flag: -n '1e CMD' (GNU extension)
    if (/sed\b.*['"]?\d*e\s/.test(raw) && /sed\s+-n\b/.test(raw)) {
      return { action: 'block', reason: 'sed execute flag can run arbitrary commands', submodule: this.name };
    }

    // sed -i in read_only mode
    if (/sed\s+-i\b/.test(raw)) {
      if (context.mode === 'read_only') {
        return { action: 'block', reason: 'sed -i (in-place edit) blocked in read-only mode', submodule: this.name };
      }
      if (context.mode === 'workspace_write') {
        for (const sysPath of SYSTEM_PATHS) {
          if (raw.includes(sysPath)) {
            return { action: 'warn', message: `sed -i targets system path ${sysPath}`, submodule: this.name };
          }
        }
      }
    }

    return { action: 'allow' };
  }
}
