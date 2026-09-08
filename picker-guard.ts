import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, appendFile, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { protectWindowsPath, watchTaskParent } from "./windows.ts";

type Environment = Record<string, string | undefined>;
type Model = Record<string, unknown> & { slug: string };
type RefreshOptions = {
  env?: Environment;
  force?: boolean;
  now?: () => number;
  requestTimeoutMs?: number;
  versionTimeoutMs?: number;
};

const MIN_MODELS = 10;
const MAX_CACHE_AGE_MS = 150_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCatalog(value: unknown): value is { models: Model[] } {
  return isRecord(value) && Array.isArray(value.models) && value.models.length >= MIN_MODELS
    && value.models.every((model) => isRecord(model) && typeof model.slug === "string" && model.slug.length > 0);
}

function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function metadataHash(models: Model[]): string {
  // Sort object keys recursively, but retain every array's ordering and all metadata.
  return createHash("sha256").update(canonicalJSON(models)).digest("hex");
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function findCodexBinary(env: Environment = process.env): Promise<string | undefined> {
  if (env.CODEX_BIN) {
    const binary = isAbsolute(env.CODEX_BIN) ? env.CODEX_BIN : Bun.which(env.CODEX_BIN, { PATH: env.PATH ?? "" });
    return binary && await isExecutable(binary) ? resolve(binary) : undefined;
  }
  const home = env.HOME || homedir();
  const appOverride = env.PICKER_GUARD_APP_CODEX;
  const cliOverride = env.PICKER_GUARD_CLI_CODEX;
  const candidates = [
    appOverride,
    cliOverride,
    !appOverride && process.platform === "darwin" ? "/Applications/ChatGPT.app/Contents/Resources/codex" : undefined,
    !appOverride && process.platform === "win32"
      ? join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "Programs", "OpenAI", "Codex", "bin", "codex.exe") : undefined,
    !cliOverride ? join(home, ".local", "bin", process.platform === "win32" ? "codex.exe" : "codex") : undefined,
    env.PATH ? Bun.which("codex", { PATH: env.PATH }) : undefined,
  ];
  for (const candidate of candidates) {
    if (candidate && await isExecutable(candidate)) return resolve(candidate);
  }
}

function clientVersion(binary: string, env: Environment, timeoutMs: number): string | undefined {
  try {
    const result = Bun.spawnSync([binary, "--version"], {
      env,
      stdout: "pipe",
      stderr: "ignore",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    });
    if (result.exitCode !== 0) return;
    return result.stdout.toString().match(/\b\d+\.\d+\.\d+\b/)?.[0];
  } catch {
    return;
  }
}

async function replaceCache(path: string, cache: unknown): Promise<void> {
  const created = await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (created) await protectWindowsPath(created);
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await protectWindowsPath(temporary);
    await file.writeFile(`${JSON.stringify(cache, null, 2)}\n`);
    await file.sync();
    await file.close();
    await rename(temporary, path);
  } catch (error) {
    await file.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function refreshPickerCache({
  env = process.env,
  force = false,
  now = Date.now,
  requestTimeoutMs = 20_000,
  versionTimeoutMs = 5_000,
}: RefreshOptions = {}): Promise<boolean> {
  const binary = await findCodexBinary(env);
  if (!binary) return false;
  const version = clientVersion(binary, env, versionTimeoutMs);
  if (!version) return false;

  let incoming: unknown;
  let incomingHash: string;
  try {
    const response = await fetch(env.PICKER_GUARD_MODELS_URL || `http://127.0.0.1:${env.PORT || "4141"}/v1/models`, {
      headers: { "user-agent": `codex_cli_rs/${version}` },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) return false;
    incoming = await response.json();
    if (!isCatalog(incoming)) return false;
    incomingHash = metadataHash(incoming.models);
  } catch {
    return false;
  }

  const home = env.HOME || homedir();
  const cachePath = join(resolve(env.CODEX_HOME || join(home, ".codex")), "models_cache.json");
  let previous: unknown;
  try {
    previous = JSON.parse(await readFile(cachePath, "utf8"));
  } catch {
    previous = undefined;
  }
  const cache = isRecord(previous) ? previous : {};
  const stamp = typeof cache.fetched_at === "string" ? Date.parse(cache.fetched_at) : NaN;
  const refreshedAt = now();
  const age = refreshedAt - stamp;
  let previousHash: string | undefined;
  try {
    if (isCatalog(cache)) previousHash = metadataHash(cache.models);
  } catch {
    // An unreadable previous catalog is repairable; never use it to reject a valid replacement.
  }
  const metadataChanged = previousHash !== incomingHash;
  const versionChanged = cache.client_version !== version;
  if (!force && !metadataChanged && !versionChanged && Number.isFinite(age) && age >= 0 && age <= MAX_CACHE_AGE_MS) {
    return false;
  }

  await replaceCache(cachePath, {
    client_version: version,
    etag: 'W/"local-proxy-extended"',
    fetched_at: new Date(refreshedAt).toISOString(),
    models: incoming.models,
  });

  if (force || metadataChanged || versionChanged) {
    const logDirectory = join(home, ".codex-proxy");
    const previousCount = Array.isArray(cache.models) ? cache.models.length : 0;
    const previousVersion = typeof cache.client_version === "string" ? cache.client_version : "none";
    const message = `${new Date(refreshedAt).toISOString()} re-seeded models cache: ${previousCount} -> ${incoming.models.length}, version ${previousVersion} -> ${version} (age ${Math.floor(age / 1000)}s, force=${Number(force)}, metadata checked)\n`;
    // Logging is best effort; a log failure must not undo an otherwise valid refresh.
    await mkdir(logDirectory, { recursive: true, mode: 0o700 })
      .then(() => appendFile(join(logDirectory, "picker-guard.log"), message, { mode: 0o600 }))
      .catch(() => {});
  }
  return true;
}

if (import.meta.main) {
  watchTaskParent();
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--force")) {
    console.error("Usage: picker-guard.ts [--force]");
    process.exitCode = 2;
  } else {
    try {
      await refreshPickerCache({ force: args[0] === "--force" });
    } catch {
      console.error("picker-guard: unable to replace the models cache");
      process.exitCode = 1;
    }
  }
}
