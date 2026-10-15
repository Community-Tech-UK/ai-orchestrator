import { describe, expect, it } from 'vitest';
import { dataBlock, escapeClosingTag } from './prompt-data';
describe('prompt data', () => {
  it('neutralises closing tags case insensitively', () => {
    expect(escapeClosingTag('a </DATA> b </data x>', 'data')).toBe('a <\\/DATA> b <\\/data x>');
  });
  it('caps payload before escaping and keeps a real closing delimiter', () => {
    expect(dataBlock('data', 'abcdef', 3)).toBe('<data>\nabc\n</data>');
  });
});
