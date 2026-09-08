import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodexCommand } from "./codex.ts";
import { cleanupMockCodex, fakeCodex } from "./test-support/helpers.ts";

afterAll(cleanupMockCodex);
if (process.platform === "win32") setDefaultTimeout(60_000);

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "codex-proxy-launch-"));
  temporary.push(root);
  const home = join(root, "home with spaces");
  const codexHome = join(home, process.platform === "win32" ? ".codex 'custom' & [state]" : '.codex "custom"');
  await mkdir(codexHome, { recursive: true });
  const binary = await fakeCodex(join(root, "fake codex"), { echoArgs: true });
  await writeFile(join(codexHome, "models_cache.json"), JSON.stringify({ models: [{ slug: "fixture" }] }));
  const config = join(codexHome, "config.toml");
  await writeFile(config, 'model_provider = "existing"\n# keep user configuration\n');
  const env = { HOME: home, CODEX_HOME: codexHome, CODEX_BIN: binary, PATH: "/usr/bin:/bin" };
  return { root, home, codexHome, binary, config, env };
}

function overrides(command: string[]) {
  const settings: Record<string, any> = {};
  for (let i = 1; i < command.length; i += 2) {
    if (command[i] !== "-c") break;
    Object.assign(settings, Bun.TOML.parse(command[i + 1]));
  }
  return settings;
}

describe("portable Codex launcher", () => {
  test("builds provider overrides without editing user configuration", async () => {
    const f = await fixture();
    const before = await readFile(f.config, "utf8");
    const beforeStat = await stat(f.config);
    const result = await buildCodexCommand([], f.env);
    expect(result.command[0]).toBe(f.binary);
    const settings = overrides(result.command);
    expect(settings.model_provider).toBe("portable-codex-proxy");
    expect(settings.model).toBe("claude-opus-5");
    expect(settings.model_reasoning_effort).toBe("max");
    expect(settings.model_catalog_json).toBe(join(f.codexHome, "models_cache.json"));
    expect(settings.model_providers["portable-codex-proxy"]).toEqual({
      name: "Local Codex Proxy",
      base_url: "http://127.0.0.1:4141/v1",
      wire_api: "responses",
      requires_openai_auth: false,
      request_max_retries: 4,
      stream_max_retries: 10,
      stream_idle_timeout_ms: 300000,
    });
    expect(await readFile(f.config, "utf8")).toBe(before);
    expect((await stat(f.config)).mtimeMs).toBe(beforeStat.mtimeMs);
  });

  test("honors the port, model, reasoning, and CODEX_HOME environment", async () => {
    const f = await fixture();
    const result = await buildCodexCommand([], {
      ...f.env, PORT: "5252", PROXY_MODEL: 'custom-"model"', PROXY_REASONING_EFFORT: "high",
    });
    const settings = overrides(result.command);
    expect(settings.model).toBe('custom-"model"');
    expect(settings.model_reasoning_effort).toBe("high");
    expect(settings.model_providers["portable-codex-proxy"].base_url).toBe("http://127.0.0.1:5252/v1");
    expect(result.env.CODEX_HOME).toBe(f.codexHome);
  });

  test("caller flags follow defaults and a single Bun argument separator is stripped", async () => {
    const f = await fixture();
    const args = ["exec", "--model", "explicit-model", "-c", 'model_reasoning_effort="low"', "literal $prompt"];
    const result = await buildCodexCommand(["--", ...args], f.env);
    expect(result.command.slice(-args.length)).toEqual(args);
    expect(result.command.filter((arg) => arg === "--")).toHaveLength(0);
  });

  test("falls back to the same executable discovery used by the picker", async () => {
    const f = await fixture();
    const { CODEX_BIN: _, ...env } = f.env;
    const result = await buildCodexCommand([], { ...env, PICKER_GUARD_CLI_CODEX: f.binary });
    expect(result.command[0]).toBe(f.binary);
  });

  test("an invalid explicit executable fails instead of silently launching another client", async () => {
    const f = await fixture();
    await expect(buildCodexCommand([], { ...f.env, CODEX_BIN: join(f.root, "missing") }))
      .rejects.toThrow("Codex executable not found");
  });

  test("missing and malformed catalogs produce a useful recovery command", async () => {
    const f = await fixture();
    const cache = join(f.codexHome, "models_cache.json");
    for (const data of ["{", '{"models":[]}', '{"models":null}']) {
      await writeFile(cache, data);
      await expect(buildCodexCommand([], f.env)).rejects.toThrow("bun run refresh");
    }
    await rm(cache);
    await expect(buildCodexCommand([], f.env)).rejects.toThrow("bun run refresh");
  });

  test("help and version inspection work before the first catalog refresh", async () => {
    const f = await fixture();
    await rm(join(f.codexHome, "models_cache.json"));
    for (const arg of ["--help", "--version"]) {
      expect((await buildCodexCommand([arg], f.env)).command.at(-1)).toBe(arg);
    }
  });

  test("rejects malformed ports before any client is launched", async () => {
    const f = await fixture();
    for (const port of ["0", "65536", "abc", "4141/path"]) {
      await expect(buildCodexCommand([], { ...f.env, PORT: port })).rejects.toThrow("PORT must be");
    }
  });

  test("CLI forwards exact arguments, inherits the selected home, and propagates the exit status", async () => {
    const f = await fixture();
    const before = await readFile(f.config, "utf8");
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "codex.ts"), "--", "exec", "literal $prompt"], {
      cwd: f.root,
      env: { ...f.env, FAKE_EXIT: "7" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const output = new Response(child.stdout).json();
    const errors = new Response(child.stderr).text();
    expect(await child.exited).toBe(7);
    expect(await errors).toBe("");
    const result = await output as any;
    expect(result.args.slice(-2)).toEqual(["exec", "literal $prompt"]);
    expect(result.home).toBe(f.home);
    expect(result.codexHome).toBe(f.codexHome);
    expect(await readFile(f.config, "utf8")).toBe(before);
  });
});
