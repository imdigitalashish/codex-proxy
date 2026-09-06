import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Explicit opt-in keeps the ordinary suite independent of a local Codex installation.
const codexBin = process.env.CODEX_TEST_BIN;
const bodyLimit = 128 * 1024;
const compactPrompt = "HARNESS_COMPACT: summarize this conversation in one short sentence.";
const summary = "HARNESS_SUMMARY: The earlier oversized user input was received.";
const result = "HARNESS_RECOVERED";
type Json = Record<string, any>;
type Exchange = { body: Json; bytes: number; status: number; response: string };

function completedResponse(text: string): Response {
  const id = `resp_${crypto.randomUUID()}`;
  const item = {
    id: `msg_${crypto.randomUUID()}`, type: "message", role: "assistant",
    content: [{ type: "output_text", text }],
  };
  const events = [
    { type: "response.created", response: { id } },
    { type: "response.output_item.done", item },
    {
      type: "response.completed",
      response: {
        id, status: "completed", output: [item],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function inputText(body: Json): string {
  return (body.input ?? []).flatMap((item: Json) => item.content ?? [])
    .filter((item: Json) => item.type === "input_text").map((item: Json) => item.text).join("\n");
}

class AppServer {
  readonly child: ReturnType<typeof Bun.spawn>;
  readonly messages: Json[] = [];
  readonly stderr: Promise<string>;
  readonly stdout: Promise<void>;
  #nextId = 0;
  #failure: unknown;

  constructor(bin: string, home: string) {
    this.child = Bun.spawn([bin, "app-server", "--listen", "stdio://"], {
      cwd: home,
      env: {
        HOME: home, CODEX_HOME: join(home, ".codex"), PATH: process.env.PATH ?? "/usr/bin:/bin",
        TMPDIR: home, RUST_LOG: "error", NO_PROXY: "127.0.0.1,localhost",
      },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    this.stderr = new Response(this.child.stderr).text();
    this.stdout = this.#read();
  }

  async #read(): Promise<void> {
    const reader = this.child.stdout.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          this.messages.push(message);
          // A mock model never calls tools; fail closed if the harness asks for anything.
          if (message.id !== undefined && message.method) {
            this.child.stdin.write(`${JSON.stringify({
              id: message.id, error: { code: -32601, message: "Unexpected server request in harness fixture" },
            })}\n`);
          }
        }
      }
    } catch (error) {
      this.#failure = error;
    }
  }

  async waitFor(predicate: (message: Json) => boolean, after = 0): Promise<Json> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const message = this.messages.slice(after).find(predicate);
      if (message) return message;
      if (this.#failure) throw this.#failure;
      if (this.child.exitCode !== null) throw new Error(`Codex exited: ${await this.stderr}`);
      await Bun.sleep(10);
    }
    throw new Error(`Timed out waiting for Codex; last messages: ${JSON.stringify(this.messages.slice(-6))}`);
  }

  async request(method: string, params: Json): Promise<Json> {
    const id = ++this.#nextId;
    this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    const message = await this.waitFor((candidate) => candidate.id === id && !candidate.method);
    if (message.error) throw new Error(`${method}: ${JSON.stringify(message.error)}`);
    return message.result;
  }

  async turn(threadId: string, text: string): Promise<Json> {
    const started = await this.request("turn/start", { threadId, input: [{ type: "text", text }] });
    const completed = await this.waitFor((message) => message.method === "turn/completed"
      && message.params.threadId === threadId && message.params.turn.id === started.turn.id);
    return completed.params.turn;
  }

  async stop(): Promise<void> {
    this.child.kill();
    await this.child.exited;
    await this.stdout;
    await this.stderr;
  }
}

type Scenario = "local byte rejection" | "upstream 413" | "failed compaction";

async function assertHarnessRecovery(scenario: Scenario): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "codex-body-limit-harness-"));
  let upstream: ReturnType<typeof Bun.serve> | undefined;
  let recorder: ReturnType<typeof Bun.serve> | undefined;
  let proxy: ReturnType<typeof Bun.spawn> | undefined;
  let app: AppServer | undefined;
  let proxyStdout: Promise<string> | undefined;
  let proxyStderr: Promise<string> | undefined;
  const uploads: { body: Json; bytes: number }[] = [];
  const exchanges: Exchange[] = [];
  let failNextCompaction = scenario === "failed compaction";
  try {
    await mkdir(join(home, ".codex"), { recursive: true });
    await mkdir(join(home, ".codex-proxy", "errors"), { recursive: true });
    const templatePath = join(home, "models-template.json");
    await Bun.write(templatePath, JSON.stringify({ models: [] }));
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method === "GET" && path === "/v1/models") return Response.json({ data: [] });
        if (request.method !== "POST" || path !== "/v1/responses") {
          return new Response("Only the loopback Responses fixture is available", { status: 404 });
        }
        const raw = await request.arrayBuffer();
        const body = JSON.parse(new TextDecoder().decode(raw));
        uploads.push({ body, bytes: raw.byteLength });
        if (scenario === "upstream 413" && raw.byteLength > bodyLimit) {
          return new Response("failed to parse request", { status: 413 });
        }
        const compacting = inputText(body).includes(compactPrompt);
        if (compacting && failNextCompaction) {
          failNextCompaction = false;
          return Response.json({
            error: { code: "invalid_request_error", message: "HARNESS_COMPACTION_FAILURE" },
          }, { status: 400 });
        }
        return completedResponse(compacting ? summary : result);
      },
    });
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = reservation.port;
    reservation.stop(true);
    const proxyUrl = `http://127.0.0.1:${port}`;
    proxy = Bun.spawn([process.execPath, join(import.meta.dir, "server.ts")], {
      cwd: home,
      env: {
        HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin",
        UPSTREAM_MODE: "relay", UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.port}/v1`,
        UPSTREAM_API_KEY: "loopback-fixture-only", PORT: String(port),
        CODEX_MODELS_TEMPLATE: templatePath, MODEL_ALIASES: "{}", EXTRA_PICKER_MODELS: "",
        UPSTREAM_MAX_BODY_BYTES: scenario === "upstream 413" ? "0" : String(bodyLimit),
        UPSTREAM_RETRIES: "0", UPLOAD_CONCURRENCY: "0",
        TRIM_REASONING_KB: "0", TRIM_REASONING_ON_408: "0",
      },
      stdout: "pipe", stderr: "pipe",
    });
    proxyStdout = new Response(proxy.stdout).text();
    proxyStderr = new Response(proxy.stderr).text();
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        if ((await fetch(`${proxyUrl}/healthz`)).ok) { ready = true; break; }
      } catch {}
      if (proxy.exitCode !== null) throw new Error(`Proxy exited: ${await proxyStderr}`);
      await Bun.sleep(20);
    }
    if (!ready) throw new Error("Loopback test proxy did not become ready");
    recorder = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const raw = request.method === "GET" ? undefined : await request.arrayBuffer();
        const headers = new Headers(request.headers);
        headers.delete("host");
        headers.delete("content-length");
        const response = await fetch(`${proxyUrl}${url.pathname}${url.search}`, {
          method: request.method, headers, body: raw,
        });
        const text = await response.text();
        if (request.method === "POST" && url.pathname === "/v1/responses") {
          exchanges.push({
            body: JSON.parse(new TextDecoder().decode(raw)), bytes: raw!.byteLength,
            status: response.status, response: text,
          });
        }
        const outgoingHeaders = new Headers(response.headers);
        outgoingHeaders.delete("content-length");
        outgoingHeaders.delete("content-encoding");
        return new Response(text, { status: response.status, headers: outgoingHeaders });
      },
    });
    await Bun.write(join(home, ".codex", "config.toml"), `
model = "gpt-5.4-mini"
model_provider = "loopback_fixture"
model_context_window = 1000000
model_auto_compact_token_limit = 900000
compact_prompt = ${JSON.stringify(compactPrompt)}
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"

[features]
shell_tool = false
multi_agent = false

[model_providers.loopback_fixture]
name = "Loopback fixture"
base_url = "http://127.0.0.1:${recorder.port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 10000

[analytics]
enabled = false
`);
    app = new AppServer(codexBin!, home);
    await app.request("initialize", {
      clientInfo: { name: "codex_body_limit_harness_test", version: "1.0" },
    });
    app.child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const started = await app.request("thread/start", {
      cwd: home, model: "gpt-5.4-mini", modelProvider: "loopback_fixture",
      baseInstructions: "You are a deterministic test fixture. Do not use tools.",
    });
    const threadId = started.thread.id;
    const oversized = `OLD_INPUT_BEGIN\n${"history ".repeat(32768)}\nOLD_INPUT_END`;
    const failed = await app.turn(threadId, oversized);
    expect(failed.status).toBe("failed");
    expect(failed.error?.codexErrorInfo).toBe("contextWindowExceeded");
    expect(uploads).toHaveLength(scenario === "upstream 413" ? 1 : 0);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].bytes).toBeGreaterThan(bodyLimit);
    expect(exchanges[0].status).toBe(200);
    expect(exchanges[0].response).toContain('"code":"context_length_exceeded"');
    expect(exchanges[0].response.match(/^event: response\.failed$/gm)).toHaveLength(1);
    expect(exchanges[0].response).not.toContain("response.completed");
    let checkpoint = app.messages.length;
    let exchangeCheckpoint = exchanges.length;
    if (scenario === "failed compaction") {
      const failedCompaction = await app.turn(threadId, "Continue after compacting.");
      expect(failedCompaction.status).toBe("failed");
      expect(failedCompaction.error?.message).toContain("HARNESS_COMPACTION_FAILURE");
      expect(app.messages.slice(checkpoint).some((message) => message.method === "item/completed"
        && message.params.item.type === "contextCompaction")).toBe(false);
      const persisted = await app.request("thread/read", { threadId, includeTurns: true });
      const userInputs = persisted.thread.turns.flatMap((turn: Json) => turn.items)
        .filter((item: Json) => item.type === "userMessage").flatMap((item: Json) => item.content);
      expect(userInputs.some((item: Json) => item.type === "text" && item.text === oversized)).toBe(true);
      const records = (await Bun.file(persisted.thread.path).text()).trim().split("\n")
        .map((line) => JSON.parse(line));
      expect(records.some((record) => record.type === "compacted")).toBe(false);
      checkpoint = app.messages.length;
      exchangeCheckpoint = exchanges.length;
    }
    const recovered = await app.turn(threadId, "Continue using the compacted summary.");
    expect(recovered.status).toBe("completed");
    const compactions = exchanges.slice(exchangeCheckpoint)
      .filter((exchange) => inputText(exchange.body).includes(compactPrompt));
    expect(compactions.length).toBeGreaterThan(1);
    expect(compactions[0].bytes).toBeGreaterThan(bodyLimit);
    expect(inputText(compactions[0].body)).toContain(oversized);
    expect(compactions.at(-1)!.bytes).toBeLessThanOrEqual(bodyLimit);
    for (let index = 1; index < compactions.length; index++) {
      expect(compactions[index].bytes).toBeLessThan(compactions[index - 1].bytes);
    }
    if (scenario === "upstream 413") {
      expect(uploads.length).toBe(exchanges.length);
    } else {
      expect(uploads).toHaveLength(scenario === "failed compaction" ? 3 : 2);
      expect(uploads.every((upload) => upload.bytes <= bodyLimit)).toBe(true);
    }
    expect(inputText(uploads.at(-2)!.body)).toContain(compactPrompt);
    expect(inputText(uploads.at(-1)!.body)).toContain(summary);
    expect(inputText(uploads.at(-1)!.body)).toContain("Continue using the compacted summary.");
    expect(app.messages.slice(checkpoint).some((message) => message.method === "item/completed"
      && message.params.item.type === "contextCompaction")).toBe(true);
    expect(app.messages.slice(checkpoint).some((message) => message.method === "item/completed"
      && message.params.item.type === "agentMessage" && message.params.item.text === result)).toBe(true);
  } finally {
    await app?.stop();
    recorder?.stop(true);
    if (proxy) { proxy.kill(); await proxy.exited; }
    await proxyStdout;
    await proxyStderr;
    upstream?.stop(true);
    await rm(home, { recursive: true, force: true });
  }
}

for (const scenario of ["local byte rejection", "upstream 413", "failed compaction"] as const) {
  test.skipIf(!codexBin)(`installed Codex recovers safely after ${scenario}`,
    () => assertHarnessRecovery(scenario), 90_000);
}
