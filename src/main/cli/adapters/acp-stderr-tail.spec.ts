import { describe, expect, it } from 'vitest';
import { StderrTailBuffer } from './acp-stderr-tail';

describe('StderrTailBuffer', () => {
  it('dumps joined chunks and reports undefined when empty', () => {
    const buffer = new StderrTailBuffer();
    expect(buffer.dump()).toBeUndefined();
    buffer.push('first line\n');
    buffer.push('  second line  ');
    expect(buffer.dump()).toBe('first line\nsecond line');
  });

  it('ignores blank chunks', () => {
    const buffer = new StderrTailBuffer();
    buffer.push('   \n\t');
    buffer.push('');
    expect(buffer.dump()).toBeUndefined();
  });

  it('drops the oldest chunks beyond the chunk cap', () => {
    const buffer = new StderrTailBuffer(3, 10_000);
    for (const line of ['a', 'b', 'c', 'd']) buffer.push(line);
    expect(buffer.dump()).toBe('b\nc\nd');
  });

  it('drops the oldest chunks beyond the byte cap', () => {
    const buffer = new StderrTailBuffer(10, 8);
    buffer.push('aaaa');
    buffer.push('bbbb');
    buffer.push('cccc');
    expect(buffer.dump()).toBe('bbbb\ncccc');
  });

  it('keeps at least one chunk even when it exceeds the byte cap', () => {
    const buffer = new StderrTailBuffer(10, 4);
    buffer.push('way-too-long-for-the-cap');
    expect(buffer.dump()).toBe('way-too-long-for-the-cap');
  });

  it('clear() empties the buffer', () => {
    const buffer = new StderrTailBuffer();
    buffer.push('something');
    buffer.clear();
    expect(buffer.dump()).toBeUndefined();
  });
});
