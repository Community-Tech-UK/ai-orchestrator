import type { AcpElicitationCreateParams } from '../../../shared/types/cli.types';
import type { AskUserQuestionEntry } from '../../../shared/types/ask-user-question.types';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function properties(params: AcpElicitationCreateParams): Record<string, unknown> | undefined {
  const schema = params.requestedSchema ?? params.schema;
  return params.mode === 'form' && record(schema?.['properties']) ? schema['properties'] : undefined;
}

function choices(schema: Record<string, unknown>): { label: string; value: unknown }[] {
  const variants = schema['oneOf'] ?? schema['anyOf'];
  if (Array.isArray(variants)) return variants.filter(record).filter((entry) => Object.hasOwn(entry, 'const'))
    .map((entry) => ({ label: String(entry['title'] ?? entry['const']), value: entry['const'] }));
  if (Array.isArray(schema['enum'])) return schema['enum'].map((value) => ({ label: String(value), value }));
  return schema['type'] === 'boolean' ? [{ label: 'Yes', value: true }, { label: 'No', value: false }] : [];
}

/** Keep the form's machine keys as headers, so answers round-trip without parsing prose. */
export function acpElicitationQuestions(params: AcpElicitationCreateParams): AskUserQuestionEntry[] | undefined {
  const fields = properties(params);
  if (!fields) return undefined;
  const questions = Object.entries(fields).slice(0, 32).flatMap(([key, schema]) => {
    if (!record(schema) || key.endsWith('_custom')) return [];
    const multiSelect = schema['type'] === 'array';
    const options = choices(multiSelect && record(schema['items']) ? schema['items'] : schema);
    return [{ header: key, question: typeof schema['title'] === 'string' ? schema['title'] : key,
      multiSelect, options: options.map(({ label }) => ({ label })) }];
  });
  return questions.length ? questions : undefined;
}

/** Restore schema enum values after the existing question UI returns selected labels. */
export function acpQuestionAnswer(params: AcpElicitationCreateParams, text: string): Record<string, unknown> | undefined {
  const fields = properties(params);
  if (!fields || !text.trimStart().startsWith('{')) return undefined;
  let answer: unknown;
  try { answer = JSON.parse(text); } catch { return undefined; }
  if (!record(answer)) return undefined;
  const result: Record<string, unknown> = { ...answer };
  for (const [key, schema] of Object.entries(fields)) {
    if (!record(schema) || !Object.hasOwn(answer, key)) continue;
    const array = schema['type'] === 'array';
    const field = array && record(schema['items']) ? schema['items'] : schema;
    const options = choices(field);
    const convert = (value: unknown) => options.find((entry) => entry.label === value)?.value ?? value;
    result[key] = array && Array.isArray(answer[key]) ? answer[key].map(convert) : convert(answer[key]);
    if (schema['type'] === 'number' || schema['type'] === 'integer') {
      const parsed = Number(result[key]);
      if (Number.isFinite(parsed)) result[key] = parsed;
    }
  }
  return result;
}
