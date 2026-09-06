import { describe, expect, test } from "bun:test";
import { UploadGate, bodyBytes, drainSignalStream } from "./upload-gate.ts";

describe("UploadGate", () => {
  test("small bodies and a disabled gate bypass without taking a slot", async () => {
    const gate = new UploadGate(1, 64);
    expect((await gate.acquire(63)).gated).toBe(false);
    expect((await new UploadGate(0, 64).acquire(5000)).gated).toBe(false);
    expect(gate.stats).toMatchObject({ active: 0, queued: 0, served: 0 });
  });

  test("serializes large uploads in FIFO order; release is idempotent", async () => {
    const gate = new UploadGate(1, 64);
    const first = await gate.acquire(700);
    const order: string[] = [];
    const second = gate.acquire(800).then((slot) => { order.push("second"); return slot; });
    const third = gate.acquire(900).then((slot) => { order.push("third"); return slot; });
    await Bun.sleep(25);
    expect(order).toEqual([]);
    expect(gate.stats).toMatchObject({ active: 1, queued: 2 });
    first.release();
    first.release();
    const s2 = await second;
    expect(order).toEqual(["second"]);
    expect(s2.queuedMs).toBeGreaterThanOrEqual(20);
    expect(gate.stats).toMatchObject({ active: 1, queued: 1 });
    s2.release();
    const s3 = await third;
    expect(order).toEqual(["second", "third"]);
    s3.release();
    expect(gate.stats).toMatchObject({ active: 0, queued: 0, served: 3 });
    expect(gate.stats.maxQueuedMs).toBeGreaterThanOrEqual(20);
  });

  test("limit 2 admits two uploads at once and queues the third", async () => {
    const gate = new UploadGate(2, 64);
    const a = await gate.acquire(100);
    const b = await gate.acquire(100);
    let admitted = false;
    const c = gate.acquire(100).then((slot) => { admitted = true; return slot; });
    await Bun.sleep(10);
    expect(admitted).toBe(false);
    b.release();
    (await c).release();
    expect(admitted).toBe(true);
    a.release();
    expect(gate.stats.active).toBe(0);
  });
});

describe("drainSignalStream", () => {
  test("delivers every byte and signals drain once, only after the last chunk was pulled", async () => {
    let drains = 0;
    const stream = drainSignalStream(bodyBytes("x".repeat(200_000)), () => drains++, 64 * 1024);
    const reader = stream.getReader();
    let got = 0;
    let chunks = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.byteLength;
      chunks++;
      expect(drains).toBe(0);
    }
    expect(got).toBe(200_000);
    expect(chunks).toBe(4);
    expect(drains).toBe(1);
  });

  test("bodyBytes accepts string, ArrayBuffer and views", () => {
    expect(bodyBytes("ab")).toEqual(new Uint8Array([97, 98]));
    expect(bodyBytes(new Uint8Array([1, 2]).buffer)).toEqual(new Uint8Array([1, 2]));
    expect(bodyBytes(new Uint8Array([9, 8, 7]).subarray(1))).toEqual(new Uint8Array([8, 7]));
  });
});
