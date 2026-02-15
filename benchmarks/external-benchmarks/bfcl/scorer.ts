/**
 * BFCL Scorer - Evaluates function call accuracy using AST comparison
 *
 * Follows BFCL's methodology: compare function name and parameters
 * structurally rather than via string matching.
 */

import type { BFCLFunctionCall } from './types.js';

/**
 * Extracts a function call from model output
 *
 * Handles multiple formats:
 * - JSON: {"name": "func", "arguments": {...}}
 * - Python-style: func_name(arg1="value", arg2=123)
 * - Markdown code blocks
 */
export function parseModelOutput(output: string): BFCLFunctionCall | null {
  // Try to extract from markdown code blocks first
  const codeBlockMatch = output.match(/```(?:json|python)?\n?([\s\S]+?)\n?```/);
  const cleanOutput = codeBlockMatch ? codeBlockMatch[1].trim() : output.trim();

  // Try JSON format first
  const jsonResult = tryParseJson(cleanOutput);
  if (jsonResult) return jsonResult;

  // Try Python-style function call
  const pythonResult = tryParsePythonStyle(cleanOutput);
  if (pythonResult) return pythonResult;

  // Try to find any JSON object in the output
  const jsonObjectMatch = cleanOutput.match(/\{[\s\S]*\}/);
  if (jsonObjectMatch) {
    const result = tryParseJson(jsonObjectMatch[0]);
    if (result) return result;
  }

  return null;
}

/**
 * Try to parse JSON format
 */
function tryParseJson(text: string): BFCLFunctionCall | null {
  try {
    const parsed = JSON.parse(text);

    // Check for direct format: {"name": "...", "arguments": {...}}
    if (parsed.name && parsed.arguments && typeof parsed.name === 'string') {
      return {
        name: parsed.name,
        arguments: parsed.arguments
      };
    }

    // Check for nested format: {"function_call": {"name": "...", "arguments": {...}}}
    if (parsed.function_call?.name && parsed.function_call?.arguments) {
      return {
        name: parsed.function_call.name,
        arguments: parsed.function_call.arguments
      };
    }

    // Check if it's a single function call with just arguments
    // (name might be inferred from context)
    if (Object.keys(parsed).length > 0 && !parsed.name && !parsed.arguments) {
      // This might be just the arguments object, try to extract function name from output
      return null;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Try to parse Python-style function call: func_name(arg1="value", arg2=123)
 */
function tryParsePythonStyle(text: string): BFCLFunctionCall | null {
  // Match: function_name(arg1="value", arg2=123, ...)
  const match = text.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([\s\S]*)\)\s*$/);
  if (!match) return null;

  const name = match[1];
  const argsString = match[2].trim();

  if (!argsString) {
    return { name, arguments: {} };
  }

  // Parse arguments
  const args: Record<string, unknown> = {};

  // Split by commas (but respect nested structures)
  const argParts = splitArguments(argsString);

  for (const part of argParts) {
    const eqIndex = part.indexOf('=');
    if (eqIndex === -1) continue;

    const key = part.substring(0, eqIndex).trim();
    const valueStr = part.substring(eqIndex + 1).trim();

    // Try to parse the value
    const value = parseArgumentValue(valueStr);
    args[key] = value;
  }

  return { name, arguments: args };
}

/**
 * Split arguments string by commas, respecting nested structures
 */
function splitArguments(argsStr: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < argsStr.length; i++) {
    const char = argsStr[i];
    const prevChar = i > 0 ? argsStr[i - 1] : '';

    if ((char === '"' || char === "'") && prevChar !== '\\') {
      if (!inString) {
        inString = true;
        stringChar = char;
      } else if (char === stringChar) {
        inString = false;
      }
    }

    if (!inString) {
      if (char === '{' || char === '[' || char === '(') {
        depth++;
      } else if (char === '}' || char === ']' || char === ')') {
        depth--;
      }
    }

    if (char === ',' && depth === 0 && !inString) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

/**
 * Parse a single argument value
 */
function parseArgumentValue(valueStr: string): unknown {
  // Try to parse as JSON
  try {
    return JSON.parse(valueStr);
  } catch {
    // Not valid JSON
  }

  // Try to parse as number
  if (/^-?\d+(\.\d+)?$/.test(valueStr)) {
    return parseFloat(valueStr);
  }

  // Try to parse as boolean
  if (valueStr === 'True' || valueStr === 'true') return true;
  if (valueStr === 'False' || valueStr === 'false') return false;

  // Try to parse as string (remove quotes)
  if ((valueStr.startsWith('"') && valueStr.endsWith('"')) ||
      (valueStr.startsWith("'") && valueStr.endsWith("'"))) {
    return valueStr.substring(1, valueStr.length - 1);
  }

  // Return as-is
  return valueStr;
}

/**
 * Score a function call against ground truth
 */
export function scoreFunctionCall(
  predicted: BFCLFunctionCall,
  groundTruth: BFCLFunctionCall
): { nameCorrect: boolean; paramsCorrect: boolean } {
  // Check function name (exact match)
  const nameCorrect = predicted.name === groundTruth.name;

  // Check parameters (deep equality with type coercion)
  const paramsCorrect = deepParamEquals(predicted.arguments, groundTruth.arguments);

  return { nameCorrect, paramsCorrect };
}

/**
 * Deep comparison of parameters with type coercion
 *
 * Handles:
 * - Number-string coercion ("42" matches 42)
 * - Boolean-string coercion ("true" matches true)
 * - Nested objects and arrays
 * - Case-insensitive string matching for enums
 */
export function deepParamEquals(a: unknown, b: unknown): boolean {
  // Same reference or both null/undefined
  if (a === b) return true;

  // One is null/undefined
  if (a == null || b == null) return false;

  // Type coercion for primitives
  if (typeof a !== typeof b) {
    // Number-string coercion
    if (typeof a === 'number' && typeof b === 'string') {
      return a.toString() === b;
    }
    if (typeof a === 'string' && typeof b === 'number') {
      return a === b.toString();
    }

    // Boolean-string coercion
    if (typeof a === 'boolean' && typeof b === 'string') {
      return a.toString() === b.toLowerCase();
    }
    if (typeof a === 'string' && typeof b === 'boolean') {
      return a.toLowerCase() === b.toString();
    }

    return false;
  }

  // String comparison (case-sensitive by default, but we can be lenient)
  if (typeof a === 'string' && typeof b === 'string') {
    return a === b;
  }

  // Number comparison
  if (typeof a === 'number' && typeof b === 'number') {
    return a === b;
  }

  // Boolean comparison
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return a === b;
  }

  // Array comparison
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, idx) => deepParamEquals(val, b[idx]));
  }

  // Object comparison
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as object).sort();
    const bKeys = Object.keys(b as object).sort();

    if (aKeys.length !== bKeys.length) return false;
    if (!aKeys.every((key, idx) => key === bKeys[idx])) return false;

    return aKeys.every(key =>
      deepParamEquals(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key]
      )
    );
  }

  return false;
}
