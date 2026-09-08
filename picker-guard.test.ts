import { afterAll, afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshPickerCache } from "./picker-guard";
import { cleanupMockCodex, expectPrivatePermissions, fakeCodex } from "./test-support/helpers.ts";

afterAll(cleanupMockCodex);
// This suite launches multiple native clients per case. Its timeout regression
// tests still use explicit 20 ms deadlines for the operations under test.
if (process.platform === "win32") setDefaultTimeout(60_000);

let home: string;
let models: any[];
let server: ReturnType<typeof Bun.serve>;
let status: number;
let malformed: boolean;
let cachePath: string;
let codexPath: string;
let userAgent: string | null;
let requests: number;
let delayMs: number;
const guard = join(import.meta.dir, "picker-guard.ts");
const wrapper = join(import.meta.dir, "picker-guard.sh");

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "codex-picker-guard-test-"));
  await mkdir(join(home, ".codex"));
  await mkdir(join(home, ".codex-proxy"));
  cachePath = join(home, ".codex", "models_cache.json");
  codexPath = await fakeCodex(join(home, "codex"), { version: "0.153.0-alpha.5" });
  models = Array.from({ length: 10 }, (_, index) => ({
    slug: `model-${index}`, priority: index, supported_reasoning_levels: [{ effort: "max", description: "Maximum" }],
  }));
  status = 200;
  malformed = false;
  userAgent = null;
  requests = 0;
  delayMs = 0;
  server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async (request) => {
      userAgent = request.headers.get("user-agent");
      requests++;
      if (delayMs) await Bun.sleep(delayMs);
      return malformed ? new Response("not JSON", { status }) : Response.json({ models }, { status });
    },
  });
}, 30_000);

afterEach(async () => {
  server.stop(true);
  await rm(home, { recursive: true, force: true });
});

async function seed(overrides: Record<string, unknown> = {}) {
  await Bun.write(cachePath, JSON.stringify({
    models, client_version: "0.153.0", fetched_at: new Date().toISOString(),
    preserved_if_not_rewritten: true, ...overrides,
  }));
  return Bun.file(cachePath).text();
}

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    PICKER_GUARD_APP_CODEX: codexPath,
    PICKER_GUARD_MODELS_URL: `http://127.0.0.1:${server.port}/v1/models`,
    ...overrides,
  };
}

async function invokeGuard(args: string[] = [], overrides: Record<string, string | undefined> = {}, shell = false) {
  const child = Bun.spawn(shell ? ["/bin/sh", wrapper, ...args] : [process.execPath, guard, ...args], {
    cwd: home,
    env: environment(overrides),
    stdout: "pipe", stderr: "pipe",
  });
  const output = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();
  return { code: await child.exited, output: await output, errors: await errors };
}

async function runGuard(...args: string[]) {
  expect(await invokeGuard(args)).toEqual({ code: 0, output: "", errors: "" });
}

