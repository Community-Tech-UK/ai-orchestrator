import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WordPieceTokenizer } from '../wordpiece-tokenizer';
import { LOCAL_EMBEDDING_MODEL } from '../embedding-model';

const VOCAB = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'hello', 'world', 'un', '##able', '##s', ',', '!', 'cafe', '日', '本'];

function tokenizerJson(overrides: Record<string, unknown> = {}): unknown {
  return {
    normalizer: { type: 'BertNormalizer', lowercase: true },
    model: {
      type: 'WordPiece',
      unk_token: '[UNK]',
      continuing_subword_prefix: '##',
      max_input_chars_per_word: 10,
      vocab: Object.fromEntries(VOCAB.map((token, index) => [token, index])),
    },
    ...overrides,
  };
}

const idOf = (token: string): number => VOCAB.indexOf(token);
const tokenizer = WordPieceTokenizer.fromJson(tokenizerJson());
const encoded = (text: string, maxTokens = 32): string[] => (
  tokenizer.encode(text, maxTokens).map((id) => VOCAB[id])
);

describe('WordPieceTokenizer', () => {
  it('wraps text in the start and end tokens', () => {
    expect(encoded('hello')).toEqual(['[CLS]', 'hello', '[SEP]']);
  });

  it('lower-cases, and splits punctuation into separate tokens', () => {
    expect(encoded('Hello, WORLD!')).toEqual(['[CLS]', 'hello', ',', 'world', '!', '[SEP]']);
  });

  it('splits an unfamiliar word into known pieces', () => {
    expect(encoded('unable')).toEqual(['[CLS]', 'un', '##able', '[SEP]']);
  });

  it('marks the whole word unknown when any piece of it is unknown', () => {
    expect(encoded('unzzz')).toEqual(['[CLS]', '[UNK]', '[SEP]']);
  });

  it('marks an overlong word unknown rather than walking it', () => {
    expect(encoded('helloworldhello')).toEqual(['[CLS]', '[UNK]', '[SEP]']);
  });

  it('strips accents', () => {
    expect(encoded('Café')).toEqual(['[CLS]', 'cafe', '[SEP]']);
  });

  it('treats each CJK character as a word', () => {
    expect(encoded('日本')).toEqual(['[CLS]', '日', '本', '[SEP]']);
  });

  it('drops control characters', () => {
    expect(encoded('hel\u0000lo')).toEqual(['[CLS]', 'hello', '[SEP]']);
  });

  it('truncates to the token limit, keeping the end token', () => {
    const ids = tokenizer.encode('hello world hello world hello world', 4);

    expect(ids).toHaveLength(4);
    expect(ids[0]).toBe(idOf('[CLS]'));
    expect(ids.at(-1)).toBe(idOf('[SEP]'));
  });

  it('handles empty text', () => {
    expect(encoded('')).toEqual(['[CLS]', '[SEP]']);
  });

  it('refuses a tokenizer it cannot reproduce', () => {
    expect(() => WordPieceTokenizer.fromJson({ model: { type: 'BPE', vocab: {} } })).toThrow('WordPiece');
    expect(() => WordPieceTokenizer.fromJson(tokenizerJson({ normalizer: { type: 'BertNormalizer', lowercase: false } })))
      .toThrow('normalizer');
  });

  it('needs the special tokens in the vocabulary', () => {
    expect(() => WordPieceTokenizer.fromJson({
      normalizer: { type: 'BertNormalizer', lowercase: true },
      model: { type: 'WordPiece', vocab: { hello: 0 } },
    })).toThrow('[CLS]');
  });
});

describe('parity with the reference tokenizer', () => {
  const tokenizerPath = path.resolve(
    __dirname, '../../../../../resources/embedding-model', LOCAL_EMBEDDING_MODEL.id, 'tokenizer.json',
  );
  const fixture = JSON.parse(
    readFileSync(path.join(__dirname, 'fixtures/bge-small-reference-token-ids.json'), 'utf8'),
  ) as { text: string; ids: number[] }[];

  // The ids came from the Hugging Face `tokenizers` library. A model produces
  // plausible but useless vectors from wrong ids, with no error to notice.
  it.skipIf(!existsSync(tokenizerPath))('produces the same ids as the reference library', () => {
    const reference = WordPieceTokenizer.fromJson(JSON.parse(readFileSync(tokenizerPath, 'utf8')));

    for (const sample of fixture) {
      expect(reference.encode(sample.text, 512), JSON.stringify(sample.text)).toEqual(sample.ids);
    }
  });
});
