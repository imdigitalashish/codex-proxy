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
  apiModel("grok-fixture", "xAI"),
] };
let home: string;
let baseUrl: string;
let upstream: ReturnType<typeof Bun.serve>;
let proxy: ReturnType<typeof Bun.spawn>;
let stdout: Promise<string>;
let stderr: Promise<string>;
let logText = "";
let captured: { path: string; body: any }[] = [];

const fixtureSse = (events: any[], chat = false) => new Response(events.map((event) =>
  `${chat ? "" : `event: ${event.type}\n`}data: ${JSON.stringify(event)}\n\n`).join("") + (chat ? "data: [DONE]\n\n" : ""), {
  headers: { "content-type": "text/event-stream" },
});
const readFixtureResponse = async (response: Response, stream: boolean) => {
  expect(response.status).toBe(200);
  if (!stream) return response.json();
  const events = (await response.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
  expect(events.at(-1).type).toBe("response.completed");
  const completed = events.at(-1).response;
  const added = events.filter((event) => event.type === "response.output_item.added" && event.item.type !== "message");
  for (const { item } of added) {
    const final = completed.output.find((call: any) => call.call_id === item.call_id);
    expect({ name: item.name, namespace: item.namespace, type: item.type })
      .toEqual({ name: final.name, namespace: final.namespace, type: final.type });
  }
  return completed;
};

// A strict, deterministic upstream that rejects the original duplicate-name bug
// and validates a complete function/custom tool-result round trip.
function fixtureToolResponse(path: string, body: any): Response {
  const chat = path === "/v1/chat/completions";
  const tools = (body.tools ?? []).map((tool: any) => chat ? tool.function : tool);
  const names = tools.map((tool: any) => tool?.name);
  const reject = (message: string) => Response.json({ error: { message, code: "invalid_request_body" } }, { status: 400 });
  if (new Set(names).size !== names.length) return reject("tools: Tool names must be unique.");
  if (names.some((name: any) => typeof name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(name))) return reject("invalid tool name");
  const input = Array.isArray(body.input) ? body.input : [];
  const history = chat ? (body.messages ?? []).flatMap((item: any) => item.tool_calls ?? [])
    : input.filter((item: any) => item.type === "function_call");
  const results = chat ? (body.messages ?? []).filter((item: any) => item.role === "tool")
    : input.filter((item: any) => item.type === "function_call_output");
  if (results.length) {
    if (history.length !== results.length) return reject("missing call history");
    for (const call of history) {
      const id = chat ? call.id : call.call_id;
      const name = chat ? call.function.name : call.name;
      const result = results.find((item: any) => (chat ? item.tool_call_id : item.call_id) === id);
      if (!names.includes(name) || call.namespace !== undefined || !result
        || (chat ? result.content : result.output) !== `fixture-result:${id}`) return reject("incorrect tool-result mapping");
    }
  }
  const choice = body.tool_choice;
  const forcedName = chat ? choice?.function?.name : choice?.type === "function" ? choice.name : undefined;
  if (forcedName && !names.includes(forcedName)) return reject("unknown forced tool");
  let selected = forcedName ? tools.filter((tool: any) => tool.name === forcedName) : tools;
  if (choice?.type === "allowed_tools") {
    const allowed = choice.tools.map((tool: any) => tool.name);
    if (allowed.some((name: string) => !names.includes(name))) return reject("unknown allowed tool");
    selected = tools.filter((tool: any) => allowed.includes(tool.name));
  }
  const calls = results.length ? [] : selected.map((tool: any, i: number) => ({
    type: "function_call", id: `fc_fixture_${i}`, call_id: `call_fixture_${i}`, name: tool.name, status: "completed",
    arguments: JSON.stringify(tool.parameters?.properties?.input ? { input: "synthetic raw input" } : { query: "synthetic" }),
  }));
  if (chat) {
    if (!body.stream) return Response.json({ model: body.model, choices: [{ message: {
      role: "assistant", content: results.length ? "TOOL_ROUNDTRIP_OK" : null,
      tool_calls: calls.map((call: any) => ({ id: call.call_id, type: "function", function: { name: call.name, arguments: call.arguments } })),
    }, finish_reason: calls.length ? "tool_calls" : "stop" }] });
    const delta = (tool_calls: any[]) => ({ choices: [{ delta: { tool_calls } }] });
    return fixtureSse([
      delta(calls.map((call: any, index: number) => ({ index, id: call.call_id, function: { arguments: call.arguments.slice(0, 4) } }))),
      ...[...calls.keys()].reverse().map((index) => delta([{ index, function: { name: calls[index].name.slice(0, 3) } }])),
      ...calls.map((call: any, index: number) => delta([{ index, function: { name: call.name.slice(3), arguments: call.arguments.slice(4) } }])),
      { choices: [{ delta: results.length ? { content: "TOOL_ROUNDTRIP_OK" } : {}, finish_reason: calls.length ? "tool_calls" : "stop" }] },
    ], true);
  }
  const response = { id: "resp_tool_fixture", model: body.model, status: "completed", output: results.length
    ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "TOOL_ROUNDTRIP_OK" }] }] : calls };
  if (!body.stream) return Response.json(response);
  return fixtureSse([
    ...calls.map((item: any, output_index: number) => ({ type: "response.output_item.added", output_index, item: { ...item, arguments: "", status: "in_progress" } })),
    ...calls.flatMap((item: any, output_index: number) => [
      { type: "response.function_call_arguments.delta", item_id: item.id, output_index, delta: item.arguments },
      { type: "response.function_call_arguments.done", item_id: item.id, output_index, arguments: item.arguments },
      { type: "response.output_item.done", output_index, item },
    ]),
    { type: "response.completed", response },
  ]);
}

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
      if (request.headers.get("x-test-tool-roundtrip") === "1") return fixtureToolResponse(path, body);
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

  const search = { type: "function", name: "search", parameters: { type: "object", properties: { query: { type: "string" } } } };
  const duplicateShortNames = () => [
    search,
    { type: "namespace", name: "crm", tools: [search] },
    { type: "namespace", name: "support", tools: [search] },
    { type: "namespace", name: "editor", tools: [{ type: "custom", name: "search" }] },
  ];
  const toolHeaders = { "user-agent": "codex-test", "x-test-tool-roundtrip": "1" };

  test.each([
    ["claude-opus-5", false], ["claude-opus-5", true], ["grok-fixture", false], ["grok-fixture", true],
  ])("%s supports duplicate short names and tool-result continuation (stream=%s)", async (model, stream) => {
    const tools = duplicateShortNames();
    const input = [{ role: "user", content: "Call the synthetic tools" }];
    const first = await readFixtureResponse(await post({ model, stream, input, tools }, toolHeaders), stream);
    expect(first.output).toMatchObject([
      { type: "function_call", name: "search", call_id: "call_fixture_0" },
      { type: "function_call", name: "search", namespace: "crm", call_id: "call_fixture_1" },
      { type: "function_call", name: "search", namespace: "support", call_id: "call_fixture_2" },
      { type: "custom_tool_call", name: "search", namespace: "editor", call_id: "call_fixture_3", input: "synthetic raw input" },
    ]);
    expect(first.output[0]).not.toHaveProperty("namespace");
    expect(first.output[3]).not.toHaveProperty("arguments");
    const wireTools = captured[0].body.tools.map((tool: any) => tool.function?.name ?? tool.name);
    expect(new Set(wireTools).size).toBe(4);
    const results = first.output.map((call: any) => ({
      type: call.type === "custom_tool_call" ? "custom_tool_call_output" : "function_call_output",
      call_id: call.call_id, output: `fixture-result:${call.call_id}`,
    }));
    const second = await readFixtureResponse(await post({ model, stream, tools: [...tools].reverse(),
      input: [...input, ...first.output, ...results], tool_choice: "auto",
    }, toolHeaders), stream);
    expect(JSON.stringify(second.output)).toContain("TOOL_ROUNDTRIP_OK");
    expect(captured).toHaveLength(2);
    expect(captured[1].body.tools.map((tool: any) => tool.function?.name ?? tool.name)).toEqual([...wireTools].reverse());
    const history = model === "claude-opus-5" ? captured[1].body.messages.flatMap((message: any) => message.tool_calls ?? [])
      : captured[1].body.input.filter((item: any) => item.type === "function_call");
    expect(history.map((call: any) => call.function?.name ?? call.name)).toEqual(wireTools);
    expect(history.map((call: any) => call.id && model === "claude-opus-5" ? call.id : call.call_id))
      .toEqual(first.output.map((call: any) => call.call_id));
  });

  test.each(["claude-opus-5", "grok-fixture"])("%s maps forced custom and allowed-tool choices", async (model) => {
    const tools = duplicateShortNames();
    const forced = await readFixtureResponse(await post({ model, input: "go", tools,
      tool_choice: { type: "custom", name: "search", namespace: "editor" },
    }, toolHeaders), false);
    expect(forced.output).toHaveLength(1);
    expect(forced.output[0]).toMatchObject({ type: "custom_tool_call", name: "search", namespace: "editor" });
    const allowed = await readFixtureResponse(await post({ model, input: "go", tools,
      tool_choice: { type: "allowed_tools", mode: "required", tools: [
        { type: "function", name: "search", namespace: "support" }, { type: "custom", name: "search", namespace: "editor" },
      ] },
    }, toolHeaders), false);
    expect(allowed.output).toMatchObject([
      { type: "function_call", name: "search", namespace: "support" },
      { type: "custom_tool_call", name: "search", namespace: "editor" },
    ]);
  });

  test.each(["claude-opus-5", "grok-fixture"])("%s rejects conflicting definitions before sending a generation request", async (model) => {
    const response = await post({ model, input: "go", tools: [search, { ...search, description: "conflicting" }] }, toolHeaders);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatchObject({ type: "invalid_request_error", code: "invalid_tool_definition" });
    expect(captured).toEqual([]);
  });

  test.each(["claude-opus-5", "grok-fixture"])("%s safely coalesces identical declarations", async (model) => {
    const response = await readFixtureResponse(await post({ model, input: "go", tools: [search, structuredClone(search)] }, toolHeaders), false);
    expect(captured[0].body.tools).toHaveLength(1);
    expect(response.output).toHaveLength(1);
    expect(response.output[0].name).toBe("search");
  });

  test("leaves native OpenAI namespaces, tool choices, and namespaced history unchanged", async () => {
    const body = { model: "gpt-6-astra", tools: duplicateShortNames(), stream: false,
      tool_choice: { type: "custom", name: "search", namespace: "editor" }, input: [
        { type: "function_call", call_id: "previous", name: "search", namespace: "support", arguments: "{}" },
        { type: "function_call_output", call_id: "previous", output: "ok" },
      ] };
    const response = await post(body);
    expect(response.status).toBe(200);
    await response.text();
    expect(captured).toEqual([{ path: "/v1/responses", body }]);
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
      bodyBytes: Buffer.byteLength(JSON.stringify(body)), requestKind: "turn", error_redacted: true,
    });
    expect(log).not.toHaveProperty("error");
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
