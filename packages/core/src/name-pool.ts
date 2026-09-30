import { NAME_GROWTH_LINEAR_THRESHOLD, nextCapacity } from './growth.ts';
import { decodeWtf8, encodeWtf8Into, wtf8ByteLengthUpperBound } from './wtf8.ts';

/**
 * A single growable byte blob holding every filesystem name in a scan, WTF-8 encoded.
 *
 * Storing names once in a shared pool and referencing them by (offset, length) is what
 * keeps a million-entry scan affordable: JavaScript strings carry per-object overhead
 * measured in tens of bytes each, whereas here a name costs only its encoded bytes.
 *
 * Deliberately *not* deduplicated. Interning repeated names ("index.ts", "package.json")
 * would need a hash map of every distinct name, and that map costs more than the bytes it
 * saves until the duplicate rate is very high. Revisit only with measurements.
 */
export class NamePool {
  #bytes: Uint8Array;
  #length = 0;

  constructor(initialCapacity = 1 << 16) {
    this.#bytes = new Uint8Array(Math.max(initialCapacity, 1024));
  }

  /** Bytes currently in use. Also the offset the next `append` will write at. */
  get byteLength(): number {
    return this.#length;
  }

  /** Bytes currently allocated, including unused headroom. */
  get capacity(): number {
    return this.#bytes.length;
  }

  /**
   * Appends `name` and returns how many bytes it occupies.
   * Read the offset from `byteLength` *before* calling; returning a pair would allocate
   * an object per name, which at a million names is the kind of garbage this pool exists
   * to avoid.
   */
  append(name: string): number {
    const upperBound = wtf8ByteLengthUpperBound(name);
    this.#reserve(this.#length + upperBound);
    const written = encodeWtf8Into(name, this.#bytes, this.#length);
    this.#length += written;
    return written;
  }

  /** Decodes a previously appended name. */
  read(offset: number, length: number): string {
    if (offset < 0 || length < 0 || offset + length > this.#length) {
      throw new RangeError(
        `name range [${offset}, ${offset + length}) is outside the pool (length ${this.#length})`,
      );
    }
    return decodeWtf8(this.#bytes, offset, length);
  }

  /** Raw bytes in use. Exposed for persistence; do not retain across `append`. */
  view(): Uint8Array {
    return this.#bytes.subarray(0, this.#length);
  }

  /** Releases growth headroom. Worth doing once a scan has finished appending. */
  compact(): void {
    if (this.#bytes.length === this.#length) return;
    this.#bytes = this.#bytes.slice(0, this.#length);
  }

  #reserve(required: number): void {
    if (required <= this.#bytes.length) return;
    const capacity = nextCapacity(
      this.#bytes.length,
      required,
      NAME_GROWTH_LINEAR_THRESHOLD,
      1 << 16,
    );
    const grown = new Uint8Array(capacity);
    grown.set(this.#bytes.subarray(0, this.#length));
    this.#bytes = grown;
  }
}
