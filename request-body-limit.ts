export const COPILOT_MAX_BODY_BYTES = 32 * 1024 * 1024;

export function parseBodyLimit(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("UPSTREAM_MAX_BODY_BYTES must be a non-negative integer (0 disables the byte budget)");
  }
  return Number(value);
}

export class RequestBodyTooLarge extends Error {
  constructor(readonly bytes: number, readonly limitBytes: number, readonly upstream?: Response) {
    super(upstream
      ? `Upstream rejected the ${bytes}-byte request body with HTTP 413.`
      : `Request body (${bytes} bytes) exceeds the configured upstream byte budget (${limitBytes} bytes).`);
    this.name = "RequestBodyTooLarge";
  }
}

export function assertBodyFits(bytes: number, limitBytes: number): void {
  if (limitBytes > 0 && bytes > limitBytes) throw new RequestBodyTooLarge(bytes, limitBytes);
}

export async function readErrorPreview(response: Response, { maxBytes = 4000, timeoutMs = 1000 } = {}): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = ""; let bytes = 0;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("error body read timed out")), timeoutMs);
  });
  try {
    while (bytes < maxBytes) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      const chunk = value.subarray(0, maxBytes - bytes);
      bytes += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    return `${text} [error body unavailable: ${String(error).slice(0, 200)}]`;
  } finally {
    clearTimeout(timer!);
    // A cloned body's cancellation can wait for the passthrough branch; never await it here.
    void reader.cancel().catch(() => {});
  }
}

export function bodyLimitResponse(
  failure: RequestBodyTooLarge,
  format: "codex-sse" | "json",
  headers = new Headers(),
): Response {
  const message = `${failure.message} Compact the conversation or reduce inline images before retrying.`;
  headers.set("x-codex-proxy-error", "request_body_too_large");
  headers.set("cache-control", "no-store");
  if (format === "json") {
    return Response.json({ error: { type: "invalid_request_error", code: "request_body_too_large", message } }, { status: 413, headers });
  }
  // Codex handles HTTP 413 as fatal transport failure. Its SSE capacity error instead marks the
  // context full; the harness owns subsequent compaction and preserves tool-call/output pairing.
  const event = {
    type: "response.failed",
    sequence_number: 0,
    response: {
      id: `resp_proxy_${crypto.randomUUID()}`, object: "response", created_at: Math.floor(Date.now() / 1000),
      status: "failed", output: [], error: { code: "context_length_exceeded", message },
    },
  };
  headers.set("content-type", "text/event-stream; charset=utf-8");
  return new Response(`event: response.failed\ndata: ${JSON.stringify(event)}\n\n`, { headers });
}

export function codexRequestKind(request: Request, parsed: any): string | undefined {
  const raw = parsed?.client_metadata?.["x-codex-turn-metadata"] ?? request.headers.get("x-codex-turn-metadata");
  if (typeof raw !== "string") return undefined;
  try {
    const kind = JSON.parse(raw)?.request_kind;
    return ["turn", "compaction", "prewarm", "memory"].includes(kind) ? kind : undefined;
  } catch { return undefined; }
}
