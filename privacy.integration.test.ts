import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPrivatePermissions } from "./test-support/helpers.ts";

test.each([false, true])("request recording and lossy retry trimming require explicit opt-in (%s)", async (optIn) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-proxy-privacy-"));
  const marker = "PRIVATE_REQUEST_FIXTURE_DO_NOT_LOG";
  const captured: any[] = [];
  let attempts = 0;
  let proxy: ReturnType<typeof Bun.spawn> | undefined;
  let stdout: Promise<string> | undefined;
  let stderr: Promise<string> | undefined;
  const upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.method === "GET") return Response.json({ data: [{
        id: "gpt-fixture", vendor: "OpenAI", supported_endpoints: ["/responses"],
      }] });
      const body = await request.json();
      if (request.headers.get("x-test-retry")) {
        captured.push(body);
        if (attempts++ > 0) return Response.json({ status: "completed", output: [] });
        return Response.json({ error: { message: marker } }, { status: 408 });
      }
      return Response.json({ error: { message: marker } }, { status: 400 });
    },
  });
  try {
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = reservation.port;
    reservation.stop(true);
    const base = `http://127.0.0.1:${port}`;
    proxy = Bun.spawn([process.execPath, join(import.meta.dir, "server.ts")], {
      cwd: directory,
      env: {
        HOME: directory, PATH: process.env.PATH, PORT: String(port),
        UPSTREAM_MODE: "relay", UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.port}`,
        UPSTREAM_API_KEY: "fixture-only", UPSTREAM_RETRIES: "1", UPLOAD_CONCURRENCY: "0",
        ...(optIn ? { RECORD_ERROR_BODIES: "1", TRIM_REASONING_ON_408: "1" } : {}),
        TRIM_REASONING_KEEP: "1",
      },
      stdout: "pipe", stderr: "pipe",
    });
    stdout = new Response(proxy.stdout).text();
    stderr = new Response(proxy.stderr).text();
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      try { if ((await fetch(`${base}/healthz`)).ok) { ready = true; break; } } catch {}
      if (proxy.exitCode !== null) throw new Error(`Fixture exited: ${await stderr}`);
      await Bun.sleep(20);
    }
    expect(ready).toBe(true);
    const health = await (await fetch(`${base}/healthz`)).json();
    expect(health.uplink.trimReasoningOn408).toBe(optIn);
    const request = { model: "gpt-fixture", input: [{ role: "user", content: marker }] };
    const failed = await fetch(`${base}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
    });
    expect(failed.status).toBe(400);
    expect((await failed.json()).error.message).toBe(marker);
    const errors = join(directory, ".codex-proxy", "errors");
    const dumps = await readdir(errors).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return [];
    });
    expect(dumps).toHaveLength(optIn ? 1 : 0);
    if (optIn) {
      const file = join(errors, dumps[0]);
      expect((await Bun.file(file).json()).request).toEqual(request);
      await expectPrivatePermissions(file, 0o600);
      await expectPrivatePermissions(errors, 0o700);
    }

    const input = [
      ...Array.from({ length: 4 }, (_, index) => ({ type: "reasoning", encrypted_content: `opaque-${index}` })),
      { role: "user", content: "retry fixture" },
    ];
    const response = await fetch(`${base}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json", "x-test-retry": "1" },
      body: JSON.stringify({ model: "gpt-fixture", input }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(captured).toHaveLength(2);
    expect(captured[0].input).toEqual(input);
    expect(captured[1].input).toEqual(optIn ? input.slice(-2) : input);
    proxy.kill();
    await proxy.exited;
    const logs = await stdout;
    if (optIn) expect(logs).toContain(marker);
    else {
      expect(logs).not.toContain(marker);
      expect(logs).not.toContain("opaque-");
      expect(logs).not.toContain("reasoning_trimmed");
    }
  } finally {
    if (proxy && proxy.exitCode === null) { proxy.kill(); await proxy.exited; }
    await stdout;
    await stderr;
    upstream.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
