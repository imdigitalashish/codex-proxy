import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { installWindowsTasks, protectWindowsPath, renderWindowsTasks } from "./windows.ts";

export type Platform = "darwin" | "linux" | "win32";
export type InstallOptions = {
  home?: string;
  sourceDir?: string;
  platform?: Platform;
  services?: boolean;
  codexHome?: string;
  bunExecutable?: string;
  env?: Record<string, string | undefined>;
};

const usage = `Usage: bun run setup [--home DIR] [--platform darwin|linux|win32] [--services]

Copies the package to HOME/.codex-proxy without changing existing credentials
or Codex configuration. --services installs user service definitions, but never
loads, enables, starts, or restarts them. Without it, definitions are only written
to HOME/.codex-proxy/services. Windows tasks are registered disabled for the
current user. No authentication or network requests are made.
`;

export function parseArgs(args: string[]): InstallOptions & { help?: boolean } {
  const options: InstallOptions & { help?: boolean } = {};
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const [flag, ...inline] = args[i].split("=");
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === "--help" || flag === "-h") {
      if (inline.length) throw new Error(`${flag} does not take a value`);
      options.help = true;
    } else if (flag === "--services") {
      if (inline.length) throw new Error("--services does not take a value");
      options.services = true;
    } else if (flag === "--home" || flag === "--platform") {
      const value = inline.length ? inline.join("=") : args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      if (flag === "--home") options.home = value;
      else options.platform = parsePlatform(value);
    } else {
      throw new Error(`Unknown option: ${args[i]}`);
    }
  }
  return options;
}

function parsePlatform(value: string): Platform {
  if (value !== "darwin" && value !== "linux" && value !== "win32") {
    throw new Error(`Unsupported platform: ${value}. Use macOS, Linux, or Windows.`);
  }
  return value;
}

