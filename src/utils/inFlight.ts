export interface InFlightEntry<T> {
  promise: Promise<T>;
  controller: AbortController;
  subscribers: number;
}

/**
 * Runs a scrape under Thundering-Herd protection: concurrent callers asking
 * for the same `key` share one in-flight promise instead of launching
 * parallel browser scrapes.
 *
 * Abort semantics: each caller may pass its own `signal`. When a caller
 * disconnects, its subscription is released; if no subscribers remain, the
 * underlying scrape's controller is aborted and the map entry is dropped so
 * the next caller starts fresh.
 */
export async function runCoalesced<T>(
  map: Map<string, InFlightEntry<T>>,
  key: string,
  factory: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  onCoalesce?: () => void,
): Promise<T> {
  let inFlight = map.get(key);
  if (inFlight) {
    onCoalesce?.();
    inFlight.subscribers++;
  } else {
    const controller = new AbortController();
    const promise = factory(controller.signal).finally(() => {
      const current = map.get(key);
      if (current && current.promise === promise) {
        map.delete(key);
      }
    });
    inFlight = { promise, controller, subscribers: 1 };
    map.set(key, inFlight);
  }

  let onAbort: (() => void) | undefined;
  let abortPromise: Promise<never> | undefined;

  if (signal) {
    abortPromise = new Promise<never>((_, reject) => {
      onAbort = () => {
        if (inFlight) {
          inFlight.subscribers--;
          if (inFlight.subscribers <= 0) {
            inFlight.controller.abort();
            map.delete(key);
          }
        }
        reject(new DOMException("The operation was aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  try {
    return await (abortPromise
      ? Promise.race([inFlight.promise, abortPromise])
      : inFlight.promise);
  } finally {
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
