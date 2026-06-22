import type { PermissionRule } from './permission-manager';

export interface CompiledMatcher {
  test(input: string): boolean;
  ruleHash: string;
}

export function globToRegex(glob: string): RegExp {
  let result = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];

    if (ch === '*' && glob[i + 1] === '*') {
      const prevSlash = i === 0 || glob[i - 1] === '/';
      const nextSlash = i + 2 >= glob.length || glob[i + 2] === '/';
      if (prevSlash && nextSlash) {
        if (glob[i + 2] === '/') {
          result += '(?:.+/)?';
          i += 3;
        } else {
          result += '.*';
          i += 2;
        }
      } else {
        result += '.*';
        i += 2;
      }
    } else if (ch === '*') {
      result += '[^/]*';
      i++;
    } else if (ch === '?') {
      result += '[^/]';
      i++;
    } else if ('.+^${}()|[]\\'.includes(ch!)) {
      result += '\\' + ch;
      i++;
    } else {
      result += ch;
      i++;
    }
  }
  return new RegExp(`^${result}$`);
}

export function hashRules(rules: PermissionRule[]): string {
  return rules
    .filter((rule) => rule.enabled)
    .map((rule) => `${rule.id}:${rule.pattern}:${rule.action}:${rule.priority}`)
    .join('|');
}

export function compileRules(rules: PermissionRule[]): CompiledMatcher {
  const enabledRules = rules.filter((rule) => rule.enabled);
  const regexes = enabledRules.map((rule) => globToRegex(rule.pattern));
  const ruleHash = hashRules(rules);
  return {
    test: (input: string) => regexes.some((regex) => regex.test(input)),
    ruleHash,
  };
}
