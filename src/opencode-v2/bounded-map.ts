/**
 * Bounded, recency-ordered map for per-session in-memory bookkeeping.
 *
 * The orchestration runtime keeps several small maps keyed by session ID
 * (`summaryBySession`, trace event markers). Only entries whose loss cannot
 * affect a safety decision may be evicted; live dispatch guards, idle-event
 * markers, and budget-enforcement counters are retained by their owners. This helper caps disposable entries
 * and drops the least-recently-used eligible key.
 *
 * Semantics:
 * - `get` touches the key, so iteration order is least-recently-used first.
 * - `set` on an existing key refreshes recency; overflow evicts the oldest
 *   entry the caller has not protected via `evictable`.
 * - When every entry is protected the map is allowed to exceed `limit`
 *   temporarily: correctness (never dropping a live entry) wins over the cap,
 *   and the next unprotected insert trims back down.
 */

export const BOUNDED_MAP_DEFAULT_LIMIT = 1024

export class BoundedMap<K, V> {
  private readonly store = new Map<K, V>()

  constructor(
    readonly limit: number = BOUNDED_MAP_DEFAULT_LIMIT,
    /** Return false to keep an entry even when it is the least recently used. */
    private readonly evictable: (key: K, value: V) => boolean = () => true,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("BoundedMap limit must be a positive integer")
  }

  get size(): number {
    return this.store.size
  }

  get(key: K): V | undefined {
    const value = this.store.get(key)
    if (value === undefined) return undefined
    // Re-insert to move the key to the most-recent position.
    this.store.delete(key)
    this.store.set(key, value)
    return value
  }

  has(key: K): boolean {
    return this.store.has(key)
  }

  set(key: K, value: V): void {
    this.store.delete(key)
    this.store.set(key, value)
    this.trim()
  }

  delete(key: K): boolean {
    return this.store.delete(key)
  }

  /** Least-recently-used first. Iteration order is the eviction order. */
  keys(): IterableIterator<K> {
    return this.store.keys()
  }

  values(): IterableIterator<V> {
    return this.store.values()
  }

  private trim(): void {
    if (this.store.size <= this.limit) return
    for (const [key, value] of this.store) {
      if (this.store.size <= this.limit) return
      if (!this.evictable(key, value)) continue
      this.store.delete(key)
    }
  }
}
