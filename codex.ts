import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { findCodexBinary } from "./picker-guard.ts";
import { parsePort } from "./setup.ts";

type Environment = Record<string, string | undefined>;
export const PROVIDER_ID = "portable-codex-proxy";

export async function buildCodexCommand(args: string[] = [], env: Environment = process.env) {
  const home = env.HOME || homedir();
  const codexHome = resolve(env.CODEX_HOME || join(home, ".codex"));
  const port = parsePort(env.PORT ?? "4141");
  const binary = await findCodexBinary(env);
  if (!binary) {
    throw new Error("Codex executable not found. Install Codex or set CODEX_BIN to its executable path.");
  }

  const forwarded = args[0] === "--" ? args.slice(1) : args;
  const catalog = join(codexHome, "models_cache.json");
  if (!forwarded.some((arg) => ["--help", "-h", "--version", "-V"].includes(arg))) {
    try {
      const data = await Bun.file(catalog).json();
      if (!data || !Array.isArray(data.models) || !data.models.length) throw new Error("empty catalog");
    } catch {
      throw new Error(`Models cache missing or invalid at ${catalog}. Start the proxy, then run "bun run refresh".`);
    }
  }
  const provider = [
    'name = "Local Codex Proxy"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "request_max_retries = 4",
    "stream_max_retries = 10",
    "stream_idle_timeout_ms = 300000",
  ].join(", ");
  const settings = [
    `model_provider = "${PROVIDER_ID}"`,
    `model = ${JSON.stringify(env.PROXY_MODEL || "claude-opus-5")}`,
    `model_reasoning_effort = ${JSON.stringify(env.PROXY_REASONING_EFFORT || "max")}`,
    `model_catalog_json = ${JSON.stringify(catalog)}`,
    // Codex merges provider tables. A dedicated stable name avoids common local-proxy collisions.
    `model_providers.${PROVIDER_ID} = { ${provider} }`,
  ];
  return {
    command: [binary, ...settings.flatMap((setting) => ["-c", setting]), ...forwarded],
    env: { ...env, HOME: home, CODEX_HOME: codexHome },
  };
}

export async function launchCodex(args: string[] = [], env: Environment = process.env): Promise<number> {
  const options = await buildCodexCommand(args, env);
  const child = Bun.spawn(options.command, {
    env: options.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  // Interactive children already receive the terminal's Ctrl-C. Do not send it twice.
  const interrupt = () => { if (!process.stdin.isTTY) child.kill("SIGINT"); };
  const terminate = () => { child.kill("SIGTERM"); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    return await child.exited;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await launchCodex(process.argv.slice(2));
  } catch (error) {
    console.error(`codex-proxy: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
