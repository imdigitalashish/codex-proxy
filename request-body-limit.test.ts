import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { assertBodyFits, bodyLimitResponse, codexRequestKind, parseBodyLimit, readErrorPreview, RequestBodyTooLarge } from "./request-body-limit.ts";

describe("request body byte budget", () => {
  test("uses the provider default, accepts overrides, and allows explicit disabling", () => {
    expect(parseBodyLimit(undefined, 1024)).toBe(1024);
    expect(parseBodyLimit("2048", 1024)).toBe(2048);
    expect(parseBodyLimit("0", 1024)).toBe(0);
  });

  test.each(["", "-1", "1.5", "NaN", "Infinity", "1e6", "9007199254740992"])("rejects invalid configuration: %s", (value) => {
    expect(() => parseBodyLimit(value, 1024)).toThrow("UPSTREAM_MAX_BODY_BYTES");
  });

  test("accepts the exact byte boundary and rejects one byte over without imposing a disabled limit", () => {
    expect(() => assertBodyFits(1024, 1024)).not.toThrow();
    expect(() => assertBodyFits(1025, 1024)).toThrow(RequestBodyTooLarge);
    expect(() => assertBodyFits(1025, 0)).not.toThrow();
  });

  test("returns a descriptive HTTP 413 for ordinary clients", async () => {
    const response = bodyLimitResponse(new RequestBodyTooLarge(1025, 1024), "json");
    expect(response.status).toBe(413);
    expect((await response.json()).error).toEqual({
      type: "invalid_request_error", code: "request_body_too_large",
      message: "Request body (1025 bytes) exceeds the configured upstream byte budget (1024 bytes). Compact the conversation or reduce inline images before retrying.",
    });
  });

  test("emits one failure, never a success, and preserves upstream correlation headers", async () => {
    const failure = new RequestBodyTooLarge(100, 1024, new Response("failed to parse request", { status: 413 }));
    const response = bodyLimitResponse(failure, "codex-sse", new Headers({ "x-request-id": "upstream-id" }));
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-request-id")).toBe("upstream-id");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(text.match(/^event: /gm)).toHaveLength(1);
    expect(text).not.toContain("response.completed");
    const event = JSON.parse(text.split("\ndata: ")[1].trim());
    expect(event.response.status).toBe("failed");
    expect(event.response.error).toEqual({
      code: "context_length_exceeded",
      message: "Upstream rejected the 100-byte request body with HTTP 413. Compact the conversation or reduce inline images before retrying.",
    });
  });
});

describe("optional upstream error diagnostics", () => {
  test("caps bytes read and times out a stalled body", async () => {
    expect(await readErrorPreview(new Response("x".repeat(8000)))).toHaveLength(4000);
    const stalled = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("partial")); } }));
    expect(await readErrorPreview(stalled, { timeoutMs: 10 })).toContain("error body read timed out");
  });

  test("a truncated HTTP 413 body cannot defeat the recovery event", async () => {
    let truncate: (() => void) | undefined;
    const server = createServer((socket) => socket.once("data", () => {
      socket.write("HTTP/1.1 413 Payload Too Large\r\nContent-Length: 1000\r\nConnection: close\r\n\r\npartial");
      truncate = () => socket.end();
    }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as { port: number };
      const upstream = await fetch(`http://127.0.0.1:${address.port}/`, { signal: AbortSignal.timeout(2000) });
      expect(upstream.status).toBe(413);
      const preview = readErrorPreview(upstream);
      truncate!();
      expect(await preview).toContain("error body unavailable");
      const response = bodyLimitResponse(new RequestBodyTooLarge(1025, 1024, upstream), "codex-sse");
      expect(await response.text()).toContain('"code":"context_length_exceeded"');
    } finally {
      truncate?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("request-kind diagnostics", () => {
  const request = new Request("http://localhost/v1/responses", { headers: { "x-codex-turn-metadata": '{"request_kind":"turn"}' } });

  test("uses canonical metadata before the compatibility header", () => {
    expect(codexRequestKind(request, { client_metadata: { "x-codex-turn-metadata": '{"request_kind":"compaction"}' } })).toBe("compaction");
    expect(codexRequestKind(request, {})).toBe("turn");
  });

  test("malformed or unknown metadata cannot break error handling or leak arbitrary values", () => {
    for (const raw of ["broken", "null", '{"request_kind":"private value"}']) {
      expect(codexRequestKind(request, { client_metadata: { "x-codex-turn-metadata": raw } })).toBeUndefined();
    }
  });
});
