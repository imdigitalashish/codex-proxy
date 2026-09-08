import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const efforts = ["low", "medium", "high", "xhigh", "max"];
const maxBodyBytes = 64 * 1024;
const upstreamSizeError = '{"error":{"message":"failed to parse request","code":""}}\n';
const apiModel = (id: string, vendor = "OpenAI", endpoint = "/responses") => ({
  id, name: id, vendor, model_picker_enabled: true, supported_endpoints: [endpoint],
  capabilities: {
    supports: { reasoning_effort: efforts, tool_calls: true, vision: true },
    limits: { max_context_window_tokens: 1000000 },
  },
});
const rawCatalog = { data: [
  apiModel("gpt-5.4-mini"), apiModel("gpt-5.6-sol"), apiModel("gpt-6-astra"), apiModel("gpt-5.6-sol-fast"),
  apiModel("claude-opus-5", "Anthropic", "/chat/completions"),
] };
let home: string;
let baseUrl: string;
let upstream: ReturnType<typeof Bun.serve>;
let proxy: ReturnType<typeof Bun.spawn>;
let stdout: Promise<string>;
let stderr: Promise<string>;
let logText = "";
let captured: { path: string; body: any }[] = [];

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "codex-proxy-integration-"));
  await mkdir(join(home, ".codex-proxy", "errors"), { recursive: true });
  const templatePath = join(home, "template.json");
  const base = {
    slug: "gpt-5.4-mini", priority: 1, default_reasoning_level: "medium",
    model_messages: { instructions_template: "Fixture instructions" },
    supported_reasoning_levels: efforts.map((effort) => ({ effort, description: effort })),
  };
  await Bun.write(templatePath, JSON.stringify({ models: [
    base,
    { ...base, slug: "gpt-5.6-sol", multi_agent_version: "v2",
      supported_reasoning_levels: [...base.supported_reasoning_levels, { effort: "ultra", description: "Delegation" }] },
  ] }));
  upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/v1/models") return Response.json(rawCatalog);
      let body: any;
      try { body = await request.json(); } catch {}
      captured.push({ path, body });
      const forcedStatus = Number(request.headers.get("x-test-status"));
      if (forcedStatus) return new Response(upstreamSizeError, {
        status: forcedStatus, headers: { "content-type": "application/json", "x-request-id": "fixture-upstream-id" },
      });
      if (!body) return Response.json({ error: "invalid JSON" }, { status: 400 });
      if (body.reasoning?.effort === "ultra") {
        return Response.json({ error: { message: "Invalid value: 'ultra'. Supported values include 'max'.", code: "invalid_request_body" } }, { status: 400 });
      }
      if (path === "/v1/chat/completions") {
        return Response.json({
          id: "chat_fixture", model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: "BRIDGE_OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      const response = {
        id: "resp_fixture", model: body.model, status: "completed",
        output: [{ id: "msg_fixture", type: "message", role: "assistant", content: [{ type: "output_text", text: "PROXY_OK" }] }],
      };
      if (body.stream) {
        return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json(response);
    },
  });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port;
  reservation.stop(true);
  baseUrl = `http://127.0.0.1:${port}`;
  proxy = Bun.spawn([process.execPath, join(import.meta.dir, "server.ts")], {
    cwd: home,
    env: {
      HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin",
      UPSTREAM_MODE: "relay", UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.port}/v1`,
      UPSTREAM_API_KEY: "mock-only", PORT: String(port), CODEX_MODELS_TEMPLATE: templatePath,
      MODEL_ALIASES: "{}", EXTRA_PICKER_MODELS: "gpt-6-astra,claude-opus-5",
      UPSTREAM_RETRIES: "2", UPLOAD_CONCURRENCY: "0", UPSTREAM_MAX_BODY_BYTES: String(maxBodyBytes),
    },
    stdout: "pipe", stderr: "pipe",
  });
  stdout = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proxy.stdout) logText += decoder.decode(chunk, { stream: true });
    return logText;
  })();
  stderr = new Response(proxy.stderr).text();
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${baseUrl}/healthz`)).ok) return;
    } catch {}
    if (proxy.exitCode !== null) throw new Error(`Test proxy exited: ${await stderr}`);
    await Bun.sleep(25);
  }
  throw new Error("Test proxy did not become ready");
});

beforeEach(() => { captured = []; });

afterAll(async () => {
  if (proxy) {
    proxy.kill();
    await proxy.exited;
    await stdout;
    await stderr;
  }
  upstream?.stop(true);
  if (home) await rm(home, { recursive: true, force: true });
});

