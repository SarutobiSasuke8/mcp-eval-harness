import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { mapWithConcurrency, parseConcurrency } from "../src/parallel.js";

void describe("parseConcurrency", () => {
  void it("defaults to 1 and accepts whole numbers from 1 upwards", () => {
    assert.equal(parseConcurrency(undefined), 1);
    assert.equal(parseConcurrency("1"), 1);
    assert.equal(parseConcurrency("8"), 8);
    assert.equal(parseConcurrency(3), 3);
  });

  void it("rejects zero, negatives, fractions and words", () => {
    for (const bad of ["0", "-2", "1.5", "two", "", "3x"]) {
      assert.throws(() => parseConcurrency(bad), /--concurrency must be a whole number of 1 or more/, bad);
    }
  });
});

void describe("mapWithConcurrency", () => {
  // Later items finish first: item 0 takes longest, item 5 is quickest.
  const delays = [120, 100, 80, 60, 40, 20];

  void it("returns results in input order whatever order they finish in", async () => {
    const finishOrder: number[] = [];
    const results = await mapWithConcurrency(delays, delays.length, async (ms, index) => {
      await sleep(ms);
      finishOrder.push(index);
      return `item-${index}`;
    });
    assert.deepEqual(results, ["item-0", "item-1", "item-2", "item-3", "item-4", "item-5"]);
    assert.deepEqual(finishOrder, [5, 4, 3, 2, 1, 0], "the workers really did finish out of order");
  });

  void it("reports each result through onResult strictly in input order", async () => {
    const reported: number[] = [];
    await mapWithConcurrency(
      delays,
      3,
      async (ms, index) => {
        await sleep(ms);
        return index;
      },
      (result, index) => {
        assert.equal(result, index);
        reported.push(index);
      },
    );
    assert.deepEqual(reported, [0, 1, 2, 3, 4, 5]);
  });

  void it("never has more than the limit in flight, and reaches the limit", async () => {
    for (const limit of [1, 2, 4]) {
      let inFlight = 0;
      let peak = 0;
      await mapWithConcurrency(delays, limit, async (ms) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await sleep(ms / 4);
        inFlight -= 1;
      });
      assert.equal(peak, limit, `limit ${limit}`);
    }
  });

  void it("runs one at a time in input order with concurrency 1", async () => {
    const started: number[] = [];
    await mapWithConcurrency(delays, 1, async (ms, index) => {
      started.push(index);
      await sleep(ms / 10);
    });
    assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
  });

  void it("handles an empty list and a limit above the item count", async () => {
    assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);
    assert.deepEqual(await mapWithConcurrency([1, 2], 10, async (n) => n * 2), [2, 4]);
  });

  void it("stops starting new items after a failure and rejects with that error", async () => {
    const started: number[] = [];
    await assert.rejects(
      mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (n) => {
        started.push(n);
        await sleep(10);
        if (n === 1) {
          throw new Error("boom");
        }
        return n;
      }),
      /boom/,
    );
    assert.ok(!started.includes(5), `started ${started.join(", ")}`);
  });
});
