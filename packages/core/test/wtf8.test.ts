import { describe, expect, it } from 'vitest';
import {
  decodeWtf8,
  encodeWtf8Into,
  wtf8ByteLength,
  wtf8ByteLengthUpperBound,
} from '../src/wtf8.ts';

function roundTrip(value: string): string {
  const buffer = new Uint8Array(wtf8ByteLengthUpperBound(value));
  const written = encodeWtf8Into(value, buffer, 0);
  expect(written).toBe(wtf8ByteLength(value));
  return decodeWtf8(buffer, 0, written);
}

describe('wtf8', () => {
  it.each([
    ['empty', ''],
    ['ascii', 'package.json'],
    ['ascii with spaces', 'My Documents  folder '],
    ['latin-1 supplement', 'café résumé'],
    ['NFD composed pair', 'cafe\u0301'],
    ['cyrillic', 'файл.txt'],
    ['cjk', '日本語のファイル.txt'],
    ['emoji outside the BMP', 'holiday 🎬🏝️.mkv'],
    ['mixed planes', 'a\u00e9\u4e2d\u{1f600}z'],
    ['null byte', 'weird\u0000name'],
    ['boundary 0x7f', '\u007f'],
    ['boundary 0x80', '\u0080'],
    ['boundary 0x7ff', '\u07ff'],
    ['boundary 0x800', '\u0800'],
    ['boundary 0xffff', '\uffff'],
  ])('round-trips %s', (_label, value) => {
    expect(roundTrip(value)).toBe(value);
  });

  it('round-trips an unpaired high surrogate', () => {
    // Windows filenames can contain these. Strict UTF-8 would substitute U+FFFD and make
    // path reconstruction lossy, which would break "reveal in Explorer".
    const value = 'broken\ud800name';
    expect(roundTrip(value)).toBe(value);
  });

  it('round-trips an unpaired low surrogate', () => {
    const value = 'broken\udc00name';
    expect(roundTrip(value)).toBe(value);
  });

  it('round-trips a high surrogate at the very end of the string', () => {
    const value = 'trailing\udbff';
    expect(roundTrip(value)).toBe(value);
  });

  it('round-trips a reversed surrogate pair', () => {
    // Low followed by high is two unpaired surrogates, not a pair.
    const value = '\udc00\ud800';
    expect(roundTrip(value)).toBe(value);
  });

  it('encodes a surrogate pair as four bytes and a lone surrogate as three', () => {
    expect(wtf8ByteLength('\u{1f600}')).toBe(4);
    expect(wtf8ByteLength('\ud83d')).toBe(3);
    expect(wtf8ByteLength('\ud83d\ude00')).toBe(4);
  });

  it('writes at the requested offset without disturbing neighbouring bytes', () => {
    const buffer = new Uint8Array(32).fill(0xaa);
    const written = encodeWtf8Into('hi', buffer, 4);
    expect(written).toBe(2);
    expect(buffer[3]).toBe(0xaa);
    expect(buffer[4]).toBe('h'.charCodeAt(0));
    expect(buffer[5]).toBe('i'.charCodeAt(0));
    expect(buffer[6]).toBe(0xaa);
  });

  it('decodes only the requested slice', () => {
    const buffer = new Uint8Array(64);
    const first = encodeWtf8Into('alpha', buffer, 0);
    const second = encodeWtf8Into('日本', buffer, first);
    expect(decodeWtf8(buffer, 0, first)).toBe('alpha');
    expect(decodeWtf8(buffer, first, second)).toBe('日本');
  });

  it('reports the replacement character for a truncated sequence', () => {
    // Only reachable from corrupted persisted data; it must not throw.
    const buffer = new Uint8Array([0xe6, 0x97]);
    expect(decodeWtf8(buffer, 0, 2)).toBe('\ufffd');
  });

  it('round-trips a long name that crosses the decoder chunk boundary', () => {
    const value = '日'.repeat(5000);
    expect(roundTrip(value)).toBe(value);
  });

  it('agrees with TextEncoder byte-for-byte on every well-formed code point', () => {
    // The codec is hand-written because @sv/core compiles without ambient types, so it is
    // worth proving it matches the platform implementation wherever both are defined.
    // Lone surrogates are excluded: that is exactly where WTF-8 diverges by design.
    const encoder = new TextEncoder();
    // `ignoreBOM: true` keeps a leading U+FEFF instead of swallowing it. A filename may
    // legitimately begin with that character, and dropping it would corrupt the path.
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

    // Compared in chunks rather than one code point at a time: the platform codecs
    // dominate the runtime, and batching keeps this exhaustive check under a second.
    const CHUNK = 4096;
    for (let base = 0; base <= 0x10ffff; base += CHUNK) {
      let value = '';
      for (
        let codePoint = base;
        codePoint < base + CHUNK && codePoint <= 0x10ffff;
        codePoint += 1
      ) {
        if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
        value += String.fromCodePoint(codePoint);
      }
      if (value.length === 0) continue;

      const expected = encoder.encode(value);
      const actual = new Uint8Array(wtf8ByteLengthUpperBound(value));
      const written = encodeWtf8Into(value, actual, 0);

      expect(written).toBe(expected.length);

      // A manual scan reporting the first differing index, rather than a deep-equality
      // assertion on a 12 kB array per chunk: same coverage, far less overhead, and a
      // failure points at the exact byte.
      let mismatchAt = -1;
      for (let index = 0; index < written; index += 1) {
        if (actual[index] !== expected[index]) {
          mismatchAt = index;
          break;
        }
      }
      expect(mismatchAt, `byte mismatch in code point block starting at ${base}`).toBe(-1);
      expect(decodeWtf8(actual, 0, written)).toBe(decoder.decode(expected));
    }
  });

  it('keeps NFC and NFD forms distinct as stored bytes', () => {
    // They are the same grapheme but different filenames to the OS, so the store must
    // not silently normalise them.
    const composed = 'caf\u00e9';
    const decomposed = 'cafe\u0301';
    expect(roundTrip(composed)).toBe(composed);
    expect(roundTrip(decomposed)).toBe(decomposed);
    expect(wtf8ByteLength(composed)).not.toBe(wtf8ByteLength(decomposed));
  });
});
