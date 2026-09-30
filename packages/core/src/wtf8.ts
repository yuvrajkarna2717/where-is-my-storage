/**
 * WTF-8 codec for filesystem names.
 *
 * Two deliberate choices here.
 *
 * **Why not `TextEncoder`/`TextDecoder`.** This package compiles with `types: []` and
 * no DOM lib, precisely so the shared model cannot accidentally depend on one runtime.
 * Neither class is declared under those settings, and declaring them ambiently would
 * collide with `lib.dom` when these same sources are compiled for the browser.
 *
 * **Why WTF-8 rather than strict UTF-8.** Real filenames on Windows can contain
 * unpaired surrogates, which strict UTF-8 cannot represent; a strict encoder has to
 * substitute U+FFFD. That would make path reconstruction lossy, so "reveal this file
 * in Explorer" would fail on exactly the files a user is most likely to be puzzled by.
 * WTF-8 encodes an unpaired surrogate as a three-byte sequence and decodes it back
 * unchanged, so every JavaScript string round-trips byte for byte.
 */

const REPLACEMENT_CHARACTER = 0xfffd;

/** Largest number of bytes `encodeWtf8Into` can write for `value`. */
export function wtf8ByteLengthUpperBound(value: string): number {
  // A BMP code unit costs at most 3 bytes; a surrogate pair costs 4 bytes for 2 units.
  return value.length * 3;
}

/** Exact encoded byte length. Used by tests and by size accounting, not on hot paths. */
export function wtf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Encodes `value` into `destination` starting at `offset`.
 * The caller must have reserved `wtf8ByteLengthUpperBound(value)` bytes.
 *
 * @returns the number of bytes written.
 */
export function encodeWtf8Into(value: string, destination: Uint8Array, offset: number): number {
  let write = offset;
  const length = value.length;

  for (let index = 0; index < length; index += 1) {
    const unit = value.charCodeAt(index);

    if (unit < 0x80) {
      destination[write] = unit;
      write += 1;
      continue;
    }

    if (unit < 0x800) {
      destination[write] = 0xc0 | (unit >> 6);
      destination[write + 1] = 0x80 | (unit & 0x3f);
      write += 2;
      continue;
    }

    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < length) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        const codePoint = 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00);
        destination[write] = 0xf0 | (codePoint >> 18);
        destination[write + 1] = 0x80 | ((codePoint >> 12) & 0x3f);
        destination[write + 2] = 0x80 | ((codePoint >> 6) & 0x3f);
        destination[write + 3] = 0x80 | (codePoint & 0x3f);
        write += 4;
        index += 1;
        continue;
      }
    }

    // A BMP character, or an unpaired surrogate preserved verbatim as WTF-8.
    destination[write] = 0xe0 | (unit >> 12);
    destination[write + 1] = 0x80 | ((unit >> 6) & 0x3f);
    destination[write + 2] = 0x80 | (unit & 0x3f);
    write += 3;
  }

  return write - offset;
}

/** Decodes `byteLength` bytes of WTF-8 from `source` starting at `offset`. */
export function decodeWtf8(source: Uint8Array, offset: number, byteLength: number): string {
  const end = offset + byteLength;
  let read = offset;

  // Filenames are overwhelmingly ASCII; decoding those in one call avoids the
  // per-code-point work below entirely.
  let ascii = true;
  for (let probe = offset; probe < end; probe += 1) {
    if (source[probe]! >= 0x80) {
      ascii = false;
      break;
    }
  }
  if (ascii) {
    return String.fromCharCode(...source.subarray(offset, end));
  }

  let result = '';
  const units: number[] = [];

  while (read < end) {
    const lead = source[read]!;
    read += 1;
    let codePoint: number;

    if (lead < 0x80) {
      codePoint = lead;
    } else {
      // 0x80–0xc1 and 0xf5–0xff are never valid leading bytes: the first are stray
      // continuation bytes, 0xc0/0xc1 would be overlong, and the last encode code points
      // above U+10FFFF.
      const continuationCount =
        lead >= 0xc2 && lead <= 0xdf
          ? 1
          : lead >= 0xe0 && lead <= 0xef
            ? 2
            : lead >= 0xf0 && lead <= 0xf4
              ? 3
              : -1;

      if (continuationCount < 0) {
        codePoint = REPLACEMENT_CHARACTER;
      } else {
        const leadMask = continuationCount === 1 ? 0x1f : continuationCount === 2 ? 0x0f : 0x07;
        let value = lead & leadMask;
        let valid = true;

        for (let remaining = continuationCount; remaining > 0; remaining -= 1) {
          const byte = read < end ? source[read]! : -1;
          if (byte < 0x80 || byte > 0xbf) {
            valid = false;
            break;
          }
          value = (value << 6) | (byte & 0x3f);
          read += 1;
        }

        // Surrogate code points in three-byte sequences are intentionally accepted:
        // that is the WTF-8 extension this codec exists for.
        codePoint = valid && value <= 0x10ffff ? value : REPLACEMENT_CHARACTER;
      }
    }

    if (codePoint > 0xffff) {
      const shifted = codePoint - 0x10000;
      units.push(0xd800 + (shifted >> 10), 0xdc00 + (shifted & 0x3ff));
    } else {
      units.push(codePoint);
    }

    if (units.length >= 4096) {
      result += String.fromCharCode(...units);
      units.length = 0;
    }
  }

  if (units.length > 0) {
    result += String.fromCharCode(...units);
  }
  return result;
}