describe("picker cache refresh", () => {
  test("initializes a complete cache and normalizes the embedded client's prerelease version", async () => {
    await runGuard();
    expect(await Bun.file(cachePath).json()).toMatchObject({
      models, client_version: "0.153.0", etag: 'W/"local-proxy-extended"',
    });
    expect(userAgent).toBe("codex_cli_rs/0.153.0");
    await expectPrivatePermissions(cachePath, 0o600);
  });

  test("refreshes fresh, same-count catalogs when Ultra or harness metadata changes", async () => {
    await seed();
    models[0].multi_agent_version = "v2";
    models[0].multi_agent_reasoning_effort = "max";
    models[0].supported_reasoning_levels.push({ effort: "ultra", description: "Codex harness" });
    await runGuard();
    expect((await Bun.file(cachePath).json()).models).toEqual(models);
  });

  test("refreshes ordering-only changes", async () => {
    await seed();
    models.reverse();
    await runGuard();
    expect((await Bun.file(cachePath).json()).models).toEqual(models);
  });

  test("refreshes same-count model replacement changes", async () => {
    await seed();
    models[0].slug = "new-model";
    await runGuard();
    expect((await Bun.file(cachePath).json()).models).toEqual(models);
  });

  test("does not rewrite an unchanged fresh cache, including JSON key-order differences", async () => {
    const before = await seed();
    models = models.map((model) => ({
      supported_reasoning_levels: model.supported_reasoning_levels.map((level: any) => ({
        description: level.description, effort: level.effort,
      })),
      priority: model.priority, slug: model.slug,
    }));
    await runGuard();
    expect(await Bun.file(cachePath).text()).toBe(before);
  });

  test("--force refreshes a matching fresh cache", async () => {
    await seed();
    await runGuard("--force");
    const refreshed = await Bun.file(cachePath).json();
    expect(refreshed.models).toEqual(models);
    expect(refreshed.preserved_if_not_rewritten).toBeUndefined();
  });

  test("refreshes stale timestamps and client-version mismatches", async () => {
    await seed({ fetched_at: "2000-01-01T00:00:00.000000Z" });
    await runGuard();
    expect(Date.now() - Date.parse((await Bun.file(cachePath).json()).fetched_at)).toBeLessThan(5000);
    await seed({ client_version: "0.151.0" });
    await runGuard();
    expect((await Bun.file(cachePath).json()).client_version).toBe("0.153.0");
  });

  test("refreshes only after the 150-second freshness boundary", async () => {
    const now = Date.now();
    const before = await seed({ fetched_at: new Date(now - 150_000).toISOString() });
    expect(await refreshPickerCache({ env: environment(), now: () => now })).toBe(false);
    expect(await Bun.file(cachePath).text()).toBe(before);
    expect(await refreshPickerCache({ env: environment(), now: () => now + 1 })).toBe(true);
    expect(await Bun.file(cachePath).text()).not.toBe(before);
  });

  test("repairs corrupt caches and invalid or future timestamps", async () => {
    for (const text of ["not JSON", "null", "[]", "17", '{"models":"invalid"}']) {
      await Bun.write(cachePath, text);
      await runGuard();
      expect((await Bun.file(cachePath).json()).models).toEqual(models);
    }
    for (const fetched_at of [null, "", "not a date", new Date(Date.now() + 60_000).toISOString()]) {
      await seed({ fetched_at });
      await runGuard();
      expect((await Bun.file(cachePath).json()).preserved_if_not_rewritten).toBeUndefined();
    }
  });

  test("keeps the last good cache on upstream errors, malformed data, or truncated lists", async () => {
    const before = await seed();
    status = 503;
    await runGuard("--force");
    expect(await Bun.file(cachePath).text()).toBe(before);
    status = 200;
    malformed = true;
    await runGuard("--force");
    expect(await Bun.file(cachePath).text()).toBe(before);
    malformed = false;
    for (const invalidModels of [[], models.slice(0, 9), Array(10).fill(null), Array(10).fill({ slug: "" })]) {
      models = invalidModels;
      await runGuard("--force");
      expect(await Bun.file(cachePath).text()).toBe(before);
    }
  });

  test("bounds network waits and preserves the last good cache on timeout", async () => {
    const before = await seed();
    delayMs = 200;
    expect(await refreshPickerCache({ env: environment(), force: true, requestTimeoutMs: 20 })).toBe(false);
    expect(await Bun.file(cachePath).text()).toBe(before);
  });

  test("honors CODEX_HOME and PORT and creates private missing cache directories", async () => {
    const customHome = join(home, "custom codex", "state");
    expect(await invokeGuard([], {
      CODEX_HOME: customHome,
      PORT: String(server.port),
      PICKER_GUARD_MODELS_URL: undefined,
    })).toEqual({ code: 0, output: "", errors: "" });
    const customCache = join(customHome, "models_cache.json");
    expect((await Bun.file(customCache).json()).models).toEqual(models);
    await expectPrivatePermissions(customHome, 0o700);
    await expectPrivatePermissions(customCache, 0o600);
    expect(await Bun.file(cachePath).exists()).toBe(false);
  });

  test("prioritizes an explicit CLI override before the default macOS app", async () => {
    expect(await invokeGuard([], {
      PICKER_GUARD_APP_CODEX: undefined,
      PICKER_GUARD_CLI_CODEX: codexPath,
    })).toEqual({ code: 0, output: "", errors: "" });
    expect((await Bun.file(cachePath).json()).client_version).toBe("0.153.0");
  });

  test("uses an explicit CODEX_BIN outside PATH before picker-specific defaults", async () => {
    const binary = await fakeCodex(join(home, "custom codex"), { version: "0.154.4-alpha.2" });
    expect(await invokeGuard([], {
      CODEX_BIN: binary,
      PATH: "",
    })).toEqual({ code: 0, output: "", errors: "" });
    expect((await Bun.file(cachePath).json()).client_version).toBe("0.154.4");
  });

  test("resolves a CODEX_BIN command name on PATH", async () => {
    const bin = join(home, "custom-command-bin");
    await mkdir(bin);
    await fakeCodex(join(bin, "alternate-codex"), { version: "0.154.5" });
    expect(await invokeGuard([], {
      CODEX_BIN: "alternate-codex",
      PATH: bin,
    })).toEqual({ code: 0, output: "", errors: "" });
    expect((await Bun.file(cachePath).json()).client_version).toBe("0.154.5");
  });

  test("invalid explicit CODEX_BIN never falls back to another installed executable", async () => {
    const before = await seed();
    const notExecutable = join(home, "non-executable-codex");
    await Bun.write(notExecutable, "#!/bin/sh\nprintf 'codex-cli 0.154.6\\n'\n");
    await chmod(notExecutable, 0o600);
    for (const override of [join(home, "missing-codex"), "missing-command", notExecutable, home]) {
      expect(await invokeGuard(["--force"], {
        CODEX_BIN: override,
        PATH: "",
      })).toEqual({ code: 0, output: "", errors: "" });
    }
    expect(requests).toBe(0);
    expect(await Bun.file(cachePath).text()).toBe(before);
  });

  test("falls back to HOME/.local/bin/codex", async () => {
    const bin = join(home, ".local", "bin");
    await mkdir(bin, { recursive: true });
    await fakeCodex(join(bin, "codex"), { version: "0.154.2" });
    expect(await invokeGuard([], {
      PICKER_GUARD_APP_CODEX: join(home, "missing-app"),
    })).toEqual({ code: 0, output: "", errors: "" });
    expect((await Bun.file(cachePath).json()).client_version).toBe("0.154.2");
  });

  test.skipIf(process.platform !== "win32")("discovers the user-local Windows Codex installation without PATH", async () => {
    const localAppData = join(home, "AppData", "Local");
    await fakeCodex(join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe"), { version: "0.153.4" });
    expect(await invokeGuard([], {
      PATH: "", LOCALAPPDATA: localAppData, PICKER_GUARD_APP_CODEX: undefined,
    })).toEqual({ code: 0, output: "", errors: "" });
    expect((await Bun.file(cachePath).json()).client_version).toBe("0.153.4");
  });

  test("falls back to PATH without curl, jq, shasum, date, or zsh", async () => {
    const bin = join(home, "only-codex-bin");
    await mkdir(bin);
    await fakeCodex(join(bin, "codex"), { version: "0.154.3-beta.1" });
    expect(await invokeGuard([], {
      PATH: bin,
      PICKER_GUARD_APP_CODEX: join(home, "missing-app"),
      PICKER_GUARD_CLI_CODEX: join(home, "missing-cli"),
    })).toEqual({ code: 0, output: "", errors: "" });
    expect((await Bun.file(cachePath).json()).client_version).toBe("0.154.3");
  });

  test.skipIf(process.platform === "win32")("keeps the POSIX shell wrapper usable with an explicit Bun binary", async () => {
    expect(await invokeGuard(["--force"], {
      BUN_BIN: process.execPath,
      PATH: "/usr/bin:/bin",
    }, true)).toEqual({ code: 0, output: "", errors: "" });
    expect((await Bun.file(cachePath).json()).models).toEqual(models);
  });

  test("skips missing, failing, or unrecognized Codex executables", async () => {
    const before = await seed();
    expect(await invokeGuard([], {
      PATH: "",
      PICKER_GUARD_APP_CODEX: join(home, "missing-app"),
      PICKER_GUARD_CLI_CODEX: join(home, "missing-cli"),
    })).toEqual({ code: 0, output: "", errors: "" });
    for (const options of [{ exitCode: 1 }, { version: "unknown-version" }]) {
      await fakeCodex(codexPath, options);
      await runGuard();
    }
    expect(requests).toBe(0);
    expect(await Bun.file(cachePath).text()).toBe(before);
  });

  test("bounds a stuck Codex version command", async () => {
    const before = await seed();
    await fakeCodex(codexPath, { hang: true });
    expect(await refreshPickerCache({ env: environment(), force: true, versionTimeoutMs: 20 })).toBe(false);
    expect(requests).toBe(0);
    expect(await Bun.file(cachePath).text()).toBe(before);
  });

  test("cleans temporary files if atomic replacement fails", async () => {
    await mkdir(cachePath);
    const result = await invokeGuard();
    expect(result.code).toBe(1);
    expect(result.errors).toContain("unable to replace the models cache");
    expect((await stat(cachePath)).isDirectory()).toBe(true);
    expect(await readdir(join(home, ".codex"))).toEqual(["models_cache.json"]);
  });

  test("rejects unknown or extra arguments without changing the cache", async () => {
    const before = await seed();
    for (const args of [["--unknown"], ["--force", "--unknown"], ["--force", "--force"]]) {
      const result = await invokeGuard(args);
      expect(result.code).toBe(2);
      expect(result.errors).toContain("Usage:");
    }
    expect(requests).toBe(0);
    expect(await Bun.file(cachePath).text()).toBe(before);
  });
});
