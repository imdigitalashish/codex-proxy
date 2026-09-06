import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { writePrivateAuthFile } from "./copilot-auth.ts";

let home: string;
const authPath = join(import.meta.dir, "copilot-auth.ts");
const permissions = async (path: string) => (await stat(path)).mode & 0o777;

beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "copilot-auth-test-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe("writePrivateAuthFile", () => {
  test("creates private files and missing parents without changing an existing parent", async () => {
    await chmod(home, 0o755);
    const directory = join(home, "custom", "credentials");
    const token = join(directory, "github-token");
    await writePrivateAuthFile(token, "fixture-only-token");

    expect(await readFile(token, "utf8")).toBe("fixture-only-token");
    expect(await permissions(token)).toBe(0o600);
    expect(await permissions(directory)).toBe(0o700);
    expect(await permissions(join(home, "custom"))).toBe(0o700);
    expect(await permissions(home)).toBe(0o755);
    expect(await readdir(directory)).toEqual(["github-token"]);
  });

  test("overwrites a permissive file atomically without modifying its old inode", async () => {
    const token = join(home, "github-token");
    const previous = join(home, "previous-token");
    await writeFile(token, "old-fixture-token");
    await chmod(token, 0o644);
    await link(token, previous);

    await writePrivateAuthFile(token, "new-fixture-token");

    expect(await readFile(token, "utf8")).toBe("new-fixture-token");
    expect(await permissions(token)).toBe(0o600);
    expect(await readFile(previous, "utf8")).toBe("old-fixture-token");
    expect(await permissions(previous)).toBe(0o644);
    expect((await stat(token)).ino).not.toBe((await stat(previous)).ino);
    expect((await readdir(home)).sort()).toEqual(["github-token", "previous-token"]);
  });

  test("replaces a token symlink without writing to its destination", async () => {
    const destination = join(home, "unrelated-file");
    const token = join(home, "github-token");
    await writeFile(destination, "untouched-fixture");
    await symlink(destination, token);

    await writePrivateAuthFile(token, "fixture-only-token");

    expect(await readFile(destination, "utf8")).toBe("untouched-fixture");
    expect(await readFile(token, "utf8")).toBe("fixture-only-token");
    expect((await lstat(token)).isSymbolicLink()).toBe(false);
    expect(await permissions(token)).toBe(0o600);
  });

  test("cleans temporary data when replacement fails", async () => {
    const token = join(home, "github-token");
    await mkdir(token);

    await expect(writePrivateAuthFile(token, "fixture-only-token")).rejects.toThrow();

    expect((await stat(token)).isDirectory()).toBe(true);
    expect(await readdir(home)).toEqual(["github-token"]);
    expect(await readdir(token)).toEqual([]);
  });

  test("preserves the previous token and cleans temporary data when a write fails", async () => {
    const token = join(home, "github-token");
    await writePrivateAuthFile(token, "previous-fixture-token");

    await expect(writePrivateAuthFile(token, undefined as unknown as string)).rejects.toThrow();

    expect(await readFile(token, "utf8")).toBe("previous-fixture-token");
    expect(await permissions(token)).toBe(0o600);
    expect(await readdir(home)).toEqual(["github-token"]);
  });
});

test("importing the authentication module has no login or filesystem side effects", async () => {
  const child = Bun.spawn([process.execPath, "--eval", `
    globalThis.fetch = () => { throw new Error("Unexpected authentication request"); };
    await import(${JSON.stringify(pathToFileURL(authPath).href)});
    console.log("imported");
  `], {
    cwd: home,
    env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
    stdout: "pipe", stderr: "pipe",
  });
  const output = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();

  expect(await child.exited).toBe(0);
  expect(output.trim()).toBe("imported");
  expect(error).toBe("");
  expect(await readdir(home)).toEqual([]);
});

test("device flow stores private status and a custom token without printing credentials", async () => {
  const preload = join(home, "offline-auth.ts");
  const observations = join(home, "observations.json");
  const token = join(home, "custom", "credentials", "github-token");
  await writeFile(preload, `
    import { writeFileSync } from "node:fs";
    const delays = [];
    let polls = 0;
    Bun.sleep = async (delay) => { delays.push(delay); };
    globalThis.fetch = async (url) => {
      if (url === "https://github.com/login/device/code") return Response.json({
        device_code: "fixture-device-code", user_code: "fixture-user-code",
        verification_uri: "https://github.com/login/device", expires_in: 120, interval: 0,
      });
      if (url !== "https://github.com/login/oauth/access_token") throw new Error("Unexpected URL");
      polls++;
      if (polls === 1) return Response.json({ error: "authorization_pending" });
      if (polls === 2) return Response.json({ error: "slow_down" });
      writeFileSync(${JSON.stringify(observations)}, JSON.stringify({ polls, delays }));
      return Response.json({ access_token: "fixture-only-access-token" });
    };
  `);
  const child = Bun.spawn([process.execPath, "--preload", preload, authPath], {
    cwd: home,
    env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", COPILOT_GITHUB_TOKEN_FILE: token },
    stdout: "pipe", stderr: "pipe",
  });
  const output = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();

  expect(await child.exited).toBe(0);
  expect(error).toBe("");
  expect(output).toContain("fixture-user-code");
  expect(output).not.toContain("fixture-only-access-token");
  expect(output).not.toContain("fixture-device-code");
  expect(await readFile(token, "utf8")).toBe("fixture-only-access-token");
  expect(await permissions(token)).toBe(0o600);
  expect(await permissions(join(home, "custom"))).toBe(0o700);
  expect(await permissions(join(home, "custom", "credentials"))).toBe(0o700);
  const statusPath = join(home, ".codex-proxy", "auth-status.json");
  expect(JSON.parse(await readFile(statusPath, "utf8")).state).toBe("authenticated");
  expect(await permissions(statusPath)).toBe(0o600);
  expect(await permissions(join(home, ".codex-proxy"))).toBe(0o700);
  expect(JSON.parse(await readFile(observations, "utf8"))).toEqual({ polls: 3, delays: [1000, 1000, 6000] });
  expect(await readdir(join(home, ".codex-proxy"))).toEqual(["auth-status.json"]);
  expect(await readdir(join(home, "custom", "credentials"))).toEqual(["github-token"]);
});
