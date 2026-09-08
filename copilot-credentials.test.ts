import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOmpCopilotCredential } from "./copilot-credentials.ts";

let directory: string;
let database: string;
let db: Database;
const apiBase = "https://api.enterprise.githubcopilot.com";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "codex-proxy-credentials-"));
  database = join(directory, "agent.db");
  db = new Database(database, { create: true });
  db.exec("CREATE TABLE auth_credentials (provider TEXT, data TEXT, disabled_cause TEXT, updated_at INTEGER)");
});
afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

function seed(token: string, updatedAt = 1, endpoint: string | undefined = apiBase, disabled: string | null = null, provider = "github-copilot") {
  db.query("INSERT INTO auth_credentials VALUES (?, ?, ?, ?)")
    .run(provider, JSON.stringify({ access: token, apiEndpoint: endpoint }), disabled, updatedAt);
}

describe("explicit OMP credential source", () => {
  test("selects only the newest enabled Copilot credential and leaves the store unchanged", async () => {
    seed("fixture-old", 1);
    seed("fixture-current", 2);
    seed("fixture-disabled", 3, apiBase, "revoked");
    seed("fixture-other-provider", 4, apiBase, null, "other-provider");
    const before = await readFile(database);
    expect(readOmpCopilotCredential(database)).toEqual({ token: "fixture-current", apiBase });
    expect(await readFile(database)).toEqual(before);
    expect(await readdir(directory)).toEqual(["agent.db"]);
  });

  test("picks up committed token rotations from a live WAL store", () => {
    db.exec("PRAGMA journal_mode=WAL");
    seed("fixture-first");
    expect(readOmpCopilotCredential(database).token).toBe("fixture-first");
    seed("fixture-rotated", 2);
    expect(readOmpCopilotCredential(database).token).toBe("fixture-rotated");
  });

  test("missing stores are not created and missing credentials fail clearly", async () => {
    const missing = join(directory, "missing.db");
    expect(() => readOmpCopilotCredential(missing)).toThrow();
    expect(await Bun.file(missing).exists()).toBe(false);
    expect(() => readOmpCopilotCredential(database)).toThrow("No enabled GitHub Copilot credential");
  });

  test("ignores malformed and empty records just like the existing shim", () => {
    seed("fixture-valid");
    db.query("INSERT INTO auth_credentials VALUES ('github-copilot', ?, NULL, 2)").run("not JSON");
    db.query("INSERT INTO auth_credentials VALUES ('github-copilot', ?, NULL, 3)").run('{"access":""}');
    expect(readOmpCopilotCredential(database).token).toBe("fixture-valid");
  });

  test("uses the public Copilot origin when the store omits its endpoint", () => {
    db.query("INSERT INTO auth_credentials VALUES ('github-copilot', ?, NULL, 1)").run('{"access":"fixture-only"}');
    expect(readOmpCopilotCredential(database).apiBase).toBe("https://api.githubcopilot.com");
  });

  test.each([
    "http://api.githubcopilot.com", "https://api.githubcopilot.com.evil.example",
    "https://evil.example", "https://user:password@api.githubcopilot.com",
    "https://api.githubcopilot.com:8443", "https://api.githubcopilot.com/path",
    "https://api.githubcopilot.com/?key=secret", "https://api.githubcopilot.com/#fragment",
  ])("rejects token forwarding to an untrusted origin: %s", (endpoint) => {
    seed("fixture-secret", 1, endpoint);
    expect(() => readOmpCopilotCredential(database)).toThrow("Untrusted Copilot endpoint");
  });

  test("rejects header injection without echoing the credential", () => {
    seed("fixture-secret\r\nInjected: value");
    expect(() => readOmpCopilotCredential(database)).toThrow("Invalid Copilot credential in the configured OMP store");
  });
});

test("proxy validates direct OAuth, follows rotations, and does not copy or log tokens", async () => {
  seed("fixture-first");
  const preload = join(directory, "mock-fetch.ts");
  const observations = join(directory, "observed-auth.json");
  await writeFile(preload, `
const observed = [];
globalThis.fetch = async (url, options) => {
  if (url !== ${JSON.stringify(apiBase + "/models")}) throw new Error("Unexpected upstream request");
  if (options.redirect !== "error" && options.redirect !== undefined) throw new Error("Unexpected redirect mode");
  const auth = new Headers(options.headers).get("authorization");
  observed.push(auth);
  await Bun.write(${JSON.stringify(observations)}, JSON.stringify(observed));
  if (!["Bearer fixture-first", "Bearer fixture-rotated"].includes(auth)) return new Response("Unauthorized", { status: 401 });
  return Response.json({ data: [{ id: "gpt-fixture", vendor: "OpenAI", supported_endpoints: ["/responses"] }] });
};
`);
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port;
  reservation.stop(true);
  const child = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "server.ts")], {
    cwd: directory,
    env: { HOME: directory, PATH: process.env.PATH, PORT: String(port), UPSTREAM_MODE: "copilot", COPILOT_OMP_AUTH_DB: database },
    stdout: "pipe", stderr: "pipe",
  });
  const output = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();
  const health = () => fetch(`http://127.0.0.1:${port}/healthz`).then((response) => response.json());
  try {
    let initial: any;
    for (let attempt = 0; attempt < 150; attempt++) {
      try { initial = await health(); break; } catch {}
      if (child.exitCode !== null) throw new Error(`Fixture proxy exited: ${await errors}`);
      await Bun.sleep(20);
    }
    expect(initial.copilot).toEqual({ authenticated: true, source: "omp", apiBase });
    expect(initial.catalogModels).toBe(1);
    seed("fixture-rotated", 2);
    expect((await health()).copilot.authenticated).toBe(true);
    expect(await Bun.file(observations).json()).toContain("Bearer fixture-rotated");
    seed("fixture-rejected", 3);
    const rejected = await health();
    expect(rejected.copilot.authenticated).toBe(false);
    expect(rejected.copilot.error).toContain("HTTP 401");
    expect(await Bun.file(join(directory, ".codex-proxy", "github-token")).exists()).toBe(false);
  } finally {
    child.kill();
    await child.exited;
  }
  const logs = await output;
  expect(logs).not.toContain("fixture-first");
  expect(logs).not.toContain("fixture-rotated");
  expect(logs).not.toContain("fixture-rejected");
  expect(await errors).toBe("");
}, 20_000);
