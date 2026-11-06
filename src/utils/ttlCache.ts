import { CONFIG } from "../config";

interface TtlEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * In-memory TTL cache with size-cap eviction (oldest-inserted first) and
 * periodic stale-entry cleanup. Shared by the stream and VOD services.
 */
export class TtlCache<T> {
  private cache = new Map<string, TtlEntry<T>>();
  private cleanupInterval: NodeJS.Timeout;

  constructor(
    private defaultTtlMs: number,
    private maxSize: number = CONFIG.CACHE_MAX_ITEMS,
  ) {
    // Periodic cleanup every 10 minutes to avoid memory leaks
    this.cleanupInterval = setInterval(() => this.cleanup(), 10 * 60 * 1000);
    // Allow Node/Bun process to exit even if interval is active
    if (this.cleanupInterval && typeof this.cleanupInterval.unref === "function") {
      this.cleanupInterval.unref();
    }
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number = this.defaultTtlMs): void {
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      // Evict oldest entry (first key in Map insertion order) to cap memory usage
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    const now = Date.now();
    this.cache.set(key, {
      value,
      expiresAt: now + ttlMs,
    });
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  deletePrefix(prefix: string, predicate?: (value: T) => boolean): boolean {
    let deletedAny = false;
    for (const [key, entry] of this.cache.entries()) {
      if (key.startsWith(prefix)) {
        if (!predicate || predicate(entry.value)) {
          this.cache.delete(key);
          deletedAny = true;
        }
      }
    }
    return deletedAny;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
  }
}
