/**
 * Async Semaphore to limit concurrency of heavy operations (such as opening browser tabs).
 */
export class Semaphore {
  private currentTasks = 0;
  private queue: (() => void)[] = [];

  constructor(public readonly maxConcurrency: number) {}

  /**
   * Acquire a slot in the semaphore. If all slots are in use, returns a promise
   * that resolves when a slot becomes available.
   */
  async acquire(): Promise<void> {
    if (this.currentTasks < this.maxConcurrency) {
      this.currentTasks++;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
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
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
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