function safeText(value: string, label: string): string {
  if (!value || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} must be nonempty and contain no control characters`);
  }
  return value;
}

export function parsePort(value: string): number {
  if (!/^[0-9]+$/.test(value.trim())) throw new Error("PORT must be an integer from 1 to 65535");
  const port = Number(value.trim());
  if (port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535");
  return port;
}

function valueFromDotenv(text: string, key: string): string | undefined {
  let value: string | undefined;
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z_0-9]*)\s*=\s*(.*)$/);
    if (!match || match[1] !== key) continue;
    const raw = match[2].trim();
    if (/^['"`]/.test(raw)) {
      const quoted = raw.match(/^(['"`])(.*?)\1\s*(?:#.*)?$/);
      if (!quoted) throw new Error(`${key} in .env must be a single-line literal`);
      value = quoted[2];
    } else {
      value = raw.split("#", 1)[0].trim();
    }
  }
  return value;
}

function setDotenvLiteral(text: string, key: string, value: string): string {
  // Choose a delimiter that needs no escape processing or shell evaluation.
  const quote = ["'", '"', "`"].find((candidate) => !value.includes(candidate));
  if (!quote || /[$\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${key} must be a literal value without interpolation or control characters`);
  }
  const assignment = `${key}=${quote}${value}${quote}`;
  const pattern = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=.*$`, "gm");
  return pattern.test(text) ? text.replace(pattern, () => assignment)
    : `${text}${text.endsWith("\n") ? "" : "\n"}${assignment}\n`;
}

async function inspect(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function manifestPath(value: unknown): string {
  if (typeof value !== "string" || !value || /[\\:*?"<>|\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`Invalid package.files entry: ${JSON.stringify(value)}`);
  }
  const parts = value.split("/");
  if (isAbsolute(value) || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe package.files path: ${value}`);
  }
  if (parts.some((part) => /[. ]$/.test(part))) throw new Error(`Unsafe package.files path: ${value}`);
  if (parts.map((part) => part.toLowerCase()).some((part) =>
    part === ".git" || part === ".env" || (part.startsWith(".env.") && part !== ".env.example") ||
    part === "github-token" || part === "auth-status.json" || part === "errors" || part === "logs" || part.endsWith(".log") ||
    part === "config.toml" || part === "codex-provider.toml" || part === "services"
  )) {
    throw new Error(`Private or generated state is not distributable: ${value}`);
  }
  return value;
}

async function checkPath(root: string, relative: string, kind: "file" | "directory") {
  let path = root;
  const parts = relative ? relative.split("/") : [];
  for (let i = 0; i <= parts.length; i++) {
    const info = await inspect(path);
    if (!info) return;
    const directory = i < parts.length || kind === "directory";
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) {
      throw new Error(`Refusing non-${directory ? "directory" : "regular-file"} path: ${path}`);
    }
    if (i < parts.length) path = join(path, parts[i]);
  }
}

async function privateDirectory(path: string) {
  if (await inspect(path)) return;
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function writeManaged(path: string, contents: string | Uint8Array, mode = 0o600) {
  const wanted = Buffer.from(contents);
  const existing = await inspect(path);
  if (existing?.isFile() && Buffer.compare(await readFile(path), wanted) === 0) return false;
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  const file = await open(temporary, "wx", mode);
  try {
    await file.writeFile(wanted);
    await file.chmod(mode);
    await file.close();
    await rename(temporary, path);
    return true;
  } finally {
    await file.close();
    await rm(temporary, { force: true });
  }
}

const xml = (value: string) => value.replace(/[<>&"']/g, (c) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;",
})[c]!);
const specifiers = (value: string) => value.replaceAll("%", "%%");
const unitWord = (value: string) =>
  `"${specifiers(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export function renderServiceDefinitions(options: {
  platform: Platform;
  home: string;
  codexHome: string;
  installDir: string;
  bunExecutable: string;
  path: string;
}): Record<string, string> {
  const { platform, home, codexHome, installDir, bunExecutable, path } = options;
  for (const [key, value] of Object.entries(options)) safeText(value, key);
  if (platform === "win32") return renderWindowsTasks(options);
  const environment = { HOME: home, CODEX_HOME: codexHome, PATH: path };
  if (platform === "darwin") {
    function plist(label: string, script: string, log: string, schedule: string) {
      const args = [bunExecutable, "run", join(installDir, script)]
        .map((arg) => `      <string>${xml(arg)}</string>`).join("\n");
      const env = Object.entries(environment)
        .map(([key, value]) => `      <key>${key}</key><string>${xml(value)}</string>`).join("\n");
      return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${label}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>WorkingDirectory</key><string>${xml(installDir)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>RunAtLoad</key><true/>
${schedule}
    <key>Umask</key><integer>63</integer>
    <key>StandardOutPath</key><string>${xml(join(installDir, "logs", `${log}.log`))}</string>
    <key>StandardErrorPath</key><string>${xml(join(installDir, "logs", `${log}.err.log`))}</string>
  </dict>
</plist>
`;
    }
    return {
      "com.codex-proxy.server.plist": plist("com.codex-proxy.server", "server.ts", "proxy",
        "    <key>KeepAlive</key><true/>\n    <key>ThrottleInterval</key><integer>5</integer>"),
      "com.codex-proxy.picker-guard.plist": plist("com.codex-proxy.picker-guard", "picker-guard.ts", "picker-guard",
        "    <key>StartInterval</key><integer>120</integer>"),
    };
  }
  const env = Object.entries(environment)
    .map(([key, value]) => `Environment=${unitWord(`${key}=${value}`)}`).join("\n");
  // WorkingDirectory is a raw path, not a shell word. ":" disables ExecStart's
  // environment expansion so dollar signs in installation paths stay literal.
  const common = `WorkingDirectory=${specifiers(installDir)}
${env}
UMask=0077
`;
  return {
    "codex-proxy.service": `[Unit]
Description=Local Codex proxy
After=network-online.target

[Service]
Type=simple
${common}ExecStart=:${unitWord(bunExecutable)} "run" ${unitWord(join(installDir, "server.ts"))}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`,
    "codex-proxy-picker-guard.service": `[Unit]
Description=Refresh Codex proxy model catalog
After=codex-proxy.service

[Service]
Type=oneshot
${common}ExecStart=:${unitWord(bunExecutable)} "run" ${unitWord(join(installDir, "picker-guard.ts"))}
`,
    "codex-proxy-picker-guard.timer": `[Unit]
Description=Refresh Codex proxy model catalog every 120 seconds

[Timer]
OnStartupSec=10s
OnUnitActiveSec=120s
AccuracySec=1s
Unit=codex-proxy-picker-guard.service

[Install]
WantedBy=timers.target
`,
  };
}

export async function install(options: InstallOptions = {}) {
  const env = options.env ?? process.env;
  const home = resolve(safeText(options.home ?? env.HOME ?? homedir(), "HOME"));
  const codexHome = resolve(safeText(
    options.codexHome ?? (options.home === undefined ? env.CODEX_HOME || undefined : undefined) ?? join(home, ".codex"),
    "Codex home",
  ));
  const installDir = join(home, ".codex-proxy");
  const sourceDir = await realpath(resolve(options.sourceDir ?? import.meta.dir));
  const platform = parsePlatform(options.platform ?? process.platform);
  if (platform === "win32" && options.services && process.platform !== "win32") {
    throw new Error("Windows task registration requires Windows; omit --services to generate definitions only");
  }
  const bunExecutable = safeText(options.bunExecutable ?? process.execPath, "Bun executable");
  if (!isAbsolute(bunExecutable)) throw new Error("Bun executable must be an absolute path");
  const manifest = JSON.parse(await readFile(join(sourceDir, "package.json"), "utf8"));
  if (!Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error("package.json must declare an explicit nonempty files array");
  }
  const files = manifest.files.map(manifestPath) as string[];
  if (new Set(files).size !== files.length) throw new Error("Duplicate package.files entries");
  if (!files.includes(".env.example") || !files.includes("package.json")) {
    throw new Error("package.files must include .env.example and package.json");
  }

  // Preflight the entire distribution before changing a target installation.
  const distribution: { relative: string; bytes: Buffer; mode: number }[] = [];
  for (const relative of files) {
    await checkPath(sourceDir, relative, "file");
    const info = await inspect(join(sourceDir, relative));
    if (!info) throw new Error(`Missing distribution file: ${relative}`);
    distribution.push({
      relative, bytes: await readFile(join(sourceDir, relative)),
      mode: info.mode & 0o111 ? 0o700 : 0o600,
    });
    await checkPath(installDir, relative, "file");
  }
  for (const relative of ["services", "logs"]) await checkPath(installDir, relative, "directory");
  for (const relative of [".env", "codex-provider.toml"]) await checkPath(installDir, relative, "file");
  const envFile = join(installDir, ".env");
  const envExists = Boolean(await inspect(envFile));
  const example = distribution.find((file) => file.relative === ".env.example")!.bytes.toString("utf8");
  let envText = envExists ? await readFile(envFile, "utf8") : example;
  const filePort = valueFromDotenv(envText, "PORT");
  const port = parsePort(envExists ? (filePort ?? "4141") : (env.PORT ?? filePort ?? "4141"));
  if (!envExists && env.PORT !== undefined) {
    envText = /^\s*(?:export\s+)?PORT\s*=/m.test(example)
      ? example.replace(/^[ \t]*(?:export[ \t]+)?PORT[ \t]*=.*$/gm, `PORT=${port}`)
      : `${example}${example.endsWith("\n") ? "" : "\n"}PORT=${port}\n`;
  }
  function modelSetting(key: string, fallback: string): string {
    const fileValue = valueFromDotenv(envText, key);
    const value = safeText(
      (envExists ? fileValue ?? env[key] : env[key] ?? fileValue) ?? fallback, key,
    );
    if (!envExists && env[key] !== undefined) envText = setDotenvLiteral(envText, key, value);
    return value;
  }
  const model = modelSetting("PROXY_MODEL", "claude-opus-5");
  const reasoningEffort = modelSetting("PROXY_REASONING_EFFORT", "max");
  const separator = platform === "win32" ? ";" : ":";
  const path = [...new Set([
    dirname(bunExecutable), join(home, ".local/bin"), join(home, ".bun/bin"),
    ...(env.PATH ?? "").split(separator).filter((entry) => isAbsolute(entry)),
    ...(platform === "win32" ? [] : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]),
  ])].join(separator);
  const definitions = renderServiceDefinitions({ platform, home, codexHome, installDir, bunExecutable, path });
  const serviceRelative = platform === "darwin" ? "Library/LaunchAgents" : ".config/systemd/user";
  for (const name of Object.keys(definitions)) {
    await checkPath(installDir, `services/${name}`, "file");
    if (options.services && platform !== "win32") await checkPath(home, `${serviceRelative}/${name}`, "file");
  }
  const sameDirectory = Boolean(await inspect(installDir)) && await realpath(installDir) === sourceDir;
  await privateDirectory(installDir);
  await protectWindowsPath(installDir);
  if (envExists) await protectWindowsPath(envFile);
  await privateDirectory(join(installDir, "logs"));
  await privateDirectory(join(installDir, "services"));
  let copiedFiles = 0;
  if (!sameDirectory) {
    for (const file of distribution) {
      await privateDirectory(dirname(join(installDir, file.relative)));
      if (await writeManaged(join(installDir, file.relative), file.bytes, file.mode)) copiedFiles++;
    }
  }
  if (!envExists) {
    // Exclusive creation ensures that a concurrently created credential file wins.
    const file = await open(envFile, "wx", 0o600);
    try {
      await file.writeFile(envText);
      await file.chmod(0o600);
    } finally {
      await file.close();
    }
  }
  const snippet = join(installDir, "codex-provider.toml");
  await writeManaged(snippet, `# Optional provider settings. setup never modifies your Codex config.toml.
# Prefer "bun run codex" in this directory to apply equivalent CLI overrides.
model_provider = "portable-codex-proxy"
model_catalog_json = ${JSON.stringify(join(codexHome, "models_cache.json"))}
model = ${JSON.stringify(model)}
model_reasoning_effort = ${JSON.stringify(reasoningEffort)}

[model_providers.portable-codex-proxy]
name = "Local Codex Proxy"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 4
stream_max_retries = 10
stream_idle_timeout_ms = 300000
`);
  const serviceFiles: string[] = [];
  const installedServiceFiles: string[] = [];
  for (const [name, contents] of Object.entries(definitions)) {
    const definition = join(installDir, "services", name);
    await writeManaged(definition, contents);
    serviceFiles.push(definition);
    if (options.services && platform !== "win32") {
      const target = join(home, serviceRelative, name);
      await privateDirectory(dirname(target));
      await writeManaged(target, contents);
      installedServiceFiles.push(target);
    }
  }
  if (options.services && platform === "win32") {
    installedServiceFiles.push(...await installWindowsTasks(definitions));
  }
  return { installDir, codexHome, port, platform, copiedFiles, envCreated: !envExists, snippet, serviceFiles, installedServiceFiles };
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage);
    } else {
      const result = await install(options);
      console.log(`Installed to ${result.installDir} (${result.copiedFiles} package files updated).`);
      console.log(`.env ${result.envCreated ? "created with private permissions" : "preserved"}; credentials and Codex config unchanged.`);
      console.log(`Provider snippet: ${result.snippet}`);
      console.log(`Service definitions: ${join(result.installDir, "services")}`);
      if (result.installedServiceFiles.length) {
        console.log(`User ${result.platform === "win32" ? "tasks registered (existing tasks unchanged)" : "service files installed"}:\n${result.installedServiceFiles.join("\n")}`);
      }
      console.log("No services were enabled, started, or restarted. See README.md for authentication and startup.");
    }
  } catch (error) {
    console.error(`Setup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
