// Upload gate: serializes large upstream uploads so concurrent Codex agents do not share one slow uplink and each
// overrun the upstream's request-body deadline (Copilot answers 408 user_request_timeout after ~60 s of reading).
// Lossless: a request waits for a slot instead of being shrunk. Small bodies bypass the gate entirely.
// With a 1 MB body on a 30 KB/s uplink, four parallel uploads take ~130 s each (all time out); one at a time takes ~35 s.

export type UploadSlot = { gated: boolean; queuedMs: number; release: () => void };
export type UploadGateStats = { limit: number; minKB: number; active: number; queued: number; served: number; maxQueuedMs: number };

export class UploadGate {
  private active = 0;
  private waiters: Array<() => void> = [];
  private served = 0;
  private maxQueuedMs = 0;

  /** `limit` concurrent uploads for bodies of at least `minKB`; limit 0 disables the gate. */
  constructor(readonly limit: number, readonly minKB: number) {}

  get stats(): UploadGateStats {
    return { limit: this.limit, minKB: this.minKB, active: this.active, queued: this.waiters.length, served: this.served, maxQueuedMs: this.maxQueuedMs };
  }

  /** Resolves when a slot is free (immediately when the gate does not apply). FIFO. `release` is idempotent. */
  async acquire(sizeKB: number): Promise<UploadSlot> {
    if (this.limit <= 0 || sizeKB < this.minKB) return { gated: false, queuedMs: 0, release: () => {} };
    const started = Date.now();
    if (this.active >= this.limit) await new Promise<void>((wake) => this.waiters.push(wake));
    this.active++;
    this.served++;
    const queuedMs = Date.now() - started;
    if (queuedMs > this.maxQueuedMs) this.maxQueuedMs = queuedMs;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
    return { gated: true, queuedMs, release };
  }
}

export function bodyBytes(body: string | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
}

/** Streams `bytes` in chunks (chunked transfer-encoding upstream) and calls `onDrain` exactly once, when the transport
 *  pulls past the last chunk, i.e. every byte has been handed to the socket. That is when an upload slot can be freed:
 *  waiting for response headers instead would also cover the model's time-to-first-token. */
export function drainSignalStream(bytes: Uint8Array, onDrain: () => void, chunkBytes = 64 * 1024): ReadableStream<Uint8Array> {
  let offset = 0;
  let drained = false;
  const finish = () => { if (!drained) { drained = true; onDrain(); } };
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) { finish(); controller.close(); return; }
      const end = Math.min(offset + chunkBytes, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
    cancel() { finish(); },
  });
}
