import { describe, expect, it } from "bun:test";
import { Semaphore } from "../src/utils/semaphore";

describe("Semaphore", () => {
  it("limits concurrency correctly", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let maxObservedActive = 0;

    const task = async () => {
      await sem.run(async () => {
        active++;
        maxObservedActive = Math.max(maxObservedActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
      });
    };

    await Promise.all([task(), task(), task(), task()]);
    expect(maxObservedActive).toBe(2);
    expect(sem.activeCount).toBe(0);
    expect(sem.queuedCount).toBe(0);
  });

  it("drains queue in FIFO order", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];

    const p1 = sem.run(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(1);
    });
    const p2 = sem.run(async () => {
      order.push(2);
    });
    const p3 = sem.run(async () => {
      order.push(3);
    });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe("smartFetch curl redirect parsing", () => {
  it("resolves the final response after redirects", async () => {
    // httpbin redirects /redirect/2 twice and lands on /get
    const { smartFetch } = await import("../src/utils/http");
    const res = await smartFetch("https://httpbin.org/redirect/2");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toContain("httpbin.org/get");
  });
});