const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${baseUrl}/v1/responses`, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});

describe("proxy HTTP integration", () => {
  test("serves Codex Ultra metadata while leaving the raw API catalog unchanged", async () => {
    const codex = await (await fetch(`${baseUrl}/v1/models`, { headers: { "user-agent": "codex-test" } })).json();
    for (const slug of ["gpt-5.6-sol", "gpt-6-astra", "gpt-5.6-sol-fast"]) {
      const model = codex.models.find((item: any) => item.slug === slug);
      expect(model.multi_agent_version).toBe("v2");
      expect(model.supported_reasoning_levels.map((level: any) => level.effort)).toContain("ultra");
    }
    for (const slug of ["gpt-6-astra", "gpt-5.6-sol-fast"]) {
      expect(codex.models.find((item: any) => item.slug === slug).multi_agent_reasoning_effort).toBe("max");
    }
    expect(await (await fetch(`${baseUrl}/v1/models`)).json()).toEqual(rawCatalog);
  });

  test.each(["gpt-6-astra", "gpt-5.6-sol-fast"])("preserves %s native effort, proactive instructions, and namespaced collaboration tools", async (model) => {
    const body = {
      model, reasoning: { effort: "max" }, stream: false,
      input: [{ role: "developer", content: [{ type: "input_text", text: "<multi_agent_mode>Proactive multi-agent delegation is active.</multi_agent_mode>" }] }],
      tools: [{ type: "namespace", name: "collaboration", tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object", properties: {} } }] }],
    };
    const response = await post(body);
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("completed");
    expect(captured).toEqual([{ path: "/v1/responses", body }]);
  });

  test.each(["gpt-6-astra", "gpt-5.6-sol-fast"])("passes %s native streaming responses through unchanged", async (model) => {
    const response = await post({ model, reasoning: { effort: "max" }, input: "hello", stream: true });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain('"type":"response.completed"');
    expect(captured).toHaveLength(1);
  });

  test.each(["gpt-6-astra", "gpt-5.6-sol-fast"])("surfaces %s upstream validation errors without silently changing the requested effort", async (model) => {
    const response = await post({ model, reasoning: { effort: "ultra" }, input: "hello" });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_request_body");
    expect(captured).toHaveLength(1);
    expect(captured[0].body.reasoning.effort).toBe("ultra");
  });

  test("keeps the non-OpenAI chat bridge operational", async () => {
    const response = await post({ model: "claude-opus-5", input: "hello", stream: false, tools: [], tool_choice: "auto" });
    expect(response.status).toBe(200);
    expect(JSON.stringify((await response.json()).output)).toContain("BRIDGE_OK");
    expect(captured[0].path).toBe("/v1/chat/completions");
    expect(captured[0].body).not.toHaveProperty("tool_choice");
  });

  test("blocks oversized Codex uploads locally without altering or retrying the payload", async () => {
    const body = { model: "gpt-6-astra", input: "x".repeat(maxBodyBytes), stream: true };
    const response = await post(body, { "user-agent": "codex-test" });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-codex-proxy-error")).toBe("request_body_too_large");
    const text = await response.text();
    expect(text.match(/^event: /gm)).toHaveLength(1);
    expect(text).toContain('"code":"context_length_exceeded"');
    expect(text).not.toContain("response.completed");
    expect(captured).toEqual([]);
    expect((await (await fetch(`${baseUrl}/healthz`)).json()).requestLimits.upstreamMaxBodyBytes).toBe(maxBodyBytes);
  });

  test("budgets UTF-8 bytes, including the exact boundary, rather than JavaScript string length", async () => {
    const body = { model: "gpt-6-astra", input: "", stream: true };
    const available = maxBodyBytes - Buffer.byteLength(JSON.stringify(body));
    body.input = "\u00e9".repeat(Math.floor(available / 2)) + "x".repeat(available % 2);
    expect(JSON.stringify(body).length).toBeLessThan(maxBodyBytes);
    expect(Buffer.byteLength(JSON.stringify(body))).toBe(maxBodyBytes);
    const accepted = await post(body, { "user-agent": "codex-test" });
    expect(await accepted.text()).toContain("response.completed");
    expect(captured).toEqual([{ path: "/v1/responses", body }]);
    body.input += "x";
    const rejected = await post(body, { "user-agent": "codex-test" });
    expect(await rejected.text()).toContain('"code":"context_length_exceeded"');
    expect(captured).toHaveLength(1);
  });

  test("checks the translated wire body, not an oversized incoming Responses envelope", async () => {
    const response = await post({
      model: "claude-opus-5", stream: false,
      input: [{ type: "reasoning", encrypted_content: "x".repeat(maxBodyBytes * 2) }, { role: "user", content: "hello" }],
    }, { "user-agent": "codex-test" });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain("BRIDGE_OK");
    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe("/v1/chat/completions");
    expect(Buffer.byteLength(JSON.stringify(captured[0].body))).toBeLessThan(maxBodyBytes);
  });

  test("does not impose the generation budget on unrelated passthrough routes", async () => {
    const response = await fetch(`${baseUrl}/v1/files`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "x".repeat(maxBodyBytes) }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe("/v1/files");
    expect(Buffer.byteLength(JSON.stringify(captured[0].body))).toBeGreaterThan(maxBodyBytes);
  });

  test("normalizes an actual upstream 413 once and retains history and correlation diagnostics", async () => {
    const body = {
      model: "gpt-6-astra", reasoning: { effort: "max" }, stream: true,
      client_metadata: { "x-codex-turn-metadata": '{"request_kind":"turn"}' },
      tools: [{ type: "function", name: "view_image", parameters: { type: "object" } }],
      input: [
        { type: "reasoning", encrypted_content: "opaque" },
        { type: "function_call", call_id: "c1", name: "view_image", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
      ],
    };
    const response = await post(body, { "user-agent": "codex-test", "x-test-status": "413" });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("fixture-upstream-id");
    expect(await response.text()).toContain('"code":"context_length_exceeded"');
    expect(captured).toEqual([{ path: "/v1/responses", body }]);
    for (let i = 0; i < 50 && !logText.includes("fixture-upstream-id"); i++) await Bun.sleep(10);
    const log = logText.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((entry) => entry.upstreamRequestId === "fixture-upstream-id");
    expect(log).toMatchObject({
      event: "request_body_too_large", source: "upstream", status: 413, clientStatus: 200,
      bodyBytes: Buffer.byteLength(JSON.stringify(body)), requestKind: "turn", error: upstreamSizeError,
    });
  });

  test("also normalizes upstream size failures from the chat bridge for Codex SSE clients", async () => {
    const response = await post({ model: "claude-opus-5", input: "hello", stream: true }, {
      "originator": "codex-test", "x-test-status": "413",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"code":"context_length_exceeded"');
    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe("/v1/chat/completions");
  });

  test.each([false, true])("preserves the chat bridge error envelope outside Codex SSE (stream=%s)", async (stream) => {
    const response = await post({ model: "claude-opus-5", input: "hello", stream }, {
      "user-agent": stream ? "other-client" : "codex-test", "x-test-status": "413",
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { message: `upstream 413: ${upstreamSizeError}`, type: "upstream_error" } });
    expect(captured).toHaveLength(1);
  });

  test.each([
    { path: "/v1/responses", codex: false, stream: true },
    { path: "/v1/responses", codex: true, stream: false },
    { path: "/v1/chat/completions", codex: true, stream: true },
  ])("preserves upstream HTTP 413 outside the Codex Responses stream contract: %j", async ({ path, codex, stream }) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST", headers: { "content-type": "application/json", "x-test-status": "413", "user-agent": codex ? "codex-test" : "other-client" },
      body: JSON.stringify({ model: "gpt-6-astra", input: "hello", stream }),
    });
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-request-id")).toBe("fixture-upstream-id");
    expect(await response.text()).toBe(upstreamSizeError);
    expect(captured).toHaveLength(1);
  });

  test("does not reinterpret malformed JSON or unrelated upstream errors as capacity errors", async () => {
    const malformed = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json", "user-agent": "codex-test", "x-test-status": "413" },
      body: '{"stream":true,',
    });
    expect(malformed.status).toBe(413);
    expect(await malformed.text()).toBe(upstreamSizeError);
    const unrelated = await post({ model: "gpt-6-astra", input: "hello", stream: true }, { "user-agent": "codex-test", "x-test-status": "400" });
    expect(unrelated.status).toBe(400);
    expect(await unrelated.text()).toBe(upstreamSizeError);
    expect(captured).toHaveLength(2);
  });

  test.each([true, false])("returns a local HTTP 413 to clients without a Codex streaming contract (stream=%s)", async (stream) => {
    const response = await post({ model: "gpt-6-astra", input: "x".repeat(maxBodyBytes), stream },
      stream ? { "user-agent": "other-client" } : { "user-agent": "codex-test" });
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("request_body_too_large");
    expect(captured).toEqual([]);
  });
});
