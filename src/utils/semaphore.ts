/**
 * Async Semaphore to limit concurrency of heavy operations (such as opening browser tabs).
 */
export class Semaphore {
  private currentTasks = 0;
  private queue: (() => void)[] = [];

  constructor(public readonly maxConcurrency: number) {}

  /**
   * Acquire a slot in the semaphore. If all slots are in use, returns a promise
   * that resolves when a slot becomes available. Supports cancellation via AbortSignal.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }

    if (this.currentTasks < this.maxConcurrency) {
      this.currentTasks++;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      const callback = () => {
        if (onAbort && signal) {
          signal.removeEventListener("abort", onAbort);
        }
        resolve();
      };

      if (signal) {
        onAbort = () => {
          const idx = this.queue.indexOf(callback);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
          }
          reject(new DOMException("The operation was aborted", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.queue.push(callback);
    });
  }

  /**
   * Release a previously acquired slot, waking up the next queued task if any.
   */
  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        next();
      }
    } else {
      this.currentTasks = Math.max(0, this.currentTasks - 1);
    }
  }

  /**
   * Helper to run a task wrapped in acquire/release.
   * If cancelled via signal while in queue or during execution, releases resources promptly.
   */
  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      return await task();
    } finally {
      this.release();
    }
  }

  get activeCount(): number {
    return this.currentTasks;
  }

  get queuedCount(): number {
    return this.queue.length;
  }
}
