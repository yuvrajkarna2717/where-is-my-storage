/**
 * Growth policy for the columnar store.
 *
 * Pure doubling is the usual choice, but at a million nodes the final reallocation
 * would hold both the old and the new columns at once, roughly 2.5x the steady-state
 * footprint for the duration of the copy. Since low memory usage is an explicit product
 * priority, capacity doubles only while it is small and then grows by a fixed increment,
 * which bounds the transient overhead by a constant instead of a proportion.
 *
 * Amortised cost stays acceptable: reaching 10M nodes with a 1M increment copies about
 * 50M elements in total, which is milliseconds of memcpy.
 */

/** Element count at which node columns switch from doubling to fixed increments. */
export const NODE_GROWTH_LINEAR_THRESHOLD = 1 << 20;

/** Byte count at which the name pool switches from doubling to fixed increments. */
export const NAME_GROWTH_LINEAR_THRESHOLD = 16 << 20;

/**
 * Smallest capacity >= `required`, following the doubling-then-linear policy.
 *
 * @param current existing capacity
 * @param required capacity the caller needs
 * @param linearThreshold capacity beyond which growth becomes additive
 * @param minimum floor for the first allocation
 */
export function nextCapacity(
  current: number,
  required: number,
  linearThreshold: number,
  minimum: number,
): number {
  if (required <= current) return current;

  let capacity = current > 0 ? current : minimum;
  while (capacity < required) {
    capacity = capacity < linearThreshold ? capacity * 2 : capacity + linearThreshold;
  }
  return capacity;
}
